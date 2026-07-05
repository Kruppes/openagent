import {
  AgentCore,
  backfillMemoryEmbeddings,
  withTimeout,
  AgentHeartbeatService,
  buildModel,
  createBaseAgentTools,
  createCronjobTool,
  createReminderTool,
  createSendFileTool,
  createResumeTaskTool,
  createTaskRuntime,
  createTaskTool,
  loadSttSettings,
  deliverTaskNotification,
  deliverTaskStatusUpdate,
  resolveTaskNotificationSessionId,
  editCronjobTool,
  ensureConfigStructure,
  ensureConfigTemplates,
  ensureMemoryStructure,
  getMemoryDir,
  getActiveModelId,
  getActiveProvider,
  getApiKeyForProvider,
  getCronjobTool,
  getFallbackModelId,
  getFallbackProvider,
  initDatabase,
  injectSecretsIntoEnv,
  listCronjobsTool,
  listTasksTool,
  loadConfig,
  storeFact,
  loadMultiPersonaSettings,
  loadProvidersDecrypted,
  resolveProviderModelInput,
  logToolCall,
  parseProviderModelId,
  getProviderDefaultModel,
  ProviderManager,
  SessionManager,
  removeCronjobTool,
  TaskEventBus,
} from '@axiom/core'
import type {
  BuiltinToolsConfig,
  Database,
  LoopDetectionConfig,
  ProviderConfig,
  StartModelTaskResult,
  TaskRuntimeBoundary,
  TaskRuntimeTaskBoundary,
} from '@axiom/core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { completeSimple } from '@earendil-works/pi-ai/compat'
import { randomUUID } from 'node:crypto'
import { createTelegramBot, createTelegramBotPool } from '@axiom/telegram'
import type { TelegramBot, TelegramBotPool, TelegramChatEvent } from '@axiom/telegram'
import { ChatEventBus } from '../chat-event-bus.js'
import { triggerFactExtractionForSessionEnd } from '../fact-extraction-session-end.js'
import { HealthMonitorService } from '../health-monitor.js'
import { MemoryConsolidationScheduler } from '../memory-consolidation-scheduler.js'
import { QuotaMonitorService } from '../quota-monitor.js'
import { RuntimeMetrics } from '../runtime-metrics.js'
import { UploadCleanupService } from '../upload-cleanup.js'

interface PendingTaskInjectionMeta {
  taskId: string
  userId: number
  /**
   * The interactive session id that will receive the streamed injection
   * response AND the persisted `task_result` chat_messages row. Pre-resolved
   * by `AgentCore.resolveInjectionSessionId` and forced into the injection
   * stream via `injectTaskResult(..., forcedSessionId)` so both the caller's
   * persistence path and the streamed chunks agree on the same session
   * without relying on FIFO ordering.
   */
  sessionId: string
  /**
   * Unique per-injection correlation token. Used as the map key so
   * multiple concurrent task completions targeting the same user's
   * cached session (which share a `sessionId`) do not collide. The same
   * token is threaded through `injectTaskResult(..., injectionId)` and
   * tagged onto every emitted chunk as `chunk.injectionId`.
   */
  injectionId: string
  /**
   * Persona the task belongs to. Deterministically sourced from the task
   * row (never LLM-inferred); routes the injection into the persona's
   * runtime/session and the Telegram delivery to the persona's bot.
   */
  agentId: string
}

interface TaskSettings {
  defaultProvider: string
  maxDurationMinutes: number
  telegramDelivery: string
  loopDetection: {
    enabled: boolean
    method: string
    maxConsecutiveFailures: number
    smartProvider: string
    smartCheckInterval: number
  }
  statusUpdates: {
    enabled: boolean
    intervalMinutes: number
  }
  verification: {
    enabled: boolean
    providerId: string
  }
}

interface RuntimeSettings {
  sessionTimeoutMinutes: number
  taskSettings: TaskSettings
  builtinToolsConfig: BuiltinToolsConfig | undefined
}

export interface RuntimeComposition {
  db: Database
  runtimeMetrics: RuntimeMetrics
  healthMonitorService: HealthMonitorService
  quotaMonitorService: QuotaMonitorService
  consolidationScheduler: MemoryConsolidationScheduler
  agentHeartbeatService: AgentHeartbeatService
  uploadCleanupService: UploadCleanupService
  taskEventBus: TaskEventBus
  chatEventBus: ChatEventBus
  getAgentCore: () => AgentCore | null
  getTaskRuntime: () => TaskRuntimeBoundary
  /**
   * Resolve a provider by id or case-insensitive name. Exposed so HTTP
   * handlers (e.g. the tasks restart endpoint) can look up providers the
   * user selected in the UI without duplicating the provider registry.
   */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /**
   * Current task default provider — same source of truth as the task
   * runner and cronjob scheduler.
   */
  getTaskDefaultProvider: () => ProviderConfig
  /**
   * Names of the tools the task runner gives to background task agents.
   * Exposed so the cronjob UI can render the current tool list dynamically
   * instead of hardcoding a stale copy.
   */
  getBackgroundTaskToolNames: () => string[]
  getTelegramBot: () => TelegramBot | null
  onTelegramSettingsChanged: () => void
  onActiveProviderChanged: () => void
  setWebSocketChatPresenceChecker: (checker: { hasActiveWebSocket: (userId: number) => boolean } | null) => void
  stopBackgroundServices: () => Promise<void>
}

export interface RuntimeCompositionOptions {
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>
}

export function loadRuntimeSettings(): RuntimeSettings {
  let sessionTimeoutMinutes = 30
  const taskSettings: TaskSettings = {
    defaultProvider: '',
    maxDurationMinutes: 60,
    telegramDelivery: 'auto',
    loopDetection: {
      enabled: true,
      method: 'systematic',
      maxConsecutiveFailures: 3,
      smartProvider: '',
      smartCheckInterval: 5,
    },
    statusUpdates: {
      enabled: false,
      intervalMinutes: 10,
    },
    verification: {
      enabled: true,
      providerId: '',
    },
  }

  let builtinToolsConfig: BuiltinToolsConfig | undefined

  try {
    const settings = loadConfig<{
      sessionTimeoutMinutes?: number
      tasks?: Partial<TaskSettings>
      builtinTools?: BuiltinToolsConfig
      braveSearchApiKey?: string
      searxngUrl?: string
      tavilyApiKey?: string
    }>('settings.json')

    // Accept 0 explicitly: 0 = never expire (disable time-based session cutting).
    if (typeof settings.sessionTimeoutMinutes === 'number' && settings.sessionTimeoutMinutes >= 0) {
      sessionTimeoutMinutes = settings.sessionTimeoutMinutes
    }

    if (settings.tasks) {
      const tasksConfig = settings.tasks as Partial<TaskSettings> & { statusUpdateIntervalMinutes?: number }
      taskSettings.defaultProvider = tasksConfig.defaultProvider ?? taskSettings.defaultProvider
      taskSettings.maxDurationMinutes = tasksConfig.maxDurationMinutes ?? taskSettings.maxDurationMinutes
      taskSettings.telegramDelivery = tasksConfig.telegramDelivery ?? taskSettings.telegramDelivery

      // New sub-object wins; legacy flat `statusUpdateIntervalMinutes` is
      // migrated into the interval only (enabled stays false so upgrades
      // stay silent until the operator opts in).
      if (tasksConfig.statusUpdates) {
        const legacyInterval = typeof tasksConfig.statusUpdateIntervalMinutes === 'number' && tasksConfig.statusUpdateIntervalMinutes > 0
          ? tasksConfig.statusUpdateIntervalMinutes
          : undefined
        taskSettings.statusUpdates = {
          ...taskSettings.statusUpdates,
          ...(legacyInterval !== undefined && tasksConfig.statusUpdates.intervalMinutes === undefined
            ? { intervalMinutes: legacyInterval }
            : {}),
          ...tasksConfig.statusUpdates,
        }
      } else if (typeof tasksConfig.statusUpdateIntervalMinutes === 'number' && tasksConfig.statusUpdateIntervalMinutes > 0) {
        taskSettings.statusUpdates.intervalMinutes = tasksConfig.statusUpdateIntervalMinutes
      }

      if (tasksConfig.loopDetection) {
        taskSettings.loopDetection = {
          ...taskSettings.loopDetection,
          ...tasksConfig.loopDetection,
        }
      }

      if (tasksConfig.verification) {
        taskSettings.verification = {
          ...taskSettings.verification,
          ...tasksConfig.verification,
        }
      }
    }

    builtinToolsConfig = settings.builtinTools

    // Migrate legacy top-level keys into builtinTools.webSearch
    if (settings.braveSearchApiKey && !builtinToolsConfig?.webSearch?.braveSearchApiKey) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        braveSearchApiKey: settings.braveSearchApiKey,
      }
    }

    if (settings.searxngUrl && !builtinToolsConfig?.webSearch?.searxngUrl) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        searxngUrl: settings.searxngUrl,
      }
    }

    if (settings.tavilyApiKey && !builtinToolsConfig?.webSearch?.tavilyApiKey) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        tavilyApiKey: settings.tavilyApiKey,
      }
    }
  } catch {
    // use default values
  }

  return {
    sessionTimeoutMinutes,
    taskSettings,
    builtinToolsConfig,
  }
}

function escapeHtmlForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeReminderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^⏰\s*/u, '')
    .replace(/^(reminder|erinnerung)\s*:\s*/u, '')
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
}

function areReminderFieldsDistinct(name: string, message: string): boolean {
  const normalizedName = normalizeReminderText(name)
  const normalizedMessage = normalizeReminderText(message)

  if (!normalizedName || !normalizedMessage) return normalizedName !== normalizedMessage
  if (normalizedName === normalizedMessage) return false
  if (normalizedMessage.includes(normalizedName) || normalizedName.includes(normalizedMessage)) return false

  return true
}

function formatReminderTelegramHtml(name: string, message: string): string {
  if (!areReminderFieldsDistinct(name, message)) {
    const singleLine = message.trim() || name.trim()
    return `⏰ ${escapeHtmlForTelegram(singleLine)}`
  }

  return `⏰ <b>${escapeHtmlForTelegram(name)}</b>\n\n${escapeHtmlForTelegram(message)}`
}

function parseNumericUserId(userId: string): number | null {
  const trimmed = userId.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const numericUserId = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(numericUserId) ? numericUserId : null
}

export async function createRuntimeComposition(options: RuntimeCompositionOptions = {}): Promise<RuntimeComposition> {
  const logger = options.logger ?? console

  logger.log('[axiom] Initializing database...')
  const db = initDatabase()

  logger.log('[axiom] Ensuring config templates...')
  ensureConfigTemplates()

  logger.log('[axiom] Ensuring memory structure...')
  ensureMemoryStructure()
  ensureConfigStructure()

  logger.log('[axiom] Injecting global secrets into environment...')
  injectSecretsIntoEnv()

  const runtimeMetrics = new RuntimeMetrics()
  const { sessionTimeoutMinutes, taskSettings } = loadRuntimeSettings()

  function getCurrentTaskSettings(): TaskSettings {
    return loadRuntimeSettings().taskSettings
  }

  function resolveProvider(nameOrId: string): ProviderConfig | null {
    try {
      const file = loadProvidersDecrypted()
      return file.providers.find(
        p => p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase(),
      ) ?? null
    } catch {
      return null
    }
  }

  function getTaskDefaultProvider(): ProviderConfig {
    const currentTaskSettings = getCurrentTaskSettings()
    if (currentTaskSettings.defaultProvider) {
      const { providerId, modelId } = parseProviderModelId(currentTaskSettings.defaultProvider)
      if (providerId) {
        let resolved = resolveProvider(providerId)
        if (resolved && modelId) {
          resolved = { ...resolved, enabledModels: [modelId] }
        }
        if (resolved) return resolved
      }
    }

    // "Active provider (default)": follow the live chat selection for BOTH
    // provider and model. Downstream task creation derives the model via
    // getProviderDefaultModel() (= enabledModels[0]), so we narrow the cloned
    // provider to the active model. Without this, tasks would pick the
    // provider's first enabled model instead of the user's active model — and
    // if enabledModels is empty they'd run with no model at all and fail.
    const active = getActiveProvider()!
    const activeModelId = getActiveModelId()
    if (activeModelId) {
      return { ...active, enabledModels: [activeModelId] }
    }
    return active
  }

  const chatEventBus = new ChatEventBus()
  const taskEventBus = new TaskEventBus()

  // Shared SessionManager dedicated to background producers (tasks,
  // heartbeat, consolidation, scheduled jobs, reminders). It only uses
  // `createSession()` to register UUID-based session rows; the per-user
  // interactive session lifecycle is owned by AgentCore's own SessionManager.
  const backgroundSessions = new SessionManager({ db })

  let wsChatPresenceChecker: ((userId: number) => boolean) | null = null

  let agentCore: AgentCore | null = null
  let providerManager: ProviderManager | null = null
  let telegramBot: TelegramBot | null = null
  // Multi-persona mode: one TelegramBot per persona account. `telegramBot`
  // then points at the pool's primary bot for backward compatibility.
  let telegramBotPool: TelegramBotPool | null = null

  /**
   * Resolve the Telegram bot bound to a persona. Falls back to the primary
   * bot when no pool is running or the persona has no dedicated bot.
   */
  function resolveTelegramBotForAgent(agentId: string | null | undefined): TelegramBot | null {
    if (agentId && telegramBotPool) {
      return telegramBotPool.getBot(agentId) ?? telegramBot
    }
    return telegramBot
  }

  // Pending task injections keyed by a per-injection UUID. The key is
  // minted here, passed into AgentCore.injectTaskResult as the
  // `injectionId`, and tagged onto every emitted chunk
  // (`chunk.injectionId`) so the handler can correlate chunks with
  // metadata.
  //
  // We MUST key by a per-call token — not by session id — because
  // multiple concurrent task completions for the same user resolve to
  // the same cached interactive session id, and a shared key would
  // collide: the second handleTaskNotification would overwrite the
  // first's metadata before either had streamed.
  const pendingInjections = new Map<string, PendingTaskInjectionMeta>()

  // Reuse one session row per scheduled-reminder id instead of creating a
  // fresh session on every fire. Keeps `sessions` growth O(number of
  // reminders) instead of O(fires). The cache is per-process; after a
  // restart a new session row is created for the reminder's first post-
  // restart fire.
  const reminderSessionByCronjobId = new Map<string, string>()
  function resolveReminderSessionId(cronjobId: string): string {
    const existing = reminderSessionByCronjobId.get(cronjobId)
    if (existing) return existing
    const newId = backgroundSessions.createSession({
      type: 'task',
      source: 'system',
    }).id
    reminderSessionByCronjobId.set(cronjobId, newId)
    return newId
  }
  function evictReminderSession(cronjobId: string): void {
    reminderSessionByCronjobId.delete(cronjobId)
  }

  /**
   * Strictly parse a numeric user id. `Number.parseInt` is too lax
   * (`parseInt('3abc', 10) === 3`) and would silently route task results
   * to the wrong user when `session_user` is a non-numeric username or a
   * malformed string that happens to start with digits. Reject anything
   * that isn't a pure integer literal.
   */
  function parseStrictUserId(value: string | number | null | undefined): number | null {
    if (value == null) return null
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? value : null
    }
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) return null
    const parsed = Number(trimmed)
    return Number.isSafeInteger(parsed) ? parsed : null
  }

  /**
   * Resolve the target user for a task result notification by walking the
   * task's session lineage back to the triggering interactive session.
   * Returns null when the task has no interactive parent (cronjob,
   * heartbeat, consolidation) — callers fall back to a default user.
   *
   * User-id precedence when both columns are populated:
   *   1. `session_user` (the canonical identity written by
   *      `SessionManager.getOrCreateSession`, always matches the runtime
   *      userId; for numeric web/telegram users this is `String(n)`).
   *   2. `user_id` (only populated for sessions recovered by the legacy
   *      migration — derived from child-table user_id columns).
   *
   * `session_user` is preferred because it reflects the caller's identity
   * at session creation time; `user_id` is a best-effort backfill.
   */
  function resolveTargetUserIdForTask(taskSessionId: string | null | undefined): number | null {
    if (!taskSessionId) return null
    // Walk up parent_session_id chain until we find a row whose own
    // parent_session_id is NULL. The top-most session is the triggering
    // interactive session.
    let currentId: string | null = taskSessionId
    let safety = 10
    while (currentId && safety-- > 0) {
      const row = db.prepare(
        'SELECT parent_session_id, user_id, session_user FROM sessions WHERE id = ?'
      ).get(currentId) as {
        parent_session_id: string | null
        user_id: number | null
        session_user: string | null
      } | undefined
      if (!row) return null
      if (!row.parent_session_id) {
        // Prefer session_user (canonical identity) over user_id (backfill).
        // Use a strict integer match — `parseInt('3abc', 10) === 3` would
        // otherwise silently route results to the wrong user.
        const parsedSessionUser = parseStrictUserId(row.session_user)
        if (parsedSessionUser !== null) return parsedSessionUser
        const parsedUserId = parseStrictUserId(row.user_id)
        if (parsedUserId !== null) return parsedUserId
        return null
      }
      currentId = row.parent_session_id
    }
    return null
  }

  /**
   * Fallback user when a task has no interactive lineage (cronjob,
   * heartbeat). Uses the lowest-id user in the `users` table. Throws if
   * the query fails or no user exists — an empty users table means the
   * system is misconfigured (admin is provisioned by `ensureAdminUser`
   * during bootstrap), and a DB error must not be silently hidden by
   * returning a hardcoded id that may not exist.
   */
  function getFallbackUserId(): number {
    const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined
    if (!row || !Number.isSafeInteger(row.id)) {
      throw new Error('getFallbackUserId: no users in database (admin not provisioned?)')
    }
    return row.id
  }

  function handleTaskNotification(taskId: string, injection: string, taskRuntime: TaskRuntimeTaskBoundary, agentIdFromTask: string | null): void {
    const task = taskRuntime.getById(taskId)
    if (!task) return

    // Persona routing: prefer the agentId handed through the task-runner
    // callback, fall back to the task row. Deterministic data, never
    // LLM-inferred.
    const effectiveAgentId = agentIdFromTask ?? task.agentId ?? 'main'

    const startMs = task.startedAt ? new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const endMs = task.completedAt ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const durationMinutes = Math.round((endMs - startMs) / 60000)

    // Resolve target user from the task's session lineage; fall back to
    // the default user when the task has no interactive parent (e.g.
    // cronjob/heartbeat triggered). A non-null task.sessionId with an
    // unresolvable lineage (deleted parent row, chain > depth cap, or
    // malformed linkage) is not an intended fallback — log it so the
    // mis-routed delivery is diagnosable instead of silently reaching the
    // fallback user.
    const resolvedUserId = resolveTargetUserIdForTask(task.sessionId)
    if (resolvedUserId == null && task.sessionId) {
      logger.warn(
        `[axiom] Task ${task.id}: could not resolve target user from session lineage (sessionId=${task.sessionId}); falling back to default user`,
      )
    }
    const userId = resolvedUserId ?? getFallbackUserId()

    // Lineage session (parent interactive, or the task's own session as a
    // last resort). May be null for legacy tasks without sessionId — the
    // helper now returns null instead of throwing so a bad legacy row
    // cannot corrupt task-completion state via the onTaskComplete callback
    // chain.
    const lineageSessionId = resolveTaskNotificationSessionId(db, task)

    // Pre-resolve the single session id that both the persisted `task_result`
    // row AND the streamed injection response will use. This guarantees
    // both writes land in the same session (no split between the old
    // lineage parent and a newly minted interactive session).
    //
    // Correlation between streamed chunks and the pending metadata uses
    // a separate per-injection UUID — NOT the session id — because
    // multiple concurrent task completions for the same user share the
    // same cached session id and would otherwise collide in the map.
    let injectionSessionId: string | null = null
    if (agentCore) {
      injectionSessionId = agentCore.resolveInjectionSessionId(String(userId), lineageSessionId, effectiveAgentId)
      const injectionId = randomUUID()
      pendingInjections.set(injectionId, {
        taskId: task.id,
        userId,
        sessionId: injectionSessionId,
        injectionId,
        agentId: effectiveAgentId,
      })
      const forcedSessionId = injectionSessionId
      agentCore.injectTaskResult(injection, String(userId), forcedSessionId, injectionId, effectiveAgentId).catch(err => {
        logger.error(`[axiom] Failed to inject task result for ${taskId}:`, err)
        pendingInjections.delete(injectionId)
      })
    }

    // Prefer the pre-resolved injection session for persistence so the
    // task-result row and the streamed response share a session. Fall back
    // to the lineage session when no agent core is available (background
    // delivery path). `targetSessionId` may still be undefined — in that
    // case `persistTaskResultMessage` logs and skips rather than throwing.
    const targetSessionId = injectionSessionId ?? lineageSessionId ?? undefined

    deliverTaskNotification({
      db,
      userId,
      task,
      durationMinutes,
      targetSessionId,
      telegramDeliveryMode: (taskSettings.telegramDelivery as 'auto' | 'always') ?? 'auto',
      hasActiveWebSocket: (uid: number) => wsChatPresenceChecker?.(uid) ?? false,
      broadcastEvent: (event) => {
        chatEventBus.broadcast({
          type: event.type,
          userId: event.userId,
          source: 'task',
          taskId: event.taskId,
          taskName: event.taskName,
          taskSummary: event.taskSummary,
          taskDurationMinutes: event.taskDurationMinutes,
          taskTokensUsed: event.taskTokensUsed,
          taskTriggerType: event.taskTriggerType,
        })
      },
    }).catch(err => {
      logger.error(`[axiom] Failed to deliver task notification for ${taskId}:`, err)
    })
  }

  /**
   * Periodic progress signal while a background task is still running.
   * Mirrors `handleTaskNotification` but intentionally routes through a
   * non-LLM delivery path: persist to chat_messages (so history shows it),
   * broadcast on chatEventBus (so live web clients render a progress
   * line), and optionally send via Telegram respecting the user's
   * `telegramDelivery` setting. No `agentCore.injectTaskResult` call —
   * status updates are ephemeral heartbeats, not new chat turns the
   * parent agent should respond to.
   */
  function handleStatusUpdateNotification(
    taskId: string,
    _statusMessage: string,
    details: {
      taskName: string
      runtimeMinutes: number
      toolCallCount: number
      totalTokens: number
    },
    taskRuntime: TaskRuntimeTaskBoundary,
  ): void {
    const task = taskRuntime.getById(taskId)
    if (!task) return

    const resolvedUserId = resolveTargetUserIdForTask(task.sessionId)
    const userId = resolvedUserId ?? getFallbackUserId()
    const statusAgentId = task.agentId ?? 'main'

    const lineageSessionId = resolveTaskNotificationSessionId(db, task)
    // Prefer the user's currently-cached interactive session (via
    // `AgentCore.resolveInjectionSessionId`) so the heartbeat lands in the
    // chat the user is actually looking at. Fall back to the lineage
    // parent when there is no cached session AND no injection resolver
    // — `deliverTaskStatusUpdate` skips the persist step (with a warn)
    // if `targetSessionId` is still undefined.
    const injectionSessionId = agentCore
      ? agentCore.resolveInjectionSessionId(String(userId), lineageSessionId, statusAgentId)
      : null
    const targetSessionId = injectionSessionId ?? lineageSessionId ?? undefined

    const statusBot = resolveTelegramBotForAgent(statusAgentId)
    const telegramChatId = statusBot ? statusBot.getTelegramChatIdForUser(userId) : null
    const sendTelegram = statusBot && telegramChatId
      ? (html: string) => statusBot.sendTaskNotification(telegramChatId, html, task.id)
      : undefined

    deliverTaskStatusUpdate({
      db,
      userId,
      task,
      details,
      targetSessionId,
      telegramDeliveryMode: (taskSettings.telegramDelivery as 'auto' | 'always') ?? 'auto',
      hasActiveWebSocket: (uid: number) => wsChatPresenceChecker?.(uid) ?? false,
      sendTelegram,
      broadcastEvent: (event) => {
        chatEventBus.broadcast({
          type: event.type,
          userId: event.userId,
          source: 'task',
          sessionId: targetSessionId,
          taskId: event.taskId,
          taskName: event.taskName,
          taskTriggerType: event.taskTriggerType,
          taskStatusContent: event.content,
          taskStatusRuntimeMinutes: event.details.runtimeMinutes,
          taskStatusToolCallCount: event.details.toolCallCount,
          taskStatusTokensUsed: event.details.totalTokens,
        })
      },
    }).catch(err => {
      logger.error(`[axiom] Failed to deliver task status update for ${taskId}:`, err)
    })
  }

  // Background task tools are built as a mutable array so that
  // create_task / list_tasks can be pushed in after taskRuntime is
  // available (they need taskRuntime.tasks — resolved below).
  const backgroundSttEnabled = (() => { try { return loadSttSettings().enabled } catch { return false } })()
  // createBaseAgentTools builds the shared tool set (yolo, web, chat-history,
  // search-memories, agent-skills, transcribe-audio). Both the interactive
  // AgentCore (via agent-runtime.ts) and background tasks use the same factory,
  // so adding a new base tool in one place automatically covers both paths.
  const backgroundTaskTools: AgentTool[] = createBaseAgentTools({
    db,
    builtinToolsConfig: () => loadRuntimeSettings().builtinToolsConfig,
    sttEnabled: backgroundSttEnabled,
    // Background tasks have no interactive session; search_memories will fall
    // back to the lowest-id user when getCurrentUserId is undefined.
  })

  const taskRuntime = createTaskRuntime({
    db,
    runner: {
      buildModel,
      getApiKey: getApiKeyForProvider,
      sessionManager: backgroundSessions,
      tools: backgroundTaskTools,
      // Absolute memory location in every task agent's system prompt —
      // without this, weaker models resolve `memory/...` relative to
      // /workspace and read nothing (nightly consolidation no-op incident).
      memoryDir: getMemoryDir(),
      onTaskComplete: (taskId: string, injection: string, agentId: string | null) => {
        handleTaskNotification(taskId, injection, taskRuntime.tasks, agentId)
      },
      onTaskPaused: (taskId: string, injection: string, agentId: string | null) => {
        handleTaskNotification(taskId, injection, taskRuntime.tasks, agentId)
      },
      onStatusUpdate: (taskId: string, statusMessage: string, details) => {
        handleStatusUpdateNotification(taskId, statusMessage, details, taskRuntime.tasks)
      },
      loopDetection: taskSettings.loopDetection.enabled
        ? {
            enabled: true,
            method: taskSettings.loopDetection.method as LoopDetectionConfig['method'],
            maxConsecutiveFailures: taskSettings.loopDetection.maxConsecutiveFailures,
            smartProvider: taskSettings.loopDetection.smartProvider || undefined,
            smartCheckInterval: taskSettings.loopDetection.smartCheckInterval,
          }
        : undefined,
      statusUpdates: taskSettings.statusUpdates,
      verification: taskSettings.verification,
      getProviderById: (id: string) => resolveProvider(id),
      taskEventBus,
      // Watchdog fallback for tasks that never set maxDurationMinutes
      // (heartbeat, consolidation, cronjobs, scheduled tasks). Without
      // this a hung LLM call would leave the row at status='running'
      // forever. Per-task limits still take precedence when set.
      defaultMaxDurationMinutes: taskSettings.maxDurationMinutes,
    },
    scheduler: {
      getDefaultProvider: getTaskDefaultProvider,
      resolveProvider,
      onInjection: (scheduledTask) => {
        const userId = 1
        const deliveryResults: string[] = []

        // Reuse one `sessions` row per scheduled reminder (keyed by cronjob
        // id) so `sessions` growth is bounded by the number of reminders
        // rather than the number of fires. A reminder firing hourly would
        // otherwise add 8760 session rows per year; with the cache each fire
        // appends a new `tool_calls` row under the same session.
        const reminderSessionId = resolveReminderSessionId(scheduledTask.id)

        chatEventBus.broadcast({
          type: 'reminder',
          userId,
          source: 'task',
          reminderMessage: scheduledTask.prompt,
          reminderName: scheduledTask.name,
          cronjobId: scheduledTask.id,
        })
        deliveryResults.push('chatEventBus: broadcast sent')

        // Deliver via the bot bound to the reminder's persona (falls back
        // to the primary bot when no pool is running).
        const reminderBot = resolveTelegramBotForAgent(scheduledTask.agentId)
        if (reminderBot) {
          const chatId = reminderBot.getTelegramChatIdForUser(userId)
          if (chatId) {
            const telegramHtml = formatReminderTelegramHtml(scheduledTask.name, scheduledTask.prompt)
            reminderBot.sendTaskNotification(chatId, telegramHtml).then(ok => {
              const status = ok ? 'sent' : 'failed'
              logToolCall(db, {
                sessionId: reminderSessionId,
                toolName: 'reminder_delivery',
                input: JSON.stringify({
                  cronjobId: scheduledTask.id,
                  name: scheduledTask.name,
                  message: scheduledTask.prompt,
                  schedule: scheduledTask.schedule,
                }),
                output: JSON.stringify({
                  telegramChatId: chatId,
                  telegramStatus: status,
                  deliveryResults: [...deliveryResults, `telegram: ${status} (chat ${chatId})`],
                }),
                durationMs: 0,
                status: ok ? 'success' : 'error',
              })
            }).catch(err => {
              logger.error(`[axiom] Failed to send Telegram reminder for ${scheduledTask.id}:`, err)
              logToolCall(db, {
                sessionId: reminderSessionId,
                toolName: 'reminder_delivery',
                input: JSON.stringify({
                  cronjobId: scheduledTask.id,
                  name: scheduledTask.name,
                  message: scheduledTask.prompt,
                  schedule: scheduledTask.schedule,
                }),
                output: JSON.stringify({
                  error: (err as Error).message,
                  deliveryResults: [...deliveryResults, `telegram: error - ${(err as Error).message}`],
                }),
                durationMs: 0,
                status: 'error',
              })
            })
            logger.log(`[axiom] Reminder "${scheduledTask.name}" sent via Telegram to chat ${chatId}`)
          } else {
            deliveryResults.push('telegram: no linked chat for this user (requires approved telegram_users entry linked to the same user_id)')
            logger.log(`[axiom] No linked Telegram chat for user ${userId}`)

            chatEventBus.broadcast({
              type: 'system',
              userId,
              source: 'task',
              text: 'Telegram reminder could not be delivered: no approved Telegram account is linked to this user. Open Settings → Telegram, let the Telegram account message the bot, then approve and assign it to this user.',
            })

            logToolCall(db, {
              sessionId: reminderSessionId,
              toolName: 'reminder_delivery',
              input: JSON.stringify({
                cronjobId: scheduledTask.id,
                name: scheduledTask.name,
                message: scheduledTask.prompt,
                schedule: scheduledTask.schedule,
              }),
              output: JSON.stringify({ deliveryResults }),
              durationMs: 0,
              status: 'error',
            })
          }
        } else {
          deliveryResults.push('telegram: bot not available')
          logger.log(`[axiom] No Telegram bot available for reminder "${scheduledTask.name}"`)

          chatEventBus.broadcast({
            type: 'system',
            userId,
            source: 'task',
            text: 'Telegram reminder could not be delivered because the Telegram bot is not available.',
          })

          logToolCall(db, {
            sessionId: reminderSessionId,
            toolName: 'reminder_delivery',
            input: JSON.stringify({
              cronjobId: scheduledTask.id,
              name: scheduledTask.name,
              message: scheduledTask.prompt,
              schedule: scheduledTask.schedule,
            }),
            output: JSON.stringify({ deliveryResults }),
            durationMs: 0,
            status: 'error',
          })
        }

        logger.log(`[axiom] Reminder "${scheduledTask.name}" fired for user ${userId}`)
      },
    },
  })

  const taskToolsOptions = {
    taskRuntime: taskRuntime.tasks,
    getDefaultProvider: getTaskDefaultProvider,
    resolveProvider,
    defaultMaxDurationMinutes: taskSettings.maxDurationMinutes,
    maxDurationMinutesCap: taskSettings.maxDurationMinutes * 2,
    // Link new task sessions to the user's current interactive session via
    // sessions.parent_session_id. Returns null when no interactive session
    // is active (e.g. tool invoked from a background context).
    getParentSessionId: () => agentCore?.getCurrentInteractiveSessionId() ?? null,
    // Attribute new tasks to the persona whose runtime invoked the tool so
    // their results route back to the same persona (runtime + Telegram bot).
    getCurrentAgentId: () => agentCore?.getCurrentToolAgentId(),
  }

  // Now that taskRuntime exists, push create_task / list_tasks into the
  // background-task tool set. The task runner holds a reference to the
  // backgroundTaskTools array, so all subsequently started tasks
  // (heartbeat, cronjob, user-spawned) will see these tools.
  // Background tasks never have an active interactive session, so
  // getParentSessionId always returns null here.
  const backgroundTaskToolsOptions = {
    ...taskToolsOptions,
    getParentSessionId: () => null as string | null,
  }
  backgroundTaskTools.push(
    createTaskTool(backgroundTaskToolsOptions),
    createResumeTaskTool(backgroundTaskToolsOptions),
    listTasksTool({ taskRuntime: taskRuntime.tasks }),
  )

  // Wrap the schedule boundary so deleting a cronjob also evicts its
  // cached reminder session id. Without this, a cronjob deleted mid-
  // process leaves a dangling entry in `reminderSessionByCronjobId`
  // (and an abandoned `sessions` row) that lives for the lifetime of
  // the process.
  const cronjobSchedulesForTools = new Proxy(taskRuntime.schedules, {
    get(target, prop, receiver) {
      if (prop === 'delete') {
        return (id: string) => {
          const deleted = target.delete(id)
          if (deleted) evictReminderSession(id)
          return deleted
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  const cronjobToolsOptions = {
    taskRuntime: cronjobSchedulesForTools,
    // Attribute new cronjobs to the persona whose runtime invoked the tool.
    getCurrentAgentId: () => agentCore?.getCurrentToolAgentId(),
  }

  // Exclusive tools for the interactive agent only.
  // The base tool set (shell, web, chat-history, memories, skills, stt) is
  // assembled inside agent-runtime.ts via createBaseAgentTools() and does NOT
  // need to be listed here — that keeps both paths in sync automatically.
  const agentTools = [
    createTaskTool(taskToolsOptions),
    createResumeTaskTool(taskToolsOptions),
    listTasksTool({ taskRuntime: taskRuntime.tasks }),
    createCronjobTool(cronjobToolsOptions),
    editCronjobTool(cronjobToolsOptions),
    removeCronjobTool(cronjobToolsOptions),
    listCronjobsTool(cronjobToolsOptions),
    getCronjobTool(cronjobToolsOptions),
    createReminderTool(cronjobToolsOptions),
    // `send_file_to_user` needs late-bound access to the active turn's user
    // id and interactive session id — both are set on `agentCore` at the
    // start of every `processUserMessage`/`processTaskInjection` call.
    // Agents built without a running AgentCore (e.g. background task
    // runner) never invoke this tool because its `getCurrentToolUserId`
    // returns `undefined` and the tool refuses to run.
    createSendFileTool({
      getCurrentToolUserId: () => agentCore?.getCurrentToolUserId(),
      getCurrentInteractiveSessionId: () => agentCore?.getCurrentInteractiveSessionId() ?? null,
    }),
  ]

  /**
   * Compact tail of the user's recent conversation with a persona, for
   * injection into prefix-command tasks. Without this, a `/fable mach das`
   * task has zero idea what "das" refers to. Deterministic (no LLM call):
   * last N user/assistant messages, oldest first, hard char cap.
   */
  function buildChatContextBlock(userId: string, agentId: string, maxMessages = 15, maxChars = 4000): string | null {
    try {
      const rows = db.prepare(
        `SELECT role, content FROM chat_messages
         WHERE user_id = ? AND agent_id = ? AND role IN ('user','assistant') AND content != ''
         ORDER BY id DESC LIMIT ?`
      ).all(Number(userId), agentId, maxMessages) as Array<{ role: string; content: string }>
      if (rows.length === 0) return null

      const lines: string[] = []
      let used = 0
      // rows are newest-first; walk and keep until the budget is spent, then
      // reverse so the block reads oldest → newest.
      for (const row of rows) {
        const text = row.content.length > 600 ? `${row.content.slice(0, 600)}…` : row.content
        const line = `${row.role === 'user' ? 'User' : 'Assistant'}: ${text}`
        if (used + line.length > maxChars) break
        lines.push(line)
        used += line.length
      }
      if (lines.length === 0) return null
      lines.reverse()
      return `<chat_context>\nRecent conversation with the user (oldest first) — use it to resolve references in the task:\n${lines.join('\n')}\n</chat_context>`
    } catch {
      return null
    }
  }

  /**
   * Start a one-off background task pinned to a specific model — backs the
   * /fable-style Telegram prefix commands. The task inherits the caller's
   * persona and links its session lineage to the user's interactive session
   * so the result routes back to the right chat and Telegram bot. The
   * default chat model is untouched.
   */
  async function startPinnedModelTask(input: {
    modelId: string
    prompt: string
    agentId: string
    userId: string | null
    source: string
  }): Promise<StartModelTaskResult> {
    const resolved = resolveProviderModelInput({ model: input.modelId })
    if (!resolved.ok) throw new Error(resolved.error)
    const baseProvider = resolveProvider(resolved.providerId)
    if (!baseProvider) throw new Error(`Provider "${resolved.providerName}" not found`)
    // Narrow the provider clone to the pinned model — the task runner derives
    // its model via getProviderDefaultModel() (= enabledModels[0]).
    const provider = { ...baseProvider, enabledModels: [resolved.modelId] }

    const promptPreview = input.prompt.length > 60 ? `${input.prompt.slice(0, 60)}…` : input.prompt
    const contextBlock = input.userId
      ? buildChatContextBlock(String(input.userId), input.agentId)
      : null
    const taskPrompt = contextBlock
      ? `${contextBlock}\n\nTask: ${input.prompt}`
      : input.prompt
    const task = taskRuntime.tasks.create({
      name: `${resolved.modelId}: ${promptPreview}`,
      prompt: taskPrompt,
      triggerType: 'user',
      provider: provider.name,
      model: resolved.modelId,
      isDefaultModel: false,
      maxDurationMinutes: taskSettings.maxDurationMinutes,
      agentId: input.agentId,
    })

    // Link lineage to the user's interactive session so
    // resolveTargetUserIdForTask delivers the result to this user.
    let parentSessionId: string | null = null
    if (agentCore && input.userId) {
      parentSessionId = agentCore.getSessionManager()
        .getOrCreateSession(String(input.userId), input.source, input.agentId).id
    }
    await taskRuntime.tasks.start(task, provider, undefined, parentSessionId)

    return {
      taskId: task.id,
      taskName: task.name,
      providerName: provider.name,
      modelId: resolved.modelId,
    }
  }

  /**
   * Draft a short execution plan for a pinned-model task BEFORE the heavy
   * model starts — shown to the user for ✅/❌ approval. Runs on the
   * verification provider when configured (cheap/local), else the active
   * chat provider. Never on the heavy target model itself.
   */
  async function draftTaskPlan(input: { prompt: string; agentId: string; userId: string | null }): Promise<string> {
    const cfg = getCurrentTaskSettings().verification
    const provider = (cfg.providerId ? resolveProvider(cfg.providerId) : null) ?? getActiveProvider()
    if (!provider) throw new Error('No provider available for plan drafting')

    const model = buildModel(provider, getProviderDefaultModel(provider) || undefined)
    const apiKey = await getApiKeyForProvider(provider)
    const contextBlock = input.userId ? buildChatContextBlock(String(input.userId), input.agentId, 8, 2000) : null

    // Hard timeout: the user is actively waiting for the ✅/❌ buttons, and
    // a dead local endpoint would otherwise hang this forever (the caller
    // falls back to a direct start on error).
    const response = await withTimeout(completeSimple(model, {
      systemPrompt:
        'You draft execution plans for autonomous background tasks. ' +
        'Produce a concise plan: max 6 short bullet points, concrete steps, no preamble, no closing remarks. ' +
        'If the request is ambiguous, make the most reasonable assumption and note it as the last bullet.',
      messages: [{
        role: 'user' as const,
        content: `${contextBlock ? `${contextBlock}\n\n` : ''}Task request: ${input.prompt}`,
        timestamp: Date.now(),
      }],
    }, {
      apiKey,
      temperature: 0,
    }), 60_000, 'Task plan draft')

    const text = response.content
      .filter((item) => item.type === 'text')
      .map((item) => (item as { type: 'text'; text: string }).text)
      .join('')
      .trim()
    if (!text) throw new Error('Plan drafting returned no text')
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text
  }

  /**
   * Deterministic handler for Telegram replies to task messages.
   * paused → resume with the user's text; running → status hint;
   * finished → follow-up task on the same provider/model + persona,
   * carrying the previous prompt/result as context.
   */
  async function handleTelegramTaskReply(input: {
    taskId: string
    text: string
    agentId: string
    userId: string | null
    source: string
  }): Promise<string> {
    const task = taskRuntime.tasks.getById(input.taskId)
    if (!task) return '⚠️ Task not found (may have been cleaned up).'

    if (task.status === 'paused') {
      const resumed = await taskRuntime.tasks.resume(input.taskId, input.text)
      return resumed
        ? `▶️ Answer passed to task "${task.name}" — it continues in the background.`
        : '⚠️ Task could not be resumed.'
    }

    if (task.status === 'running') {
      return `⏳ Task "${task.name}" is still running — reply again once it has finished.`
    }

    // completed / failed → follow-up task with previous prompt+result as context
    const baseProvider = task.provider ? resolveProvider(task.provider) : null
    const provider = baseProvider && task.model
      ? { ...baseProvider, enabledModels: [task.model] }
      : (baseProvider ?? getTaskDefaultProvider())

    const prevPrompt = task.prompt.length > 3000 ? `${task.prompt.slice(0, 3000)}…` : task.prompt
    const prevResult = (task.resultSummary ?? '(no result summary)').slice(0, 4000)
    const followUpPrompt = [
      '<previous_task>',
      `Status: ${task.status}${task.resultStatus ? ` (${task.resultStatus})` : ''}`,
      `Prompt:\n${prevPrompt}`,
      `Result:\n${prevResult}`,
      '</previous_task>',
      '',
      `Follow-up from the user: ${input.text}`,
    ].join('\n')

    const previewText = input.text.length > 50 ? `${input.text.slice(0, 50)}…` : input.text
    const followUp = taskRuntime.tasks.create({
      name: `Follow-up: ${previewText}`,
      prompt: followUpPrompt,
      triggerType: 'user',
      provider: provider.name,
      model: getProviderDefaultModel(provider),
      isDefaultModel: !task.provider,
      maxDurationMinutes: taskSettings.maxDurationMinutes,
      agentId: input.agentId,
    })

    let parentSessionId: string | null = null
    if (agentCore && input.userId) {
      parentSessionId = agentCore.getSessionManager()
        .getOrCreateSession(String(input.userId), input.source, input.agentId).id
    }
    await taskRuntime.tasks.start(followUp, provider, undefined, parentSessionId)

    return `🔁 Follow-up task started on ${provider.name} (${getProviderDefaultModel(provider)}).\nTask: ${followUp.name}\nID: ${followUp.id}`
  }

  /**
   * Inline-button actions on Telegram task messages: kill a running task or
   * store 👍/👎 feedback as a memory fact (picked up by the nightly
   * consolidation, so personas learn what worked).
   */
  async function handleTelegramTaskAction(input: {
    taskId: string
    action: 'kill' | 'feedback_up' | 'feedback_down'
    agentId: string
    userId: string | null
  }): Promise<string> {
    const task = taskRuntime.tasks.getById(input.taskId)
    if (!task) return 'Task not found.'

    if (input.action === 'kill') {
      if (task.status !== 'running' && task.status !== 'paused') {
        return `Task is already ${task.status}.`
      }
      taskRuntime.tasks.abort(input.taskId, 'Killed via Telegram button')
      return '🗑 Task killed.'
    }

    const positive = input.action === 'feedback_up'
    const numericUserId = input.userId ? parseStrictUserId(input.userId) : null
    storeFact(
      db,
      numericUserId,
      task.sessionId ?? `task-feedback-${task.id}`,
      `User rated the result of background task "${task.name}" (persona: ${input.agentId}, model: ${task.model ?? 'default'}) as ${positive ? 'good 👍' : 'not good 👎'}.${positive ? '' : ' When handling similar tasks, reconsider the approach that was used here.'}`,
    )
    return positive ? '👍 Feedback saved.' : '👎 Feedback saved — flows into memory consolidation.'
  }

  taskRuntime.schedules.start()

  const healthMonitorService = new HealthMonitorService({ db, providerManager: null })
  healthMonitorService.start()

  const quotaMonitorService = new QuotaMonitorService()
  quotaMonitorService.start()

  const consolidationScheduler = new MemoryConsolidationScheduler({
    db,
    agentCore: null,
    taskRuntime: taskRuntime.tasks,
    getDefaultProvider: getTaskDefaultProvider,
    sessionManager: backgroundSessions,
  })
  consolidationScheduler.start()

  const agentHeartbeatService = new AgentHeartbeatService({
    taskRuntime: taskRuntime.tasks,
    getDefaultProvider: getTaskDefaultProvider,
  })
  agentHeartbeatService.start()

  const uploadCleanupService = new UploadCleanupService(db)
  uploadCleanupService.start()

  const onTelegramChatEvent = (event: TelegramChatEvent) => {
    if (event.userId == null) return
    chatEventBus.broadcast({
      type: event.type,
      userId: event.userId,
      source: 'telegram',
      sessionId: event.sessionId,
      text: event.text,
      thinking: event.thinking,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      toolArgs: event.toolArgs,
      toolResult: event.toolResult,
      toolIsError: event.toolIsError,
      senderName: event.senderName,
      attachment: event.attachment,
      replyContext: event.replyContext,
    })
  }

  function wireAgentCoreEvents(): void {
    if (!agentCore) return

    agentCore.setOnSessionEnd((
      userId: string,
      sessionId: string,
      summary: string | null,
      agentId: string,
      opts,
    ) => {
      const numericUserId = parseNumericUserId(userId)
      const isBackground = !!opts?.background

      // CRITICAL: `sessionId` is the id of the session that just ENDED,
      // explicitly captured by SessionManager.handleNewCommandAsync at the
      // moment the user clicked "New Session". Do NOT replace it with any
      // "current session" lookup (e.g. `sessionManager.getSession(userId)`)
      // — by the time a background summary lands, the user is already
      // chatting in the new session and that lookup would return the
      // wrong id, causing the divider row + summary to be written into
      // the NEW session's transcript instead of the OLD one.
      const dividerMetadata = JSON.stringify({ type: 'session_divider', summary: summary ?? null })
      db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionId, numericUserId, 'system', summary ?? '', dividerMetadata, agentId)

      if (numericUserId !== null) {
        if (isBackground) {
          // Background path: the originating client already received a
          // `session_end` (without text) the moment it clicked
          // "New Session". Re-broadcasting `session_end` here would
          // render a duplicate divider, so we instead emit a dedicated
          // `session_summary` event. The carried `sessionId` is the
          // *ended* session's id so clients can match it back to the
          // empty divider they already rendered and fill in the
          // summary in place. Clients that hadn't seen the immediate
          // `session_end` (e.g. another browser tab) treat the event
          // as a signal to render a fresh divider for the old
          // session.
          if (summary) {
            chatEventBus.broadcast({
              type: 'session_summary',
              userId: numericUserId,
              source: 'web',
              sessionId,
              text: summary,
            })
          }
        } else {
          // Synchronous path (timeout, provider_change): broadcast
          // `session_end` with the summary so every connected client
          // renders a divider in one shot.
          chatEventBus.broadcast({
            type: 'session_end',
            userId: numericUserId,
            source: 'web',
            text: summary ?? undefined,
          })
        }
      }

      triggerFactExtractionForSessionEnd({
        db,
        agentCore,
        userId,
        sessionId,
      })
    })

    // Per-injection streaming state, keyed by the unique `injectionId`
    // (NOT the session id). Concurrent injections for the same user
    // share a session id, so keying by session id would cross-contaminate
    // their buffers. `telegramDelivered` is per-injection too so the
    // broadcast on `done` reflects the right delivery state.
    interface InjectionStreamState {
      responseBuffer: string
      telegramDelivered: boolean
    }
    const streamStateByInjection = new Map<string, InjectionStreamState>()

    agentCore.setOnTaskInjectionChunk((chunk) => {
      // Correlate the chunk with its pending metadata via `chunk.injectionId`,
      // which AgentCore guarantees to equal the per-injection UUID we
      // registered in `pendingInjections`. Keying by session id would
      // collide across concurrent injections targeting the same user's
      // cached session — the whole point of the injectionId token.
      const injectionId = chunk.injectionId
      if (!injectionId) {
        logger.warn('[axiom] Task injection chunk has no injectionId; dropping')
        return
      }
      const pendingMeta = pendingInjections.get(injectionId)
      if (!pendingMeta) {
        logger.warn(`[axiom] No pending injection for injectionId ${injectionId}; dropping chunk`)
        return
      }
      const persistSessionId = pendingMeta.sessionId

      let streamState = streamStateByInjection.get(injectionId)
      if (!streamState) {
        streamState = { responseBuffer: '', telegramDelivered: false }
        streamStateByInjection.set(injectionId, streamState)
      }

      try {
        if (chunk.type === 'text' && chunk.text) {
          streamState.responseBuffer += chunk.text
        }

        if (chunk.type === 'done') {
          const responseText = streamState.responseBuffer

          // Route the Telegram delivery to the persona's own bot.
          const resolvedBot = resolveTelegramBotForAgent(pendingMeta.agentId)
          if (resolvedBot && responseText) {
            const shouldSend =
              taskSettings.telegramDelivery === 'always' ||
              (taskSettings.telegramDelivery === 'auto' && !(wsChatPresenceChecker?.(pendingMeta.userId) ?? false))

            if (shouldSend) {
              const chatId = resolvedBot.getTelegramChatIdForUser(pendingMeta.userId)
              if (chatId) {
                streamState.telegramDelivered = true
                resolvedBot.sendFormattedMessage(chatId, responseText, pendingMeta.taskId).catch(err => {
                  logger.error(`[axiom] Failed to send Telegram for task ${pendingMeta.taskId}:`, err)
                })
              }
            }
          }

          if (responseText) {
            try {
              const metadata = JSON.stringify({ type: 'task_injection_response', telegramDelivered: streamState.telegramDelivered })
              // Persist under the injection session — same id the task-result
              // row was written under in `deliverTaskNotification`, so both
              // rows live together and are reachable via
              // `buildConversationHistory`.
              db.prepare(
                'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
              ).run(persistSessionId, pendingMeta.userId, 'assistant', responseText, metadata, pendingMeta.agentId)
            } catch (err) {
              logger.error('[axiom] Failed to persist task injection response:', err)
            }
          }
        }

        try {
          chatEventBus.broadcast({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: pendingMeta.userId,
            source: 'task',
            sessionId: persistSessionId,
            text: chunk.text,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            toolArgs: chunk.toolArgs,
            toolResult: chunk.toolResult,
            toolIsError: chunk.toolIsError,
            error: chunk.error,
            telegramDelivered: chunk.type === 'done' ? streamState.telegramDelivered : undefined,
            isTaskInjection: true,
          })
        } catch (err) {
          logger.error('[axiom] Failed to broadcast task injection chunk:', err)
        }
      } finally {
        if (chunk.type === 'done') {
          // Clear per-injection state regardless of success/failure so
          // stale buffers can't leak into a subsequent injection.
          streamStateByInjection.delete(injectionId)
          pendingInjections.delete(injectionId)
        }
      }
    })
  }

  async function restartTelegramBot(): Promise<void> {
    if (!agentCore) {
      logger.warn('[axiom] Cannot start Telegram bot: no agent core initialized')
      return
    }

    // Stop existing pool if any
    if (telegramBotPool) {
      try {
        await telegramBotPool.stop()
      } catch {
        // ignore
      }
      telegramBotPool = null
      telegramBot = null
    }

    // Stop existing single bot if any
    if (telegramBot) {
      try {
        await telegramBot.stop()
      } catch {
        // ignore
      }
      telegramBot = null
    }

    const multiPersonaSettings = loadMultiPersonaSettings()

    if (multiPersonaSettings.enabled) {
      // Multi-persona mode: one bot per persona account via TelegramBotPool.
      const pool = createTelegramBotPool({
        agentCore,
        db,
        onChatEvent: onTelegramChatEvent,
        // Per-bot depth changes report the pool-wide aggregate so the
        // metric reflects total telegram backlog, not the last bot's.
        onQueueDepthChanged: () => runtimeMetrics.setQueueDepth('telegram', pool.getQueueDepth()),
        startModelTask: startPinnedModelTask,
        onTaskReply: handleTelegramTaskReply,
        onTaskAction: handleTelegramTaskAction,
        draftTaskPlan,
        onActiveProviderChanged: () => {
          initOrUpdateAgentCore().catch((err) => {
            logger.error('[axiom] Error rebuilding agent core after Telegram provider change:', err)
          })
        },
      })
      telegramBotPool = pool

      try {
        await telegramBotPool.start()
        // Point telegramBot at the primary bot for backward compatibility
        // (reminders, status updates, single-bot callers).
        telegramBot = telegramBotPool.getPrimaryBot()
        if (telegramBotPool.hasRunningBots()) {
          logger.log('[axiom] Telegram bot pool (re)started')
        } else {
          logger.log('[axiom] Telegram bot pool: no bots configured or all disabled')
        }
      } catch (err) {
        logger.error('[axiom] Failed to start Telegram bot pool:', err)
        telegramBotPool = null
        telegramBot = null
      }
      return
    }

    // Legacy single-bot mode
    telegramBot = createTelegramBot(
      agentCore,
      db,
      onTelegramChatEvent,
      (queueDepth) => runtimeMetrics.setQueueDepth('telegram', queueDepth),
      {
        startModelTask: startPinnedModelTask,
        onTaskReply: handleTelegramTaskReply,
        onTaskAction: handleTelegramTaskAction,
        draftTaskPlan,
        onActiveProviderChanged: () => {
          initOrUpdateAgentCore().catch((err) => {
            logger.error('[axiom] Error rebuilding agent core after Telegram provider change:', err)
          })
        },
      },
    )
    if (telegramBot) {
      try {
        await telegramBot.start()
        logger.log('[axiom] Telegram bot (re)started')
      } catch (err) {
        logger.error('[axiom] Failed to start Telegram bot:', err)
        telegramBot = null
      }
    } else {
      logger.log('[axiom] Telegram bot disabled or not configured')
    }
  }

  /**
   * Wire fallback/recovery listeners onto a (new) ProviderManager. The
   * `providerManager !== manager` guard makes listeners of superseded
   * managers inert after a later hot-swap.
   */
  function registerProviderManagerListeners(manager: ProviderManager): void {
    manager.on('mode:fallback', async () => {
      if (!agentCore || providerManager !== manager) return
      const effectiveProvider = manager.getEffectiveProvider()
      if (!effectiveProvider) return

      try {
        const fbModelId = getFallbackModelId()
        const key = await getApiKeyForProvider(effectiveProvider)
        agentCore.swapProvider(effectiveProvider, key, fbModelId ?? undefined)
        logger.log(`[axiom] Swapped to fallback provider: ${effectiveProvider.name} (${fbModelId ?? getProviderDefaultModel(effectiveProvider)})`)
      } catch (err) {
        logger.error('[axiom] Failed to swap to fallback provider:', err)
      }
    })

    manager.on('mode:normal', async () => {
      if (!agentCore || providerManager !== manager) return
      const effectiveProvider = manager.getEffectiveProvider()
      if (!effectiveProvider) return

      try {
        const actModelId = getActiveModelId()
        const key = await getApiKeyForProvider(effectiveProvider)
        agentCore.swapProvider(effectiveProvider, key, actModelId ?? undefined)
        logger.log(`[axiom] Swapped back to primary provider: ${effectiveProvider.name} (${actModelId ?? getProviderDefaultModel(effectiveProvider)})`)
      } catch (err) {
        logger.error('[axiom] Failed to swap to primary provider:', err)
      }
    })
  }

  async function initOrUpdateAgentCore(): Promise<void> {
    const provider = getActiveProvider()
    if (!provider) {
      logger.warn('[axiom] No provider configured — chat will be unavailable. Configure a provider in Settings.')
      return
    }

    // HOT SWAP: when an agent core already exists, a provider/model change
    // must NOT end sessions, wipe conversations, or restart the Telegram
    // bots. swapProvider is the same conversation-preserving mechanism the
    // fallback machinery uses mid-stream. Falls back to a full rebuild on
    // any error.
    if (agentCore) {
      try {
        const activeModelId = getActiveModelId()
        const apiKey = await getApiKeyForProvider(provider)
        const fallbackProvider = getFallbackProvider()

        const manager = new ProviderManager(provider, fallbackProvider)
        registerProviderManagerListeners(manager)
        providerManager = manager
        healthMonitorService.setProviderManager(manager)

        agentCore.setProviderManager(manager)
        agentCore.swapProvider(provider, apiKey, activeModelId ?? undefined)
        agentCore.refreshSystemPrompt()

        logger.log(`[axiom] Provider hot-swapped to ${provider.name} (${activeModelId ?? getProviderDefaultModel(provider)}) — sessions preserved`)
        return
      } catch (err) {
        logger.error('[axiom] Provider hot-swap failed — falling back to full rebuild:', err)
      }
    }

    const previousAgentCore = agentCore

    try {
      if (previousAgentCore) {
        try {
          await previousAgentCore.endAllSessions()
        } catch (err) {
          logger.error('[axiom] Failed to end sessions before provider change:', err)
        }

        try {
          await previousAgentCore.dispose()
        } catch (err) {
          logger.error('[axiom] Failed to dispose previous agent core:', err)
        }
      }

      const activeModelId = getActiveModelId()
      const model = buildModel(provider, activeModelId ?? undefined)
      const apiKey = await getApiKeyForProvider(provider).catch((err) => {
        logger.error('[axiom] Failed to resolve active provider API key; chat may be unavailable until provider auth is fixed, but Telegram commands will still start:', err)
        return provider.apiKey || 'no-key'
      })
      const fallbackProvider = getFallbackProvider()

      providerManager = new ProviderManager(provider, fallbackProvider)

      agentCore = new AgentCore({
        model,
        apiKey,
        db,
        tools: agentTools,
        providerConfig: provider,
        providerManager,
        sessionTimeoutMinutes,
      })

      registerProviderManagerListeners(providerManager)

      healthMonitorService.setProviderManager(providerManager)
      consolidationScheduler.setAgentCore(agentCore)

      wireAgentCoreEvents()

      agentCore.init().catch(err => {
        logger.error('[axiom] Error during agentCore.init():', err)
      })

      await restartTelegramBot()

      logger.log(`[axiom] Agent core initialized with provider: ${provider.name} (${activeModelId ?? getProviderDefaultModel(provider)})`)
      if (fallbackProvider) {
        const fallbackModelId = getFallbackModelId()
        logger.log(`[axiom] Fallback provider configured: ${fallbackProvider.name} (${fallbackModelId ?? getProviderDefaultModel(fallbackProvider)})`)
      }
    } catch (err) {
      logger.error('[axiom] Failed to initialize agent core:', err)
    }
  }

  await initOrUpdateAgentCore()

  // Backfill semantic vectors for memory rows that don't have one yet
  // (no-op when memoryEmbeddings is disabled). Fire-and-forget — lexical
  // search works regardless.
  backfillMemoryEmbeddings(db)
    .then((embedded) => {
      if (embedded > 0) logger.log(`[axiom] Memory embeddings: backfilled ${embedded} rows`)
    })
    .catch((err) => logger.warn('[axiom] Memory embedding backfill failed:', err))

  // Recover tasks interrupted by the restart: running tasks are re-started
  // with a progress summary built from their stored tool calls; paused ones
  // are closed. (The recovery machinery existed in the runner but was never
  // wired — without this call, interrupted work was silently lost.)
  try {
    if (getActiveProvider()) {
      const recovery = await taskRuntime.tasks.recover(
        (name: string) => resolveProvider(name),
        getTaskDefaultProvider(),
      )
      if (recovery.resumed > 0 || recovery.failed > 0) {
        logger.log(`[axiom] Task recovery: ${recovery.resumed} resumed, ${recovery.failed} closed`)
      }
    }
  } catch (err) {
    logger.error('[axiom] Task recovery failed:', err)
  }

  return {
    db,
    runtimeMetrics,
    healthMonitorService,
    quotaMonitorService,
    consolidationScheduler,
    agentHeartbeatService,
    uploadCleanupService,
    taskEventBus,
    chatEventBus,
    getAgentCore: () => agentCore,
    getTaskRuntime: () => taskRuntime,
    resolveProvider,
    getTaskDefaultProvider,
    getBackgroundTaskToolNames: () => backgroundTaskTools.map(t => t.name),
    getTelegramBot: () => telegramBot,
    onTelegramSettingsChanged: () => {
      restartTelegramBot().catch((err) => {
        logger.error('[axiom] Error restarting Telegram bot:', err)
      })
    },
    onActiveProviderChanged: () => {
      initOrUpdateAgentCore().catch((err) => {
        logger.error('[axiom] Error initializing agent core after provider change:', err)
      })
    },
    setWebSocketChatPresenceChecker: (checker) => {
      wsChatPresenceChecker = checker ? checker.hasActiveWebSocket : null
    },
    stopBackgroundServices: async () => {
      healthMonitorService.stop()
      quotaMonitorService.stop()
      consolidationScheduler.stop()
      agentHeartbeatService.stop()
      uploadCleanupService.stop()
      taskRuntime.schedules.stop()

      if (telegramBotPool) {
        try {
          await telegramBotPool.stop()
        } catch {
          // ignore
        }
        telegramBotPool = null
        telegramBot = null
      }

      if (telegramBot) {
        try {
          await telegramBot.stop()
        } catch {
          // ignore
        }
        telegramBot = null
      }
    },
  }
}
