#!/usr/bin/env bash
# Throwaway Postgres for the admin-app database tests (ADR 0008). Never touches Neon.
#
#   scripts/test-db.sh            # up, run tests/admin/*.test.mjs, then down (npm run test:db)
#   scripts/test-db.sh up         # start + migrate, leave it running; prints the env file
#   scripts/test-db.sh down       # remove the container
#
# What `up` does:
#   1. Makes a self-signed certificate for `localhost` and starts a `postgres` container
#      with TLS on, published on a random 127.0.0.1 port.
#   2. Applies EVERY migration with the real backend/scripts/migrate.js, unchanged. It
#      insists on verify-full TLS, so the test cert is passed through DB_CA_CERT (the
#      same optional override production supports). Then runs it again to prove a
#      re-run applies nothing.
#   3. Gives the NOLOGIN app roles (admin_app, checkin_writer, site_reader, social_checker) LOGIN and a random
#      test password, as the operator does out of band on Neon.
#   4. Starts a throwaway MinIO (S3-compatible, standing in for Neon Object Storage,
#      ADR 0010) with one bucket, on a random 127.0.0.1 port, path-style, with a random
#      root credential. If the image can't be pulled or MinIO doesn't come up, it
#      carries on without it and the storage integration tests skip.
#   5. Writes TEST_OWNER_URL / TEST_ADMIN_URL / TEST_CHECKIN_URL / TEST_SITE_URL /
#      TEST_SOCIAL_CHECK_URL (+ DB_CA_CERT_FILE)
#      and, when MinIO is up, STORAGE_* to $STATE/test-db.env for the tests.
#
# Env: PG_IMAGE (default postgres:17-alpine), MINIO_IMAGE (default pinned below; "none"
# skips MinIO), BOCC_TEST_DB_NAME (container name; MinIO's is "<name>-minio", so
# parallel runs with different names stay isolated).
#
# MinIO image: the official minio/minio images can no longer be pulled from Docker Hub
# or quay.io (checked 2026-11-17), so this uses Bitnami's frozen legacy build, pinned by
# digest. It is only a local test double, never deployed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${BOCC_TEST_DB_NAME:-bocc-admin-test-db}"
IMAGE="${PG_IMAGE:-postgres:17-alpine}"
MINIO_NAME="${NAME}-minio"
MINIO_IMAGE="${MINIO_IMAGE:-bitnamilegacy/minio:2025.4.22@sha256:50cec18ac4184af4671a78aedd5554942c8ae105d51a465fa82037949046da01}"
MINIO_BUCKET="bocc-media-test"
MINIO_REGION="us-east-2"
STATE="${TMPDIR:-/tmp}/${NAME}"
ENV_FILE="$STATE/test-db.env"

down() {
  docker rm -f "$NAME" "$MINIO_NAME" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}

# Start MinIO and write $STATE/storage.env. Never fails the run: without MinIO the
# storage integration tests skip.
minio_up() {
  if [ "$MINIO_IMAGE" = "none" ]; then
    echo "MinIO skipped (MINIO_IMAGE=none); storage integration tests will skip"
    return 0
  fi
  local user pw port=""
  user="test$(openssl rand -hex 8)"
  pw="$(openssl rand -hex 24)"
  if ! docker run -d --name "$MINIO_NAME" -p 127.0.0.1::9000 \
      -e MINIO_ROOT_USER="$user" -e MINIO_ROOT_PASSWORD="$pw" \
      -e MINIO_DEFAULT_BUCKETS="$MINIO_BUCKET" -e MINIO_SITE_REGION="$MINIO_REGION" \
      "$MINIO_IMAGE" >/dev/null 2>&1; then
    echo "MinIO unavailable (could not start $MINIO_IMAGE); storage integration tests will skip"
    docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
    return 0
  fi
  for _ in $(seq 1 60); do
    port="$(docker port "$MINIO_NAME" 9000/tcp 2>/dev/null | head -1 | sed 's/.*://')"
    # Ready once the server answers and the image has created the bucket.
    if [ -n "$port" ] && curl -sf "http://127.0.0.1:${port}/minio/health/ready" >/dev/null 2>&1 \
        && docker exec "$MINIO_NAME" sh -c 'test -d "/bitnami/minio/data/$1"' _ "$MINIO_BUCKET" 2>/dev/null; then
      {
        echo "STORAGE_ENDPOINT=http://localhost:${port}"
        echo "STORAGE_BUCKET=${MINIO_BUCKET}"
        echo "STORAGE_REGION=${MINIO_REGION}"
        echo "STORAGE_ACCESS_KEY_ID=${user}"
        echo "STORAGE_SECRET_ACCESS_KEY=${pw}"
        echo "STORAGE_FORCE_PATH_STYLE=true"
      } >"$STATE/storage.env"
      echo "MinIO up: container $MINIO_NAME on 127.0.0.1:${port}, bucket $MINIO_BUCKET"
      return 0
    fi
    sleep 1
  done
  echo "MinIO did not become ready; storage integration tests will skip"
  docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
}

