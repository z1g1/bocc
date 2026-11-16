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
#   3. Gives the NOLOGIN app roles (admin_app, checkin_writer) LOGIN and a random
#      test password, as the operator does out of band on Neon.
#   4. Writes TEST_OWNER_URL / TEST_ADMIN_URL / TEST_CHECKIN_URL (+ DB_CA_CERT_FILE)
#      to $STATE/test-db.env for the tests.
#
# Env: PG_IMAGE (default postgres:17-alpine), BOCC_TEST_DB_NAME (container name).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${BOCC_TEST_DB_NAME:-bocc-admin-test-db}"
IMAGE="${PG_IMAGE:-postgres:17-alpine}"
STATE="${TMPDIR:-/tmp}/${NAME}"
ENV_FILE="$STATE/test-db.env"

down() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}

up() {
  down
  mkdir -p "$STATE"
  chmod 700 "$STATE"

  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -keyout "$STATE/server.key" -out "$STATE/server.crt" >/dev/null 2>&1

  local owner_pw admin_pw writer_pw
  owner_pw="$(openssl rand -hex 16)"
  admin_pw="$(openssl rand -hex 16)"
  writer_pw="$(openssl rand -hex 16)"

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
SQL

  cat >"$ENV_FILE" <<EOF
TEST_OWNER_URL=${owner_url}
TEST_ADMIN_URL=postgresql://admin_app:${admin_pw}@localhost:${port}/neondb
TEST_CHECKIN_URL=postgresql://checkin_writer:${writer_pw}@localhost:${port}/neondb
DB_CA_CERT_FILE=$STATE/server.crt
EOF
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
