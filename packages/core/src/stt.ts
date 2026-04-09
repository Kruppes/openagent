import { loadConfig, ensureConfigTemplates } from './config.js'

// ── Types ─────────────────────────────────────────────────────────────

export type SttProvider = 'whisper-url' | 'openai' | 'ollama'

export interface SttRewriteSettings {
  enabled: boolean
  providerId: string
}

export interface SttSettings {
  enabled: boolean
  provider: SttProvider
  whisperUrl: string
  providerId: string
  ollamaModel: string
  rewrite: SttRewriteSettings
}

export interface TranscribeOptions {
  language?: string
}

// ── Load settings ─────────────────────────────────────────────────────

export function loadSttSettings(): SttSettings {
  ensureConfigTemplates()
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  const stt = (settings.stt ?? {}) as Partial<SttSettings>
  const rewrite = (stt.rewrite ?? {}) as Partial<SttRewriteSettings>
  return {
    enabled: stt.enabled ?? false,
    provider: stt.provider ?? 'whisper-url',
    whisperUrl: stt.whisperUrl ?? '',
    providerId: stt.providerId ?? '',
    ollamaModel: stt.ollamaModel ?? '',
    rewrite: {
      enabled: rewrite.enabled ?? false,
      providerId: rewrite.providerId ?? '',
    },
  }
}

// ── Whisper URL provider ──────────────────────────────────────────────

export async function transcribeWhisperUrl(
  buffer: Buffer,
  url: string,
  language?: string,
): Promise<string> {
  const formData = new FormData()
  formData.append('file', new Blob([buffer]), 'audio.webm')
  formData.append('response_format', 'text')
  if (language) {
    formData.append('language', language)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      body: formData,
    })
  } catch (err) {
    throw new Error(`Whisper URL request failed: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`Whisper URL returned HTTP ${response.status}: ${errorText}`)
  }

  const text = await response.text()
  return text.trim()
}

// ── Dispatcher ────────────────────────────────────────────────────────

export async function transcribeAudio(
  buffer: Buffer,
  options: TranscribeOptions = {},
): Promise<string> {
  const settings = loadSttSettings()

  if (!settings.enabled) {
    throw new Error('STT is not enabled. Enable it in Settings → Speech-to-Text.')
  }

  switch (settings.provider) {
    case 'whisper-url': {
      if (!settings.whisperUrl) {
        throw new Error('Whisper URL is not configured. Set it in Settings → Speech-to-Text.')
      }
      return transcribeWhisperUrl(buffer, settings.whisperUrl, options.language)
    }
    case 'openai':
      throw new Error('OpenAI STT provider is not yet implemented.')
    case 'ollama':
      throw new Error('Ollama STT provider is not yet implemented.')
    default:
      throw new Error(`Unknown STT provider: ${settings.provider}`)
  }
}
