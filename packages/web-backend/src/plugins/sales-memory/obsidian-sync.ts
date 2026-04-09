/**
 * obsidian-sync.ts — SSH-based sync to Mac Studio Obsidian Vault.
 *
 * Reads and writes Obsidian Markdown files via SSH to:
 *   Host: 192.168.10.222
 *   User: user
 *   Key:  /data/ssh/id_ed25519
 *   Vault: ~/Obsidian/OpenAgent/
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execAsync = promisify(exec)

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const SSH_HOST = process.env.OBSIDIAN_SSH_HOST ?? '192.168.10.222'
const SSH_USER = process.env.OBSIDIAN_SSH_USER ?? 'user'
const SSH_KEY = process.env.OBSIDIAN_SSH_KEY ?? '/data/ssh/id_ed25519'
const VAULT_BASE = process.env.OBSIDIAN_VAULT_PATH ?? '~/Obsidian/OpenAgent'

const SSH_OPTS = [
  '-o StrictHostKeyChecking=no',
  '-o ConnectTimeout=10',
  '-o BatchMode=yes',
  `-i ${SSH_KEY}`,
].join(' ')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sshCommand(cmd: string): string {
  return `ssh ${SSH_OPTS} ${SSH_USER}@${SSH_HOST} ${JSON.stringify(cmd)}`
}

/**
 * Test SSH connectivity. Returns true if reachable.
 */
export async function testSshConnection(): Promise<boolean> {
  try {
    await execAsync(sshCommand('echo ok'), { timeout: 12000 })
    return true
  } catch {
    return false
  }
}

/**
 * Read a file from the Obsidian vault via SSH.
 * Returns null if the file does not exist.
 */
export async function readObsidianFile(relativePath: string): Promise<string | null> {
  const fullPath = `${VAULT_BASE}/${relativePath}`
  try {
    const { stdout } = await execAsync(sshCommand(`cat ${JSON.stringify(fullPath)}`), { timeout: 15000 })
    return stdout
  } catch (err: unknown) {
    // File not found (exit code 1) is expected — return null
    const error = err as { code?: number }
    if (error?.code === 1) return null
    throw err
  }
}

/**
 * Write a file to the Obsidian vault via SSH.
 * Creates parent directories as needed.
 */
export async function writeObsidianFile(relativePath: string, content: string): Promise<void> {
  const fullPath = `${VAULT_BASE}/${relativePath}`
  const dir = path.dirname(fullPath)

  // Escape content for shell heredoc
  const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")

  const cmd = `mkdir -p ${JSON.stringify(dir)} && printf '%s' '${escaped}' > ${JSON.stringify(fullPath)}`
  await execAsync(sshCommand(cmd), { timeout: 20000 })
}

/**
 * List files in a vault directory via SSH.
 * Returns an array of relative paths (relative to VAULT_BASE).
 */
export async function listObsidianFiles(subDir: string): Promise<string[]> {
  const fullPath = `${VAULT_BASE}/${subDir}`
  try {
    const { stdout } = await execAsync(
      sshCommand(`find ${JSON.stringify(fullPath)} -name '*.md' -type f 2>/dev/null || echo ''`),
      { timeout: 15000 }
    )
    return stdout.trim()
      .split('\n')
      .filter(Boolean)
      .map(f => f.replace(new RegExp(`^.*?Obsidian/OpenAgent/`), ''))
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Project Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known project keyword mappings.
 * Keys are project file names (without .md), values are arrays of keywords.
 */
const PROJECT_KEYWORDS: Record<string, string[]> = {
  'openagent': ['openagent', 'agent', 'salesmemory', 'session', 'telegram bot', 'docker', 'forgejo'],
  'ai-cage-fight': ['cage-fight', 'cage fight', 'ai-cage', 'benchmarking', 'benchmark'],
}

/**
 * Detect which Obsidian project files should be updated based on session facts.
 *
 * @param facts - Array of fact strings extracted from a session
 * @returns Array of project names (without .md) that should be updated
 */
export function detectProjects(facts: string[]): string[] {
  const combined = facts.join(' ').toLowerCase()
  const matches: string[] = []

  for (const [project, keywords] of Object.entries(PROJECT_KEYWORDS)) {
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        if (!matches.includes(project)) matches.push(project)
        break
      }
    }
  }

  return matches
}

// ─────────────────────────────────────────────────────────────────────────────
// Obsidian File Format
// ─────────────────────────────────────────────────────────────────────────────

export interface ObsidianProjectFile {
  project: string
  lastUpdated: string
  tags: string[]
  context: string
  openTodos: string[]
  decisionsAndLearnings: string[]
}

/**
 * Parse an Obsidian project file into structured data.
 */
