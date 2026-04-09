/**
 * session-store.ts — Pure functions for session persistence and topic-matching.
 * No class, no LLM, no embeddings — pure keyword extraction and Jaccard similarity.
 *
 * SalesMemory 2.0: Sliding-Window Topic-Shift Detection with Hysteresis
 */

import type { Database } from './database.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ArchivedSession {
  id: string
  userId: string
  source: string
  startedAt: string
  endedAt: string
  messageCount: number
  topicTags: string[]
  tokenCount: number
}

/**
 * A lightweight message record for sliding-window analysis.
 */
export interface SessionMessage {
  content: string
  /** Unix timestamp in milliseconds */
  timestampMs: number
  /** Approximate token count (characters / 4) */
  tokens: number
  /** True if the message contains an attachment marker */
  hasAttachment: boolean
}

/**
 * Result of the sliding-window topic-shift detection.
 */
export interface TopicShiftResult {
  /** Score: 0-4. Shift detected when score >= 2. */
  score: number
  /** True when a shift is detected (score >= 2) */
  shiftDetected: boolean
  /** Breakdown of which signals fired */
  signals: {
    timeGap: boolean       // Signal 1: >30 min gap
    jaccardShift: boolean  // Signal 2: Jaccard < 0.25 over sliding window
    explicit: boolean      // Signal 3: explicit /new trigger
  }
  /** Jaccard overlap computed between left/right windows (or null if insufficient data) */
  jaccardOverlap: number | null
  /** True when there is not enough data for detection (< 5 messages or < 200 tokens) */
  insufficient: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-word list (German + English, ~50 words)
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // English
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'from', 'they', 'will',
  'what', 'when', 'then', 'than', 'there', 'their', 'about', 'which', 'would',
  'could', 'should', 'were', 'been', 'being', 'some', 'into', 'also', 'just',
  'more', 'very', 'your', 'here', 'like', 'over', 'only', 'back', 'other',
  'after', 'such', 'where', 'these',
  // German
  'und', 'der', 'die', 'das', 'ist', 'ich', 'mit', 'ein', 'eine', 'nicht',
  'auch', 'sich', 'von', 'dem', 'des', 'auf', 'wie', 'aber', 'noch', 'bei',
  'oder', 'wenn', 'dann', 'durch', 'wird', 'kann', 'sind', 'alle', 'als',
  'nach', 'hier', 'dass', 'mehr', 'nur', 'schon', 'sein', 'hat', 'haben',
  'wurde', 'aus', 'zum', 'zur',
])

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate token count from text (rough approximation: chars / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─────────────────────────────────────────────────────────────────────────────
// Attachment detection
// ─────────────────────────────────────────────────────────────────────────────

const ATTACHMENT_MARKERS = ['[File:', '[Anhang:', 'attachment:']

/**
 * Returns true if a message contains an attachment marker.
 */
export function hasAttachmentMarker(text: string): boolean {
  const lower = text.toLowerCase()
  return ATTACHMENT_MARKERS.some(m => lower.includes(m.toLowerCase()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract topic fingerprint from an array of text strings.
 * Pure keyword extraction — no LLM, no embedding.
 *
 * Algorithm:
 *  1. Lowercase all text, combine into a single string
 *  2. Split on non-alpha characters
 *  3. Remove stop words and tokens <= 4 chars
 *  4. Count frequency
 *  5. Return top 8 by frequency
 */
export function extractTopicTags(texts: string[]): string[] {
  const combined = texts.join(' ').toLowerCase()

  // Split on any non-letter character (also handles umlauts via \p{L})
  const tokens = combined.split(/[^a-z\u00c0-\u024f]+/)

  const freq = new Map<string, number>()
  for (const token of tokens) {
    // Only keep tokens > 4 chars and not in stop-word list
    if (token.length > 4 && !STOP_WORDS.has(token)) {
      freq.set(token, (freq.get(token) ?? 0) + 1)
    }
  }

  // Sort by frequency descending, return top 8 keys
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word)
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two tag arrays.
 * Returns a value in [0.0, 1.0].
 */
export function topicOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  const setA = new Set(a)
  const setB = new Set(b)

  let intersectionSize = 0
  for (const tag of setA) {
    if (setB.has(tag)) intersectionSize++
  }

  const unionSize = setA.size + setB.size - intersectionSize
  return unionSize === 0 ? 0.0 : intersectionSize / unionSize
}

// ─────────────────────────────────────────────────────────────────────────────
// Sliding-Window Topic-Shift Detection (SalesMemory 2.0)
// ─────────────────────────────────────────────────────────────────────────────

const WINDOW_MIN_TOKENS = 200
const WINDOW_MAX_TOKENS = 1000
const WINDOW_SIZE = 3            // messages per window (left / right)
const TOTAL_MIN_MESSAGES = 5    // minimum messages before detection is active
const TOTAL_MIN_TOKENS = 200    // minimum total tokens before detection is active
const LARGE_MSG_THRESHOLD = 500 // messages > this → only first 200 tokens used
const LARGE_MSG_SLICE = 200     // chars used from large messages (≈50 tokens)
const SMALL_MSG_THRESHOLD = 50  // messages < this → don't count for token-minimum
const JACCARD_SHIFT_THRESHOLD = 0.25
const TIME_GAP_MS = 30 * 60 * 1000 // 30 minutes

/**
 * Build a sliding window from an array of messages.
 *
 * Rules:
 * - Takes the last `windowSize` messages from `msgs`
 * - Messages < 50 tokens: counted for message count but NOT for token-minimum
 * - Messages > 500 tokens: only first 200 tokens (≈ first 800 chars) used
 * - Total tokens in window capped at WINDOW_MAX_TOKENS (older messages trimmed first)
 * - Returns null if the window doesn't meet the minimum token threshold
 */
function buildWindow(msgs: SessionMessage[], windowSize: number): string[] | null {
  if (msgs.length === 0) return null

  const window = msgs.slice(-windowSize)
  const texts: string[] = []
  let tokenSum = 0

  for (const msg of window) {
    let text = msg.content
    let tokens = msg.tokens

    // Large message: only first portion
    if (tokens > LARGE_MSG_THRESHOLD) {
      text = msg.content.slice(0, LARGE_MSG_SLICE * 4) // ≈ 800 chars → 200 tokens
      tokens = LARGE_MSG_SLICE
    }

    // Small message: counts for message count but not for token sum
    if (tokens < SMALL_MSG_THRESHOLD) {
      texts.push(text)
      continue
    }

    // Check if adding this message would exceed the cap
    if (tokenSum + tokens > WINDOW_MAX_TOKENS) {
      // Trim: take only the remaining budget from this message
      const remainingTokens = WINDOW_MAX_TOKENS - tokenSum
      if (remainingTokens <= 0) break
      text = text.slice(0, remainingTokens * 4)
      tokens = remainingTokens
    }

    texts.push(text)
    tokenSum += tokens
  }

  // Window must meet minimum token threshold (excluding small messages)
  // Recompute token sum excluding small messages
  let qualifyingTokens = 0
  for (const msg of window) {
    const tokens = msg.tokens < LARGE_MSG_THRESHOLD ? msg.tokens : LARGE_MSG_SLICE
    if (tokens >= SMALL_MSG_THRESHOLD) {
      qualifyingTokens += Math.min(tokens, WINDOW_MAX_TOKENS - qualifyingTokens)
      if (qualifyingTokens >= WINDOW_MIN_TOKENS) break
    }
  }

  if (qualifyingTokens < WINDOW_MIN_TOKENS) return null

  return texts
}

/**
 * Sliding-Window Topic-Shift Detection.
 *
 * Takes the full message history and a new incoming message, and computes
 * whether a topic shift is occurring based on hysteresis signals:
 *
 * Signal 1 (+1): Time gap > 30 min between last stored message and new message
 * Signal 2 (+1): Jaccard overlap < 0.25 between LEFT and RIGHT sliding windows
 * Signal 3 (+2): Explicit trigger (pass explicitTrigger=true for /new command)
 *
 * Shift is detected when score >= 2.
 *
 * @param history       - Existing messages in the session (oldest first)
 * @param newMessage    - The incoming new message
 * @param explicitTrigger - True when the user explicitly requests a new session (/new)
 */
export function detectTopicShift(
  history: SessionMessage[],
  newMessage: SessionMessage,
  explicitTrigger = false,
): TopicShiftResult {
  const insufficient = history.length < TOTAL_MIN_MESSAGES ||
    getTotalQualifyingTokens(history) < TOTAL_MIN_TOKENS

  let score = 0
  const signals = { timeGap: false, jaccardShift: false, explicit: false }

  // Signal 3: Explicit trigger (always fires if provided)
  if (explicitTrigger) {
    score += 2
    signals.explicit = true
    return { score, shiftDetected: score >= 2, signals, jaccardOverlap: null, insufficient: false }
  }

  // If there's not enough history data, we cannot detect a shift
  if (insufficient) {
    return { score: 0, shiftDetected: false, signals, jaccardOverlap: null, insufficient: true }
  }

  // If the new message has an attachment, no shift trigger is possible
  if (newMessage.hasAttachment) {
    return { score: 0, shiftDetected: false, signals, jaccardOverlap: null, insufficient: false }
  }

  // Signal 1: Time gap > 30 min
  const lastMsg = history[history.length - 1]
  if (lastMsg && newMessage.timestampMs - lastMsg.timestampMs > TIME_GAP_MS) {
    score += 1
    signals.timeGap = true
  }

  // Signal 2: Jaccard shift via sliding windows
  // RIGHT window = older messages (positions -6 to -4 from end)
  // LEFT window  = newer messages (positions -3 to -1 from end, i.e., most recent)
  // We compare "what we were talking about" (right) vs "what we're talking about now" (left + new)
  const rightWindow = buildWindow(history.slice(0, -WINDOW_SIZE), WINDOW_SIZE)
  const leftWindowMsgs = [...history.slice(-WINDOW_SIZE), newMessage]
  const leftWindow = buildWindow(leftWindowMsgs, WINDOW_SIZE + 1)

  let jaccardOverlap: number | null = null

  if (rightWindow && leftWindow) {
    const rightTags = extractTopicTags(rightWindow)
    const leftTags = extractTopicTags(leftWindow)
    jaccardOverlap = topicOverlap(rightTags, leftTags)

    if (jaccardOverlap < JACCARD_SHIFT_THRESHOLD) {
      score += 1
      signals.jaccardShift = true
    }
  }

  return {
    score,
    shiftDetected: score >= 2,
    signals,
    jaccardOverlap,
    insufficient: false,
  }
}

/**
 * Compute the total qualifying token count from a message array.
 * Messages < 50 tokens do not count toward the minimum.
 */
function getTotalQualifyingTokens(msgs: SessionMessage[]): number {
  let total = 0
  for (const msg of msgs) {
    const tokens = Math.min(msg.tokens, LARGE_MSG_SLICE)
    if (tokens >= SMALL_MSG_THRESHOLD) {
      total += tokens
    }
  }
  return total
}

/**
 * Convert raw chat_messages DB rows to SessionMessage records.
 */
export function toSessionMessages(
  rows: Array<{ content: string; timestamp: string }>
): SessionMessage[] {
  return rows.map(row => {
    const content = row.content ?? ''
    const tokens = estimateTokens(content)
    const timestampMs = new Date(row.timestamp).getTime()
    return {
      content,
      timestampMs: isNaN(timestampMs) ? Date.now() : timestampMs,
      tokens,
      hasAttachment: hasAttachmentMarker(content),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the last N archived (ended) sessions for a user, most recent first.
 * Only returns sessions that have ended (ended_at IS NOT NULL).
 */
export function getRecentArchivedSessions(
  db: Database,
  userId: string,
  limit: number,
  maxAgeDays: number = 7,
): ArchivedSession[] {
  const rows = db.prepare(
    `SELECT
       id,
       user_id     AS rawUserId,
       source,
       started_at  AS startedAt,
       ended_at    AS endedAt,
       message_count AS messageCount,
       topic_tags  AS topicTagsJson,
       token_count AS tokenCount
     FROM sessions
     WHERE ended_at IS NOT NULL
       AND ended_at >= datetime('now', ? || ' days')
       AND (user_id = ? OR user_id IS NULL AND ? IS NULL)
     ORDER BY ended_at DESC
     LIMIT ?`,
  ).all(`-${maxAgeDays}`, userId, userId, limit) as Array<{
    id: string
    rawUserId: string | null
    source: string
    startedAt: string
    endedAt: string
    messageCount: number
    topicTagsJson: string | null
    tokenCount: number
  }>

  return rows.map(row => ({
    id: row.id,
    userId: row.rawUserId ?? userId,
    source: row.source,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    messageCount: row.messageCount,
    topicTags: row.topicTagsJson ? (JSON.parse(row.topicTagsJson) as string[]) : [],
    tokenCount: row.tokenCount,
  }))
}

/**
 * Reactivate a previously archived session by clearing its ended_at timestamp.
 */
export function reactivateSession(db: Database, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET ended_at = NULL WHERE id = ?`,
  ).run(sessionId)
}

/**
 * Persist topic tags for a session as a JSON array.
 */
export function saveTopicTags(db: Database, sessionId: string, tags: string[]): void {
  db.prepare(
    `UPDATE sessions SET topic_tags = ? WHERE id = ?`,
  ).run(JSON.stringify(tags), sessionId)
}

/**
 * Increment the token_count for a session by `delta`.
 */
export function updateTokenCount(db: Database, sessionId: string, delta: number): void {
  db.prepare(
    `UPDATE sessions SET token_count = token_count + ? WHERE id = ?`,
  ).run(delta, sessionId)
}

/**
 * Read the current token_count for a session.
 */
export function getTokenCount(db: Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT token_count FROM sessions WHERE id = ?`,
  ).get(sessionId) as { token_count: number } | undefined
  return row?.token_count ?? 0
}

/**
 * Load all chat_messages for a session and return their text content.
 * Used when computing topic tags for a session that is being archived.
 */
export function getSessionMessageTexts(db: Database, sessionId: string): string[] {
  const rows = db.prepare(
    `SELECT content FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
  ).all(sessionId) as Array<{ content: string }>

  return rows.map(r => r.content)
}

/**
 * Load all chat_messages for a session as SessionMessage records.
 * Used for sliding-window topic-shift detection.
 */
export function getSessionMessages(db: Database, sessionId: string): SessionMessage[] {
  const rows = db.prepare(
    `SELECT content, timestamp FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
  ).all(sessionId) as Array<{ content: string; timestamp: string }>

  return toSessionMessages(rows)
}
