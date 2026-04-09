/**
 * Composable for reading and persisting SalesMemory settings via the backend API.
 *
 * Settings are stored in /data/config/salesmemory.json on the server via
 * GET/POST /api/salesmemory/config.
 */

export type SalesMemoryProvider = 'ollama' | 'openai' | 'anthropic'

export interface SalesMemoryPluginSettings {
  // ── Core ──────────────────────────────────────────────────────────────────
  /** Whether SalesMemory is enabled */
  enabled: boolean
  /** LLM provider to use for recall/digest/fact-extraction */
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

  // ── Retrieval / injection ─────────────────────────────────────────────────
  /** Whether to auto-inject memory context into chat messages */
  autoInject: boolean
  /** Number of top results to return via RRF fusion */
  topK: number
  /** Maximum number of memory results to inject (legacy) */
  injectMaxResults: number
  /** Minimum relevance threshold for injection (FTS5 rank, negative numbers) */
  injectThreshold: number
  /** RRF k constant (default 60) */
  rrf_k: number

  // ── Fact extraction (Schicht 2) ───────────────────────────────────────────
  /** Whether to extract facts at session end */
  factExtractionEnabled: boolean
  /** Model to use for fact extraction (can differ from main model) */
  factExtractionModel: string

  // ── Obsidian Zettelkasten (Schicht 3) ────────────────────────────────────
  /** Whether Obsidian sync is enabled */
  obsidianEnabled: boolean
  /** SSH host of the Mac running Obsidian */
  obsidianHost: string
  /** SSH user on the Mac */
  obsidianUser: string
  /** Path to the Obsidian vault on the Mac */
  obsidianVaultPath: string

  // ── Session hysteresis (Schicht 1) ───────────────────────────────────────
  /** Minimum messages before topic-shift detection activates */
  sessionHysteresisMinMessages: number
  /** Minimum total tokens before topic-shift detection activates */
  sessionHysteresisMinTokens: number
  /** Time gap in minutes that triggers a hysteresis signal (+1) */
  sessionTimeGapMinutes: number
  /** Jaccard similarity threshold below which a semantic shift is detected */
  sessionJaccardThreshold: number
}

const DEFAULTS: SalesMemoryPluginSettings = {
  // Core
  enabled: false,
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  anthropicKey: '',
  anthropicModel: 'claude-3-haiku-20240307',
  // Retrieval
  autoInject: false,
  topK: 5,
  injectMaxResults: 3,
  injectThreshold: -1.0,
  rrf_k: 60,
  // Fact extraction
  factExtractionEnabled: false,
  factExtractionModel: 'llama3.2',
  // Obsidian
  obsidianEnabled: false,
  obsidianHost: '192.168.10.222',
  obsidianUser: 'user',
  obsidianVaultPath: '~/Obsidian/OpenAgent',
  // Session hysteresis
  sessionHysteresisMinMessages: 5,
  sessionHysteresisMinTokens: 200,
  sessionTimeGapMinutes: 30,
  sessionJaccardThreshold: 0.25,
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
