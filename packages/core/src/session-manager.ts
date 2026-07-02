import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { appendToDailyFile } from './memory.js'
import { logToolCall } from './token-logger.js'
import {
  extractTopicTags,
  getSessionMessages,
  detectTopicShift,
  queryMemoriesFts,
  buildFactInjection,
  estimateTokens,
  hasAttachmentMarker,
} from './session-store.js'
import type { SessionMessage } from './session-store.js'

/**
 * The single canonical session ID generator. All new sessions — interactive,
 * task, heartbeat, consolidation, loop_detection — must obtain their ID from
 * this function so that ID format is uniform across the system.
 */
export function generateSessionId(): string {
  return randomUUID()
}

/**
 * Merge incoming topic tags into an existing list, de-duplicating and
 * capping at 8 to keep the sliding-window signal bounded.
 */
function mergeTopicTags(existing: string[], incoming: string[]): string[] {
  const merged = [...existing]
  for (const tag of incoming) {
    if (!merged.includes(tag)) {
      merged.push(tag)
    }
  }
  return merged.slice(0, 8)
}

export type SessionType =
  | 'interactive'
  | 'task'
  | 'heartbeat'
  | 'consolidation'
  | 'loop_detection'

export interface CreateSessionOptions {
  type: SessionType
  source: string
  userId?: string
  parentSessionId?: string
}

export interface SessionInfo {
  id: string
  userId: string
  source: string
  startedAt: number // timestamp ms
  lastActivity: number // timestamp ms
  messageCount: number
  summaryWritten: boolean
  /** True if this session was restored from DB after a server restart */
  restored: boolean
  /** Cached topic tags for the current session (topic-shift detection) */
  topicTags?: string[]
  /** Agent ID for multi-persona support (default: 'main') */
  agentId: string
}

export interface SessionManagerOptions {
  db: Database
  timeoutMinutes?: number
  memoryDir?: string
  /**
   * Called to generate a summary of the session. Returns the summary text.
   * conversationHistory is built from chat_messages in the DB (single source of truth).
   */
  onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  /**
   * Called when a session is disposed (after summary if applicable).
   *
   * `options.background` is true when the session was ended via
   * `handleNewCommandAsync()` and the summary was generated asynchronously
   * after the new session had already been announced to the client.
   * Listeners use this to deliver the summary as a *late* update event
   * instead of a fresh session_end divider that would duplicate the one
   * already rendered when the new session was opened.
   */
  onSessionEnd?: (
    session: SessionInfo,
    summary: string | null,
    options?: { background?: boolean },
  ) => void
  /**
   * Called when a topic shift is detected (or facts are injected on a fresh
   * session). Lets the caller surface the injected memory context to the UI.
   */
  onTopicShift?: (session: SessionInfo, factInjection: string) => void
}

export type SessionEndReason = 'timeout' | 'manual' | 'provider_change' | 'topic_shift'

