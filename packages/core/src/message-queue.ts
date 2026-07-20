import { EventEmitter } from 'node:events'

export interface QueuedMessage {
  id: string
  type: 'user_message' | 'task_injection'
  payload: {
    userId: string
    text: string
    source: string
  }
}

/**
 * Thrown into the consumer of a queued turn when the watchdog expires.
 * The queue lock has already been force-released at that point, so
 * subsequent messages proceed normally.
 */
export class QueueTurnTimeoutError extends Error {
  constructor(idleMs: number) {
    super(`Turn produced no output for ${Math.round(idleMs / 1000)}s (queue idle watchdog) and was abandoned`)
    this.name = 'QueueTurnTimeoutError'
  }
}

/**
 * Idle window for the queue-level backstop: a turn is abandoned only after this
 * long with NO output flowing (no chunk yielded) — it is NOT a total-runtime
 * cap. A turn that keeps streaming tokens / running tools re-arms it on every
 * chunk and may run for hours (massive autonomous agentic coding). This sits
 * ABOVE the agent-runtime inactivity guard (20 min) so that one fires first and
 * settles the run cleanly; the queue backstop only matters if that mechanism
 * itself wedges (incident 2026-07-20: a blind wall-clock cap wrongly killed a
 * still-working Kimi turn). Raise via AXIOM_QUEUE_TURN_MAX_MS for workloads with
 * single tool calls longer than the window (e.g. multi-hour builds).
 */
const DEFAULT_MAX_TURN_MS = (() => {
  const raw = Number(process.env.AXIOM_QUEUE_TURN_MAX_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000
})()

/**
 * In-memory message queue that serializes all inputs to the main agent.
 * Both user chat messages and task result injections go through this queue
 * to prevent concurrent processing collisions.
 *
 * Uses a simple mutex pattern: acquires a lock before processing,
 * releases it when the consumer finishes iterating the response.
 *
 * A progress-aware idle watchdog force-releases the lock after `maxTurnMs` of
 * NO output (re-armed on every yielded chunk, so a turn actively streaming for
 * hours is never abandoned) — only a genuinely stuck turn (hung completion,
 * dead consumer) trips it. The stuck turn's consumer receives a
 * QueueTurnTimeoutError on its next iteration step; the underlying processor is
 * closed best-effort but never awaited — it may be stuck on a promise that
 * never settles.
 */
export class MessageQueue extends EventEmitter {
  private pendingCount = 0
  private lockPromise: Promise<void> = Promise.resolve()
  private readonly maxTurnMs: number

  constructor(options?: { maxTurnMs?: number }) {
    super()
    this.maxTurnMs = options?.maxTurnMs ?? DEFAULT_MAX_TURN_MS
  }

  /**
   * Enqueue a message for sequential processing.
   * Returns a wrapped async iterable from the processor.
   * The next queued message won't start until this iterable is fully consumed
   * (or the watchdog gives up on it).
   */
  async enqueue<T>(
    type: 'user_message' | 'task_injection',
    userId: string,
    text: string,
    source: string,
    processor: (msg: QueuedMessage) => AsyncIterable<T>,
  ): Promise<AsyncIterable<T>> {
    const msg: QueuedMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      payload: { userId, text, source },
    }

    this.pendingCount++
    this.emit('enqueued', msg)

    // Wait for our turn
    const previousLock = this.lockPromise
    let releaseFn: () => void
    this.lockPromise = new Promise<void>((resolve) => {
      releaseFn = resolve
    })

    await previousLock
    this.pendingCount--

    // Rejects when the watchdog fires; raced against every iteration step so
    // a consumer stuck in `await next()` is woken up with the error.
    let expire: ((err: Error) => void) | undefined
    const expiry = new Promise<never>((_, reject) => {
      expire = reject
    })
    // The race below may already have thrown out of the consumer by the time
    // this settles again — keep it from surfacing as an unhandled rejection.
    expiry.catch(() => {})

    let released = false
    const idleMs = this.maxTurnMs
    let watchdog: ReturnType<typeof setTimeout> | undefined

    const releaseOnce = (): void => {
      if (released) return
      released = true
      clearTimeout(watchdog)
      releaseFn!()
    }

    // Progress-aware watchdog: abandon the turn only after `idleMs` of NO output
    // (no chunk yielded), NOT after a fixed wall-clock budget. A turn that keeps
    // streaming tokens or running tools re-arms it on every chunk and can run
    // for hours (massive autonomous agentic work). Only genuine silence — a run
    // truly stuck with nothing coming through — trips it.
    const arm = (): void => {
      if (released) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        if (released) return
        const err = new QueueTurnTimeoutError(idleMs)
        console.error(`[message-queue] ${err.message} (type=${msg.type}, source=${msg.payload.source}) — force-releasing lock so queued messages proceed`)
        this.emit('turn-timeout', msg)
        releaseOnce()
        expire!(err)
      }, idleMs)
      if (typeof watchdog === 'object' && 'unref' in watchdog) watchdog.unref()
    }
    arm()

    // We now have the lock — run the processor
    const iterable = processor(msg)

    // Wrap iterable to release lock when fully consumed
    const wrapped = async function* (): AsyncIterable<T> {
      const it = iterable[Symbol.asyncIterator]()
      try {
        while (true) {
          const res = await Promise.race([it.next(), expiry])
          if (res.done) break
          arm() // progress — reset the idle timer
          yield res.value
        }
      } finally {
        releaseOnce()
        // Close the underlying generator without awaiting it: if the watchdog
        // tripped, it is stuck on a promise that may never settle, and its
        // generator body only resumes (running finally blocks) if it ever does.
        try {
          void Promise.resolve(it.return?.(undefined as never)).catch(() => {})
        } catch {
          // ignore — best-effort cleanup only
        }
      }
    }

    return wrapped()
  }

  /**
   * Get the number of pending (waiting) messages
   */
  get length(): number {
    return this.pendingCount
  }

}
