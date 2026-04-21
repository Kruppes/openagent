import fs from 'node:fs'
import nodePath from 'node:path'
import type { Agent as PiAgent } from '@mariozechner/pi-agent-core'
import type { Api, ImageContent, Model } from '@mariozechner/pi-ai'
import { completeSimple } from '@mariozechner/pi-ai'
import type { Database } from './database.js'
import { getApiKeyForProvider, buildModel } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import { loadConfig } from './config.js'
import { getUploadsDir } from './uploads.js'
import type { UploadDescriptor } from './uploads.js'
import { SessionManager } from './session-manager.js'
import type { SessionInfo } from './session-manager.js'
import { MessageQueue } from './message-queue.js'
import { createAgentRuntime } from './agent-runtime.js'
import type { AgentRuntimeBoundary, AgentRuntimePiAgentAccess } from './agent-runtime.js'
import type { AgentRuntimeStateSnapshot, ResponseChunk } from './agent-runtime-types.js'
import { resolveBackgroundReasoning } from './thinking-level.js'

export type { ResponseChunk } from './agent-runtime-types.js'
export { createYoloTools, isRetryablePreStreamError } from './agent-runtime.js'

export interface AgentCoreOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: import('@mariozechner/pi-agent-core').AgentTool[]
  memoryDir?: string
  sessionTimeoutMinutes?: number
  baseInstructions?: string
  providerConfig?: ProviderConfig // For OAuth token refresh
  providerManager?: ProviderManager // For fallback retry support
  /** Called when a session ends (timeout or /new command) with the summary text */
  onSessionEnd?: (userId: string, sessionId: string, summary: string | null) => void
}

// Re-export for backward compatibility
export { getWorkspaceDir } from './workspace.js'

/**
 * Agent Core - manages message queue/session lifecycle and delegates runtime internals
 * (tool wiring, prompt assembly, execution orchestration) to AgentRuntimeBoundary.
 *
 * When multi-persona is enabled, maintains a separate AgentRuntime per agentId.
 * Each runtime has its own PiAgent with independent systemPrompt and message history.
 */
export class AgentCore {
  private db: Database
  private sessionManager: SessionManager
  private memoryDir?: string
  private baseInstructions?: string
  private onSessionEndCallback?: (userId: string, sessionId: string, summary: string | null) => void
  private onTaskInjectionChunkCallback?: (chunk: ResponseChunk) => void
  private messageQueue: MessageQueue
  private currentToolUserId?: number
  private currentToolAgentId?: string
  private runtimes: Map<string, AgentRuntimeBoundary> = new Map()
  private runtimeOptions: AgentCoreOptions

  constructor(options: AgentCoreOptions) {
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions
    this.onSessionEndCallback = options.onSessionEnd
    this.runtimeOptions = options

    // Create the default 'main' runtime
    this.runtimes.set('main', this.createRuntimeForAgent('main', options.systemPrompt))

    // Initialize message queue for sequential processing
    this.messageQueue = new MessageQueue()

    // Initialize session manager
    this.sessionManager = new SessionManager({
      db: this.db,
      timeoutMinutes: options.sessionTimeoutMinutes ?? 15,
      memoryDir: options.memoryDir,
      onSummarize: async (_sessionId: string, userId: string, conversationHistory?: string) => {
        return this.generateSessionSummary(userId, conversationHistory)
      },
      onSessionEnd: (session: SessionInfo, summary: string | null) => {
        // Only clear agent messages for non-system sessions.
        // System sessions (from task injections) share the same agent instance,
        // and clearing messages here would wipe the user's conversation history
        // before their session has a chance to generate a summary.
        if (session.userId !== 'system') {
          // Clear messages on the runtime for the session's agentId
          const sessionAgentId = session.agentId ?? 'main'
          const runtime = this.runtimes.get(sessionAgentId)
          if (runtime) {
            runtime.clearMessages()
            this.refreshSystemPrompt(undefined, undefined, sessionAgentId)
          }
        }

        // Notify external listener (e.g. ws-chat)
        if (this.onSessionEndCallback) {
          this.onSessionEndCallback(session.userId, session.id, summary)
        }
      },
    })
  }

