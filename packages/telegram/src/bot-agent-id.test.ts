/**
 * Tests that the Telegram bot correctly sets agent_id in all chat_messages INSERTs.
 * Part of the multi-persona wall leak fix.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('telegram bot chat_messages agent_id', () => {
  const botSrc = fs.readFileSync(
    path.resolve(__dirname, 'bot.ts'),
    'utf-8',
  )

  it('has this.agentId available as a private field', () => {
    expect(botSrc).toMatch(/private\s+agentId\s*:\s*string/)
  })

  it('all INSERT INTO chat_messages include agent_id column', () => {
    const insertRegex = /INSERT INTO chat_messages\s*\(([^)]+)\)/g
    let match: RegExpExecArray | null
    const inserts: string[] = []

    while ((match = insertRegex.exec(botSrc)) !== null) {
      inserts.push(match[1])
    }

    // Should have exactly 5 INSERTs in bot.ts
    expect(inserts.length).toBe(5)

    for (const columns of inserts) {
      expect(columns).toContain('agent_id')
    }
  })

  it('all INSERT INTO chat_messages use this.agentId as the agent_id value', () => {
    // For each INSERT, find the corresponding .run() call and verify this.agentId is the last param
    const lines = botSrc.split('\n')
    const insertLineNos: number[] = []

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('INSERT INTO chat_messages') && lines[i].includes('agent_id')) {
        insertLineNos.push(i)
      }
    }

    expect(insertLineNos.length).toBe(5)

    // For each INSERT line, look at the next few lines for the .run() call
    for (const lineNo of insertLineNos) {
      const contextLines = lines.slice(lineNo, lineNo + 5).join('\n')
      expect(contextLines).toContain('this.agentId')
    }
  })

  it('user message INSERT (text-only) includes agent_id', () => {
    // Verify the specific pattern: user message without attachments
    expect(botSrc).toContain(
      "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)"
    )
  })

  it('assistant response INSERT includes agent_id', () => {
    // Verify there's an assistant INSERT with agent_id
    const assistantInsertRegex = /\.run\(sessionId,\s*numericUserId,\s*'assistant',\s*fullResponse\.trim\(\),\s*this\.agentId\)/
    expect(botSrc).toMatch(assistantInsertRegex)
  })

  it('tool call INSERT includes agent_id', () => {
    // Verify tool INSERT includes agent_id
    expect(botSrc).toContain(
      "INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
  })
})
