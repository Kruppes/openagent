/**
 * Tests for the multi-persona task injection routing fix.
 *
 * Bug: Warren sub-task completion notifications leaked to the main bot because
 * pendingTaskInjections lost the agentId, and the delivery callback fell back
 * to the primary (main) bot. Additionally, chat_messages INSERTs were missing
 * the agent_id column, causing all messages to be recorded as 'main'.
 *
 * These tests verify:
 * - PendingTaskInjectionMeta carries agentId through the delivery chain
 * - Bot resolution uses agentId to pick the correct persona bot
 * - chat_messages persistence includes explicit agent_id
 * - No INSERT INTO chat_messages in the codebase omits agent_id
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('multi-persona task injection routing', () => {
  describe('PendingTaskInjectionMeta agentId field', () => {
    it('interface requires agentId as a string field', async () => {
      // Read the source to verify the interface definition
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      // The interface must contain agentId: string (not optional)
      const interfaceMatch = src.match(
        /interface\s+PendingTaskInjectionMeta\s*\{([^}]+)\}/,
      )
      expect(interfaceMatch).not.toBeNull()
      const body = interfaceMatch![1]
      expect(body).toContain('agentId')
      // Should be a required field (no ?)
      expect(body).toMatch(/agentId\s*:\s*string/)
    })

    it('pendingTaskInjections.push includes agentId from effectiveAgentId', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      // Find the push call and verify it includes agentId
      const pushMatch = src.match(/pendingTaskInjections\.push\(\{([^}]+)\}\)/)
      expect(pushMatch).not.toBeNull()
      const pushBody = pushMatch![1]
      expect(pushBody).toContain('agentId')
      // Must derive from effectiveAgentId, not be hardcoded
      expect(pushBody).toMatch(/agentId\s*:\s*effectiveAgentId/)
    })
  })

  describe('task injection bot resolution', () => {
    it('setOnTaskInjectionChunk resolves bot via pendingMeta.agentId and telegramBotPool', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      // Find the setOnTaskInjectionChunk block
      const chunkIdx = src.indexOf('setOnTaskInjectionChunk')
      expect(chunkIdx).toBeGreaterThan(-1)
      const chunkBlock = src.slice(chunkIdx, chunkIdx + 2000)

      // Must reference pendingMeta.agentId for bot resolution
      expect(chunkBlock).toContain('pendingMeta?.agentId')
      // Must use telegramBotPool.getBot for resolution
      expect(chunkBlock).toContain('telegramBotPool.getBot(pendingMeta.agentId)')
      // Must NOT use bare `telegramBot` for sending (only as fallback)
      expect(chunkBlock).toContain('resolvedBot.sendFormattedMessage')
      expect(chunkBlock).toContain('resolvedBot.getTelegramChatIdForUser')
    })

    it('task injection response falls back to primary bot when agentId is main', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      const chunkIdx = src.indexOf('setOnTaskInjectionChunk')
      const chunkBlock = src.slice(chunkIdx, chunkIdx + 2000)

      // Fallback pattern: if no agentId or no pool, use telegramBot
      expect(chunkBlock).toMatch(/return telegramBot/)
    })
  })

  describe('task injection persistence', () => {
    it('task injection response INSERT includes agent_id column', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      // Find the INSERT in the setOnTaskInjectionChunk block
      const chunkIdx = src.indexOf('setOnTaskInjectionChunk')
      const chunkBlock = src.slice(chunkIdx, chunkIdx + 3000)
      const insertMatch = chunkBlock.match(/INSERT INTO chat_messages\s*\(([^)]+)\)/)
      expect(insertMatch).not.toBeNull()
      expect(insertMatch![1]).toContain('agent_id')
    })

    it('task injection response uses real session instead of pseudo task-injection-<ts> ID', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      const chunkIdx = src.indexOf('setOnTaskInjectionChunk')
      const chunkBlock = src.slice(chunkIdx, chunkIdx + 3000)

      // Must NOT contain the old pseudo session pattern
      expect(chunkBlock).not.toContain('task-injection-${Date.now()}')
      // Must use getOrCreateSession for real session
      expect(chunkBlock).toContain('getOrCreateSession')
    })

    it('session divider INSERT includes agent_id from callback parameter', async () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, 'runtime-composition.ts'),
        'utf-8',
      )

      // Find the setOnSessionEnd block
      const sessionEndIdx = src.indexOf('setOnSessionEnd')
      expect(sessionEndIdx).toBeGreaterThan(-1)
      const sessionEndBlock = src.slice(sessionEndIdx, sessionEndIdx + 1000)

      // Callback must receive agentId parameter
      expect(sessionEndBlock).toMatch(/agentId\s*:\s*string/)

      // INSERT must include agent_id
      const insertMatch = sessionEndBlock.match(/INSERT INTO chat_messages\s*\(([^)]+)\)/)
      expect(insertMatch).not.toBeNull()
      expect(insertMatch![1]).toContain('agent_id')
    })
  })
})

describe('chat_messages agent_id coverage — no INSERT without agent_id', () => {
  const sourceFiles = [
    'packages/web-backend/src/bootstrap/runtime-composition.ts',
    'packages/web-backend/src/ws-chat.ts',
    'packages/web-backend/src/routes/chat.ts',
    'packages/telegram/src/bot.ts',
    'packages/core/src/task-notification.ts',
    'packages/core/src/task-runner.ts',
  ]

  for (const relPath of sourceFiles) {
    it(`${relPath}: all INSERT INTO chat_messages include agent_id`, () => {
      const absPath = path.resolve(__dirname, '../../../../', relPath)
      const src = fs.readFileSync(absPath, 'utf-8')

      // Find all INSERT INTO chat_messages statements
      const insertRegex = /INSERT INTO chat_messages\s*\(([^)]+)\)/g
      let match: RegExpExecArray | null
      const inserts: string[] = []

      while ((match = insertRegex.exec(src)) !== null) {
        inserts.push(match[1])
      }

      expect(inserts.length).toBeGreaterThan(0)

      for (const columns of inserts) {
        expect(columns).toContain('agent_id')
      }
    })
  }
})

describe('agent.ts setOnSessionEnd callback signature', () => {
  it('callback receives agentId as fourth parameter', async () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../packages/core/src/agent.ts'),
      'utf-8',
    )

    // The setOnSessionEnd method signature must include agentId
    const methodMatch = src.match(/setOnSessionEnd\(callback:\s*\(([^)]+)\)/)
    expect(methodMatch).not.toBeNull()
    const params = methodMatch![1]
    expect(params).toContain('agentId: string')
  })

  it('callback invocation passes session.agentId', async () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../../packages/core/src/agent.ts'),
      'utf-8',
    )

    // The invocation must pass session.agentId
    expect(src).toContain("session.agentId ?? 'main'")
  })
})
