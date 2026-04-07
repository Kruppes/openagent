import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '@openagent/core'

const CONFIG_FILENAME = 'salesmemory.json'

export type SalesMemoryProvider = 'ollama' | 'openai' | 'anthropic'

export interface SalesMemorySettings {
  enabled: boolean
  provider: SalesMemoryProvider
  ollamaUrl: string
  ollamaModel: string
  openaiKey: string
  openaiModel: string
  anthropicKey: string
  anthropicModel: string
  autoInject: boolean
  injectMaxResults: number
  injectThreshold: number
}

/** Env-based defaults — used as fallback when no config file exists */
const ENV_DEFAULTS: SalesMemorySettings = {
  enabled: process.env.SALESMEMORY_ENABLED === 'true',
  provider: (process.env.SALESMEMORY_PROVIDER ?? 'ollama') as SalesMemoryProvider,
  ollamaUrl: process.env.SALESMEMORY_OLLAMA_URL ?? 'http://localhost:11434',
  ollamaModel: process.env.SALESMEMORY_OLLAMA_MODEL ?? 'llama3.2',
  openaiKey: process.env.SALESMEMORY_OPENAI_KEY ?? '',
  openaiModel: process.env.SALESMEMORY_OPENAI_MODEL ?? 'gpt-4o-mini',
  anthropicKey: process.env.SALESMEMORY_ANTHROPIC_KEY ?? '',
  anthropicModel: process.env.SALESMEMORY_ANTHROPIC_MODEL ?? 'claude-3-haiku-20240307',
  autoInject: process.env.SALESMEMORY_AUTO_INJECT === 'true',
  injectMaxResults: Math.max(1, parseInt(process.env.SALESMEMORY_INJECT_MAX_RESULTS ?? '3') || 3),
  injectThreshold: parseFloat(process.env.SALESMEMORY_INJECT_THRESHOLD ?? '-1.0'),
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
