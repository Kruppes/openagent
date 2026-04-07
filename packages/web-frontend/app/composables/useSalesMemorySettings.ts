/**
 * Composable for persisting and reading SalesMemory Plugin settings from localStorage.
 *
 * Settings are stored under the key `plugin:sales-memory:settings` and are reactive
 * so any component can read the latest values after a save.
 */

export type SalesMemoryProvider = 'ollama' | 'openai' | 'anthropic'

export interface SalesMemoryPluginSettings {
  /** LLM provider to use for recall/digest */
  provider: SalesMemoryProvider
  /** Base URL of the Ollama instance */
  ollamaUrl: string
  /** Ollama model to use */
  ollamaModel: string
  /** OpenAI API key */
  openaiKey: string
  /** OpenAI model to use */
  openaiModel: string
  /** Anthropic API key */
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

const STORAGE_KEY = 'plugin:sales-memory:settings'

const DEFAULTS: SalesMemoryPluginSettings = {
  provider: 'ollama',
  ollamaUrl: 'http://192.168.10.222:11434',
  ollamaModel: 'qwen3:32b',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  anthropicKey: '',
  anthropicModel: 'claude-3-haiku-20240307',
  autoInject: false,
  injectMaxResults: 3,
  injectThreshold: -1.0,
}

/** Reactive shared state — initialised once from localStorage */
const _settings = ref<SalesMemoryPluginSettings>({ ...DEFAULTS })
let _initialised = false

function _init() {
  if (_initialised || !import.meta.client) return
  _initialised = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SalesMemoryPluginSettings>
      _settings.value = { ...DEFAULTS, ...parsed }
    }
  } catch {
    // Ignore — use defaults
  }
}

export function useSalesMemorySettings() {
  _init()

  /** Current settings (reactive) */
  const settings = computed(() => _settings.value)

  /**
   * Persist new settings to localStorage and update reactive state.
   */
  function saveSettings(next: SalesMemoryPluginSettings) {
    _settings.value = { ...next }
    if (import.meta.client) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  }

  /** Reset to defaults without persisting (caller must call saveSettings to persist) */
  function getDefaults(): SalesMemoryPluginSettings {
    return { ...DEFAULTS }
  }

  return {
    settings,
    saveSettings,
    getDefaults,
  }
}
