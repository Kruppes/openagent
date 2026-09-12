import { Router } from 'express'
import type { Database, AgentCore } from '@axiom/core'
import { saveUpload, serializeUploadsMetadata, listLoadableSkills } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { uploadMiddleware } from '../uploads.js'
import type { ChatActionRegistry } from '../chat-actions.js'
import { normalizeClientMessageId, resolveAgentId } from '../persona-request.js'

/** Columns returned by every history query (kept in one place so both branches stay identical). */
const HISTORY_SELECT = `SELECT cm.id, cm.session_id, cm.user_id, cm.role, cm.content, cm.metadata, cm.timestamp,
                cm.agent_id, cm.client_message_id,
                s.source AS source, s.type AS session_type
         FROM chat_messages cm
         LEFT JOIN sessions s ON s.id = cm.session_id`

export interface ChatRouterOptions {
  db: Database
  /** Backs the interactive action buttons rendered inside chat messages. */
  chatActions?: ChatActionRegistry | null
  /** Resolves the live AgentCore (and via it, SessionManager). May return null
   * if the agent isn't available yet — in which case the REST upload endpoint
   * cannot create a tracked session and will return an error. */
  getAgentCore?: () => AgentCore | null
}

export function createChatRouter(options: ChatRouterOptions): Router {
  const { db } = options
  const getAgentCore = options.getAgentCore ?? (() => null)
  const router = Router()

  router.use(jwtMiddleware)

  router.post('/message', uploadMiddleware.array('files', 5), (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId
    const text = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
    const files = (req.files as Express.Multer.File[] | undefined) ?? []

    if (!text && files.length === 0) {
      res.status(400).json({ error: 'Message content or at least one file is required' })
      return
    }

    // Fork multi-persona (Axiom-Companion M1): optional persona + idempotency key.
    const agentId = resolveAgentId(req.body?.agentId)
    if (agentId === null) {
      res.status(400).json({ error: 'Unknown agentId' })
      return
    }
    const clientMessageId = normalizeClientMessageId(req.body?.clientMessageId)
    if (clientMessageId === null) {
      res.status(400).json({ error: 'Invalid clientMessageId' })
      return
    }

    // Resolve a tracked interactive session via SessionManager. Source is
    // 'web' — this REST endpoint is the upload prelude for a WebSocket chat
    // message, so the session belongs to the web channel. Using 'rest' here
    // would leak into the cached session and mistag subsequent WS messages
    // (the cache keeps the initial source), corrupting source-based filters
    // in chat history, logs, and usage stats.
    const agentCore = getAgentCore()
    if (!agentCore) {
      res.status(503).json({ error: 'Agent core not available' })
      return
    }
    // Idempotent retry: the row already exists, hand it back unchanged (200,
    // not 201) and do NOT store the re-uploaded files a second time.
    if (clientMessageId) {
      const existing = db.prepare(
        'SELECT id, session_id, user_id, role, content, metadata, timestamp, agent_id, client_message_id FROM chat_messages WHERE user_id = ? AND client_message_id = ?'
      ).get(userId, clientMessageId) as Record<string, unknown> | undefined
      if (existing) {
        if (existing.agent_id !== agentId) {
          res.status(409).json({ error: 'clientMessageId already used for another persona' })
          return
        }
        res.status(200).json({ message: existing, duplicate: true })
        return
      }
    }

    const session = agentCore.getSessionManager().getOrCreateSession(String(userId), 'web', agentId)
    const sessionId = session.id

    const uploads = files.map(file => saveUpload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      source: 'web',
      userId,
      sessionId,
    }))

    const metadata = uploads.length > 0 ? serializeUploadsMetadata(uploads) : null
    let insertedId: number
    try {
      const result = db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, client_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, userId, 'user', text, metadata, agentId, clientMessageId ?? null)
      insertedId = Number(result.lastInsertRowid)
    } catch (err) {
      // Two concurrent retries with the same key: the loser reads the winner.
      if (clientMessageId && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const existing = db.prepare(
          'SELECT id, session_id, user_id, role, content, metadata, timestamp, agent_id, client_message_id FROM chat_messages WHERE user_id = ? AND client_message_id = ?'
        ).get(userId, clientMessageId) as Record<string, unknown>
        res.status(200).json({ message: existing, duplicate: true })
        return
      }
      throw err
    }

    res.status(201).json({
      message: {
        id: insertedId,
        session_id: sessionId,
        user_id: userId,
        role: 'user',
        content: text,
        metadata,
        timestamp: new Date().toISOString(),
        agent_id: agentId,
        client_message_id: clientMessageId ?? null,
      },
    })
  })

  /**
   * GET /api/chat/history
   * Query: ?session_id=xxx&page=1&limit=50[&agent_id=bob][&since_id=123]
   * Returns paginated chat messages, joined with `sessions` so each message
   * carries the originating `source` (web, telegram, rest, ...). The frontend
   * uses `source` instead of inferring from session-ID prefixes.
   *
   * Fork (Axiom-Companion M1), both optional and additive:
   * - `agent_id` restricts to one persona.
   * - `since_id` switches to cursor mode: rows with `id > since_id`, ordered
   *   ASCENDING by id, so a reconnecting client fetches exactly the gap it
   *   missed. `page` is ignored in cursor mode; `limit` still caps the batch
   *   and `pagination.total` is the number of rows after the cursor.
   */
  router.get('/history', (req: AuthenticatedRequest, res) => {
    const sessionId = req.query.session_id as string | undefined
    const page = Math.max(1, parseInt(req.query.page as string) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50))
    const offset = (page - 1) * limit
    const userId = req.user!.userId

    const agentId = req.query.agent_id === undefined ? undefined : resolveAgentId(req.query.agent_id)
    if (agentId === null) {
      res.status(400).json({ error: 'Unknown agent_id' })
      return
    }
    let sinceId: number | undefined
    if (req.query.since_id !== undefined) {
      const raw = String(req.query.since_id)
      if (!/^\d{1,15}$/.test(raw)) {
        res.status(400).json({ error: 'since_id must be a non-negative integer' })
        return
      }
      sinceId = Number(raw)
    }

    const where: string[] = ['cm.user_id = ?']
    const params: unknown[] = [userId]
    if (sessionId) {
      where.push('cm.session_id = ?')
      params.push(sessionId)
    }
    if (agentId !== undefined) {
      where.push('cm.agent_id = ?')
      params.push(agentId)
    }
    if (sinceId !== undefined) {
      where.push('cm.id > ?')
      params.push(sinceId)
    }
    const whereSql = where.join(' AND ')

    const messages = sinceId !== undefined
      ? db.prepare(`${HISTORY_SELECT} WHERE ${whereSql} ORDER BY cm.id ASC LIMIT ?`).all(...params, limit)
      : db.prepare(`${HISTORY_SELECT} WHERE ${whereSql} ORDER BY cm.timestamp DESC LIMIT ? OFFSET ?`).all(...params, limit, offset)

    const total = (db.prepare(
      `SELECT COUNT(*) as count FROM chat_messages cm WHERE ${whereSql}`
    ).get(...params) as { count: number }).count

    res.json({
      messages,
      pagination: {
        page: sinceId !== undefined ? 1 : page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  })

  /**
   * POST /api/chat/actions/:messageId
   * Body: { actionId }
   * Answers a button of an interactive chat message. The registered handler
   * owns the decision semantics (including first-action-wins), so a stale
   * click just loses there and gets the handler's message back.
   */
  router.post('/actions/:messageId', async (req: AuthenticatedRequest, res) => {
    const registry = options.chatActions
    if (!registry) {
      res.status(503).json({ error: 'Chat actions are not available' })
      return
    }

    const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId.trim() : ''
    if (!actionId) {
      res.status(400).json({ error: 'actionId is required' })
      return
    }

    const user = req.user!

    try {
      const result = await registry.invoke(String(req.params.messageId), actionId, {
        userId: user.userId,
        username: user.username,
      })

      if (result.status === 'not_found') {
        res.status(404).json({ error: 'This action is no longer available.' })
        return
      }

      if (result.status === 'ok') {
        res.json({ status: result.status, resolution: result.resolution })
        return
      }

      // `error` mirrors the resolution so generic API clients surface the
      // reason (e.g. "already decided") instead of a bare status code.
      res.status(409).json({ status: result.status, resolution: result.resolution, error: result.resolution })
    } catch (err) {
      res.status(500).json({ error: `Failed to run chat action: ${(err as Error).message}` })
    }
  })

  /**
   * GET /api/chat/sessions
   * Returns list of chat sessions for the current user
   */
  router.get('/sessions', (req: AuthenticatedRequest, res) => {
    const userId = req.user!.userId

    const sessions = db.prepare(`
      SELECT DISTINCT session_id,
        MIN(timestamp) as started_at,
        MAX(timestamp) as last_message_at,
        COUNT(*) as message_count
      FROM chat_messages
      WHERE user_id = ?
      GROUP BY session_id
      ORDER BY last_message_at DESC
    `).all(userId)

    res.json({ sessions })
  })

  /**
   * GET /api/chat/skills
   * Skills the current user can load via `/skill:<id>` (composer autocomplete).
   * Deliberately not admin-gated: every chat user may load skills.
   */
  router.get('/skills', (_req: AuthenticatedRequest, res) => {
    try {
      res.json({ skills: listLoadableSkills() })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
