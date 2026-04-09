import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '@openagent/core'

const CONFIG_FILENAME = 'salesmemory.json'

export type SalesMemoryProvider = 'ollama' | 'openai' | 'anthropic'

export interface SalesMemorySettings {
  // ── Core ──────────────────────────────────────────────────────────────────
  enabled: boolean
  provider: SalesMemoryProvider
  ollamaUrl: string
  ollamaModel: string
  openaiKey: string
  openaiModel: string
  anthropicKey: string
  anthropicModel: string

  // ── Retrieval / injection ─────────────────────────────────────────────────
  autoInject: boolean
  /** Number of results to return (topK for RRF) */
  topK: number
  /** Legacy alias — kept for backwards compat */
  injectMaxResults: number
  /** BM25 score threshold for injection (negative: lower = more permissive) */
  injectThreshold: number
  /** RRF k constant (default 60) */
  rrf_k: number

  // ── Fact extraction (Schicht 2) ───────────────────────────────────────────
  factExtractionEnabled: boolean
  factExtractionModel: string

  // ── Obsidian Zettelkasten (Schicht 3) ────────────────────────────────────
  obsidianEnabled: boolean
  obsidianHost: string
  obsidianUser: string
  obsidianVaultPath: string

  // ── Session hysteresis (Schicht 1) ───────────────────────────────────────
  sessionHysteresisMinMessages: number
  sessionHysteresisMinTokens: number
  sessionTimeGapMinutes: number
  sessionJaccardThreshold: number
}

/** Env-based defaults — used as fallback when no config file exists */
const ENV_DEFAULTS: SalesMemorySettings = {
  // Core
  enabled: process.env.SALESMEMORY_ENABLED === 'true',
  provider: (process.env.SALESMEMORY_PROVIDER ?? 'ollama') as SalesMemoryProvider,
  ollamaUrl: process.env.SALESMEMORY_OLLAMA_URL ?? 'http://localhost:11434',
  ollamaModel: process.env.SALESMEMORY_OLLAMA_MODEL ?? 'llama3.2',
  openaiKey: process.env.SALESMEMORY_OPENAI_KEY ?? '',
  openaiModel: process.env.SALESMEMORY_OPENAI_MODEL ?? 'gpt-4o-mini',
  anthropicKey: process.env.SALESMEMORY_ANTHROPIC_KEY ?? '',
  anthropicModel: process.env.SALESMEMORY_ANTHROPIC_MODEL ?? 'claude-3-haiku-20240307',

  // Retrieval / injection
  autoInject: process.env.SALESMEMORY_AUTO_INJECT === 'true',
  topK: Math.max(1, parseInt(process.env.SALESMEMORY_TOP_K ?? '5') || 5),
  injectMaxResults: Math.max(1, parseInt(process.env.SALESMEMORY_INJECT_MAX_RESULTS ?? '3') || 3),
  injectThreshold: parseFloat(process.env.SALESMEMORY_INJECT_THRESHOLD ?? '-1.0'),
  rrf_k: Math.max(1, parseInt(process.env.SALESMEMORY_RRF_K ?? '60') || 60),

  // Fact extraction
  factExtractionEnabled: process.env.SALESMEMORY_FACT_EXTRACTION === 'true',
  factExtractionModel: process.env.SALESMEMORY_FACT_EXTRACTION_MODEL ?? 'llama3.2',

  // Obsidian
  obsidianEnabled: process.env.SALESMEMORY_OBSIDIAN_ENABLED === 'true',
  obsidianHost: process.env.SALESMEMORY_OBSIDIAN_HOST ?? '192.168.10.222',
  obsidianUser: process.env.SALESMEMORY_OBSIDIAN_USER ?? 'user',
  obsidianVaultPath: process.env.SALESMEMORY_OBSIDIAN_VAULT_PATH ?? '~/Obsidian/OpenAgent',

  // Session hysteresis
  sessionHysteresisMinMessages: Math.max(1, parseInt(process.env.SALESMEMORY_HYSTERESIS_MIN_MESSAGES ?? '5') || 5),
  sessionHysteresisMinTokens: Math.max(0, parseInt(process.env.SALESMEMORY_HYSTERESIS_MIN_TOKENS ?? '200') || 200),
  sessionTimeGapMinutes: Math.max(1, parseInt(process.env.SALESMEMORY_TIME_GAP_MINUTES ?? '30') || 30),
  sessionJaccardThreshold: parseFloat(process.env.SALESMEMORY_JACCARD_THRESHOLD ?? '0.25'),
}

function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILENAME)
}

/**
 * Loads the SalesMemory config from disk, falling back to env-based defaults
 * if no config file exists yet.
 */
export function loadSalesMemoryConfig(): SalesMemorySettings {
  const filePath = getConfigPath()
  if (!fs.existsSync(filePath)) {
    return { ...ENV_DEFAULTS }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<SalesMemorySettings>
    return { ...ENV_DEFAULTS, ...parsed }
  } catch {
    return { ...ENV_DEFAULTS }
  }
}

/**
 * Persists the SalesMemory config to disk.
 * Creates the config directory if it does not exist yet.
 */
export function saveSalesMemoryConfig(settings: SalesMemorySettings): void {
  const dir = getConfigDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const filePath = getConfigPath()
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
}