/**
 * Manages active sessions per user with timeout and auto-summarization.
 *
 * After constructing, call `init()` to handle orphaned sessions from
 * a previous server run (restore or summarize them).
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map() // sessionKey (userId:agentId) -> session
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map() // sessionKey -> timeout timer
  private db: Database
  private timeoutMs: number
  private memoryDir?: string
  private onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  private onSessionEnd?: (
    session: SessionInfo,
    summary: string | null,
    options?: { background?: boolean },
  ) => void
  private onTopicShift?: (session: SessionInfo, factInjection: string) => void
  /** Pending fact injection text to be included in the next response, keyed by sessionKey */
  private pendingFactInjection: Map<string, string> = new Map()
  /**
   * Tracks pending background summary jobs spawned by
   * `handleNewCommandAsync` so `dispose()` can drain them on shutdown
   * and tests can deterministically await completion via
   * `awaitBackgroundJobs()`.
   */
  private backgroundJobs: Set<Promise<void>> = new Set()
  /**
   * Sessions with fewer than this many messages are too short to be worth
   * a summary LLM round-trip (typical: ping/pong = 2 messages). For these
   * we still emit a divider so the user sees a visual session boundary,
   * but we use an em-dash placeholder instead of calling the summarizer
   * (which would just return "Empty session." anyway and waste a model call).
   */
  private static readonly MIN_MESSAGES_FOR_SUMMARY = 3
  private static readonly SHORT_SESSION_PLACEHOLDER = 'Empty session.'

  constructor(options: SessionManagerOptions) {
    this.db = options.db
    this.timeoutMs = (options.timeoutMinutes ?? 15) * 60 * 1000
    this.memoryDir = options.memoryDir
    this.onSummarize = options.onSummarize
    this.onSessionEnd = options.onSessionEnd
    this.onTopicShift = options.onTopicShift
  }

  /**
   * Compute the session map key. Uses a userId:agentId composite so the same
   * user can hold independent sessions with different persona bots.
   */
  private sessionKey(userId: string, agentId: string = 'main'): string {
    return `${userId}:${agentId}`
  }

  /**
   * Initialize the session manager. Must be called after construction.
   * Handles orphaned sessions from a previous server run:
   * - Sessions whose timeout has elapsed → summarize and close
   * - Sessions whose timeout has NOT elapsed → restore with remaining timer
   */
  async init(): Promise<void> {
    await this.handleOrphanedSessions()
  }

  /**
   * Handle sessions left open from a previous server run.
   */
  private async handleOrphanedSessions(): Promise<void> {
    // Only interactive sessions go through the inactivity-timeout / summarize
    // lifecycle. Background session types (task, heartbeat, consolidation,
    // loop_detection) are owned by their respective producers and must not be
    // auto-summarized or auto-closed by SessionManager on startup.
    const orphaned = this.db.prepare(
      `SELECT id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id
       FROM sessions WHERE ended_at IS NULL AND type = 'interactive'`
    ).all() as Array<{
      id: string
      user_id: number | null
      session_user: string | null
      source: string
      type: string
      started_at: string
      last_activity: string | null
      message_count: number
      summary_written: number
      agent_id: string | null
    }>

    if (orphaned.length === 0) return

    // Guard: a SessionManager without `onSummarize` is not configured to
    // manage the interactive-session lifecycle. If an orphan would hit the
    // summarize-and-close path and we proceeded without an onSummarize
    // handler, we would silently close it and lose the daily-file summary
    // — the exact failure mode that makes a mis-routed init() call
    // invisible (see runtime-composition.ts's background-only
    // SessionManager). Fail fast so misuse surfaces immediately.
    //
    // Only orphans whose timeout has already elapsed AND still carry
    // unsummarized messages are at risk. Orphans within the timeout window
    // are restored, and empty/already-summarized ones are closed
    // losslessly, so neither requires onSummarize.
    if (!this.onSummarize) {
      const now = Date.now()
      const needsSummary = orphaned.filter(r => {
        if (r.summary_written || r.message_count === 0) return false
        const lastActivityStr = r.last_activity ?? r.started_at
        const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
        return (now - lastActivity) >= this.timeoutMs
      })
      if (needsSummary.length > 0) {
        throw new Error(
          `[session] ${needsSummary.length} orphaned interactive session(s) need summarization `
          + `but SessionManager was constructed without an onSummarize handler. `
          + `This instance is not configured to manage the interactive-session lifecycle; `
          + `do not call init() on it.`,
        )
      }
    }

    console.log(`[session] Found ${orphaned.length} orphaned session(s) from previous run`)

    for (const row of orphaned) {
      // Determine last activity time (fall back to started_at for pre-migration sessions)
      const lastActivityStr = row.last_activity ?? row.started_at
      const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
      const elapsed = Date.now() - lastActivity

      // Prefer numeric user_id when present (stable canonical key), then
      // fall back to session_user for rows without user_id (e.g. legacy /
      // non-numeric identities). Final fallback keeps sessions distinct.
      const userId = row.user_id != null
        ? String(row.user_id)
        : (row.session_user ?? `orphan:${row.id}`)

      // No-time-reset guarantee: when timeouts are disabled (timeoutMs <= 0),
      // sessions never expire — always force-restore orphans rather than
      // summarizing+closing them, so a restart can't silently reset a user's
      // long-running conversation.
      if (this.timeoutMs > 0 && elapsed >= this.timeoutMs) {
        // Timeout already elapsed → summarize and close
        await this.summarizeAndCloseOrphanedSession(row, userId, lastActivity)
      } else {
        // Timeout not yet elapsed (or timeouts disabled) → restore session
        const remainingMs = this.timeoutMs > 0 ? this.timeoutMs - elapsed : 0
        this.restoreSession(row, userId, lastActivity, remainingMs)
      }
    }
  }

  /**
   * Parse a SQLite datetime string to a timestamp in ms.
   * SQLite stores as 'YYYY-MM-DD HH:MM:SS' in UTC without timezone marker.
   */
  private parseSqliteTimestamp(str: string): number {
    // Append 'Z' to treat as UTC if no timezone info present
    const normalized = str.includes('Z') || str.includes('+') ? str : str + 'Z'
    return new Date(normalized).getTime()
  }

  /**
   * Summarize an orphaned session that has already timed out, then close it.
   * Uses the lastActivity timestamp to write to the correct daily file.
   */
  private async summarizeAndCloseOrphanedSession(
    row: { id: string; started_at: string; message_count: number; summary_written: number; source: string; agent_id: string | null },
    userId: string,
    lastActivity: number,
  ): Promise<void> {
    let summary: string | null = null
    let summaryWritten = !!row.summary_written
    const startedAt = this.parseSqliteTimestamp(row.started_at)

    if (row.message_count > 0 && !summaryWritten && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(row.id)
        if (history) {
          summary = await this.onSummarize(row.id, userId, history)
          if (summary) {
            this.writeSummaryToDailyFile(summary, lastActivity)
            summaryWritten = true
            console.log(`[session] Summary written for orphaned session ${row.id} (at ${new Date(lastActivity).toISOString()})`)
          }
        }
      } catch (err) {
        console.error(`[session] Failed to summarize orphaned session ${row.id}:`, err)
      }
    }

    // Close session in DB
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), summary_written = ? WHERE id = ?`
    ).run(summaryWritten ? 1 : 0, row.id)

    // Log to tool_calls for activity log visibility
    logToolCall(this.db, {
      sessionId: row.id,
      toolName: 'session_timeout',
      input: JSON.stringify({
        reason: 'server_restart',
        messageCount: row.message_count,
      }),
      output: JSON.stringify({
        summaryWritten,
        summary,
        note: summary
          ? 'Orphaned session summarized on startup'
          : 'Session closed due to server restart',
      }),
      durationMs: 0,
      status: 'success',
    })

    // Only fire onSessionEnd for sessions that actually had messages.
    // Empty orphaned sessions (message_count = 0) produce no useful divider
    // and would spam the chat history with blank "New Session" entries.
    if (row.message_count > 0 && this.onSessionEnd) {
      this.onSessionEnd({
        id: row.id,
        userId,
        source: row.source,
        startedAt,
        lastActivity,
        messageCount: row.message_count,
        summaryWritten,
        restored: true,
        agentId: row.agent_id ?? 'main',
      }, summary)
    }
  }

  /**
   * Restore an orphaned session whose timeout has not yet elapsed.
   * Recreates the in-memory session and starts a timer with the remaining time.
   */
  private restoreSession(
    row: {
      id: string
      source: string
      started_at: string
      message_count: number
      summary_written: number
      agent_id: string | null
    },
    userId: string,
    lastActivity: number,
    remainingMs: number,
  ): void {
    const startedAt = this.parseSqliteTimestamp(row.started_at)
    const agentId = row.agent_id ?? 'main'
    const key = this.sessionKey(userId, agentId)

    const session: SessionInfo = {
      id: row.id,
      userId,
      source: row.source,
      startedAt,
      lastActivity,
      messageCount: row.message_count,
      summaryWritten: !!row.summary_written,
      restored: true,
      agentId,
    }

    this.sessions.set(key, session)

    // No-time-reset guarantee: when timeouts are disabled, restore without a
    // timer so the session never expires.
    if (this.timeoutMs <= 0) {
      console.log(`[session] Restored session ${row.id} for user ${userId} agent ${agentId} (no time-based expiry)`)
      return
    }

    const remainingMinutes = Math.round(remainingMs / 60000)
    console.log(`[session] Restored session ${row.id} for user ${userId} agent ${agentId} (${remainingMinutes}min remaining)`)

    // Start timer with remaining time
    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for restored session of user ${userId} agent ${agentId}`)
      this.endSession(key).catch(err => {
        console.error(`[session] Timeout error for user ${userId} agent ${agentId}:`, err)
      })
    }, remainingMs)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(key, timer)
  }

  /**
   * Write a summary to the daily memory file at the given timestamp.
   */
  private writeSummaryToDailyFile(summary: string, timestamp: number): void {
    const activityDate = new Date(timestamp)
    const hh = String(activityDate.getHours()).padStart(2, '0')
    const mm = String(activityDate.getMinutes()).padStart(2, '0')
    const formattedSummary = `\n## ${hh}:${mm}\n\n${summary}\n`
    appendToDailyFile(formattedSummary, activityDate, this.memoryDir)
  }

  /**
   * Build a conversation history string from chat_messages in the DB.
   *
   * Includes:
   * - All messages in the given session
   * - All messages in descendant sessions (children, grandchildren, ...)
   *   linked via `sessions.parent_session_id`
   *
   * This subsumes the previous time-window heuristic for pulling in task
   * result notifications and task injection responses: those messages now
   * live in child/task sessions (or — when merged — in this session
   * directly via `processTaskInjection`).
   */
  buildConversationHistory(sessionId: string): string | null {
    type ChatMessageRow = {
      session_id: string
      role: string
      content: string
      metadata: string | null
      timestamp: string
    }

    // Recursive CTE: include the session itself + all descendants via
    // parent_session_id (task, loop_detection, etc.). Use UNION (distinct)
    // so accidental cycles in parent_session_id cannot recurse forever.
    const messages = this.db.prepare(
      `WITH RECURSIVE session_tree(id) AS (
         SELECT ?
         UNION
         SELECT s.id FROM sessions s
         JOIN session_tree st ON s.parent_session_id = st.id
       )
       SELECT session_id, role, content, metadata, timestamp
       FROM chat_messages
       WHERE session_id IN (SELECT id FROM session_tree)
       ORDER BY timestamp ASC`
    ).all(sessionId) as ChatMessageRow[]

    if (messages.length === 0) return null

    const lines: string[] = []
    for (const msg of messages) {
      let metadata: Record<string, unknown> | null = null
      try {
        metadata = msg.metadata ? JSON.parse(msg.metadata) as Record<string, unknown> : null
      } catch {
        metadata = null
      }

      if (msg.role === 'user') {
        lines.push(`User: ${msg.content}`)
      } else if (msg.role === 'assistant') {
        if (metadata?.type === 'task_injection_response') {
          lines.push(`Assistant (task update): ${msg.content.slice(0, 2000)}`)
        } else {
          lines.push(`Assistant: ${msg.content.slice(0, 2000)}`)
        }
      } else if (msg.role === 'system' && metadata?.type === 'task_result') {
        const taskStatus = typeof metadata.taskResultStatus === 'string'
          ? metadata.taskResultStatus
          : typeof metadata.taskStatus === 'string'
            ? metadata.taskStatus
            : 'completed'
        const taskName = typeof metadata.taskName === 'string' ? metadata.taskName.trim() : ''
        const taskLabel = taskName ? `: ${taskName}` : ''
        lines.push(`Background task (${taskStatus}${taskLabel}): ${msg.content.slice(0, 2000)}`)
      }
    }

    const text = lines.join('\n').slice(0, 12000)
    return text || null
  }

  /**
   * Update the timeout duration (in minutes)
   */
  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000
  }

  /**
   * Get or create an interactive session for a user. Always creates sessions
   * with `type='interactive'` — background session types (task, heartbeat,
   * consolidation, loop_detection) must use `createSession()` instead so they
   * are not cached per-user and do not occupy the interactive-session
   * lifecycle slot.
   */
  getOrCreateSession(userId: string, source: string = 'web', agentId: string = 'main'): SessionInfo {
    return this.resolveSession(userId, source, undefined, agentId)
  }

  /**
   * Resolve the active interactive session for a (user, agent), running
   * topic-shift detection when `messageText` is supplied.
   *
   * - No active session → create a fresh one and (if messageText) inject facts.
   * - Active session + messageText + topic shift → end the current session
   *   (fire-and-forget summary) and start a fresh one with fact injection.
   * - Active session, no shift → continue it, refreshing topic tags + timer.
   *
   * ALWAYS creates a fresh session on shift (never reactivates an old one).
   */
  resolveSession(userId: string, source: string = 'web', messageText?: string, agentId: string = 'main'): SessionInfo {
    const key = this.sessionKey(userId, agentId)
    const existingSession = this.sessions.get(key)

    if (existingSession && messageText) {
      const history = getSessionMessages(this.db, existingSession.id)

      if (history.length > 0) {
        const newMsg: SessionMessage = {
          content: messageText,
          timestampMs: Date.now(),
          tokens: estimateTokens(messageText),
          hasAttachment: hasAttachmentMarker(messageText),
        }

        const result = detectTopicShift(history, newMsg)

        if (result.shiftDetected) {
          console.log(`[session] Topic shift detected for user ${userId} agent ${agentId} (score=${result.score}, signals=${JSON.stringify(result.signals)})`)

          // End current session (fire-and-forget the summary)
          this.endSession(key, 'topic_shift').catch(err => {
            console.error(`[session] Error ending session on topic shift:`, err)
          })

          // Create fresh session and inject facts
          const newSession = this.createFreshSession(userId, source, agentId)
          this.injectFacts(key, messageText, agentId)
          return newSession
        }
      }

      // No shift — update topic tags incrementally and continue
      const newTags = extractTopicTags([messageText])
      existingSession.topicTags = mergeTopicTags(existingSession.topicTags ?? [], newTags)
      existingSession.lastActivity = Date.now()
      this.resetTimer(key)
      return existingSession
    }

    if (existingSession) {
      // No message text — just continue the existing session
      existingSession.lastActivity = Date.now()
      this.resetTimer(key)
      return existingSession
    }

    // No active session — create a new one and inject facts
    const session = this.createFreshSession(userId, source, agentId)
    if (messageText) {
      this.injectFacts(key, messageText, agentId)
    }
    return session
  }

  /**
   * Create a fresh interactive session for a (user, agent) and cache it.
   */
  private createFreshSession(userId: string, source: string, agentId: string = 'main'): SessionInfo {
    const id = generateSessionId()
    const key = this.sessionKey(userId, agentId)

    const session: SessionInfo = {
      id,
      userId,
      source,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      summaryWritten: false,
      restored: false,
      agentId,
    }
    this.sessions.set(key, session)

    this.db.prepare(
      `INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, last_activity, session_user, message_count, summary_written, agent_id)
       VALUES (?, ?, ?, 'interactive', NULL, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0, ?)`
    ).run(session.id, null, source, session.startedAt, session.lastActivity, userId, agentId)

    logToolCall(this.db, {
      sessionId: session.id,
      toolName: 'session_start',
      input: JSON.stringify({ userId, source, agentId }),
      output: JSON.stringify({ sessionId: session.id }),
      durationMs: 0,
      status: 'success',
    })

    this.resetTimer(key)
    return session
  }

  /**
   * Query memories FTS5 for relevant facts based on message text and store
   * the injection for the next response (consumed via consumeFactInjection).
   */
  private injectFacts(key: string, messageText: string, agentId?: string): void {
    try {
      const keywords = extractTopicTags([messageText])
      if (keywords.length === 0) return

      const facts = queryMemoriesFts(this.db, keywords, 5, agentId)
      if (facts.length === 0) return

      const injection = buildFactInjection(facts)
      this.pendingFactInjection.set(key, injection)

      const session = this.sessions.get(key)
      if (session && this.onTopicShift) {
        this.onTopicShift(session, injection)
      }

      console.log(`[session] Injected ${facts.length} facts for key ${key} (keywords: ${keywords.join(', ')})`)
    } catch (err) {
      console.error('[session] Fact injection error:', err)
    }
  }

  /**
   * Consume and clear any pending fact injection for a (user, agent).
   */
  consumeFactInjection(userId: string, agentId: string = 'main'): string | null {
    const key = this.sessionKey(userId, agentId)
    const injection = this.pendingFactInjection.get(key)
    if (injection) {
      this.pendingFactInjection.delete(key)
      return injection
    }
    return null
  }

  /**
   * Create a non-interactive session (task, heartbeat, consolidation,
   * loop_detection). Unlike `getOrCreateSession`, this does NOT cache the
   * session per-user and does NOT start an inactivity timer — background
   * sessions are owned and closed by their producers.
   */
  createSession(options: CreateSessionOptions): SessionInfo {
    const id = generateSessionId()
    const now = Date.now()
    const session: SessionInfo = {
      id,
      userId: options.userId ?? 'system',
      source: options.source,
      startedAt: now,
      lastActivity: now,
      messageCount: 0,
      summaryWritten: false,
      restored: false,
      agentId: 'main',
    }

    this.db.prepare(
      `INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, last_activity, session_user, message_count, summary_written)
       VALUES (?, NULL, ?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0)`
    ).run(
      id,
      options.source,
      options.type,
      options.parentSessionId ?? null,
      now,
      now,
      options.userId ?? null,
    )

    return session
  }

  /**
   * Record a message in the active session
   */
  recordMessage(userId: string, agentId: string = 'main'): void {
    const key = this.sessionKey(userId, agentId)
    const session = this.sessions.get(key)
    if (session) {
      session.messageCount++
      session.lastActivity = Date.now()
      this.resetTimer(key)

      // Update SQLite (message count and last activity)
      this.db.prepare(
        `UPDATE sessions SET message_count = ?, last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(session.messageCount, session.lastActivity, session.id)
    }
  }

  /**
   * Get the active session for a (user, agent) (without creating one)
   */
  getSession(userId: string, agentId: string = 'main'): SessionInfo | undefined {
    return this.sessions.get(this.sessionKey(userId, agentId))
  }

  /**
   * Check if a (user, agent) has an active session
   */
  hasActiveSession(userId: string, agentId: string = 'main'): boolean {
    return this.sessions.has(this.sessionKey(userId, agentId))
  }

  /**
   * Handle /new command: immediately summarize and reset (blocking).
   *
   * The returned Promise resolves only AFTER the summary has been
   * generated and persisted. Prefer `handleNewCommandAsync()` for
   * interactive UIs where blocking on summary generation is
   * user-visible.
   */
  async handleNewCommand(userId: string, agentId: string = 'main'): Promise<string | null> {
    const key = this.sessionKey(userId, agentId)
    const session = this.sessions.get(key)
    if (!session) {
      return null
    }

    return this.endSession(key, 'manual')
  }

  /**
   * Non-blocking variant of `handleNewCommand`. Detaches the current
   * interactive session synchronously (clears the timer + removes it
   * from the active-session map + clears in-memory agent state via the
   * onSessionEnd callback in the next tick), creates a fresh session
   * for the user, and returns it immediately.
   *
   * Summary generation and persistence (daily log + DB UPDATE + tool
   * call log + onSessionEnd callback) run in the background. When the
   * summary is ready, `onSessionEnd` fires with `options.background = true`
   * so the listener can deliver the summary as a follow-up event without
   * duplicating the divider that was already rendered when the new
   * session was opened.
   */
  // Used by the websocket chat /new command handler for instant session switch.
  handleNewCommandAsync(userId: string, source: string = 'web', agentId: string = 'main'): SessionInfo {
    const key = this.sessionKey(userId, agentId)
    const oldSession = this.sessions.get(key)
    // Snapshot the OLD session's id as a primitive *before* we mint the new
    // one, so every downstream write (daily-log, chat_messages divider,
    // tool_calls row, onSessionEnd callback) is unambiguously bound to the
    // session the user just left — never to the freshly-created session
    // that replaces it. The previous code threaded the captured object
    // reference through, but it's easier to reason about (and impossible
    // to accidentally re-resolve via `this.sessions.get(userId)` at
    // callback time) when the id is also passed explicitly.
    const oldSessionId = oldSession?.id

    if (oldSession && oldSessionId) {
      this.clearTimer(key)
      this.sessions.delete(key)

      // Defer the finalize one microtask so that `onSessionEnd` (and any
      // resulting broadcast) NEVER fires on the synchronous stack of this
      // call. The short-session placeholder branch has no `await` before
      // `onSessionEnd`, so without this it would fire synchronously here —
      // before the caller (ws-chat) has had a chance to emit the immediate
      // `session_end`, causing the late `session_summary` to overtake it and
      // render a duplicate divider on the originating client.
      const job = Promise.resolve().then(() => this.finalizeDetachedSession(
        oldSession,
        oldSessionId,
        userId,
        'manual',
      )).catch((err) => {
        console.error(
          `[session] Background finalize failed for session ${oldSessionId}:`,
          err,
        )
      })
      this.backgroundJobs.add(job)
      job.finally(() => {
        this.backgroundJobs.delete(job)
      })
    }

    return this.getOrCreateSession(userId, source, agentId)
  }

  /**
   * Run the summary-and-persist tail of a session that has already been
   * detached from `this.sessions` (timer cleared, map entry removed).
   * Mirrors `endSession`'s tail but is callable without holding the
   * session in the active map.
   */
  private async finalizeDetachedSession(
    session: SessionInfo,
    oldSessionId: string,
    userId: string,
    reason: SessionEndReason,
  ): Promise<void> {
    // `oldSessionId` is the primitive id captured at trigger time in
    // `handleNewCommandAsync` (or wherever this method is called from).
    // We deliberately do NOT re-resolve the session via
    // `this.sessions.get(userId)` here — by the time the awaited summary
    // resolves, the user is already chatting in a new session under that
    // map key, and writing the divider / daily-log entry against the
    // current session would clobber the new session instead of the one
    // that actually ended.
    console.log(
      `[session] Finalizing detached session ${oldSessionId} for user ${userId} `
      + `(${session.messageCount} messages, background)`,
    )

    let summary: string | null = null

    if (
      session.messageCount > 0
      && session.messageCount < SessionManager.MIN_MESSAGES_FOR_SUMMARY
    ) {
      // Ping/pong session (typically 2 messages: one user turn + one
      // assistant reply). Calling the summarizer for this just produces
      // "Empty session." — wasting an LLM round-trip and cluttering the
      // daily activity log. Substitute an em-dash placeholder so the
      // divider still renders in place of the old session, but don't
      // write a daily-log entry.
      summary = SessionManager.SHORT_SESSION_PLACEHOLDER
      console.log(
        `[session] Skipping summary for short session ${oldSessionId} `
        + `(${session.messageCount} < ${SessionManager.MIN_MESSAGES_FOR_SUMMARY} messages); `
        + `using placeholder divider`,
      )
    } else if (session.messageCount > 0 && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(oldSessionId) ?? undefined
        summary = await this.onSummarize(oldSessionId, userId, history)
        if (summary) {
          this.writeSummaryToDailyFile(summary, session.lastActivity)
          session.summaryWritten = true
          console.log(
            `[session] Background summary written to daily log for session ${oldSessionId}`,
          )
        }
      } catch (err) {
        console.error('[session] Failed to generate background session summary:', err)
      }
    } else {
      console.log(
        `[session] Skipping background summary: messageCount=${session.messageCount}, `
        + `onSummarize=${!!this.onSummarize}`,
      )
    }

    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, oldSessionId)

    const durationMs = Date.now() - session.startedAt
    logToolCall(this.db, {
      sessionId: oldSessionId,
      toolName: reason === 'timeout' ? 'session_timeout' : 'session_end',
      input: JSON.stringify({
        userId,
        reason,
        messageCount: session.messageCount,
        durationMinutes: Math.round(durationMs / 60000),
        background: true,
      }),
      output: JSON.stringify({
        summaryWritten: session.summaryWritten,
        summary: summary ?? null,
      }),
      durationMs,
      status: 'success',
    })

    if (this.onSessionEnd) {
      // Defensive: ensure the session object handed to the callback
      // carries the captured old id, in case anything later in the
      // callback chain reads `session.id` instead of the explicit
      // sessionId argument. The captured object reference IS already
      // the old session, but pinning the id here makes the intent
      // impossible to misread.
      const endedSession: SessionInfo = session.id === oldSessionId
        ? session
        : { ...session, id: oldSessionId }
      this.onSessionEnd(endedSession, summary, { background: true })
    }
  }

  /**
   * Await all in-flight background summary jobs. Useful for tests that
   * need to deterministically observe the post-summary state after
   * calling `handleNewCommandAsync`.
   */
  async awaitBackgroundJobs(): Promise<void> {
    if (this.backgroundJobs.size === 0) return
    await Promise.allSettled(Array.from(this.backgroundJobs))
  }

  /**
   * End a session: summarize and dispose.
   * Always uses session.lastActivity as the timestamp for the daily file entry.
   */
  private async endSession(key: string, reason: SessionEndReason = 'timeout'): Promise<string | null> {
    const session = this.sessions.get(key)
    if (!session) {
      console.log(`[session] endSession called for key ${key} but no active session found`)
      return null
    }
    const userId = session.userId

    console.log(`[session] Ending session ${session.id} for user ${userId} agent ${session.agentId} (${session.messageCount} messages)`)

    // Clear the timeout timer
    this.clearTimer(key)

    let summary: string | null = null

    // Generate summary if there were messages and a summarizer is configured
    if (session.messageCount > 0 && this.onSummarize) {
      try {
        // Build conversation history from DB (single source of truth).
        // In-memory agent messages are unreliable (lost on provider change, restart, etc.)
        const history = this.buildConversationHistory(session.id) ?? undefined

        summary = await this.onSummarize(session.id, userId, history)
        if (summary) {
          this.writeSummaryToDailyFile(summary, session.lastActivity)
          session.summaryWritten = true
          console.log(`[session] Summary written to daily log for session ${session.id}`)
        }
      } catch (err) {
        console.error('[session] Failed to generate session summary:', err)
      }
    } else {
      console.log(`[session] Skipping summary: messageCount=${session.messageCount}, onSummarize=${!!this.onSummarize}`)
    }

    // Update SQLite with end time and summary flag
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)

    // Log session end to tool_calls for activity log visibility
    const durationMs = Date.now() - session.startedAt
    logToolCall(this.db, {
      sessionId: session.id,
      toolName: reason === 'timeout' ? 'session_timeout' : 'session_end',
      input: JSON.stringify({
        userId,
        reason,
        messageCount: session.messageCount,
        durationMinutes: Math.round(durationMs / 60000),
      }),
      output: JSON.stringify({
        summaryWritten: session.summaryWritten,
        summary: summary ?? null,
      }),
      durationMs,
      status: 'success',
    })

    // Notify listener
    if (this.onSessionEnd) {
      this.onSessionEnd(session, summary)
    }

    // Remove from active sessions
    this.sessions.delete(key)

    return summary
  }

  /**
   * End all active sessions.
   */
  async endAllSessions(reason: Exclude<SessionEndReason, 'timeout'> = 'manual'): Promise<void> {
    const keys = Array.from(this.sessions.keys())
    for (const key of keys) {
      await this.endSession(key, reason)
    }
  }

  /**
   * Reset the inactivity timer for a session (keyed by userId:agentId).
   */
  private resetTimer(key: string): void {
    this.clearTimer(key)

    if (this.timeoutMs <= 0) return

    const timeoutMinutes = Math.round(this.timeoutMs / 60000)
    console.log(`[session] Timer set for ${key}: ${timeoutMinutes}min (${this.timeoutMs}ms)`)

    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for ${key} — ending session`)
      this.endSession(key).catch(err => {
        console.error(`[session] Timeout error for ${key}:`, err)
      })
    }, this.timeoutMs)

    // Unref so it doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(key, timer)
  }

  /**
   * Clear the timeout timer for a session (keyed by userId:agentId).
   */
  private clearTimer(key: string): void {
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(key)
    }
  }

  /**
   * Dispose all sessions and timers (for shutdown). Drains any
   * fire-and-forget background summary jobs first so daily-log writes
   * and DB updates settle before we tear down.
   */
  async dispose(): Promise<void> {
    for (const [key] of this.timers) {
      this.clearTimer(key)
    }

    if (this.backgroundJobs.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundJobs))
    }

    // End all active sessions without summarizing
    for (const [, session] of this.sessions) {
      this.db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
      ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)
    }

    this.sessions.clear()
    this.timers.clear()
  }

  /**
   * Get session metadata from SQLite
   */
  getSessionMetadata(sessionId: string): {
    id: string
    started_at: string
    ended_at: string | null
    message_count: number
    summary_written: number
    source: string
    type: string
    parent_session_id: string | null
    last_activity: string | null
    session_user: string | null
    prompt_tokens: number
    completion_tokens: number
  } | undefined {
    return this.db.prepare(
      `SELECT id, started_at, ended_at, message_count, summary_written, source, type, parent_session_id, last_activity, session_user, prompt_tokens, completion_tokens
       FROM sessions WHERE id = ?`
    ).get(sessionId) as {
      id: string
      started_at: string
      ended_at: string | null
      message_count: number
      summary_written: number
      source: string
      type: string
      parent_session_id: string | null
      last_activity: string | null
      session_user: string | null
      prompt_tokens: number
      completion_tokens: number
    } | undefined
  }
}
