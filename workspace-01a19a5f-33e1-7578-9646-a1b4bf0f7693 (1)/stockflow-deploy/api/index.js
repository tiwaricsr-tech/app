'use strict';
/**
 * Vercel serverless entry point.
 *
 * Vercel rewrites every path here (see vercel.json) and this handler delegates
 * to the same Express app used by `node src/server.js`, so routing, static
 * assets and the SPA fallback behave identically.
 *
 * Requirements on Vercel:
 *   • DATABASE_URL must point at Supabase Postgres — the filesystem is read-only
 *     and ephemeral, so the embedded SQLite fallback cannot persist.
 *   • Keep PG_POOL_MAX small (1-3) and use the *transaction pooler* on port 6543:
 *     postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
 *   • Set JWT_SECRET in Project → Settings → Environment Variables.
 */
const { app, start } = require('../src/server');

let booted = null;

function boot() {
  if (!booted) {
    booted = start().catch((err) => {
      booted = null; // let the next invocation retry instead of caching a failure
      throw err;
    });
  }
  return booted;
}

module.exports = async (req, res) => {
  await boot();
  return app(req, res);
};
