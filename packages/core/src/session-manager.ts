import type { Database } from './database.js'
import { appendToDailyFile } from './memory.js'
import { logToolCall } from './token-logger.js'
import {
  extractTopicTags,
  topicOverlap,
  getRecentArchivedSessions,
  reactivateSession,
  saveTopicTags,
  updateTokenCount as dbUpdateTokenCount,
  getTokenCount,
  getSessionMessageTexts,
} from './session-store.js'

export interface SessionInfo {
  id: string
  userId: string
  source: string
  startedAt: number // timestamp ms
  lastActivity: number // timestamp ms
  messageCount: number
  summaryWritten: boolean
  /** Whether this session is dormant (timeout fired but not yet archived) */
  dormant?: boolean
  /** Cached topic tags for active session */
  topicTags?: string[]
}

export interface SessionManagerOptions {
  db: Database
  timeoutMinutes?: number
  memoryDir?: string
  /** Called to generate a summary of the session. Returns the summary text. */
  onSummarize?: (sessionId: string, userId: string) => Promise<string>
  /** Called when a session is disposed (after summary if applicable) */
  onSessionEnd?: (session: SessionInfo, summary: string | null) => void
  /** Topic-overlap threshold for reactivation (0.0–1.0, default: 0.25) */
  topicReactivationThreshold?: number
  /** Max token count before hard reset (default: 80000) */
  maxTokenCount?: number
  /** How many archived sessions to search for reactivation (default: 10) */
  reactivationSearchDepth?: number
}

