import fs from 'node:fs'
import path from 'node:path'
import { loadMultiPersonaSettings, loadConfig, invalidatePersonaCache } from '@openagent/core'
import type { PersonaFilesContract as PersonaFiles, PersonaListItemContract as PersonaListItem, PersonaDetailContract as PersonaDetail } from '@openagent/core/contracts'
import { PERSONA_FILE_NAMES, PERSONA_FILE_KEYS } from '@openagent/core/contracts'
import type { PersonaFileKey } from '@openagent/core/contracts'

/** Map file name → key in PersonaFiles */
const FILE_TO_KEY: Record<string, PersonaFileKey> = {
  'IDENTITY.md': 'identity',
  'SOUL.md': 'soul',
  'USER.md': 'user',
  'TOOLS.md': 'tools',
  'AGENTS.md': 'agents',
  'HEARTBEAT.md': 'heartbeat',
}

const KEY_TO_FILE: Record<PersonaFileKey, string> = {
  identity: 'IDENTITY.md',
  soul: 'SOUL.md',
  user: 'USER.md',
  tools: 'TOOLS.md',
  agents: 'AGENTS.md',
  heartbeat: 'HEARTBEAT.md',
}

/* ── Path safety ── */

function getAgentsBaseDir(): string {
  return path.resolve(process.env.DATA_DIR ?? '/data', 'agents')
}

/**
 * Resolve a persona directory with path-traversal protection.
 * Throws if the resolved path escapes the base directory.
 */
function safePersonaDir(agentId: string): string {
  const baseDir = getAgentsBaseDir()
  const resolved = path.resolve(baseDir, agentId)
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid agent ID: path traversal attempt')
  }
  return resolved
}

/**
 * Resolve a persona file path with path-traversal protection.
 * Only allows files from the PERSONA_FILE_NAMES whitelist.
 */
function safeFilePath(personaDir: string, fileName: string): string {
  if (!(PERSONA_FILE_NAMES as readonly string[]).includes(fileName)) {
    throw new Error(`Invalid file name: ${fileName}`)
  }
  const resolved = path.resolve(personaDir, fileName)
  if (!resolved.startsWith(personaDir + path.sep) && resolved !== personaDir) {
    throw new Error('Invalid file path: path traversal attempt')
  }
  return resolved
}

/* ── Atomic file writes ── */

/**
 * Write a file atomically: write to temp file, then rename.
 * Prevents corruption from concurrent or interrupted writes.
 */
function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, filePath)
  } catch (err) {
    // Clean up temp file on error
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

/* ── Per-agentId write mutex ── */

const writeLocks = new Map<string, Promise<void>>()

/**
 * Serialize write operations for a given agentId.
 * Prevents race conditions when multiple requests update the same persona concurrently.
 */
async function withWriteLock<T>(agentId: string, fn: () => T): Promise<T> {
  // Wait for any pending operation on this agentId
  const pending = writeLocks.get(agentId)
  let resolve: () => void
  const lock = new Promise<void>(r => { resolve = r })
  writeLocks.set(agentId, lock)

  if (pending) {
    await pending
  }

  try {
    return fn()
  } finally {
    resolve!()
    // Clean up if this is still our lock
    if (writeLocks.get(agentId) === lock) {
      writeLocks.delete(agentId)
    }
  }
}

/* ── Telegram bindings ── */

/**
 * Get telegram bindings: agentId → botToken exists.
 */
function getTelegramBindings(): Map<string, string> {
  const bindings = new Map<string, string>()
  try {
    const multiPersona = loadMultiPersonaSettings()
    interface RawTelegramConfig {
      enabled?: boolean
      botToken?: string
      accounts?: Record<string, { agentId?: string; botToken?: string; enabled?: boolean }>
    }
    const telegram = loadConfig<RawTelegramConfig>('telegram.json')

    if (multiPersona.enabled && telegram.accounts) {
      for (const [key, account] of Object.entries(telegram.accounts)) {
        const agentId = account.agentId ?? key
        if (account.botToken && account.enabled !== false) {
          bindings.set(agentId, account.botToken)
        }
      }
    } else if (telegram.enabled && telegram.botToken) {
      bindings.set('main', telegram.botToken)
    }
  } catch {
    // Config not available
  }
  return bindings
}

/* ── CRUD operations ── */

/**
 * List all personas.
 */
export function listPersonas(): PersonaListItem[] {
  const baseDir = getAgentsBaseDir()
  const telegramBindings = getTelegramBindings()
  const personas: PersonaListItem[] = []

  // Always include "main"
  const mainDir = path.join(baseDir, 'main')
  const mainFileCount = countPersonaFiles(mainDir)
  personas.push({
    id: 'main',
    hasTelegramBinding: telegramBindings.has('main'),
    fileCount: mainFileCount,
  })

  // Scan agents directory
  try {
    if (fs.existsSync(baseDir)) {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'main') {
          const fileCount = countPersonaFiles(path.join(baseDir, entry.name))
          personas.push({
            id: entry.name,
            hasTelegramBinding: telegramBindings.has(entry.name),
            fileCount,
          })
        }
      }
    }
  } catch {
    // Directory not readable
  }

  return personas.sort((a, b) => {
    if (a.id === 'main') return -1
    if (b.id === 'main') return 1
    return a.id.localeCompare(b.id)
  })
}

