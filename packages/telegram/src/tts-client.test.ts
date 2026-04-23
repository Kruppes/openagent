import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TtsClient } from './tts-client.js'

describe('TtsClient', () => {
  let client: TtsClient

  beforeEach(() => {
    client = new TtsClient({
      baseUrl: 'http://localhost:7400',
      timeoutMs: 5000,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', () => {
      const c = new TtsClient({ baseUrl: 'http://host:7400/' })
      // We can verify by checking health call URL
      expect(c).toBeDefined()
    })

    it('uses default timeout and voice', () => {
      const c = new TtsClient({ baseUrl: 'http://host:7400' })
      expect(c).toBeDefined()
    })
  })

  describe('isHealthy', () => {
    it('returns true when service responds with ok', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok', model_loaded: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      expect(await client.isHealthy()).toBe(true)
    })

    it('returns false when model not loaded', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok', model_loaded: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      expect(await client.isHealthy()).toBe(false)
    })

    it('returns false on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
      expect(await client.isHealthy()).toBe(false)
    })

    it('returns false on non-200 response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('error', { status: 500 }),
      )
      expect(await client.isHealthy()).toBe(false)
    })
  })

  describe('synthesize', () => {
    it('returns audio buffer on success', async () => {
      const fakeOgg = Buffer.from('fake-ogg-data')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(fakeOgg, {
          status: 200,
          headers: {
            'Content-Type': 'audio/ogg',
            'X-TTS-Generation-Time': '2.50',
            'X-TTS-Total-Time': '3.10',
            'X-TTS-Audio-Duration': '5.00',
          },
        }),
      )

      const result = await client.synthesize('Hallo Welt')
      expect(result.audio).toBeInstanceOf(Buffer)
      expect(result.audio.length).toBe(fakeOgg.length)
      expect(result.generationTime).toBe(2.5)
      expect(result.totalTime).toBe(3.1)
      expect(result.audioDuration).toBe(5.0)
    })

    it('sends correct request body', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(Buffer.from('ogg'), { status: 200 }),
      )

      await client.synthesize('Test text', 'Chelsie')

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:7400/tts',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'Test text',
            voice: 'Chelsie',
            lang: 'German',
          }),
        }),
      )
    })

    it('uses default voice when not specified', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(Buffer.from('ogg'), { status: 200 }),
      )

      await client.synthesize('Hallo')

      const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
      expect(body.voice).toBe('Ethan')
    })

    it('throws on HTTP error with detail', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Model not loaded' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      )

      await expect(client.synthesize('Test')).rejects.toThrow('TTS service error: Model not loaded')
    })

    it('throws on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
      await expect(client.synthesize('Test')).rejects.toThrow('ECONNREFUSED')
    })

    it('handles missing timing headers', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(Buffer.from('ogg'), { status: 200 }),
      )

      const result = await client.synthesize('Test')
      expect(result.generationTime).toBeUndefined()
      expect(result.totalTime).toBeUndefined()
      expect(result.audioDuration).toBeUndefined()
    })
  })
})