  /**
   * Create an AgentRuntime for a specific agentId.
   */
  private createRuntimeForAgent(agentId: string, systemPrompt?: string): AgentRuntimeBoundary {
    return createAgentRuntime({
      model: this.runtimeOptions.model,
      apiKey: this.runtimeOptions.apiKey,
      db: this.runtimeOptions.db,
      systemPrompt,
      tools: this.runtimeOptions.tools,
      memoryDir: this.runtimeOptions.memoryDir,
      baseInstructions: this.runtimeOptions.baseInstructions,
      providerConfig: this.runtimeOptions.providerConfig,
      providerManager: this.runtimeOptions.providerManager,
      getCurrentToolUserId: () => this.currentToolUserId,
      agentId,
    })
  }

  /**
   * Get or lazily create the AgentRuntime for a given agentId.
   */
  private getOrCreateRuntime(agentId: string): AgentRuntimeBoundary {
    let runtime = this.runtimes.get(agentId)
    if (!runtime) {
      runtime = this.createRuntimeForAgent(agentId)
      this.runtimes.set(agentId, runtime)
    }
    return runtime
  }

  /**
   * Initialize async components (must be called after construction).
   * Handles orphaned sessions from previous server runs.
   */
  async init(): Promise<void> {
    await this.sessionManager.init()
  }

  /**
   * Get the session manager.
   */
  getSessionManager(): SessionManager {
    return this.sessionManager
  }

  /**
   * Get the agentId of the currently executing runtime (set during tool execution).
   * Returns undefined when no runtime is actively processing.
   */
  getCurrentToolAgentId(): string | undefined {
    return this.currentToolAgentId
  }

  /**
   * Hot-swap the provider at runtime while preserving conversation context.
   * Updates ALL runtimes so every persona uses the new provider.
   */
  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void {
    // Update stored options so future lazy-created runtimes use the new provider
    this.runtimeOptions = {
      ...this.runtimeOptions,
      providerConfig: provider,
    }
    // Swap on all existing runtimes
    for (const runtime of this.runtimes.values()) {
      runtime.swapProvider(provider, apiKey, modelId)
    }
  }

  /**
   * Get the ProviderManager reference (if configured).
   * Uses the 'main' runtime as the canonical source.
   */
  getProviderManager(): ProviderManager | undefined {
    const mainRuntime = this.runtimes.get('main')
    return mainRuntime?.getProviderManager()
  }

