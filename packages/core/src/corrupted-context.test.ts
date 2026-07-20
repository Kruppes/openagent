import { describe, it, expect } from 'vitest'
import { isCorruptedContextError } from './agent-runtime.js'

describe('isCorruptedContextError', () => {
  it('matches the Anthropic dangling-tool_use phrasing', () => {
    const msg = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01N2. Each `tool_result` block must have a corresponding `tool_use` block in the previous message."}}'
    expect(isCorruptedContextError(msg)).toBe(true)
    expect(isCorruptedContextError(new Error(msg))).toBe(true)
  })

  it('matches the OpenAI/Kimi tool_call_id phrasing', () => {
    expect(isCorruptedContextError('400: {"message":"Invalid request: tool_call_id  is not found","type":"invalid_request_error"}')).toBe(true)
  })

  it('matches a generic tool_result/tool_use mismatch', () => {
    expect(isCorruptedContextError('tool_result without matching tool_use')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isCorruptedContextError('429 rate limit exceeded')).toBe(false)
    expect(isCorruptedContextError('invalid temperature: only 1 is allowed for this model')).toBe(false)
    expect(isCorruptedContextError('This request triggered restrictions on violative cyber content')).toBe(false)
    expect(isCorruptedContextError('')).toBe(false)
    expect(isCorruptedContextError(undefined)).toBe(false)
    expect(isCorruptedContextError(null)).toBe(false)
  })
})