/**
 * Manages active sessions per user with topic-aware reactivation.
 *
 * Session lifecycle:
 *  - New message arrives → resolveSession() checks topic overlap
 *  - Active session matches topic → continue
 *  - Active session diverges / over token limit → archive it
 *  - Archived session matches topic → reactivate
 *  - No match → create new session
 *
 * Timeout is now a "soft signal" — after 120 min inactivity the session is
 * marked dormant; on the next message, topic-check decides whether to
 * reactivate or start fresh.
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map() // userId -> session
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map() // userId -> timeout timer
  private db: Database
  private timeoutMs: number
  private memoryDir?: string
  private onSummarize?: (sessionId: string, userId: string) => Promise<string>
  private onSessionEnd?: (session: SessionInfo, summary: string | null) => void
  private _skipSessionSummary = false
  private topicReactivationThreshold: number
  private maxTokenCount: number
  private reactivationSearchDepth: number

  constructor(options: SessionManagerOptions) {
    this.db = options.db
    // Default timeout raised to 120 minutes (soft signal, not hard reset)
    this.timeoutMs = (options.timeoutMinutes ?? 120) * 60 * 1000
    this.memoryDir = options.memoryDir
    this.onSummarize = options.onSummarize
    this.onSessionEnd = options.onSessionEnd
    this.topicReactivationThreshold = options.topicReactivationThreshold ?? 0.25
    this.maxTokenCount = options.maxTokenCount ?? 80_000
    this.reactivationSearchDepth = options.reactivationSearchDepth ?? 10

    // Close any orphaned sessions from a previous server run
    this.closeOrphanedSessions()
  }

  /**
   * Close sessions that were left open from a previous server run
   * (no ended_at). These exist because the server crashed or restarted
   * without graceful shutdown.
   */
  private closeOrphanedSessions(): void {
    const orphaned = this.db.prepare(
      `SELECT id, message_count, summary_written, source FROM sessions WHERE ended_at IS NULL`
    ).all() as Array<{ id: string; message_count: number; summary_written: number; source: string }>

    if (orphaned.length === 0) return

    console.log(`[session] Closing ${orphaned.length} orphaned session(s) from previous run`)

    for (const session of orphaned) {
      this.db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), summary_written = ? WHERE id = ?`
      ).run(session.summary_written, session.id)

      // Log to tool_calls so it shows up in the activity log
      logToolCall(this.db, {
        sessionId: session.id,
        toolName: 'session_timeout',
        input: JSON.stringify({
          reason: 'server_restart',
          messageCount: session.message_count,
        }),
        output: JSON.stringify({
          summaryWritten: false,
          summary: null,
          note: 'Session closed due to server restart',
        }),
        durationMs: 0,
        status: 'success',
      })
    }
  }

  /**
   * Update the timeout duration (in minutes)
   */
  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000
  }

  /**
   * When true, session summaries are skipped (e.g. because AgentHeartbeat handles memory).
   */
  setSkipSessionSummary(skip: boolean): void {
    this._skipSessionSummary = skip
  }

  /**
   * Whether session summaries are currently being skipped.
   */
  get skipSessionSummary(): boolean {
    return this._skipSessionSummary
  }

  /**
   * Resolve or create a session for a user using topic-aware logic.
   *
   * Steps:
   *  1. Active session present?
   *     a. Token limit exceeded → archive (hard reset)
   *     b. Session is dormant → compute topic overlap
   *        - overlap > threshold → un-dormant and continue
   *        - overlap too low → archive
   *     c. Session is active (not dormant) → continue as-is
   *  2. No active session:
   *     a. Search archived sessions for topic match
   *     b. Match → reactivate
   *     c. No match → create new session
   *
   * Falls back to `getOrCreateSession` behaviour when no message text is available.
   */
  resolveSession(userId: string, source: string = 'web', messageText?: string): SessionInfo {
    let session = this.sessions.get(userId)

    if (session) {
      // ── Hard reset: token count exceeded ──────────────────────────────────
      const tokenCount = getTokenCount(this.db, session.id)
      if (tokenCount > this.maxTokenCount) {
        console.log(`[session] Token limit exceeded for ${userId} (${tokenCount} > ${this.maxTokenCount}) — archiving`)
        void this.archiveSession(userId)
        session = undefined
      } else if (session.dormant) {
        // ── Soft timeout fired: topic-check decides fate ───────────────────
        if (messageText) {
          const newTags = extractTopicTags([messageText])
          const existingTags = session.topicTags ?? []
          const overlap = topicOverlap(existingTags, newTags)

          console.log(`[session] Dormant session topic-check for ${userId}: overlap=${overlap.toFixed(3)} tags=${JSON.stringify(existingTags)} vs ${JSON.stringify(newTags)}`)

          if (overlap >= this.topicReactivationThreshold) {
            // Same topic — resume dormant session
            session.dormant = false
            session.lastActivity = Date.now()
            this.resetTimer(userId)
            return session
          } else {
            // Different topic — archive dormant session
            console.log(`[session] Topic mismatch for dormant session (overlap=${overlap.toFixed(3)}) — archiving`)
            void this.archiveSession(userId)
            session = undefined
          }
        } else {
          // No text to check — resume dormant session as-is
          session.dormant = false
          session.lastActivity = Date.now()
          this.resetTimer(userId)
          return session
        }
      } else {
        // Active session (not dormant) — update topic tags incrementally and continue
        if (messageText) {
          const newTags = extractTopicTags([messageText])
          const merged = mergeTopicTags(session.topicTags ?? [], newTags)
          session.topicTags = merged
        }
        session.lastActivity = Date.now()
        this.resetTimer(userId)
        return session
      }
    }

    // ── No active session — look for a matching archived session ──────────
    if (messageText) {
      const newTags = extractTopicTags([messageText])
      if (newTags.length > 0) {
        const archived = getRecentArchivedSessions(this.db, userId, this.reactivationSearchDepth)
        let bestMatch: { session: typeof archived[0]; overlap: number } | null = null

        for (const archivedSession of archived) {
          if (archivedSession.topicTags.length === 0) continue
          const overlap = topicOverlap(archivedSession.topicTags, newTags)
          if (overlap >= this.topicReactivationThreshold) {
            if (!bestMatch || overlap > bestMatch.overlap) {
              bestMatch = { session: archivedSession, overlap }
            }
          }
        }

        if (bestMatch) {
          return this.reactivateArchivedSession(bestMatch.session, bestMatch.overlap, userId, source)
        }
      }
    }

    // ── Create a brand-new session ─────────────────────────────────────────
    return this.createSession(userId, source, messageText)
  }

  /**
   * Get or create a session for a user. Resets the inactivity timer.
   * This is the original method, kept for backward compatibility.
   * Delegates to resolveSession() without message text (no topic-check).
   */
  getOrCreateSession(userId: string, source: string = 'web'): SessionInfo {
    return this.resolveSession(userId, source)
  }

  /**
   * Create a brand-new session and persist it to DB.
   */
  private createSession(userId: string, source: string, messageText?: string): SessionInfo {
    const id = `session-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const topicTags = messageText ? extractTopicTags([messageText]) : []

    const session: SessionInfo = {
      id,
      userId,
      source,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      summaryWritten: false,
      dormant: false,
      topicTags,
    }
    this.sessions.set(userId, session)

    // Insert into SQLite
    this.db.prepare(
      `INSERT INTO sessions (id, user_id, source, started_at, message_count, summary_written, topic_tags, token_count)
       VALUES (?, ?, ?, datetime(? / 1000, 'unixepoch'), 0, 0, ?, 0)`
    ).run(session.id, null, source, session.startedAt, topicTags.length > 0 ? JSON.stringify(topicTags) : null)

    // Log session start to tool_calls for activity log visibility
    logToolCall(this.db, {
      sessionId: session.id,
      toolName: 'session_start',
      input: JSON.stringify({ userId, source }),
      output: JSON.stringify({ sessionId: session.id }),
      durationMs: 0,
      status: 'success',
    })

    this.resetTimer(userId)
    return session
  }

  /**
   * Reactivate an archived session: restore it to active map.
   */
  private reactivateArchivedSession(
    archived: { id: string; userId: string; source: string; startedAt: string; messageCount: number; topicTags: string[]; tokenCount: number },
    overlap: number,
    userId: string,
    source: string,
  ): SessionInfo {
    // Clear ended_at in DB
    reactivateSession(this.db, archived.id)

    const session: SessionInfo = {
      id: archived.id,
      userId,
      source: archived.source ?? source,
      startedAt: new Date(archived.startedAt).getTime(),
      lastActivity: Date.now(),
      messageCount: archived.messageCount,
      summaryWritten: false,
      dormant: false,
      topicTags: archived.topicTags,
    }
    this.sessions.set(userId, session)

    // Log reactivation
    console.log(`[session] Reactivating session ${archived.id} for user ${userId} (overlap=${overlap.toFixed(3)}, tags=${JSON.stringify(archived.topicTags)})`)

    logToolCall(this.db, {
      sessionId: archived.id,
      toolName: 'session_reactivated',
      input: JSON.stringify({
        userId,
        matchedSessionId: archived.id,
        overlap: Math.round(overlap * 1000) / 1000,
      }),
      output: JSON.stringify({
        reactivated: true,
        topicTags: archived.topicTags,
      }),
      durationMs: 0,
      status: 'success',
    })

    this.resetTimer(userId)
    return session
  }

  /**
   * Archive (end) a session: save topic tags, write ended_at, remove from map.
   * Does NOT generate a summary (use endSession for that).
   */
  private async archiveSession(userId: string): Promise<void> {
    const session = this.sessions.get(userId)
    if (!session) return

    this.clearTimer(userId)

    // Compute and persist topic tags from chat messages
    const texts = getSessionMessageTexts(this.db, session.id)
    if (texts.length > 0) {
      const tags = extractTopicTags(texts)
      session.topicTags = tags
      saveTopicTags(this.db, session.id, tags)
    }

    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)

    this.sessions.delete(userId)
  }

  /**
   * Record a message in the active session
   */
  recordMessage(userId: string): void {
    const session = this.sessions.get(userId)
    if (session) {
      session.messageCount++
      session.lastActivity = Date.now()
      this.resetTimer(userId)

      // Update SQLite
      this.db.prepare(
        `UPDATE sessions SET message_count = ? WHERE id = ?`
      ).run(session.messageCount, session.id)
    }
  }

  /**
   * Update the token count for the active session of a user.
   * Called after each LLM response with the total tokens used (input + output).
   */
  updateTokenCount(userId: string, delta: number): void {
    const session = this.sessions.get(userId)
    if (session) {
      dbUpdateTokenCount(this.db, session.id, delta)
    }
  }

  /**
   * Get the active session for a user (without creating one)
   */
  getSession(userId: string): SessionInfo | undefined {
    return this.sessions.get(userId)
  }

  /**
   * Check if a user has an active session
   */
  hasActiveSession(userId: string): boolean {
    return this.sessions.has(userId)
  }

  /**
   * Handle /new command: immediately summarize and reset
   */
  async handleNewCommand(userId: string): Promise<string | null> {
    const session = this.sessions.get(userId)
    if (!session) {
      return null
    }

    return this.endSession(userId, 'manual')
  }

  /**
   * End a session: summarize and dispose
   */
  private async endSession(userId: string, reason: 'timeout' | 'manual' | 'dormant' = 'timeout'): Promise<string | null> {
    const session = this.sessions.get(userId)
    if (!session) {
      console.log(`[session] endSession called for user ${userId} but no active session found`)
      return null
    }

    console.log(`[session] Ending session ${session.id} for user ${userId} (${session.messageCount} messages)`)

    // Clear the timeout timer
    this.clearTimer(userId)

    let summary: string | null = null

    // Generate summary if there were messages, a summarizer is configured,
    // and session summaries are not skipped (e.g. because Agent Heartbeat handles memory)
    if (session.messageCount > 0 && this.onSummarize && !this._skipSessionSummary) {
      try {
        summary = await this.onSummarize(session.id, userId)
        if (summary) {
          // Append summary to today's daily file
          const timestamp = new Date().toISOString().split('T')[1].split('.')[0]
          const formattedSummary = `\n## Session Summary (${timestamp})\n\n${summary}\n`
          appendToDailyFile(formattedSummary, undefined, this.memoryDir)
          session.summaryWritten = true
          console.log(`[session] Summary written to daily log for session ${session.id}`)
        }
      } catch (err) {
        console.error('[session] Failed to generate session summary:', err)
      }
    } else {
      console.log(`[session] Skipping summary: messageCount=${session.messageCount}, onSummarize=${!!this.onSummarize}`)
    }

    // Compute and persist topic tags from chat messages before archiving
    const texts = getSessionMessageTexts(this.db, session.id)
    if (texts.length > 0) {
      const tags = extractTopicTags(texts)
      session.topicTags = tags
      saveTopicTags(this.db, session.id, tags)
    }

    // Update SQLite with end time and summary flag
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)

    // Log session end to tool_calls for activity log visibility
    const durationMs = Date.now() - session.startedAt
    logToolCall(this.db, {
      sessionId: session.id,
      toolName: reason === 'timeout' || reason === 'dormant' ? 'session_timeout' : 'session_end',
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
    this.sessions.delete(userId)

    return summary
  }

  /**
   * Mark a session as dormant (timeout fired — soft signal).
   * The session stays in the map but is flagged as dormant.
   * Next message will perform a topic-check before deciding to archive or resume.
   */
  private markDormant(userId: string): void {
    const session = this.sessions.get(userId)
    if (!session) return

    console.log(`[session] Session ${session.id} for user ${userId} marked dormant (soft timeout)`)
    session.dormant = true

    // Compute and persist current topic tags so they're available for reactivation
    const texts = getSessionMessageTexts(this.db, session.id)
    if (texts.length > 0) {
      const tags = extractTopicTags(texts)
      session.topicTags = tags
      saveTopicTags(this.db, session.id, tags)
    }

    // Persist dormant state via ended_at = NULL (keep alive), just update message_count
    this.db.prepare(
      `UPDATE sessions SET message_count = ? WHERE id = ?`
    ).run(session.messageCount, session.id)

    // Don't clear the session from the map — it stays dormant
    // Don't reset the timer — let it rest until next message
  }

  /**
   * Reset the inactivity timer for a user.
   * After timeout, the session is marked dormant (soft signal) — NOT ended.
   */
  private resetTimer(userId: string): void {
    this.clearTimer(userId)

    if (this.timeoutMs <= 0) return

    const timeoutMinutes = Math.round(this.timeoutMs / 60000)
    console.log(`[session] Timer set for user ${userId}: ${timeoutMinutes}min (${this.timeoutMs}ms)`)

    const timer = setTimeout(() => {
      console.log(`[session] Soft timeout fired for user ${userId} — marking session dormant`)
      this.markDormant(userId)
    }, this.timeoutMs)

    // Unref so it doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(userId, timer)
  }

  /**
   * Clear the timeout timer for a user
   */
  private clearTimer(userId: string): void {
    const existing = this.timers.get(userId)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(userId)
    }
  }

  /**
   * Dispose all sessions and timers (for shutdown)
   */
  async dispose(): Promise<void> {
    for (const [userId] of this.timers) {
      this.clearTimer(userId)
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
    topic_tags: string | null
    token_count: number
  } | undefined {
    return this.db.prepare(
      `SELECT id, started_at, ended_at, message_count, summary_written, source, topic_tags, token_count FROM sessions WHERE id = ?`
    ).get(sessionId) as {
      id: string
      started_at: string
      ended_at: string | null
      message_count: number
      summary_written: number
      source: string
      topic_tags: string | null
      token_count: number
    } | undefined
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge two tag arrays, keeping top 8 unique tags (existing tags take priority).
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
