import { spawn } from 'node:child_process'
import fs from 'node:fs'
import nodePath from 'node:path'
import { Agent as PiAgent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Message, ImageContent, Model } from '@earendil-works/pi-ai'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { estimateCost, getApiKeyForProvider, buildModel, buildStreamFn, loadProvidersDecrypted, parseProviderModelId, getProviderDefaultModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'
import { assembleSystemPrompt, ensureMemoryStructure, ensureConfigStructure, formatCurrentTimeContext } from './memory.js'
import type { SkillPromptEntry, AvailableProviderModelPromptEntry } from './memory.js'
import { loadMultiPersonaSettings } from './config.js'
import { createAskAgentTool, buildAskAgentPromptHint } from './ask-agent-tool.js'
import { getWorkspaceDir } from './workspace.js'
import { loadConfig, ensureConfigTemplates } from './config.js'
import { loadSkills, getSkillDecrypted } from './skill-config.js'
import { createBuiltinWebTools } from './web-tools.js'
import type { BuiltinToolsConfig, BuiltinToolsConfigSource } from './web-tools.js'
import { createTranscribeAudioTool } from './stt-tool.js'
import { loadSttSettings } from './stt.js'
import { createAgentSkillTools, getAgentSkillsForPrompt, getAgentSkillsCount, getAgentSkillsDir, trackAgentSkillUsage, currentPlatform } from './agent-skills.js'
import { createSearchMemoriesTool } from './memories-tool.js'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import type { AgentRuntimeStateSnapshot, ResponseChunk } from './agent-runtime-types.js'

/**
 * Options for the shared base agent tool factory.
 * Both the interactive AgentCore and background task agents use this to
 * build the common tool set — keeping the two paths in sync automatically.
 */
export interface BaseAgentToolsOptions {
  db: Database
  builtinToolsConfig?: BuiltinToolsConfigSource
  sttEnabled?: boolean
  /** Called by search_memories to scope results to the current user. */
  getCurrentUserId?: () => number | undefined
  /**
   * Called by read_chat_history / search_memories to scope results to the
   * calling persona. Non-'main' personas only see their own data; 'main'
   * and callers that omit this stay unscoped (orchestrator behavior).
   */
  getCurrentAgentId?: () => string | undefined
}

/**
 * Build the base tool set shared by the interactive agent and all background
 * task agents (heartbeat, cronjob, user-spawned tasks).
 *
 * Callers add their exclusive tools on top:
 * - Interactive agent: create_task, resume_task, list_tasks, cronjob tools
 * - Background tasks: create_task, resume_task, list_tasks
 */
export function createBaseAgentTools(options: BaseAgentToolsOptions): AgentTool[] {
  return [
    ...createYoloTools(),
    ...createBuiltinWebTools(options.builtinToolsConfig),
    createReadChatHistoryTool({ db: options.db, getCurrentAgentId: options.getCurrentAgentId }),
    createSearchMemoriesTool({
      db: options.db,
      getCurrentUserId: options.getCurrentUserId,
      getCurrentAgentId: options.getCurrentAgentId,
    }),
    ...createAgentSkillTools(),
    ...(options.sttEnabled ? [createTranscribeAudioTool()] : []),
  ]
}

export interface AgentRuntimeOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: AgentTool[]
  memoryDir?: string
  baseInstructions?: string
  providerConfig?: ProviderConfig
  providerManager?: ProviderManager
  getCurrentToolUserId?: () => number | undefined
  /**
   * Reasoning / thinking level applied to every LLM turn. Defaults to the value
   * stored in `settings.json` (`thinkingLevel`), or `off` if not configured.
   */
  thinkingLevel?: SettingsThinkingLevel
  /**
   * Agent ID for multi-persona support. Determines which persona files to load
   * and which agent identity to use for cross-persona tools like ask_agent.
   * Defaults to 'main'.
   */
  agentId?: string
}

export interface AgentRuntimeBoundary {
  streamPrompt(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk>
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string): void
  getCurrentTimeContext(): string
  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void
  getProviderManager(): ProviderManager | undefined
  /** Replace the ProviderManager (hot provider switch keeps fallback machinery intact). */
  setProviderManager(manager: ProviderManager | undefined): void
  clearMessages(): void
  abort(): void
  getStateSnapshot(): AgentRuntimeStateSnapshot
  getCurrentModel(): Model<Api>
  getCurrentApiKey(): string
  /** The current provider config, if the runtime was initialized with one. */
  getCurrentProvider(): ProviderConfig | null
  /** Update the thinking level used for future turns. */
  setThinkingLevel(level: SettingsThinkingLevel | string): void
}

/**
 * Escape hatch for legacy integrations that still need direct pi-agent access.
 * Not part of AgentRuntimeBoundary to keep the abstraction clean.
 */
