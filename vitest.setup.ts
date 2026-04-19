/**
 * Vitest global setup.
 *
 * Strips host environment variables that would otherwise leak into tests
 * and cause non-deterministic failures. Notably, when OpenAgent itself is
 * running in the same container/process environment as the test suite,
 * ADMIN_PASSWORD / ADMIN_USERNAME / JWT_SECRET are set for the production
 * instance. ensureAdminUser() then seeds the test DB with a hash of the
 * production password instead of "admin", breaking every auth-dependent
 * test with a 401.
 *
 * This file runs once before the test suite starts.
 */

const VARS_TO_STRIP = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'JWT_SECRET',
]

for (const name of VARS_TO_STRIP) {
  if (process.env[name] !== undefined) {
    delete process.env[name]
  }
}
