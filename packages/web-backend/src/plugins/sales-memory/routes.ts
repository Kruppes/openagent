import { Router } from 'express'
import type { Database } from '@openagent/core'
import { jwtMiddleware } from '../../auth.js'
import {
  searchMemory,
  getLatestDigest,
  getSalesMemoryStats,
} from './db.js'
import { summarizeResults, generateDigest } from './llm.js'
import type { SalesMemorySettings } from './config.js'
import { loadSalesMemoryConfig, saveSalesMemoryConfig } from './config.js'

export function createSalesMemoryRouter(db: Database): Router {
  const router = Router()

  // All routes require a valid JWT
  router.use(jwtMiddleware)

  // ── Config endpoints ────────────────────────────────────────────────────────

  /**
   * GET /api/plugins/salesmemory/config
   * Returns the current effective config (saved file + env defaults merged).
   * The openai/anthropic keys are masked for security.
   */
  router.get('/config', (_req, res) => {
    try {
      const config = loadSalesMemoryConfig()
      // Mask secrets in the response (non-empty → "***")
      const masked = {
        ...config,
        openaiKey: config.openaiKey ? '***' : '',
        anthropicKey: config.anthropicKey ? '***' : '',
      }
      res.json(masked)
    } catch (err) {
      console.error('[sales-memory] GET /config error:', err)
      res.status(500).json({ error: 'Failed to load config', detail: (err as Error).message })
    }
  })

  /**
   * POST /api/plugins/salesmemory/config
   * Saves the provided settings to /data/config/salesmemory.json.
   * Partial updates are merged with existing config.
   * If openaiKey / anthropicKey is "***" (masked), the existing stored value is preserved.
   */
  router.post('/config', (req, res) => {
    try {
      const existing = loadSalesMemoryConfig()
      const body = req.body as Partial<SalesMemorySettings>

      const next: SalesMemorySettings = {
        provider: body.provider ?? existing.provider,
        ollamaUrl: body.ollamaUrl ?? existing.ollamaUrl,
        ollamaModel: body.ollamaModel ?? existing.ollamaModel,
        // Preserve existing secret if the client sends the masked placeholder
        openaiKey: (body.openaiKey !== undefined && body.openaiKey !== '***')
          ? body.openaiKey
          : existing.openaiKey,
        openaiModel: body.openaiModel ?? existing.openaiModel,
        anthropicKey: (body.anthropicKey !== undefined && body.anthropicKey !== '***')
          ? body.anthropicKey
          : existing.anthropicKey,
        anthropicModel: body.anthropicModel ?? existing.anthropicModel,
        autoInject: body.autoInject ?? existing.autoInject,
        injectMaxResults: body.injectMaxResults ?? existing.injectMaxResults,
        injectThreshold: body.injectThreshold ?? existing.injectThreshold,
      }

      saveSalesMemoryConfig(next)

      // Return the saved config (with masked secrets)
      const masked = {
        ...next,
        openaiKey: next.openaiKey ? '***' : '',
        anthropicKey: next.anthropicKey ? '***' : '',
      }
      res.json(masked)
    } catch (err) {
      console.error('[sales-memory] POST /config error:', err)
      res.status(500).json({ error: 'Failed to save config', detail: (err as Error).message })
    }
  })

  // ── Search & recall endpoints ───────────────────────────────────────────────

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
   *
   * Optional JSON body or query params: settings overrides (provider, ollamaUrl, etc.)
   */
  router.get('/recall', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    if (!q) {
      res.status(400).json({ error: 'Query parameter "q" is required' })
      return
    }

    // Accept optional per-request settings overrides from query params
    const settingsOverrides: Partial<SalesMemorySettings> = {}
    if (typeof req.query.provider === 'string') settingsOverrides.provider = req.query.provider as SalesMemorySettings['provider']
    if (typeof req.query.ollamaUrl === 'string') settingsOverrides.ollamaUrl = req.query.ollamaUrl
    if (typeof req.query.ollamaModel === 'string') settingsOverrides.ollamaModel = req.query.ollamaModel

    try {
      const results = searchMemory(db, q, 10)
      const summary = await summarizeResults(results, q, settingsOverrides)
      res.json({ summary, results, count: results.length, query: q })
    } catch (err) {
      console.error('[sales-memory] /recall error:', err)
      res.status(500).json({ error: 'Recall failed', detail: (err as Error).message })
    }
  })

  /**
   * POST /api/plugins/salesmemory/digest
   * Body: { date?: "YYYY-MM-DD", settings?: SalesMemorySettings }  — defaults to today
   * Generates a daily digest via LLM and persists it.
   */
  router.post('/digest', async (req, res) => {
    const today = new Date().toISOString().slice(0, 10)
    const body = req.body as Record<string, unknown>
    const date =
      typeof body?.date === 'string'
        ? (body.date as string).trim() || today
        : today

    // Accept optional per-request settings overrides from body
    const settingsOverrides = (typeof body?.settings === 'object' && body.settings !== null)
      ? body.settings as Partial<SalesMemorySettings>
      : {}

    try {
      const content = await generateDigest(db, date, settingsOverrides)
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