export interface AgentRuntimePiAgentAccess {
  getAgent(): PiAgent
}

/**
 * Resolve a path relative to WORKSPACE_DIR (consistent across all tools)
 */
function resolveWorkspacePath(filePath: string): string {
  if (nodePath.isAbsolute(filePath)) return filePath
  return nodePath.resolve(getWorkspaceDir(), filePath)
}

const SHELL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/**
 * Inactivity guard for a running turn: if neither the model stream nor a tool
 * produces any agent event for this long, the turn is considered stuck (e.g.
 * a completion promise on a dead connection that never settles — incident
 * 2026-07-19) and gets aborted. This is the PRIMARY hang guard (a real hang
 * shows as silence); it must comfortably exceed the longest silent window a
 * legitimate turn can have. Generous on purpose: autonomous agents (e.g. Kimi
 * K3) run long, multi-step work with slow reasoning + long single tool calls,
 * and killing a still-working turn is worse than waiting (incident 2026-07-20).
 */
const TURN_INACTIVITY_MS = (() => {
  const raw = Number(process.env.AXIOM_TURN_INACTIVITY_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60_000
})()

interface ShellResult {
  output: string
  exitCode: number
  timedOut: boolean
}

/**
 * Run a shell command without blocking the Node event loop.
 *
 * Uses async spawn (not execSync) so the HTTP server stays responsive while a
 * command runs. stdin is closed so interactive prompts (ssh/sudo password) get
 * EOF immediately instead of hanging forever. On timeout the whole process
 * group is SIGKILLed, so backgrounded grandchildren (e.g. an ssh ControlMaster)
 * that hold the stdout pipe open cannot keep the call alive past the deadline.
 */
function runShellCommand(command: string, timeout: number, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let bytes = 0
    let timedOut = false
    let settled = false

    const killGroup = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, timeout)

    const append = (chunk: Buffer, toStderr: boolean) => {
      if (bytes >= SHELL_MAX_OUTPUT_BYTES) return
      bytes += chunk.length
      if (toStderr) stderr += chunk.toString('utf-8')
      else stdout += chunk.toString('utf-8')
    }
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, false))
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, true))

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const parts = [stdout, stderr].filter(Boolean)
      if (timedOut) parts.push(`Command timed out after ${timeout}ms and was killed.`)
      const output = parts.join('\n') || (exitCode === 0 ? '(no output)' : 'Command failed')
      resolve({ output, exitCode, timedOut })
    }

    child.on('error', (err: Error) => {
      stderr += (stderr ? '\n' : '') + err.message
      finish(1)
    })
    child.on('close', (code) => finish(code ?? (timedOut ? 124 : 1)))
  })
}

/**
 * Build YOLO-mode tools that give the agent unrestricted access
 */
