import { describe, expect, it } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { completeSimple, streamSimple } from './pi-models.js'

/**
 * These tests deliberately exercise only the local wiring (provider
 * registration + error surfacing), never the network. Every case points at a
 * bogus base URL or omits the API key, so nothing leaves the process.
 */

function testContext(): Context {
  return { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }
}

function buildModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider: 'test-provider',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  } as Model<Api>
}

describe('pi-models', () => {
  it('surfaces a missing API key as stopReason "error" instead of throwing', async () => {
    const message = await completeSimple(
      buildModel({ provider: 'unconfigured-provider' }),
      testContext(),
      // no apiKey on purpose
    )
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toBeTruthy()
  })

  it('surfaces an unmapped wire api as stopReason "error"', async () => {
    const message = await completeSimple(
      buildModel({ provider: 'unmapped-api-provider', api: 'pi-messages' as Api }),
      testContext(),
      { apiKey: 'test-key' },
    )
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toBeTruthy()
  })

  it('registers a provider per model.provider id and reuses it across calls', async () => {
    const model = buildModel({ provider: 'idempotent-provider' })
    const context = testContext()

    // Two calls against the same provider id must not throw on re-registration.
    const first = await completeSimple(model, context, { apiKey: 'test-key' })
    const second = await completeSimple(model, context, { apiKey: 'test-key' })

    // Both fail at the network layer (unroutable baseUrl), not at registration.
    expect(first.stopReason).toBe('error')
    expect(second.stopReason).toBe('error')
  })

  it('exposes streamSimple returning an event stream', () => {
    const stream = streamSimple(
      buildModel({ provider: 'stream-provider' }),
      testContext(),
      { apiKey: 'test-key' },
    )
    expect(typeof stream.result).toBe('function')
  })
})