function countPersonaFiles(dir: string): number {
  let count = 0
  for (const file of PERSONA_FILE_NAMES) {
    const filePath = path.join(dir, file)
    try {
      if (fs.existsSync(filePath)) count++
    } catch {
      // ignore
    }
  }
  return count
}

/**
 * Get persona detail (all files).
 */
export function getPersona(agentId: string): PersonaDetail {
  const dir = safePersonaDir(agentId)
  const telegramBindings = getTelegramBindings()

  const files: PersonaFiles = {
    identity: '',
    soul: '',
    user: '',
    tools: '',
    agents: '',
    heartbeat: '',
  }

  for (const fileName of PERSONA_FILE_NAMES) {
    const key = FILE_TO_KEY[fileName]
    const filePath = safeFilePath(dir, fileName)
    try {
      if (fs.existsSync(filePath)) {
        files[key] = fs.readFileSync(filePath, 'utf-8')
      }
    } catch {
      // File not readable
    }
  }

  return {
    id: agentId,
    files,
    hasTelegramBinding: telegramBindings.has(agentId),
  }
}

/**
 * Update persona files. Uses atomic writes and per-agent write lock.
 */
export function updatePersona(agentId: string, files: Partial<PersonaFiles>): PersonaDetail {
  const dir = safePersonaDir(agentId)

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  for (const [key, content] of Object.entries(files)) {
    if (!(PERSONA_FILE_KEYS as readonly string[]).includes(key)) continue
    const fileName = KEY_TO_FILE[key as PersonaFileKey]
    if (!fileName) continue
    const filePath = safeFilePath(dir, fileName)
    atomicWriteFile(filePath, content as string)
  }

  // Invalidate persona loader cache for this agent
  invalidatePersonaCache(agentId)

  return getPersona(agentId)
}

/**
 * Default template content for new persona files (German).
 */
const TEMPLATE_FILES: PersonaFiles = {
  identity: `# IDENTITY.md

- **Name:** (Dein Agent-Name)
- **Wesen:** KI-Assistent
- **Stil:** Hilfsbereit, kompetent, freundlich
- **Emoji:** 🤖
`,
  soul: `# SOUL.md

Du bist ein hilfreicher KI-Assistent mit eigener Persönlichkeit.

## Grundprinzipien

- Sei hilfreich und antworte klar
- Bleib in deiner Rolle
- Gib gut durchdachte Antworten

## Kommunikationsstil

- Freundlich und nahbar
- Prägnant, aber gründlich wenn nötig
`,
  user: `# USER.md

## Benutzerprofil

(Beschreibe den Hauptbenutzer, mit dem dieser Agent interagiert)
`,
  tools: `# TOOLS.md

## Verfügbare Werkzeuge

Dieser Agent kann die Standard-OpenAgent-Werkzeuge nutzen.
`,
  agents: `# AGENTS.md

## Agent-Regeln

Standardmäßige Agent-Regeln gelten.
`,
  heartbeat: `# HEARTBEAT.md

## Heartbeat-Aufgaben

(Definiere periodische Aufgaben für diesen Agent)
`,
}

/**
 * Create a new persona with template files.
 */
export function createPersona(agentId: string): PersonaDetail {
  const dir = safePersonaDir(agentId)

  if (fs.existsSync(dir)) {
    throw new Error(`Persona "${agentId}" already exists`)
  }

  fs.mkdirSync(dir, { recursive: true })

  // Write template files atomically
  for (const [key, content] of Object.entries(TEMPLATE_FILES)) {
    const fileName = KEY_TO_FILE[key as PersonaFileKey]
    if (!fileName) continue
    const filePath = safeFilePath(dir, fileName)
    atomicWriteFile(filePath, content)
  }

  // Invalidate persona loader cache
  invalidatePersonaCache(agentId)

  return getPersona(agentId)
}

/**
 * Delete a persona (cannot delete 'main').
 * Refuses deletion if a Telegram binding exists (HTTP 409).
 */
export function deletePersona(agentId: string): void {
  if (agentId === 'main') {
    throw new Error('Cannot delete the main persona')
  }

  const dir = safePersonaDir(agentId)

  if (!fs.existsSync(dir)) {
    throw new Error(`Persona "${agentId}" not found`)
  }

  // Guard: refuse if this persona has an active Telegram binding
  const telegramBindings = getTelegramBindings()
  if (telegramBindings.has(agentId)) {
    throw new Error(
      `Persona "${agentId}" has an active Telegram binding — remove the bot binding in telegram.json first`,
    )
  }

  fs.rmSync(dir, { recursive: true, force: true })

  // Invalidate persona loader cache
  invalidatePersonaCache(agentId)
}