export function parseObsidianFile(content: string): ObsidianProjectFile {
  const lines = content.split('\n')

  let project = ''
  let lastUpdated = ''
  const tags: string[] = []
  let context = ''
  const openTodos: string[] = []
  const decisionsAndLearnings: string[] = []

  // Parse frontmatter
  let inFrontmatter = false
  let frontmatterDone = false
  let currentSection = ''
  const sectionContent: Record<string, string[]> = {}

  for (const line of lines) {
    if (line.trim() === '---' && !frontmatterDone) {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      } else {
        inFrontmatter = false
        frontmatterDone = true
        continue
      }
    }

    if (inFrontmatter) {
      if (line.startsWith('project:')) {
        project = line.replace('project:', '').trim()
      } else if (line.startsWith('last_updated:')) {
        lastUpdated = line.replace('last_updated:', '').trim()
      } else if (line.startsWith('tags:')) {
        const tagStr = line.replace('tags:', '').trim()
        const tagMatch = tagStr.match(/\[([^\]]*)\]/)
        if (tagMatch) {
          tags.push(...tagMatch[1].split(',').map(t => t.trim()).filter(Boolean))
        }
      }
      continue
    }

    // Parse sections
    if (line.startsWith('## ')) {
      currentSection = line.slice(3).trim()
      sectionContent[currentSection] = []
    } else if (currentSection) {
      sectionContent[currentSection] = sectionContent[currentSection] ?? []
      sectionContent[currentSection].push(line)
    }
  }

  context = (sectionContent['Kontext'] ?? []).join('\n').trim()
  openTodos.push(...(sectionContent['Offene TODOs'] ?? []).filter(l => l.trim().startsWith('-')).map(l => l.trim().slice(1).trim()))
  decisionsAndLearnings.push(...(sectionContent['Entscheidungen & Learnings'] ?? []).filter(l => l.trim().startsWith('-')).map(l => l.trim().slice(1).trim()))

  return { project, lastUpdated, tags, context, openTodos, decisionsAndLearnings }
}

/**
 * Serialize an ObsidianProjectFile to Markdown string.
 */
export function serializeObsidianFile(data: ObsidianProjectFile): string {
  const tagStr = `[${data.tags.join(', ')}]`
  const projectTitle = data.project.charAt(0).toUpperCase() + data.project.slice(1)

  const todosSection = data.openTodos.length > 0
    ? data.openTodos.map(t => `- ${t}`).join('\n')
    : '_Keine offenen TODOs_'

  const dlSection = data.decisionsAndLearnings.length > 0
    ? data.decisionsAndLearnings.map(d => `- ${d}`).join('\n')
    : '_Keine Einträge_'

  return `---
project: ${data.project}
last_updated: ${data.lastUpdated}
tags: ${tagStr}
---

# ${projectTitle}

## Kontext
${data.context || '_Kein Kontext vorhanden_'}

## Offene TODOs
${todosSection}

## Entscheidungen & Learnings
${dlSection}
`
}

/**
 * Update an Obsidian project file with new facts from a session.
 * Creates the file if it doesn't exist.
 *
 * @param projectName  - Name of the project (without .md)
 * @param newFacts     - New facts extracted from the session
 * @param sessionDate  - ISO date string of when the session ended
 */
export async function updateObsidianProject(
  projectName: string,
  newFacts: string[],
  sessionDate: string,
): Promise<void> {
  const relativePath = `projects/${projectName}.md`

  let fileData: ObsidianProjectFile

  try {
    const existing = await readObsidianFile(relativePath)
    if (existing) {
      fileData = parseObsidianFile(existing)
    } else {
      fileData = {
        project: projectName,
        lastUpdated: sessionDate,
        tags: [],
        context: '',
        openTodos: [],
        decisionsAndLearnings: [],
      }
    }
  } catch {
    fileData = {
      project: projectName,
      lastUpdated: sessionDate,
      tags: [],
      context: '',
      openTodos: [],
      decisionsAndLearnings: [],
    }
  }

  // Update last_updated
  fileData.lastUpdated = sessionDate

  // Append new facts as learnings (avoiding duplicates)
  for (const fact of newFacts) {
    const factLower = fact.toLowerCase()
    const isDuplicate = fileData.decisionsAndLearnings.some(
      existing => existing.toLowerCase() === factLower
    )
    if (!isDuplicate) {
      fileData.decisionsAndLearnings.push(fact)
    }
  }

  // Keep a reasonable limit (last 50 entries)
  if (fileData.decisionsAndLearnings.length > 50) {
    fileData.decisionsAndLearnings = fileData.decisionsAndLearnings.slice(-50)
  }

  const content = serializeObsidianFile(fileData)
  await writeObsidianFile(relativePath, content)
}