up() {
  down
  mkdir -p "$STATE"
  chmod 700 "$STATE"

  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$STATE/server.key" -out "$STATE/server.crt" >/dev/null 2>&1

  local owner_pw admin_pw writer_pw site_pw checker_pw
  owner_pw="$(openssl rand -hex 16)"
  admin_pw="$(openssl rand -hex 16)"
  writer_pw="$(openssl rand -hex 16)"
  site_pw="$(openssl rand -hex 16)"
  checker_pw="$(openssl rand -hex 16)"

  # The key must belong to the server user with mode 0600, so copy it in at start.
  docker run -d --name "$NAME" -p 127.0.0.1::5432 \
    -e POSTGRES_PASSWORD="$owner_pw" -e POSTGRES_DB=neondb \
    -v "$STATE/server.crt:/certs/server.crt:ro" -v "$STATE/server.key:/certs/server.key:ro" \
    --entrypoint sh "$IMAGE" -c '
      cp /certs/server.crt /certs/server.key /var/lib/postgresql/ &&
      chown postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key &&
      chmod 600 /var/lib/postgresql/server.key &&
      exec docker-entrypoint.sh postgres -c ssl=on \
        -c ssl_cert_file=/var/lib/postgresql/server.crt \
        -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null

  local port=""
  for _ in $(seq 1 60); do
    port="$(docker port "$NAME" 5432/tcp 2>/dev/null | head -1 | sed 's/.*://')"
    # pg_isready over TCP only succeeds after the entrypoint's init restart.
    if [ -n "$port" ] && docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d neondb >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres -d neondb >/dev/null

  local owner_url="postgresql://postgres:${owner_pw}@localhost:${port}/neondb"
  (
    cd "$ROOT/backend"
    export DATABASE_URL="$owner_url" DB_CA_CERT
    DB_CA_CERT="$(cat "$STATE/server.crt")"
    echo "migrate.js (first run):"
    node scripts/migrate.js
    echo "migrate.js (second run, expect nothing new):"
    node scripts/migrate.js
  )

  docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres -d neondb <<SQL
alter role admin_app      login password '${admin_pw}';
alter role checkin_writer login password '${writer_pw}';
alter role site_reader    login password '${site_pw}';
alter role social_checker login password '${checker_pw}';
SQL

  minio_up

  cat >"$ENV_FILE" <<EOF
TEST_OWNER_URL=${owner_url}
TEST_ADMIN_URL=postgresql://admin_app:${admin_pw}@localhost:${port}/neondb
TEST_CHECKIN_URL=postgresql://checkin_writer:${writer_pw}@localhost:${port}/neondb
TEST_SITE_URL=postgresql://site_reader:${site_pw}@localhost:${port}/neondb
TEST_SOCIAL_CHECK_URL=postgresql://social_checker:${checker_pw}@localhost:${port}/neondb
DB_CA_CERT_FILE=$STATE/server.crt
EOF
  if [ -f "$STATE/storage.env" ]; then cat "$STATE/storage.env" >>"$ENV_FILE"; fi
  chmod 600 "$ENV_FILE"
  echo "test database up: container $NAME on 127.0.0.1:${port}; env in $ENV_FILE"
}

case "${1:-test}" in
  up) up ;;
  down) down ;;
  test)
    trap down EXIT
    up
    cd "$ROOT"
    node --env-file="$ENV_FILE" --test --test-concurrency=1 "tests/admin/*.test.mjs"
    ;;
  *) echo "usage: $0 [test|up|down]" >&2; exit 2 ;;
esac
