// Public site data seam (ADR 0009 decision 4): the /events/YYYY-MM-DD/ pages and the
// sitemap read Neon on request as `site_reader`, which may SELECT `events` and
// `event_links` and nothing else (migration 20261121120000_event_links_site_reader.sql).
// Public traffic never holds the admin_app credential. Parameterized SQL only.
//
// Environment, validated fail-fast at first use (like readAdminEnv) and never needed
// by the static build, which doesn't import this module's pool:
//   SITE_DB_URL       pooled Neon URL for the `site_reader` role (never the owner URL)
//   SITE_DB_POOL_MAX  optional, pool size per function instance (default 2)
//   DB_CA_CERT        optional PEM CA override (src/lib/auth/pg-config.mjs)
// TLS is verify-full, except for a loopback host (the Docker test database).
//
// Callers catch every error and answer 503 (SiteUnavailable): nothing from here
// reaches a visitor.

import pg from "pg";
import { toAdminPgConfig } from "../auth/pg-config.mjs";

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ dbUrl: string, poolMax: number }}
 * @throws {Error} listing every problem at once; names variables, never values
 */
export function readSiteEnv(env = process.env) {
  const problems = [];
  const dbUrl = env.SITE_DB_URL;
  if (!dbUrl) problems.push("SITE_DB_URL is not set (pooled site_reader connection string)");
  else {
    try {
      const u = new URL(dbUrl);
      if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push("SITE_DB_URL must be a postgres:// URL");
    } catch {
      problems.push("SITE_DB_URL is not a valid URL");
    }
  }
  let poolMax = 2;
  if (env.SITE_DB_POOL_MAX !== undefined && env.SITE_DB_POOL_MAX !== "") {
    poolMax = Number(env.SITE_DB_POOL_MAX);
    if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 10) problems.push("SITE_DB_POOL_MAX must be an integer from 1 to 10");
  }
  if (problems.length) throw new Error(`[site env] Misconfigured:\n  - ${problems.join("\n  - ")}`);
  return { dbUrl: /** @type {string} */ (dbUrl), poolMax };
}

/** @type {import("pg").Pool | null} */
let pool = null;

/** The one site_reader pool, made on first use. Throws if the environment is wrong. */
export function sitePool() {
  if (!pool) {
    const { dbUrl, poolMax } = readSiteEnv();
    pool = new pg.Pool(toAdminPgConfig(dbUrl, {
      max: poolMax,
      // Neon may be scaled to zero; a cold start takes a few seconds. Past that the
      // page answers 503 rather than holding the visitor.
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 5000,
      query_timeout: 6000,
      application_name: "bocc-site",
    }));
    pool.on("error", (err) => console.error("[site db] idle client error:", err.message));
  }
  return pool;
}

/** For tests: close the pool so the next call makes a new one. */
export async function endSitePool() {
  const p = pool;
  pool = null;
  await p?.end();
}

const PLATFORMS = new Set(["luma", "eventbrite", "facebook_event", "linkedin_event"]);

/**
 * @typedef {object} SiteEvent
 * @property {string} date              YYYY-MM-DD
 * @property {"scheduled"|"held"|"cancelled"} status
 * @property {"lobby"|"food_hall"|"other"|null} location
 * @property {string|null} locationOther
 * @property {Date} updatedAt            latest of the event row and its links
 * @property {Partial<Record<"luma"|"eventbrite"|"facebook_event"|"linkedin_event", { url: string, externalId: string|null }>>} links
 * @property {string|null} nextDate     the next scheduled event on or after `today`, not this one
 */

/**
 * One event with its links and the next upcoming scheduled date, in one round trip.
 * @param {string} date   YYYY-MM-DD (already validated)
 * @param {string} today  YYYY-MM-DD, Eastern
 * @param {{ query: Function }} [db]
 * @returns {Promise<SiteEvent|null>} null when there is no events row
 */
export async function getSiteEvent(date, today, db = sitePool()) {
  const { rows } = await db.query(
    `select e.event_date::text as date, e.status, e.location, e.location_other,
            greatest(e.updated_at, max(l.updated_at)) as updated_at,
            coalesce(json_agg(json_build_object('platform', l.platform, 'url', l.url, 'external_id', l.external_id))
                       filter (where l.platform is not null), '[]'::json) as links,
            (select n.event_date::text from public.events n
              where n.status = 'scheduled' and n.event_date >= $2::date and n.event_date <> e.event_date
              order by n.event_date limit 1) as next_date
       from public.events e
       left join public.event_links l on l.event_date = e.event_date
      where e.event_date = $1::date
      group by e.event_date`,
    [date, today],
  );
  const r = rows[0];
  if (!r) return null;
  /** @type {SiteEvent["links"]} */
  const links = {};
  for (const l of r.links) if (PLATFORMS.has(l.platform)) links[/** @type {keyof SiteEvent["links"]} */ (l.platform)] = { url: l.url, externalId: l.external_id };
  return {
    date: r.date,
    status: r.status,
    location: r.location,
    locationOther: r.location_other,
    updatedAt: r.updated_at,
    links,
    nextDate: r.next_date,
  };
}

/**
 * Upcoming scheduled events for the sitemap, soonest first.
 * @param {string} today YYYY-MM-DD, Eastern
 * @param {{ query: Function }} [db]
 * @returns {Promise<{ date: string, updatedAt: Date }[]>}
 */
export async function listUpcomingScheduled(today, db = sitePool()) {
  const { rows } = await db.query(
    `select e.event_date::text as date, greatest(e.updated_at, max(l.updated_at)) as updated_at
       from public.events e
       left join public.event_links l on l.event_date = e.event_date
      where e.status = 'scheduled' and e.event_date >= $1::date
      group by e.event_date
      order by e.event_date
      limit 60`,
    [today],
  );
  return rows.map((r) => ({ date: r.date, updatedAt: r.updated_at }));
}
