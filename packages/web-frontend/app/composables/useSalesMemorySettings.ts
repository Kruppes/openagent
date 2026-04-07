/**
 * Composable for reading and persisting SalesMemory settings via the backend API.
 *
 * Settings are stored in /data/config/salesmemory.json on the server via
 * GET/POST /api/salesmemory/config.
 */

export type SalesMemoryProvider = 'ollama' | 'openai' | 'anthropic'

export interface SalesMemoryPluginSettings {
  /** Whether SalesMemory is enabled */
  enabled: boolean
  /** LLM provider to use for recall/digest */
  provider: SalesMemoryProvider
  /** Base URL of the Ollama instance */
  ollamaUrl: string
  /** Ollama model to use */
  ollamaModel: string
  /** OpenAI API key (masked as "***" when returned from API) */
  openaiKey: string
  /** OpenAI model to use */
  openaiModel: string
  /** Anthropic API key (masked as "***" when returned from API) */
  anthropicKey: string
  /** Anthropic model to use */
  anthropicModel: string
  /** Whether to auto-inject memory context into chat messages */
  autoInject: boolean
  /** Maximum number of memory results to inject */
  injectMaxResults: number
  /** Minimum relevance threshold for injection (FTS5 rank, negative numbers) */
  injectThreshold: number
}

const DEFAULTS: SalesMemoryPluginSettings = {
  enabled: false,
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  anthropicKey: '',
  anthropicModel: 'claude-3-haiku-20240307',
  autoInject: false,
  injectMaxResults: 3,
  injectThreshold: -1.0,
}

/** Reactive shared state */
const _settings = ref<SalesMemoryPluginSettings>({ ...DEFAULTS })
const _loaded = ref(false)
const _loading = ref(false)

export function useSalesMemorySettings() {
  const { apiFetch } = useApi()

  /** Current settings (reactive) */
  const settings = computed(() => _settings.value)

  /**
   * Load settings from the backend API.
   * Safe to call multiple times — subsequent calls always refresh from the server.
   */
  async function fetchSettings() {
    if (_loading.value) return
    _loading.value = true
    try {
      const data = await apiFetch<SalesMemoryPluginSettings>('/api/salesmemory/config')
      _settings.value = { ...DEFAULTS, ...data }
      _loaded.value = true
    } catch {
      // API may not be available (feature disabled) — use defaults
      _settings.value = { ...DEFAULTS }
      _loaded.value = true
    } finally {
      _loading.value = false
    }
  }

  /**
   * Persist new settings to the backend and update reactive state.
   * Returns true on success, false on error.
   */
  async function saveSettings(next: Partial<SalesMemoryPluginSettings>): Promise<boolean> {
    try {
      const saved = await apiFetch<SalesMemoryPluginSettings>('/api/salesmemory/config', {
        method: 'POST',
        body: JSON.stringify(next),
      })
      _settings.value = { ...DEFAULTS, ...saved }
      return true
    } catch (err) {
      console.error('[SalesMemory] Failed to save settings:', err)
      return false
    }
  }

  /** Reset to defaults without persisting */
  function getDefaults(): SalesMemoryPluginSettings {
    return { ...DEFAULTS }
  }

  return {
    settings,
    loading: _loading,
    loaded: _loaded,
    fetchSettings,
    saveSettings,
    getDefaults,
  }
}
