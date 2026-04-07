import type { OpenAgentPlugin } from '../types.js'
import type { Database } from '@openagent/core'
import { initSalesMemoryDb } from './db.js'
import { createSalesMemoryRouter } from './routes.js'

/**
 * SalesMemory plugin — persistent memory with FTS5 search and LLM recall.
 *
 * Requires a Database instance, passed via the plugin's `init(db)` method
 * which the loader calls before `register(app)`.
 */
const salesMemoryPlugin = {
  name: 'sales-memory',
  version: '1.0.0',

  _db: null as Database | null,

  init(db: Database): void {
    this._db = db
    try {
      initSalesMemoryDb(db)
    } catch (err) {
      console.error('[sales-memory] Failed to initialise database tables:', err)
    }
  },

  register(app: import('express').Express): void {
    if (!this._db) {
      console.warn('[sales-memory] No database available — plugin routes will not be registered')
      return
    }
    app.use('/api/plugins/salesmemory', createSalesMemoryRouter(this._db))
    console.log('[sales-memory] Routes registered at /api/plugins/salesmemory')
  },
} satisfies OpenAgentPlugin & { _db: Database | null; init(db: Database): void }

export default salesMemoryPlugin