  /**
   * Send a message and get back an async iterable of response chunks.
   * All messages are queued and processed sequentially to prevent collisions.
   */
  async *sendMessage(userId: string, text: string, source: string = 'web', attachments?: UploadDescriptor[], agentId: string = 'main'): AsyncIterable<ResponseChunk> {
    const uploads = attachments
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'user_message',
      userId,
      text,
      source,
      (msg) => {
        return this.processUserMessage(msg.payload.userId, msg.payload.text, msg.payload.source, uploads, agentId)
      },
    )
    yield* iterable
  }

  /**
   * Inject a task result into the agent via the message queue.
   * When agentId is provided, the injection is routed to that persona's runtime
   * instead of defaulting to 'main'. This enables multi-persona task routing:
   * a task started by Warren routes its completion back to Warren's runtime.
   */
  async injectTaskResult(injection: string, agentId?: string): Promise<void> {
    const targetAgentId = agentId ?? 'main'
    const iterable = await this.messageQueue.enqueue<ResponseChunk>(
      'task_injection',
      'system',
      injection,
      'task',
      (msg) => {
        return this.processTaskInjection(msg.payload.text, targetAgentId)
      },
    )
    // Stream response chunks via callback (if set), otherwise drain silently
    for await (const chunk of iterable) {
      this.onTaskInjectionChunkCallback?.(chunk)
    }
  }

  /**
   * Process a user message (called from the queue).
   */
  private async *processUserMessage(userId: string, text: string, source: string, attachments?: UploadDescriptor[], agentId: string = 'main'): AsyncIterable<ResponseChunk> {
    // Use resolveSession with messageText to enable topic-shift detection
    // and fact injection on new sessions / topic shifts
    const session = this.sessionManager.resolveSession(userId, source, text, agentId)
    const sessionId = session.id

    // Resolve username for user profile injection (skip for group chats)
    let currentUser: { username: string } | undefined
    if (source !== 'telegram-group') {
      try {
        const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined
        if (row?.username) {
          currentUser = { username: row.username }
        }
      } catch {
        // userId might not be a numeric ID (e.g. telegram-12345), skip
      }
    }

    // Pass channel as 'telegram' for both DM and group sources
    const channel = source.startsWith('telegram') ? 'telegram' : source
    this.refreshSystemPrompt(channel, currentUser, agentId)
    this.sessionManager.recordMessage(userId, agentId)

    // Consume any pending fact injection (set during resolveSession on
    // new session start or topic shift) and prepend to user message
    const factInjection = this.sessionManager.consumeFactInjection(userId, agentId)
    if (factInjection) {
      text = `${factInjection}\n\n${text}`
    }

    // Build image content and file context from attachments
    const images: ImageContent[] = []
    const fileHints: string[] = []
    if (attachments?.length) {
      for (const att of attachments) {
        if (att.kind === 'image') {
          try {
            const absPath = nodePath.resolve(getUploadsDir(), att.relativePath)
            const buf = fs.readFileSync(absPath)
            images.push({ type: 'image', data: buf.toString('base64'), mimeType: att.mimeType })
          } catch {
            fileHints.push(`[Image upload failed to read: ${att.originalName}]`)
          }
        } else {
          const absPath = nodePath.resolve(getUploadsDir(), att.relativePath)
          fileHints.push(`[Uploaded file: ${att.originalName} (${att.mimeType}, ${att.size} bytes) at ${absPath}]`)
        }
      }
    }

    const enrichedText = fileHints.length > 0 ? `${text}\n\n${fileHints.join('\n')}` : text
    const parsedUserId = Number.parseInt(userId, 10)
    this.currentToolUserId = Number.isFinite(parsedUserId) ? parsedUserId : undefined
    this.currentToolAgentId = agentId

    // Route to the correct runtime for this agentId
    const runtime = this.getOrCreateRuntime(agentId)

    try {
      yield* runtime.streamPrompt(enrichedText, sessionId, images.length > 0 ? images : undefined)
    } finally {
      this.currentToolUserId = undefined
      this.currentToolAgentId = undefined
    }

    // Count the agent response as a message too
    this.sessionManager.recordMessage(userId, agentId)
  }

  /**
   * Process a task injection by sending it through the runtime boundary.
   * Routes to the correct persona runtime based on agentId.
   */
  private async *processTaskInjection(injection: string, agentId: string = 'main'): AsyncIterable<ResponseChunk> {
    const session = this.sessionManager.getOrCreateSession('system', 'task')
    const sessionId = session.id

    this.sessionManager.recordMessage('system')
    this.currentToolUserId = undefined
    this.currentToolAgentId = agentId

    // Route task injection to the originating persona's runtime
    const runtime = this.getOrCreateRuntime(agentId)

    try {
      yield* runtime.streamPrompt(injection, sessionId)
    } finally {
      this.currentToolUserId = undefined
      this.currentToolAgentId = undefined
    }

    // Count the agent response as a message too
    this.sessionManager.recordMessage('system')
  }

  /**
   * Handle /new command: summarize current session and start fresh.
   */
  async handleNewCommand(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * Generate a summary of the current conversation using the LLM.
   * Returns a combined activity log entry that may include an optional
   * "### Offene Fäden" (open threads) section when unresolved items exist.
   */
  private async generateSessionSummary(_userId: string, conversationHistory?: string): Promise<string> {
    // Always use DB conversation history (single source of truth).
    // In-memory agent messages can disappear on provider change or restart,
    // but chat_messages in the DB are always reliable.
    if (!conversationHistory) {
      console.warn('[session-summary] No conversation history available, returning Empty session.')
      return 'Empty session.'
    }

    console.log(`[session-summary] Generating summary for ${conversationHistory.length} chars of history`)

    // Resolve model + apiKey: use dedicated summary provider if configured, else current model
    // Use the 'main' runtime as canonical source for model/apiKey
    const mainRuntime = this.runtimes.get('main')!
    let summaryModel = mainRuntime.getCurrentModel()
    let summaryApiKey = mainRuntime.getCurrentApiKey()
    try {
      const summarySettings = loadConfig<{ sessionSummaryProviderId?: string }>('settings.json')
      const summaryProviderId = summarySettings.sessionSummaryProviderId
      if (summaryProviderId) {
        const { parseProviderModelId, loadProvidersDecrypted } = await import('./provider-config.js')
        const { providerId, modelId } = parseProviderModelId(summaryProviderId)
        if (providerId) {
          const file = loadProvidersDecrypted()
          const summaryProvider = file.providers.find(p => p.id === providerId)
          if (summaryProvider) {
            const resolvedModelId = modelId ?? summaryProvider.defaultModel
            summaryModel = buildModel(summaryProvider, resolvedModelId)
            summaryApiKey = await getApiKeyForProvider(summaryProvider)
            console.log(`[session-summary] Using dedicated provider: ${summaryProvider.name} (${resolvedModelId})`)
          } else {
            console.warn(`[session-summary] Configured summary provider '${providerId}' not found, using active provider`)
          }
        }
      }
    } catch {
      // Settings not available, use current model
    }

    try {
      // Session summary is a background job — use the background thinking level.
      const response = await completeSimple(summaryModel, {
        systemPrompt: `You are writing a chronological activity log entry for this session. Your output will be stored in a daily file so the agent can recall what happened in past sessions (e.g. "yesterday at 14:30 we discussed X and you asked me to do Y").

Your output has two parts:

**Part 1 — Activity Log (always required)**
- Write 2–5 sentences or bullet points. Max 200 words.
- Describe what actually happened: topics discussed, questions answered, decisions made, tasks started or completed, PRs or files created.
- If a background task completed or a task result was injected, mention its outcome (e.g. "PR #15 created for X", "wiki page updated").
- Use neutral, factual tone. No filler words. No meta-commentary about the summary itself.
- Do NOT filter for "memory-worthiness" — this is an activity log, not a memory promotion filter. Even a single answered question is worth one sentence.
- Write "Empty session." ONLY if the transcript contains nothing but greetings or a bare connection with zero substantive content.

**Part 2 — Open Threads (optional)**
If and only if there are genuinely unresolved items, append the following section after the activity log (separated by a blank line):

### Offene Fäden
- <concrete open item>
- <concrete open item>

Open items are: explicitly mentioned but unfinished tasks, background tasks started without a confirmed result, decisions that were deferred, or questions that were not answered.
Do NOT add this section if everything discussed was resolved or if there is nothing left open. Never add an empty "### Offene Fäden" section.`,
        messages: [{
          role: 'user' as const,
          content: `Analyze the following session transcript and write an activity log entry:\n\n<transcript>\n${conversationHistory}\n</transcript>`,
          timestamp: Date.now(),
        }],
      }, {
        apiKey: summaryApiKey,
        temperature: 0,
        reasoning: resolveBackgroundReasoning(),
      })

      const textContent = response.content.filter(c => c.type === 'text')

      if (textContent.length === 0) {
        console.warn('[session-summary] API response contained no text content. Full response.content:', JSON.stringify(response.content))
      }

      const summary = textContent
        .map(c => (c as { type: 'text'; text: string }).text)
        .join('')
        .trim()

      if (!summary) {
        console.warn('[session-summary] Summary was empty after filtering, falling back to "Empty session."')
      }

      return summary || 'Empty session.'
    } catch (err) {
      console.error('Failed to generate session summary:', err)
      return 'Session ended (summary generation failed).'
    }
  }

  /**
   * Set the callback for session end events.
   */
  setOnSessionEnd(callback: (userId: string, sessionId: string, summary: string | null) => void): void {
    this.onSessionEndCallback = callback
  }

  /**
   * Set a callback for response chunks generated when the agent processes a task injection.
   * This allows streaming the agent's natural-language response to connected clients.
   */
  setOnTaskInjectionChunk(callback: (chunk: ResponseChunk) => void): void {
    this.onTaskInjectionChunkCallback = callback
  }

  /**
   * Abort the current agent task on all runtimes.
   */
  abort(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.abort()
    }
  }

  /**
   * Reset a user's session (async - generates summary before reset).
   */
  async resetSession(userId: string): Promise<string | null> {
    const summary = await this.sessionManager.handleNewCommand(userId)
    return summary
  }

  /**
   * End all active sessions and emit session_end events.
   */
  async endAllSessions(): Promise<void> {
    await this.sessionManager.endAllSessions('provider_change')
  }

  /**
   * Refresh the system prompt from current memory state.
   * When agentId is specified, only refreshes that runtime.
   * When agentId is omitted, refreshes ALL runtimes.
   */
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string): void {
    if (agentId) {
      // Get or create the runtime for this agentId, then refresh
      const runtime = this.getOrCreateRuntime(agentId)
      runtime.refreshSystemPrompt(channel, currentUser, agentId)
    } else {
      // Refresh all existing runtimes
      for (const [id, runtime] of this.runtimes) {
        runtime.refreshSystemPrompt(channel, currentUser, id)
      }
    }
  }

  /**
   * Update the thinking/reasoning level used for future agent turns.
   * Accepts any string; invalid values are ignored by the runtime.
   * Updates ALL runtimes.
   */
  setThinkingLevel(level: string): void {
    for (const runtime of this.runtimes.values()) {
      runtime.setThinkingLevel(level)
    }
  }

  /**
   * Refresh skills: rebuild system prompt with current active skills.
   */
  refreshSkills(): void {
    this.refreshSystemPrompt()
  }

  /**
   * Get a stable runtime snapshot for diagnostics/testing.
   * Returns the snapshot from the 'main' runtime by default.
   */
  getRuntimeStateSnapshot(agentId: string = 'main'): AgentRuntimeStateSnapshot {
    const runtime = this.runtimes.get(agentId)
    if (!runtime) {
      return { modelId: '', toolNames: [], messageCount: 0 }
    }
    return runtime.getStateSnapshot()
  }

  /**
   * Get the message queue (for monitoring/testing).
   */
  getMessageQueue(): MessageQueue {
    return this.messageQueue
  }

  /**
   * Get the underlying pi-mono agent (for advanced usage).
   * @deprecated Prefer boundary methods like sendMessage()/abort()/getRuntimeStateSnapshot().
   */
  getAgent(agentId: string = 'main'): PiAgent {
    const runtime = this.getOrCreateRuntime(agentId)
    const runtimeWithAgent = runtime as Partial<AgentRuntimePiAgentAccess>
    if (typeof runtimeWithAgent.getAgent !== 'function') {
      throw new Error('Direct agent access is not available on this runtime implementation.')
    }

    return runtimeWithAgent.getAgent()
  }

  /**
   * Dispose all sessions and clean up.
   */
  async dispose(): Promise<void> {
    await this.sessionManager.dispose()
    this.runtimes.clear()
  }
}
