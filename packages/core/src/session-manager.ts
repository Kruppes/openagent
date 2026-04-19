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
  /** Cached topic tags for the current session */
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
  /** Called when a session is disposed (after summary if applicable) */
  onSessionEnd?: (session: SessionInfo, summary: string | null) => void
  /** Called when a topic shift is detected, with the injected facts context string */
  onTopicShift?: (session: SessionInfo, factInjection: string) => void
}

export type SessionEndReason = 'timeout' | 'manual' | 'provider_change' | 'topic_shift'

/**
 * Manages active sessions per user with timeout and auto-summarization.
 *
 * Enhanced with topic-shift detection (sliding window + Jaccard + hysteresis).
 * On topic shift: ALWAYS start a fresh session (no reactivation of old sessions).
 * On new session or topic shift: query memories FTS5 for relevant facts and inject.
 *
 * Session map key: `${userId}:${agentId}` — allows the same user to chat with
 * multiple persona bots simultaneously without session collisions.
 *
 * After constructing, call `init()` to handle orphaned sessions from
 * a previous server run (restore or summarize them).
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map() // sessionKey -> session
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map() // sessionKey -> timeout timer
  private db: Database
  private timeoutMs: number
  private memoryDir?: string
  private onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  private onSessionEnd?: (session: SessionInfo, summary: string | null) => void
  private onTopicShift?: (session: SessionInfo, factInjection: string) => void

  /** Pending fact injection text to be included in the next response */
  private pendingFactInjection: Map<string, string> = new Map() // sessionKey -> injection text

  constructor(options: SessionManagerOptions) {
    this.db = options.db
    this.timeoutMs = (options.timeoutMinutes ?? 15) * 60 * 1000
    this.memoryDir = options.memoryDir
    this.onSummarize = options.onSummarize
    this.onSessionEnd = options.onSessionEnd
    this.onTopicShift = options.onTopicShift
  }

  /**
   * Compute the session map key. Uses userId:agentId composite key so the same
   * user can have independent sessions with different persona bots.
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
    const orphaned = this.db.prepare(
      `SELECT id, session_user, source, started_at, last_activity, message_count, summary_written, agent_id
       FROM sessions WHERE ended_at IS NULL`
    ).all() as Array<{
      id: string
      session_user: string | null
      source: string
      started_at: string
      last_activity: string | null
      message_count: number
      summary_written: number
      agent_id?: string
    }>

    if (orphaned.length === 0) return

    console.log(`[session] Found ${orphaned.length} orphaned session(s) from previous run`)

    for (const row of orphaned) {
      const lastActivityStr = row.last_activity ?? row.started_at
      const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
      const elapsed = Date.now() - lastActivity
      const userId = row.session_user ?? this.parseUserIdFromSessionId(row.id)

      if (elapsed >= this.timeoutMs) {
        await this.summarizeAndCloseOrphanedSession(row, userId, lastActivity)
      } else {
        this.restoreSession(row, userId, lastActivity, this.timeoutMs - elapsed)
      }
    }
  }

  private parseSqliteTimestamp(str: string): number {
    const normalized = str.includes('Z') || str.includes('+') ? str : str + 'Z'
    return new Date(normalized).getTime()
  }

  private parseUserIdFromSessionId(sessionId: string): string {
    const match = sessionId.match(/^session-(.+?)-\d{13,}-/)
    return match?.[1] ?? 'unknown'
  }

  private async summarizeAndCloseOrphanedSession(
    row: { id: string; started_at: string; message_count: number; summary_written: number; source: string; agent_id?: string },
    userId: string,
    lastActivity: number,
  ): Promise<void> {
    let summary: string | null = null
    let summaryWritten = !!row.summary_written

    if (row.message_count > 0 && !summaryWritten && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(row.id, {
          userId,
          startedAt: this.parseSqliteTimestamp(row.started_at),
          endAt: lastActivity,
        })
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

    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), summary_written = ? WHERE id = ?`
    ).run(summaryWritten ? 1 : 0, row.id)

    logToolCall(this.db, {
      sessionId: row.id,
      toolName: 'session_timeout',
      input: JSON.stringify({ reason: 'server_restart', messageCount: row.message_count }),
      output: JSON.stringify({
        summaryWritten, summary,
        note: summary ? 'Orphaned session summarized on startup' : 'Session closed due to server restart',
      }),
      durationMs: 0,
      status: 'success',
    })

    if (this.onSessionEnd) {
      this.onSessionEnd({
        id: row.id,
        userId,
        source: row.source,
        startedAt: this.parseSqliteTimestamp(row.started_at),
        lastActivity,
        messageCount: row.message_count,
        summaryWritten,
        restored: true,
        agentId: row.agent_id ?? 'main',
      }, summary)
    }
  }

  private restoreSession(
    row: { id: string; source: string; started_at: string; message_count: number; summary_written: number; agent_id?: string },
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

    const remainingMinutes = Math.round(remainingMs / 60000)
    console.log(`[session] Restored session ${row.id} for user ${userId} agent ${agentId} (${remainingMinutes}min remaining)`)

    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for restored session key ${key}`)
      this.endSessionByKey(key).catch(err => {
        console.error(`[session] Timeout error for key ${key}:`, err)
      })
    }, remainingMs)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(key, timer)
  }

  private writeSummaryToDailyFile(summary: string, timestamp: number): void {
    const activityDate = new Date(timestamp)
    const hh = String(activityDate.getHours()).padStart(2, '0')
    const mm = String(activityDate.getMinutes()).padStart(2, '0')
    const formattedSummary = `\n## ${hh}:${mm}\n\n${summary}\n`
    appendToDailyFile(formattedSummary, activityDate, this.memoryDir)
  }

  buildConversationHistory(
    sessionId: string,
    options?: { userId?: string; startedAt?: number; endAt?: number },
  ): string | null {
    type ChatMessageRow = {
      session_id: string
      role: string
      content: string
      metadata: string | null
      timestamp: string
    }

    const mainMessages = this.db.prepare(
      `SELECT session_id, role, content, metadata, timestamp
       FROM chat_messages
       WHERE session_id = ?
       ORDER BY timestamp ASC`
    ).all(sessionId) as ChatMessageRow[]

    const extraMessages: ChatMessageRow[] = []
    const numericUserId = options?.userId ? Number.parseInt(options.userId, 10) : Number.NaN

    if (Number.isFinite(numericUserId) && options?.startedAt !== undefined && options?.endAt !== undefined) {
      const candidates = this.db.prepare(
        `SELECT session_id, role, content, metadata, timestamp
         FROM chat_messages
         WHERE user_id = ?
           AND session_id != ?
           AND timestamp >= datetime(? / 1000, 'unixepoch')
           AND timestamp <= datetime(? / 1000, 'unixepoch')
         ORDER BY timestamp ASC`
      ).all(numericUserId, sessionId, options.startedAt, options.endAt) as ChatMessageRow[]

      for (const msg of candidates) {
        let metadata: Record<string, unknown> | null = null
        try {
          metadata = msg.metadata ? JSON.parse(msg.metadata) as Record<string, unknown> : null
        } catch { metadata = null }

        if (metadata?.type === 'task_result' || metadata?.type === 'task_injection_response') {
          extraMessages.push(msg)
        }
      }
    }

    const messages = [...mainMessages, ...extraMessages]
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    if (messages.length === 0) return null

    const lines: string[] = []
    for (const msg of messages) {
      let metadata: Record<string, unknown> | null = null
      try {
        metadata = msg.metadata ? JSON.parse(msg.metadata) as Record<string, unknown> : null
      } catch { metadata = null }

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
          : typeof metadata.taskStatus === 'string' ? metadata.taskStatus : 'completed'
        const taskName = typeof metadata.taskName === 'string' ? metadata.taskName.trim() : ''
        const taskLabel = taskName ? `: ${taskName}` : ''
        lines.push(`Background task (${taskStatus}${taskLabel}): ${msg.content.slice(0, 2000)}`)
      }
    }

    const text = lines.join('\n').slice(0, 12000)
    return text || null
  }

  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000
  }

  /**
   * Resolve a session for a user with topic-shift detection.
   *
   * If the user has an active session and a topic shift is detected,
   * the current session is ended (with summary) and a fresh session is created.
   * On new session or topic shift, relevant facts are queried from memories FTS5
   * and stored for injection into the next response.
   *
   * ALWAYS creates a fresh session on shift (no reactivation of old sessions).
   */
  resolveSession(userId: string, source: string = 'web', messageText?: string, agentId: string = 'main'): SessionInfo {
    const key = this.sessionKey(userId, agentId)
    const existingSession = this.sessions.get(key)

    if (existingSession && messageText) {
      // Run topic-shift detection using sliding window
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
          this.endSessionByKey(key, 'topic_shift').catch(err => {
            console.error(`[session] Error ending session on topic shift:`, err)
          })

          // Create fresh session and inject facts
          const newSession = this.createFreshSession(userId, source, agentId)
          this.injectFacts(key, messageText, agentId)
          return newSession
        }
      }

      // No shift — update topic tags incrementally and continue
      if (messageText) {
        const newTags = extractTopicTags([messageText])
        existingSession.topicTags = mergeTopicTags(existingSession.topicTags ?? [], newTags)
      }

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
   * Create a fresh session (internal helper).
   */
  private createFreshSession(userId: string, source: string, agentId: string = 'main'): SessionInfo {
    const id = `session-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
      `INSERT INTO sessions (id, user_id, source, started_at, last_activity, session_user, message_count, summary_written, agent_id)
       VALUES (?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0, ?)`
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
   * the injection for the next response.
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
   * Consume and return any pending fact injection for a user+agent combination.
   * Returns the injection text and clears it, or null if none pending.
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
   * Get or create a session for a user. Resets the inactivity timer.
   * This is the backward-compatible method that delegates to resolveSession
   * without message text (no topic-check).
   */
  getOrCreateSession(userId: string, source: string = 'web', agentId: string = 'main'): SessionInfo {
    return this.resolveSession(userId, source, undefined, agentId)
  }

  recordMessage(userId: string, agentId: string = 'main'): void {
    const key = this.sessionKey(userId, agentId)
    const session = this.sessions.get(key)
    if (session) {
      session.messageCount++
      session.lastActivity = Date.now()
      this.resetTimer(key)

      this.db.prepare(
        `UPDATE sessions SET message_count = ?, last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(session.messageCount, session.lastActivity, session.id)
    }
  }

  getSession(userId: string, agentId: string = 'main'): SessionInfo | undefined {
    const key = this.sessionKey(userId, agentId)
    return this.sessions.get(key)
  }

  hasActiveSession(userId: string, agentId: string = 'main'): boolean {
    const key = this.sessionKey(userId, agentId)
    return this.sessions.has(key)
  }

  async handleNewCommand(userId: string, agentId: string = 'main'): Promise<string | null> {
    const key = this.sessionKey(userId, agentId)
    const session = this.sessions.get(key)
    if (!session) return null
    return this.endSessionByKey(key, 'manual')
  }

  private async endSessionByKey(key: string, reason: SessionEndReason = 'timeout'): Promise<string | null> {
    const session = this.sessions.get(key)
    if (!session) {
      console.log(`[session] endSession called for key ${key} but no active session found`)
      return null
    }

    const userId = session.userId
    console.log(`[session] Ending session ${session.id} for user ${userId} agent ${session.agentId} (${session.messageCount} messages, reason: ${reason})`)

    this.clearTimer(key)

    let summary: string | null = null

    if (session.messageCount > 0 && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(session.id, {
          userId,
          startedAt: session.startedAt,
          endAt: Date.now(),
        }) ?? undefined

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

    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)

    const durationMs = Date.now() - session.startedAt
    logToolCall(this.db, {
      sessionId: session.id,
      toolName: reason === 'timeout' ? 'session_timeout' : 'session_end',
      input: JSON.stringify({
        userId, reason,
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

    if (this.onSessionEnd) {
      this.onSessionEnd(session, summary)
    }

    this.sessions.delete(key)

    return summary
  }

  async endAllSessions(reason: Exclude<SessionEndReason, 'timeout'> = 'manual'): Promise<void> {
    const keys = Array.from(this.sessions.keys())
    for (const key of keys) {
      await this.endSessionByKey(key, reason)
    }
  }

  private resetTimer(key: string): void {
    this.clearTimer(key)

    if (this.timeoutMs <= 0) return

    const timeoutMinutes = Math.round(this.timeoutMs / 60000)
    console.log(`[session] Timer set for key ${key}: ${timeoutMinutes}min (${this.timeoutMs}ms)`)

    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for key ${key} — ending session`)
      this.endSessionByKey(key).catch(err => {
        console.error(`[session] Timeout error for key ${key}:`, err)
      })
    }, this.timeoutMs)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(key, timer)
  }

  private clearTimer(key: string): void {
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(key)
    }
  }

  async dispose(): Promise<void> {
    for (const [key] of this.timers) {
      this.clearTimer(key)
    }

    for (const [, session] of this.sessions) {
      this.db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
      ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)
    }

    this.sessions.clear()
    this.timers.clear()
    this.pendingFactInjection.clear()
  }

  getSessionMetadata(sessionId: string): {
    id: string
    started_at: string
    ended_at: string | null
    message_count: number
    summary_written: number
    source: string
    last_activity: string | null
    session_user: string | null
    prompt_tokens: number
    completion_tokens: number
  } | undefined {
    return this.db.prepare(
      `SELECT id, started_at, ended_at, message_count, summary_written, source, last_activity, session_user, prompt_tokens, completion_tokens
       FROM sessions WHERE id = ?`
    ).get(sessionId) as {
      id: string
      started_at: string
      ended_at: string | null
      message_count: number
      summary_written: number
      source: string
      last_activity: string | null
      session_user: string | null
      prompt_tokens: number
      completion_tokens: number
    } | undefined
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function mergeTopicTags(existing: string[], incoming: string[]): string[] {
  const merged = [...existing]
  for (const tag of incoming) {
    if (!merged.includes(tag)) {
      merged.push(tag)
    }
  }
  return merged.slice(0, 8)
}
