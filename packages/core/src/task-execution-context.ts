import { AsyncLocalStorage } from 'node:async_hooks'
import type { ProviderConfig } from './provider-config.js'

/**
 * Per-task execution context, carried through the async call tree of a running
 * background task via AsyncLocalStorage.
 *
 * Why AsyncLocalStorage and not an instance field: multiple background tasks
 * (and their sub-tasks / sub-sub-tasks) run concurrently in one process. A tool
 * invoked from inside task A must see task A's context even while task B is mid
 * LLM call. A shared mutable field would leak B's provider into A. ALS gives
 * each async task tree its own isolated view.
 *
 * The context enables the per-task/subtask model inheritance chain:
 *   explicit provider/model on create_task  >  parent task's model (this ctx)
 *   >  agent/persona default  >  system default
 *
 * When a running task calls `create_task` WITHOUT an explicit provider/model,
 * the tool resolves its default via `getTaskDefaultProvider`, which reads
 * `getCurrentTaskProvider()` here first — so a Kimi-pinned parent spawns a
 * Kimi-pinned child instead of silently falling back to the global default.
 */
export interface TaskExecutionContext {
  /** The provider config (already model-pinned) the current task runs on. */
  provider: ProviderConfig | null
  /** The persona/agent id the current task is attributed to, if any. */
  agentId?: string | null
  /** The current task's id (for debugging / future depth limits). */
  taskId?: string
}

const storage = new AsyncLocalStorage<TaskExecutionContext>()

/**
 * Run `fn` with the given task execution context bound to the async call tree.
 * Every `create_task` / provider resolution that happens inside `fn` (including
 * nested tool calls and their own child tasks) sees this context.
 */
export function runWithTaskExecutionContext<T>(
  ctx: TaskExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn)
}

/** The full context of the task currently executing, or undefined at top level. */
export function getCurrentTaskExecutionContext(): TaskExecutionContext | undefined {
  return storage.getStore()
}

/**
 * The provider (model-pinned) of the task currently executing, or null when
 * not inside a task (interactive chat, top-level scheduler, etc.). Used by the
 * task-default-provider resolver to implement parent-task model inheritance.
 */
export function getCurrentTaskProvider(): ProviderConfig | null {
  return storage.getStore()?.provider ?? null
}

/** The persona/agent id of the task currently executing, if any. */
export function getCurrentTaskAgentId(): string | null | undefined {
  return storage.getStore()?.agentId
}