export function createYoloTools(): AgentTool[] {
  const shellTool: AgentTool = {
    name: 'shell',
    label: 'Execute Shell Command',
    description: 'Execute a shell command and return stdout/stderr. Use this for any system operation. You run as a non-root user; use sudo for privileged operations (e.g. sudo apt-get install, sudo systemctl).',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 60000)' })),
    }),
    execute: async (_toolCallId, params) => {
      const { command, timeout = 60000 } = params as { command: string; timeout?: number }
      const { output, exitCode } = await runShellCommand(command, timeout, getWorkspaceDir())
      return {
        content: [{ type: 'text' as const, text: output }],
        details: { exitCode },
      }
    },
  }

  const readFileTool: AgentTool = {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file at the given path.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath } = params as { path: string }
      try {
        const resolved = resolveWorkspacePath(filePath)
        let content = fs.readFileSync(resolved, 'utf-8')

        // Detect SKILL.md loads under /data/skills_agent/<name>/
        const agentSkillMdMatch = resolved.match(/\/data\/skills_agent\/([^/]+)\/SKILL\.md$/)
        if (agentSkillMdMatch) {
          const skillDir = nodePath.dirname(resolved)
          content = content.replaceAll('{baseDir}', skillDir)
          const skillName = agentSkillMdMatch[1]
          trackAgentSkillUsage(skillName)
          const header = `Skill directory: ${skillDir}\n\n`
          return {
            content: [{ type: 'text' as const, text: header + content }],
            details: {
              path: resolved,
              size: content.length,
              skillLoad: true,
              skillName,
              agentSkill: true,
            },
          }
        }

        // Detect SKILL.md loads under /data/skills/
        const skillMdMatch = resolved.match(/\/data\/skills\/(.+)\/SKILL\.md$/)
        if (skillMdMatch) {
          const skillDir = nodePath.dirname(resolved)

          // Replace {baseDir} with actual skill directory
          content = content.replaceAll('{baseDir}', skillDir)

          // Look up skill in skills.json and inject env vars
          const injectedVars: string[] = []
          try {
            const skillsFile = loadSkills()
            const matchedSkill = skillsFile.skills.find(s => resolved.startsWith(s.path))
            if (matchedSkill) {
              const decrypted = getSkillDecrypted(matchedSkill.id)
              if (decrypted?.envValues) {
                for (const [key, value] of Object.entries(decrypted.envValues)) {
                  if (value) {
                    process.env[key] = value
                    injectedVars.push(key)
                  }
                }
              }
            }
          } catch {
            // Skills config not available, continue without env injection
          }

          const skillName = skillMdMatch[1] // e.g. "zats/perplexity"
          const header = `Skill directory: ${skillDir}\n\n`
          return {
            content: [{ type: 'text' as const, text: header + content }],
            details: {
              path: resolved,
              size: content.length,
              skillLoad: true,
              skillName,
              envVarsInjected: injectedVars,
            },
          }
        }

        return {
          content: [{ type: 'text' as const, text: content }],
          details: { path: resolved, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error reading file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const writeFileTool: AgentTool = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, content } = params as { path: string; content: string }
      try {
        const resolved = resolveWorkspacePath(filePath)
        const dir = nodePath.dirname(resolved)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully wrote ${content.length} bytes to ${resolved}` }],
          details: { path: resolved, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error writing file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const editFileTool: AgentTool = {
    name: 'edit_file',
    label: 'Edit File',
    description: 'Edit a file using exact text replacements. Each edit specifies an oldText to find and a newText to replace it with. The oldText must match exactly and be unique in the file. Use this instead of write_file when you only need to change specific parts of a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to edit' }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: 'Exact text to find and replace. Must be unique in the file.' }),
          newText: Type.String({ description: 'Replacement text.' }),
        }),
        { description: 'One or more targeted replacements. Each oldText is matched against the original file.' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, edits } = params as { path: string; edits: Array<{ oldText: string; newText: string }> }
      try {
        const resolved = resolveWorkspacePath(filePath)

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: `File not found: ${resolved}` }],
            details: { error: true },
          }
        }

        if (!Array.isArray(edits) || edits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'edits must contain at least one replacement.' }],
            details: { error: true },
          }
        }

        const originalContent = fs.readFileSync(resolved, 'utf-8')
        let content = originalContent

        // Validate all edits first (against original content)
        for (let i = 0; i < edits.length; i++) {
          const { oldText } = edits[i]
          if (!oldText) {
            return {
              content: [{ type: 'text' as const, text: `edits[${i}].oldText must not be empty.` }],
              details: { error: true },
            }
          }
          const occurrences = content.split(oldText).length - 1
          if (occurrences === 0) {
            return {
              content: [{ type: 'text' as const, text: `Could not find edits[${i}].oldText in ${filePath}. The text must match exactly.` }],
              details: { error: true },
            }
          }
          if (occurrences > 1) {
            return {
              content: [{ type: 'text' as const, text: `Found ${occurrences} occurrences of edits[${i}].oldText in ${filePath}. The text must be unique.` }],
              details: { error: true },
            }
          }
        }

        // Apply all edits
        for (const { oldText, newText } of edits) {
          content = content.replace(oldText, newText)
        }

        if (content === originalContent) {
          return {
            content: [{ type: 'text' as const, text: `No changes made to ${filePath}. The replacements produced identical content.` }],
            details: { error: true },
          }
        }

        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
          details: { path: resolved, editsApplied: edits.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error editing file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const listFilesTool: AgentTool = {
    name: 'list_files',
    label: 'List Files',
    description: 'List files and directories at the given path.',
    parameters: Type.Object({
      path: Type.String({ description: 'Directory path to list' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: dirPath } = params as { path: string }
      try {
        const resolved = resolveWorkspacePath(dirPath)
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
        const listing = entries.map(e =>
          `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`
        ).join('\n')
        return {
          content: [{ type: 'text' as const, text: listing || '(empty directory)' }],
          details: { path: resolved, count: entries.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error listing directory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  return [shellTool, readFileTool, writeFileTool, editFileTool, listFilesTool]
}

/**
 * Check if an error is a retryable pre-stream error (429, 5xx, connection refused).
 */
export function isRetryablePreStreamError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // HTTP 429 rate limit
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return true
  }

  // HTTP 5xx server errors
  if (/\b5\d{2}\b/.test(message) || message.includes('internal server error') || message.includes('bad gateway') || message.includes('service unavailable') || message.includes('gateway timeout')) {
    return true
  }

  // Connection errors
  if (message.includes('econnrefused') || message.includes('econnreset') || message.includes('enotfound') || message.includes('connection refused') || message.includes('fetch failed')) {
    return true
  }

  return false
}

/**
 * Detect the "poisoned context" error class: the in-memory message history has
 * a tool_result with no matching tool_use (or vice-versa), typically left by a
 * turn that errored/was refused mid-tool-execution or by a bad compaction
 * boundary. EVERY provider rejects such history, so the session wedges on every
 * subsequent turn until the context is cleared (incident 2026-07-20).
 *
 * Matches both Anthropic ("unexpected `tool_use_id` found in `tool_result`
 * blocks … must have a corresponding `tool_use` block") and OpenAI-style
 * ("tool_call_id … is not found") phrasings.
 */
export function isCorruptedContextError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!message) return false
  return message.includes('tool_use_id')
    || message.includes('tool_call_id')
    || (message.includes('tool_result') && message.includes('tool_use'))
}

/**
 * pi-agent rejects `prompt()` synchronously when a previous run is still marked
 * active ("Agent is already processing a prompt"). When a prior turn was
 * abandoned but its run never settled, this leaks into the NEXT turn even
 * though nothing is really running — recoverable by force-clearing the stale run.
 */
export function isAgentBusyError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  return message.includes('already processing')
}

/**
 * Load active skill entries for system prompt injection.
 */
function getActiveSkillEntries(): SkillPromptEntry[] {
  try {
    const skillsFile = loadSkills()
    return skillsFile.skills
      .filter(s => s.enabled)
      .map(s => ({
        name: s.name,
        description: s.description,
        location: s.path,
      }))
  } catch {
    return []
  }
}

class PiAgentRuntime implements AgentRuntimeBoundary, AgentRuntimePiAgentAccess {
  private agent: PiAgent
  private model: Model<Api>
  private apiKey: string
  private db: Database
  private toolCallTimers: Map<string, number> = new Map() // toolCallId -> startTime
  private toolCallArgs: Map<string, unknown> = new Map() // toolCallId -> args
  private memoryDir?: string
  private baseInstructions?: string
  private providerConfig?: ProviderConfig
  private providerManager?: ProviderManager
  private getCurrentToolUserId: () => number | undefined
  private agentId: string

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model
    this.apiKey = options.apiKey
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions
    this.providerConfig = options.providerConfig
    this.providerManager = options.providerManager
    this.getCurrentToolUserId = options.getCurrentToolUserId ?? (() => undefined)
    this.agentId = options.agentId ?? 'main'

    // Ensure memory/config structure exists before prompt assembly.
    ensureMemoryStructure(options.memoryDir)
    ensureConfigStructure()

    const { sttEnabled, thinkingLevel: storedThinkingLevel } = this.readRuntimeSettings()
    const effectiveThinkingLevel = normalizeThinkingLevel(options.thinkingLevel) ?? storedThinkingLevel ?? 'off'

    const systemPrompt = options.systemPrompt ?? this.buildSystemPrompt(undefined, undefined, this.agentId)

    // Conditionally add the ask_agent tool when multi-persona is enabled.
    //
    // getApiKey must mirror the main PiAgent's OAuth-aware resolver: for OAuth-authenticated
    // providers (e.g. Claude Pro) `this.apiKey` is an empty string and the real token has to
    // be resolved fresh from the provider config on every call. Without this, cross-persona
    // calls hit the provider with an empty key and fail silently.
    const runtimeAgentId = this.agentId
    const providerConfigRef = this.providerConfig
    const askAgentTools: AgentTool[] = loadMultiPersonaSettings().enabled
      ? [createAskAgentTool({
          getCurrentAgentId: () => runtimeAgentId,
          getModel: () => this.model,
          getApiKey: providerConfigRef?.authMethod === 'oauth'
            ? async () => {
                try {
                  const file = loadProvidersDecrypted()
                  const freshProvider = file.providers.find(p => p.id === providerConfigRef.id)
                  if (freshProvider) {
                    return await getApiKeyForProvider(freshProvider)
                  }
                } catch (err) {
                  console.error('[ask_agent] OAuth token refresh failed:', err)
                }
                return this.apiKey
              }
            : () => this.apiKey,
        })]
      : []

    const tools: AgentTool[] = [
      ...(options.tools ?? []),
      ...createBaseAgentTools({
        db: this.db,
        builtinToolsConfig: () => this.readRuntimeSettings().builtinToolsConfig,
        sttEnabled,
        getCurrentUserId: () => this.getCurrentToolUserId(),
        // Each runtime is permanently bound to one persona — scope its
        // history/memory tools to that persona (main stays unscoped).
        getCurrentAgentId: () => this.agentId,
      }),
      ...askAgentTools,
    ]

    this.agent = new PiAgent({
      initialState: {
        systemPrompt,
        model: this.model,
        tools,
        thinkingLevel: effectiveThinkingLevel,
      },
      streamFn: buildStreamFn({
        textVerbosity: this.providerConfig?.textVerbosity,
        transport: this.providerConfig?.transport,
      }),
      ...(this.providerConfig?.transport && this.providerConfig.transport !== 'sse'
        && { transport: this.providerConfig.transport }),
      getApiKey: this.providerConfig?.authMethod === 'oauth'
        ? async () => {
            try {
              // Reload provider config to get latest OAuth credentials
              const { loadProvidersDecrypted } = await import('./provider-config.js')
              const file = loadProvidersDecrypted()
              const freshProvider = file.providers.find(p => p.id === this.providerConfig!.id)
              if (freshProvider) {
                return await getApiKeyForProvider(freshProvider)
              }
            } catch (err) {
              console.error('OAuth token refresh failed:', err)
            }
            return this.apiKey
          }
        : () => this.apiKey,
    })
  }

  streamPrompt(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk> {
    return this.executePromptWithRetry(text, sessionId, false, images)
  }

  refreshSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string): void {
    this.agent.state.systemPrompt = this.buildSystemPrompt(channel, currentUser, agentId ?? this.agentId)
  }

  getCurrentTimeContext(): string {
    const { timezone } = this.readRuntimeSettings()
    return formatCurrentTimeContext(timezone)
  }

  setThinkingLevel(level: SettingsThinkingLevel | string): void {
    const normalized = normalizeThinkingLevel(level)
    if (!normalized) return
    this.agent.state.thinkingLevel = normalized
  }

  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void {
    this.model = buildModel(provider, modelId)
    this.apiKey = apiKey
    this.providerConfig = provider
    this.agent.state.model = this.model
  }

  getProviderManager(): ProviderManager | undefined {
    return this.providerManager
  }

  setProviderManager(manager: ProviderManager | undefined): void {
    this.providerManager = manager
  }

  clearMessages(): void {
    this.agent.state.messages = []
  }

  abort(): void {
    this.agent.abort()
  }

  getAgent(): PiAgent {
    return this.agent
  }

  getStateSnapshot(): AgentRuntimeStateSnapshot {
    return {
      modelId: this.model.id,
      toolNames: this.agent.state.tools.map(tool => tool.name),
      messageCount: this.agent.state.messages.length,
    }
  }

  getCurrentModel(): Model<Api> {
    return this.model
  }

  getCurrentApiKey(): string {
    return this.apiKey
  }

  getCurrentProvider(): ProviderConfig | null {
    return this.providerConfig ?? null
  }

  private readRuntimeSettings(): {
    language: string | undefined
    timezone: string | undefined
    builtinToolsConfig: BuiltinToolsConfig | undefined
    sttEnabled: boolean
    thinkingLevel: SettingsThinkingLevel | undefined
  } {
    let language: string | undefined
    let timezone: string | undefined
    let builtinToolsConfig: BuiltinToolsConfig | undefined
    let thinkingLevel: SettingsThinkingLevel | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{
        language?: string
        timezone?: string
        builtinTools?: BuiltinToolsConfig
        thinkingLevel?: string
      }>('settings.json')
      language = settings.language
      timezone = settings.timezone
      builtinToolsConfig = settings.builtinTools
      thinkingLevel = normalizeThinkingLevel(settings.thinkingLevel)
    } catch {
      // Config not available yet, use defaults
    }

    let sttEnabled = false
    try {
      sttEnabled = loadSttSettings().enabled
    } catch {
      // STT settings not available
    }

    return { language, timezone, builtinToolsConfig, sttEnabled, thinkingLevel }
  }

  private buildSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string): string {
    const { language, timezone, builtinToolsConfig, sttEnabled } = this.readRuntimeSettings()

    const activeSkills = getActiveSkillEntries()
    // Build a skill-prompt context so agent skills can be gated by the current
    // platform / active toolset and annotated with missing required env vars.
    const activeTools = new Set<string>([
      'shell', 'read_file', 'write_file', 'edit_file', 'list_files',
      'create_task', 'resume_task', 'list_tasks',
      'create_cronjob', 'edit_cronjob', 'remove_cronjob', 'list_cronjobs', 'get_cronjob',
      'create_reminder',
      'read_chat_history', 'search_memories', 'list_agent_skills',
    ])
    if (builtinToolsConfig?.webSearch?.enabled !== false) activeTools.add('web_search')
    if (builtinToolsConfig?.webFetch?.enabled !== false) activeTools.add('web_fetch')
    if (sttEnabled) activeTools.add('transcribe_audio')

    const agentSkillEntries = getAgentSkillsForPrompt({
      platform: currentPlatform(),
      activeTools,
    })
    const totalAgentSkills = getAgentSkillsCount()
    const allSkills = [...activeSkills, ...agentSkillEntries]

    const builtinToolsPromptConfig = {
      ...builtinToolsConfig,
      stt: { enabled: sttEnabled },
    }

    // Provider/model inventory — lets the agent translate user-facing
    // model names (e.g. "kimi-k2.6") into the right `provider`/`model`
    // arguments for create_task / create_cronjob / edit_cronjob, and route
    // background tasks to models the user annotated with a description.
    // Failures here are non-fatal: the tools still work without this hint,
    // the agent just has to guess or ask.
    let availableProviders: Array<{ name: string; models: AvailableProviderModelPromptEntry[] }> | undefined
    try {
      const file = loadProvidersDecrypted()
      const activeProviderId = file.activeProvider ?? null

      let taskProviderId: string | null = null
      let taskModelId: string | undefined
      try {
        ensureConfigTemplates()
        const settings = loadConfig<{ tasks?: { defaultProvider?: string } }>('settings.json')
        const taskDefault = settings.tasks?.defaultProvider
        if (taskDefault) {
          const parsed = parseProviderModelId(taskDefault)
          if (parsed.providerId) {
            taskProviderId = parsed.providerId
            taskModelId = parsed.modelId
          }
        }
      } catch {
        // settings not available yet — no task default label
      }

      availableProviders = file.providers.map(p => {
        const enabled = p.enabledModels ?? []
        const activeModelForProvider = p.id === activeProviderId ? (file.activeModel ?? getProviderDefaultModel(p)) : null
        const models: AvailableProviderModelPromptEntry[] = enabled.map(id => {
          const entry = p.models?.find(m => m.id === id)
          const isDefaultAgentModel = p.id === activeProviderId && id === activeModelForProvider
          const isDefaultTaskModel = p.id === taskProviderId && id === (taskModelId ?? getProviderDefaultModel(p))
          return {
            id,
            description: entry?.description,
            isDefaultAgentModel: isDefaultAgentModel || undefined,
            isDefaultTaskModel: isDefaultTaskModel || undefined,
          }
        })
        return { name: p.name, models }
      })
    } catch {
      availableProviders = undefined
    }

    let prompt = assembleSystemPrompt({
      memoryDir: this.memoryDir,
      baseInstructions: this.baseInstructions,
      language,
      timezone,
      channel,
      skills: allSkills,
      agentSkillsOverflowCount: totalAgentSkills > 10 ? totalAgentSkills : undefined,
      currentUser,
      builtinTools: builtinToolsPromptConfig,
      agentSkillsDir: getAgentSkillsDir(),
      availableProviders,
      agentId,
    })

    // Append cross-persona hint when ask_agent is available.
    if (loadMultiPersonaSettings().enabled) {
      const hint = buildAskAgentPromptHint(agentId ?? 'main')
      if (hint) {
        prompt += hint
      }
    }

    return prompt
  }

  /**
   * Execute a prompt with optional fallback retry on pre-stream errors.
   */
  private async *executePromptWithRetry(text: string, sessionId: string, isRetry: boolean = false, images?: ImageContent[]): AsyncIterable<ResponseChunk> {
    const eventQueue: AgentEvent[] = []
    let resolveWaiting: (() => void) | null = null
    let done = false
    let preStreamError: unknown = null
    let midStreamError: unknown = null

    const unsubscribe = this.agent.subscribe((event: AgentEvent) => {
      eventQueue.push(event)
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    // Start the prompt (non-blocking)
    const promptPromise = this.agent.prompt(text, images).then(() => {
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    }).catch((err) => {
      // If no events have been received yet, this is a pre-stream error
      if (eventQueue.length === 0) {
        preStreamError = err
      } else {
        // Mid-stream error — surface error to the user, then signal agent_end
        console.error('Agent prompt error (mid-stream):', err)
        midStreamError = err
        eventQueue.push({ type: 'agent_end', messages: [] })
      }
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    let yieldedDone = false

    // Per-turn accounting so a turn that ends with zero visible output is
    // diagnosable from the logs (incident 2026-07-20: silent empty turns).
    let textChars = 0
    let thinkingChars = 0
    let toolCalls = 0
    let errorChunks = 0
    let corruptedContext = false

    try {
      while (true) {
        // Process all queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          const chunks = this.processEvent(event, sessionId)
          for (const chunk of chunks) {
            if (chunk.type === 'done') yieldedDone = true
            if (chunk.type === 'text') textChars += chunk.text?.length ?? 0
            if (chunk.type === 'thinking') thinkingChars += chunk.thinking?.length ?? 0
            if (chunk.type === 'tool_call_start') toolCalls++
            if (chunk.type === 'error') {
              // Suppress the raw provider corruption error (ugly, and we emit a
              // friendly recovery notice after auto-clearing below).
              if (isCorruptedContextError(chunk.error)) {
                corruptedContext = true
                continue
              }
              errorChunks++
            }
            yield chunk
          }
        }

        if (done && eventQueue.length === 0) break

        // Wait for more events — bounded by the inactivity watchdog so a
        // completion whose promise never settles cannot hang the turn (and
        // with it the sequential message queue) forever.
        const outcome = await new Promise<'event' | 'inactivity'>(resolve => {
          const timer = setTimeout(() => resolve('inactivity'), TURN_INACTIVITY_MS)
          if (typeof timer === 'object' && 'unref' in timer) timer.unref()
          resolveWaiting = () => {
            clearTimeout(timer)
            resolve('event')
          }
        })
        resolveWaiting = null

        if (outcome === 'inactivity') {
          console.error(`[agent-runtime] Turn watchdog: no agent events for ${Math.round(TURN_INACTIVITY_MS / 1000)}s — aborting turn (session ${sessionId})`)
          try {
            this.agent.abort()
          } catch {
            // best effort — the turn is abandoned either way
          }
          midStreamError = new Error(`Keine Aktivität für ${Math.round(TURN_INACTIVITY_MS / 60_000)} Minuten — Turn abgebrochen. Bitte Nachricht erneut senden.`)
          break
        }
      }
    } finally {
      unsubscribe()
      // Normally settled once `done` is set; after a watchdog abort it may
      // never settle (that's the failure mode we're guarding against), so
      // never await it unbounded.
      await Promise.race([
        promptPromise,
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, 10_000)
          if (typeof t === 'object' && 'unref' in t) t.unref()
        }),
      ])
      // If the run is STILL active after the bounded wait, abort it and let it
      // settle on its own — pi-agent's handleRunFailure then clears activeRun.
      // We deliberately do NOT force-clear activeRun here: nulling it out from
      // under a live run makes pi-agent throw "Agent listener invoked outside
      // active run" when a late event (e.g. a delayed connection error) arrives
      // (incident 2026-07-20). A run that truly ignores the abort is rare and
      // self-recovers once it eventually settles.
      if (!done) {
        console.error(`[agent-runtime] Turn generator closing with run still active (session ${sessionId}) — aborting orphaned run`)
        try {
          this.agent.abort()
        } catch {
          // best effort
        }
      }
    }

    // One line per turn — this is the primary forensic breadcrumb for
    // "bot went silent" reports: it shows exactly what the model returned.
    console.log(`[agent-runtime] Turn end (session ${sessionId}): text=${textChars} thinking=${thinkingChars} tools=${toolCalls} errors=${errorChunks}${midStreamError ? ' midStreamError' : ''}${preStreamError ? ' preStreamError' : ''}${corruptedContext ? ' corruptedContext' : ''}`)
    if (textChars === 0 && toolCalls === 0 && errorChunks === 0 && !midStreamError && !preStreamError && !corruptedContext) {
      console.warn(`[agent-runtime] EMPTY TURN (session ${sessionId}): model produced no text, no tool calls, no error — thinking=${thinkingChars} chars. Provider degradation?`)
    }

    // Surface mid-stream errors (e.g. context window exceeded after tool calls)
    if (midStreamError) {
      const errMsg = (midStreamError instanceof Error ? midStreamError.message : String(midStreamError)) || 'Unknown error'
      console.error('Agent mid-stream error surfaced to user:', errMsg)
      if (isCorruptedContextError(midStreamError)) corruptedContext = true
      yield { type: 'error' as const, error: errMsg }
    }
    if (preStreamError && isCorruptedContextError(preStreamError)) corruptedContext = true

    // Self-heal a poisoned context: a dangling tool_use/tool_result pair wedges
    // EVERY provider on EVERY subsequent turn. Clear the in-memory history so
    // the next message starts clean instead of requiring a manual /new or a
    // container restart (incident 2026-07-20). The DB chat history is untouched;
    // only the live agent context is reset.
    if (corruptedContext) {
      console.error(`[agent-runtime] Corrupted context detected (session ${sessionId}) — auto-clearing in-memory history to unwedge the session`)
      try {
        this.clearMessages()
      } catch (err) {
        console.error('[agent-runtime] Failed to auto-clear corrupted context:', err)
      }
      yield { type: 'error' as const, error: '⚠️ Der Gesprächskontext war beschädigt und wurde automatisch zurückgesetzt. Bitte sende deine letzte Nachricht noch einmal.' }
    }

    // Safety net: if no 'done' chunk was yielded (e.g. agent_end never fired),
    // ensure we always signal completion so the frontend doesn't hang.
    if (!yieldedDone && !preStreamError) {
      yield { type: 'done' as const }
    }

    // Handle pre-stream error with fallback retry
    if (preStreamError) {
      // "Agent is already processing" means a PRIOR turn's run is still live
      // (long autonomous work whose queue slot the watchdog released early).
      // Surface an honest, non-destructive notice — do NOT force-clear the
      // live run (that caused "listener invoked outside active run",
      // incident 2026-07-20). The running turn finishes on its own.
      if (isAgentBusyError(preStreamError)) {
        console.warn(`[agent-runtime] prompt() rejected as busy (session ${sessionId}) — a previous turn is still running; asking user to retry`)
        yield { type: 'error' as const, error: '⚠️ Es läuft noch eine vorherige, länger dauernde Anfrage. Bitte warte, bis sie fertig ist, und sende die Nachricht dann erneut.' }
        yield { type: 'done' as const }
        return
      }

      const canRetry = !isRetry
        && this.providerManager
        && this.providerManager.getOperatingMode() === 'normal'
        && this.providerManager.getFallbackProvider() !== null
        && isRetryablePreStreamError(preStreamError)

      if (canRetry) {
        console.warn('[AgentRuntime] Pre-stream error detected, swapping to fallback provider:', (preStreamError as Error).message)
        this.providerManager!.swapToFallback()
        const fallback = this.providerManager!.getEffectiveProvider()!
        const apiKey = await getApiKeyForProvider(fallback)
        this.swapProvider(fallback, apiKey)

        // Retry once with fallback
        yield* this.executePromptWithRetry(text, sessionId, true, images)
        return
      }

      // No retry possible — surface the error
      console.error('Agent prompt error (pre-stream):', preStreamError)
      yield { type: 'error' as const, error: (preStreamError as Error).message ?? String(preStreamError) }
      yield { type: 'done' as const }
    }
  }

  /**
   * Process an agent event into response chunks.
   */
  private processEvent(event: AgentEvent, sessionId: string): ResponseChunk[] {
    const chunks: ResponseChunk[] = []

    switch (event.type) {
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent.type === 'text_delta') {
          chunks.push({
            type: 'text',
            text: assistantEvent.delta,
          })
        } else if (assistantEvent.type === 'thinking_delta') {
          chunks.push({
            type: 'thinking',
            thinking: assistantEvent.delta,
          })
        }
        break
      }

      case 'message_end': {
        const msg = event.message as Message
        if (msg.role === 'assistant') {
          const assistantMsg = msg as AssistantMessage
          // Log token usage
          const cost = estimateCost(
            this.model,
            assistantMsg.usage.input,
            assistantMsg.usage.output,
            assistantMsg.usage.cacheRead,
            assistantMsg.usage.cacheWrite,
          )

          // Use pi-mono cost if available and non-zero, otherwise our estimate
          const finalCost = assistantMsg.usage.cost.total > 0
            ? assistantMsg.usage.cost.total
            : cost

          logTokenUsage(this.db, {
            provider: assistantMsg.provider,
            model: assistantMsg.model,
            promptTokens: assistantMsg.usage.input,
            completionTokens: assistantMsg.usage.output,
            estimatedCost: finalCost,
            sessionId,
          })

          // pi-agent-core swallows run failures (e.g. exhausted provider
          // retries) into a synthetic assistant message with empty text and
          // only `errorMessage`/`stopReason` set — the event sequence looks
          // like a clean turn. Without surfacing this, the user gets pure
          // silence (incident 2026-07-20, overnight empty turns).
          const failure = assistantMsg as { stopReason?: string; errorMessage?: string }
          if (failure.errorMessage || failure.stopReason === 'error') {
            const errText = failure.errorMessage ?? 'Unknown model error'
            console.error(`[agent-runtime] Assistant message carries error (stopReason=${failure.stopReason ?? 'n/a'}, session ${sessionId}): ${errText}`)
            chunks.push({ type: 'error', error: `Modellfehler: ${errText}` })
          }
        }
        break
      }

      case 'tool_execution_start': {
        this.toolCallTimers.set(event.toolCallId, Date.now())
        this.toolCallArgs.set(event.toolCallId, event.args)
        chunks.push({
          type: 'tool_call_start',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolArgs: event.args,
        })
        break
      }

      case 'tool_execution_end': {
        const startTime = this.toolCallTimers.get(event.toolCallId) ?? Date.now()
        const durationMs = Date.now() - startTime
        const args = this.toolCallArgs.get(event.toolCallId) ?? {}
        this.toolCallTimers.delete(event.toolCallId)
        this.toolCallArgs.delete(event.toolCallId)

        // Log tool call
        logToolCall(this.db, {
          sessionId,
          toolName: event.toolName,
          input: JSON.stringify(args),
          output: JSON.stringify(event.result ?? {}),
          durationMs,
        })

        chunks.push({
          type: 'tool_call_end',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolResult: event.result,
          toolIsError: event.isError,
        })
        break
      }

      case 'agent_end': {
        chunks.push({ type: 'done' })
        break
      }
    }

    return chunks
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntimeBoundary {
  return new PiAgentRuntime(options)
}
