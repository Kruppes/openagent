import fs from 'node:fs'
import path from 'node:path'
import { loadMultiPersonaSettings, loadConfig } from '@openagent/core'
import type { PersonaFiles, PersonaListItem, PersonaDetail } from './types.js'
import { PERSONA_FILE_NAMES } from './types.js'

/** Map file name → key in PersonaFiles */
const FILE_TO_KEY: Record<string, keyof PersonaFiles> = {
  'IDENTITY.md': 'identity',
  'SOUL.md': 'soul',
  'USER.md': 'user',
  'TOOLS.md': 'tools',
  'AGENTS.md': 'agents',
  'HEARTBEAT.md': 'heartbeat',
}

const KEY_TO_FILE: Record<keyof PersonaFiles, string> = {
  identity: 'IDENTITY.md',
  soul: 'SOUL.md',
  user: 'USER.md',
  tools: 'TOOLS.md',
  agents: 'AGENTS.md',
  heartbeat: 'HEARTBEAT.md',
}

function getAgentsBaseDir(): string {
  return path.join(process.env.DATA_DIR ?? '/data', 'agents')
}

function getPersonaDir(agentId: string): string {
  return path.join(getAgentsBaseDir(), agentId)
}

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

/**
 * List all personas.
 */
export function listPersonas(): PersonaListItem[] {
  const baseDir = getAgentsBaseDir()
  const telegramBindings = getTelegramBindings()
  const personas: PersonaListItem[] = []

  // Always include "main"
  const mainFileCount = countPersonaFiles(path.join(baseDir, 'main'))
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
  const dir = getPersonaDir(agentId)
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
    const filePath = path.join(dir, fileName)
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
 * Update persona files.
 */
export function updatePersona(agentId: string, files: Partial<PersonaFiles>): PersonaDetail {
  const dir = getPersonaDir(agentId)

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  for (const [key, content] of Object.entries(files)) {
    const fileName = KEY_TO_FILE[key as keyof PersonaFiles]
    if (!fileName) continue
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, content as string, 'utf-8')
  }

  return getPersona(agentId)
}

/**
 * Default template content for new persona files.
 */
const TEMPLATE_FILES: PersonaFiles = {
  identity: `# IDENTITY.md

- **Name:** (Your Agent Name)
- **Creature:** AI Assistant
- **Vibe:** Helpful, knowledgeable, friendly
- **Emoji:** 🤖
`,
  soul: `# SOUL.md

You are a helpful AI assistant with your own unique personality.

## Core Principles

- Be helpful and respond clearly
- Stay in character
- Provide well-reasoned answers

## Communication Style

- Friendly and approachable
- Concise but thorough when needed
`,
  user: `# USER.md

## User Profile

(Describe the primary user this agent interacts with)
`,
  tools: `# TOOLS.md

## Available Tools

This agent can use the standard OpenAgent toolset.
`,
  agents: `# AGENTS.md

## Agent Rules

Standard agent rules apply.
`,
  heartbeat: `# HEARTBEAT.md

## Heartbeat Tasks

(Define periodic tasks this agent should perform)
`,
}

/**
 * Create a new persona with template files.
 */
export function createPersona(agentId: string): PersonaDetail {
  const dir = getPersonaDir(agentId)

  if (fs.existsSync(dir)) {
    throw new Error(`Persona "${agentId}" already exists`)
  }

  fs.mkdirSync(dir, { recursive: true })

  // Write template files
  for (const [key, content] of Object.entries(TEMPLATE_FILES)) {
    const fileName = KEY_TO_FILE[key as keyof PersonaFiles]
    if (!fileName) continue
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, content, 'utf-8')
  }

  return getPersona(agentId)
}

/**
 * Delete a persona (cannot delete 'main').
 */
export function deletePersona(agentId: string): void {
  if (agentId === 'main') {
    throw new Error('Cannot delete the main persona')
  }

  const dir = getPersonaDir(agentId)

  if (!fs.existsSync(dir)) {
    throw new Error(`Persona "${agentId}" not found`)
  }

  fs.rmSync(dir, { recursive: true, force: true })
}
