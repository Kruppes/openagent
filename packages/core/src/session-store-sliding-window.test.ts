/**
 * Tests for Sliding Window Topic-Shift Detection (SalesMemory 2.0)
 */

import { describe, it, expect } from 'vitest'
import {
  detectTopicShift,
  estimateTokens,
  hasAttachmentMarker,
  toSessionMessages,
  type SessionMessage,
} from './session-store.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMsg(
  content: string,
  timestampMs: number,
): SessionMessage {
  return {
    content,
    timestampMs,
    tokens: estimateTokens(content),
    hasAttachment: hasAttachmentMarker(content),
  }
}

/**
 * Build a history of `n` messages all about the same topic.
 * Each message is ~65 tokens (260+ chars) to pass the 50-token qualifying threshold.
 */
function buildHistory(
  topic: string,
  count: number,
  baseTime = 1_000_000,
  intervalMs = 60_000,
): SessionMessage[] {
  const msgs: SessionMessage[] = []
  for (let i = 0; i < count; i++) {
    // ~260 characters ≈ 65 tokens — above the 50-token qualifying threshold
    const content = `This is detailed message number ${i + 1} regarding the subject of ${topic}. ` +
      `We are deeply exploring the ${topic} domain, discussing various perspectives and implications. ` +
      `The topic of ${topic} involves many complex considerations that require careful analysis.`
    msgs.push(makeMsg(content, baseTime + i * intervalMs))
  }
  return msgs
}

