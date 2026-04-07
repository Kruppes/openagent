import { Router } from 'express'
import type { Database } from '@openagent/core'
import { jwtMiddleware } from '../../auth.js'
import {
  searchMemory,
  getLatestDigest,
  getSalesMemoryStats,
} from './db.js'
import { summarizeResults, generateDigest } from './llm.js'

export function createSalesMemoryRouter(db: Database): Router {
  const router = Router()

  // All routes require a valid JWT
  router.use(jwtMiddleware)

  /**
   * GET /api/plugins/salesmemory/search?q=...&limit=5
   * Raw FTS5 search — returns matching messages without LLM post-processing.
   */
  router.get('/search', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10))

    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' })
      return
    }

    try {
      const results = searchMemory(db, q, limit)
      res.json({ results, count: results.length, query: q })
    } catch (err) {
      console.error('[sales-memory] /search error:', err)
      res.status(500).json({ error: 'Search failed', detail: (err as Error).message })
    }
  })

  /**
   * GET /api/plugins/salesmemory/recall?q=...
   * FTS5 search + LLM summarisation — returns a human-readable summary plus
   * the raw results for reference.
   */
  router.get('/recall', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' })
      return
    }

    try {
      const results = searchMemory(db, q, 10)
      const summary = await summarizeResults(results, q)
      res.json({ summary, results, count: results.length, query: q })
    } catch (err) {
      console.error('[sales-memory] /recall error:', err)
      res.status(500).json({ error: 'Recall failed', detail: (err as Error).message })
    }
  })

  /**
   * POST /api/plugins/salesmemory/digest
   * Body: { date?: "YYYY-MM-DD" }  — defaults to today
   * Generates a daily digest via LLM and persists it.
   */
  router.post('/digest', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10)
    const date =
      typeof (req.body as Record<string, unknown>)?.date === 'string'
        ? ((req.body as Record<string, unknown>).date as string).trim() || today
        : today

    try {
      const content = await generateDigest(db, date)
      res.status(201).json({ date, content })
    } catch (err) {
      console.error('[sales-memory] /digest error:', err)
      res.status(500).json({ error: 'Digest generation failed', detail: (err as Error).message })
    }
  })

  /**
   * GET /api/plugins/salesmemory/digest/latest
   * Returns the most recent digest or 404 if none exist.
   */
  router.get('/digest/latest', (req, res) => {
    try {
      const digest = getLatestDigest(db)
      if (!digest) {
        res.status(404).json({ error: 'No digest found' })
        return
      }
      res.json(digest)
    } catch (err) {
      console.error('[sales-memory] /digest/latest error:', err)
      res.status(500).json({ error: 'Failed to retrieve digest', detail: (err as Error).message })
    }
  })

  /**
   * GET /api/plugins/salesmemory/status
   * Returns basic statistics about the FTS index and digest table.
   */
  router.get('/status', (req, res) => {
    try {
      const stats = getSalesMemoryStats(db)
      res.json(stats)
    } catch (err) {
      console.error('[sales-memory] /status error:', err)
      // Fall back gracefully if the FTS wildcard query fails
      res.json({ fts_count: null, digest_count: null, last_digest_date: null, error: (err as Error).message })
    }
  })

  return router
}