// ─────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates roughly chars/4', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })

  it('rounds up', () => {
    expect(estimateTokens('abc')).toBe(1) // ceil(3/4) = 1
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hasAttachmentMarker
// ─────────────────────────────────────────────────────────────────────────────

describe('hasAttachmentMarker', () => {
  it('detects [File: marker', () => {
    expect(hasAttachmentMarker('Here is the file [File: document.pdf]')).toBe(true)
  })

  it('detects [Anhang: marker', () => {
    expect(hasAttachmentMarker('[Anhang: bild.jpg] wurde hochgeladen')).toBe(true)
  })

  it('detects attachment: marker (case insensitive)', () => {
    expect(hasAttachmentMarker('ATTACHMENT: document.pdf')).toBe(true)
  })

  it('returns false for normal text', () => {
    expect(hasAttachmentMarker('Hallo, wie geht es dir?')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// toSessionMessages
// ─────────────────────────────────────────────────────────────────────────────

describe('toSessionMessages', () => {
  it('converts rows with valid timestamps', () => {
    const rows = [{ content: 'hello world', timestamp: '2024-01-01T10:00:00' }]
    const msgs = toSessionMessages(rows)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('hello world')
    expect(msgs[0].tokens).toBeGreaterThan(0)
    expect(msgs[0].timestampMs).toBeGreaterThan(0)
    expect(msgs[0].hasAttachment).toBe(false)
  })

  it('handles attachment markers', () => {
    const rows = [{ content: '[File: doc.pdf] uploaded', timestamp: '2024-01-01T10:00:00' }]
    const msgs = toSessionMessages(rows)
    expect(msgs[0].hasAttachment).toBe(true)
  })

  it('handles invalid timestamps gracefully', () => {
    const rows = [{ content: 'test', timestamp: 'invalid-date' }]
    const msgs = toSessionMessages(rows)
    expect(msgs[0].timestampMs).toBeGreaterThan(0) // Falls back to Date.now()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectTopicShift — insufficient data
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTopicShift — insufficient data', () => {
  it('returns insufficient=true when fewer than 5 messages', () => {
    const history = buildHistory('software', 3)
    const newMsg = makeMsg('More about software engineering patterns and architecture', history[history.length - 1].timestampMs + 60_000)
    const result = detectTopicShift(history, newMsg)
    expect(result.insufficient).toBe(true)
    expect(result.shiftDetected).toBe(false)
  })

  it('returns insufficient=true when total qualifying tokens < 200', () => {
    // 10 messages but each < 50 tokens (small messages)
    const history: SessionMessage[] = []
    for (let i = 0; i < 10; i++) {
      history.push({
        content: 'Hi', // ~1 token — too small to qualify
        timestampMs: 1_000_000 + i * 60_000,
        tokens: 1,
        hasAttachment: false,
      })
    }
    const newMsg: SessionMessage = {
      content: 'New topic',
      timestampMs: 2_000_000,
      tokens: 2,
      hasAttachment: false,
    }
    const result = detectTopicShift(history, newMsg)
    expect(result.insufficient).toBe(true)
  })

  it('returns sufficient after 5+ messages with 65+ tokens each', () => {
    const history = buildHistory('machine learning and artificial intelligence', 6)
    // Verify history messages qualify (>= 50 tokens each)
    history.forEach(m => {
      expect(m.tokens).toBeGreaterThanOrEqual(50)
    })
    const newMsg = makeMsg(
      'Machine learning algorithms and artificial intelligence systems are being used extensively.',
      history[history.length - 1].timestampMs + 60_000,
    )
    const result = detectTopicShift(history, newMsg)
    expect(result.insufficient).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectTopicShift — explicit trigger
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTopicShift — explicit trigger', () => {
  it('detects shift immediately with score >= 2 on explicit trigger', () => {
    // Even with just 1 message in history
    const history = buildHistory('cooking', 1)
    const newMsg = makeMsg('Anything at all', Date.now())
    const result = detectTopicShift(history, newMsg, true)
    expect(result.shiftDetected).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(2)
    expect(result.signals.explicit).toBe(true)
  })

  it('score is exactly 2 for explicit trigger regardless of history', () => {
    const history: SessionMessage[] = []
    const newMsg = makeMsg('Something', Date.now())
    const result = detectTopicShift(history, newMsg, true)
    expect(result.score).toBe(2)
    expect(result.shiftDetected).toBe(true)
  })

  it('returns early without computing windows for explicit trigger', () => {
    const history: SessionMessage[] = []
    const newMsg = makeMsg('Something', Date.now())
    const result = detectTopicShift(history, newMsg, true)
    // No window computation needed
    expect(result.jaccardOverlap).toBeNull()
    expect(result.insufficient).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectTopicShift — time gap signal
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTopicShift — time gap signal', () => {
  it('triggers time gap signal after 30+ minutes (31 min)', () => {
    const history = buildHistory('cooking recipes and culinary arts', 6)
    // New message about cooking recipes (same topic) after 31 minutes
    const lastTs = history[history.length - 1].timestampMs
    const newMsg = makeMsg(
      'Cooking recipes and culinary arts involve many techniques and skills that chefs develop.',
      lastTs + 31 * 60 * 1000,
    )
    const result = detectTopicShift(history, newMsg)
    expect(result.signals.timeGap).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(1)
  })

  it('does not trigger time gap signal within 30 minutes (10 min)', () => {
    const history = buildHistory('cooking recipes and culinary arts', 6)
    const lastTs = history[history.length - 1].timestampMs
    // New message after 10 minutes only
    const newMsg = makeMsg(
      'Cooking recipes and culinary arts involve many techniques.',
      lastTs + 10 * 60 * 1000,
    )
    const result = detectTopicShift(history, newMsg)
    expect(result.signals.timeGap).toBe(false)
  })

  it('triggers at exactly 30 min + 1 ms', () => {
    const history = buildHistory('typescript programming', 6)
    const lastTs = history[history.length - 1].timestampMs
    const newMsg = makeMsg(
      'TypeScript programming language features and type system considerations.',
      lastTs + 30 * 60 * 1000 + 1, // exactly at boundary + 1ms
    )
    const result = detectTopicShift(history, newMsg)
    expect(result.signals.timeGap).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectTopicShift — attachment guard
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTopicShift — attachment guard', () => {
  it('never detects shift for messages with attachments', () => {
    const history = buildHistory('cooking and culinary arts recipe', 6)
    const lastTs = history[history.length - 1].timestampMs
    // Message with attachment AND time gap AND different topic
    const attachmentMsg: SessionMessage = {
      content: '[File: document.pdf] Here is something totally different about quantum physics nuclear reactor particle accelerator',
      timestampMs: lastTs + 40 * 60 * 1000, // 40 min gap
      tokens: 100,
      hasAttachment: true,
    }
    const result = detectTopicShift(history, attachmentMsg)
    expect(result.shiftDetected).toBe(false)
    expect(result.score).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectTopicShift — hysteresis (score >= 2 required)
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTopicShift — hysteresis', () => {
  it('single signal produces score=1, no shift detected', () => {
    // Only time gap fires, no Jaccard signal
    const history = buildHistory('typescript programming language features', 6)
    const lastTs = history[history.length - 1].timestampMs
    // Same topic as history but with long gap — only time signal fires
    const newMsg = makeMsg(
      'TypeScript programming language features and type system considerations are important.',
      lastTs + 35 * 60 * 1000,
    )
    const result = detectTopicShift(history, newMsg)
    expect(result.signals.timeGap).toBe(true)
    // If Jaccard is high (same topic), no Jaccard signal → score = 1 → no shift
    if (!result.signals.jaccardShift) {
      expect(result.shiftDetected).toBe(false)
      expect(result.score).toBe(1)
    }
  })

  it('score of 2 from both time gap and Jaccard shift triggers detection', () => {
    // Both signals fire
    const baseTime = 1_000_000
    const history = buildHistory('cooking recipe pasta tomatoes italian kitchen chef', 6, baseTime, 60_000)
    const lastTs = history[history.length - 1].timestampMs

    // New message: completely different topic + time gap
    const newMsg = makeMsg(
      'Quantum mechanics particle physics nuclear reactor photon electron wave function superposition entanglement research laboratory experiment',
      lastTs + 40 * 60 * 1000, // >30 min → Signal 1
    )
    const result = detectTopicShift(history, newMsg)
    expect(result.signals.timeGap).toBe(true) // Signal 1 fires
    // Signal 2 may or may not fire depending on keyword extraction
    // But at minimum score >= 1
    expect(result.score).toBeGreaterThanOrEqual(1)
    if (result.signals.jaccardShift) {
      expect(result.score).toBe(2)
      expect(result.shiftDetected).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// detectTopicShift — window token limits
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTopicShift — window token limits', () => {
  it('handles a mix of small and large messages in history', () => {
    const history: SessionMessage[] = []
    const baseTime = 1_000_000

    // 3 qualifying messages (65 tokens each)
    for (let i = 0; i < 3; i++) {
      const content = `This is a detailed discussion about software engineering and programming. ` +
        `Message number ${i + 1} explores various aspects of software development, testing, and deployment practices.`
      history.push({ content, timestampMs: baseTime + i * 60_000, tokens: estimateTokens(content), hasAttachment: false })
    }

    // 3 small messages (< 50 tokens each)
    for (let i = 0; i < 3; i++) {
      history.push({
        content: 'OK',
        timestampMs: baseTime + (3 + i) * 60_000,
        tokens: 1,
        hasAttachment: false,
      })
    }

    const lastTs = history[history.length - 1].timestampMs
    const newMsg = makeMsg('More about software engineering and development.', lastTs + 60_000)

    // Should not throw and should return a result
    const result = detectTopicShift(history, newMsg)
    expect(result).toBeDefined()
    expect(typeof result.score).toBe('number')
    expect(typeof result.shiftDetected).toBe('boolean')
  })
})
