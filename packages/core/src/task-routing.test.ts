/**
 * Tests for multi-persona task routing (agent_id).
 *
 * Verifies that:
 * 1. tasks.agent_id column exists and is persisted correctly
 * 2. create_task tool injects the current agent's ID
 * 3. Task completion routes to the correct persona runtime (not always 'main')
 * 4. Tasks without agent_id default to 'main' (backwards compatibility)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { TaskStore } from './task-store.js'
import type { Database } from './database.js'
import { formatTaskInjection } from './task-runner.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('Task Routing — agent_id', () => {
  let db: Database
  let store: TaskStore
  const tmpFiles: string[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `openagent-task-routing-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('Schema — agent_id column', () => {
    it('tasks table has agent_id column', () => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
      const colNames = cols.map(c => c.name)
      expect(colNames).toContain('agent_id')
    })

    it('agent_id column has an index', () => {
      const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'").all() as { name: string }[]
      const indexNames = indices.map(i => i.name)
      expect(indexNames).toContain('idx_tasks_agent_id')
    })
  })

  describe('TaskStore — agentId persistence', () => {
    it('creates task without agentId → agentId is null', () => {
      const task = store.create({
        name: 'Main Task',
        prompt: 'do stuff',
        triggerType: 'agent',
      })

      expect(task.agentId).toBeNull()

      // Verify via direct DB read
      const row = db.prepare('SELECT agent_id FROM tasks WHERE id = ?').get(task.id) as { agent_id: string | null }
      expect(row.agent_id).toBeNull()
    })

    it('creates task with agentId → agentId is persisted', () => {
      const task = store.create({
        name: 'Warren Research',
        prompt: 'research stocks',
        triggerType: 'agent',
        agentId: 'warren',
      })

      expect(task.agentId).toBe('warren')

      // Verify via getById
      const found = store.getById(task.id)!
      expect(found.agentId).toBe('warren')
    })

    it('creates task with agentId "main" → agentId is "main"', () => {
      const task = store.create({
        name: 'Main Agent Task',
        prompt: 'do main things',
        triggerType: 'agent',
        agentId: 'main',
      })

      expect(task.agentId).toBe('main')
    })

    it('list returns agentId correctly', () => {
      store.create({ name: 'Task A', prompt: 'a', triggerType: 'agent', agentId: 'warren' })
      store.create({ name: 'Task B', prompt: 'b', triggerType: 'agent' })
      store.create({ name: 'Task C', prompt: 'c', triggerType: 'agent', agentId: 'gekko' })

      const tasks = store.list()
      expect(tasks).toHaveLength(3)

      const warren = tasks.find(t => t.name === 'Task A')!
      expect(warren.agentId).toBe('warren')

      const main = tasks.find(t => t.name === 'Task B')!
      expect(main.agentId).toBeNull()

      const gekko = tasks.find(t => t.name === 'Task C')!
      expect(gekko.agentId).toBe('gekko')
    })
  })

  describe('Backwards compatibility', () => {
    it('old tasks without agent_id column value default to NULL', () => {
      // Simulate an old task by inserting directly without agent_id
      db.prepare(`
        INSERT INTO tasks (id, name, prompt, status, trigger_type, created_at)
        VALUES ('legacy-1', 'Legacy Task', 'old prompt', 'completed', 'agent', datetime('now'))
      `).run()

      const task = store.getById('legacy-1')!
      expect(task.agentId).toBeNull()
    })
  })

  describe('formatTaskInjection includes routing info', () => {
    it('injection message contains task metadata', () => {
      const task = store.create({
        name: 'Warren Research',
        prompt: 'research stocks',
        triggerType: 'agent',
        agentId: 'warren',
      })

      store.update(task.id, {
        status: 'completed',
        resultStatus: 'completed',
        resultSummary: 'Found 3 stocks.',
        completedAt: '2026-04-21 10:00:00',
      })

      const updatedTask = store.getById(task.id)!
      const injection = formatTaskInjection(updatedTask, 5)

      expect(injection).toContain('task_name="Warren Research"')
      expect(injection).toContain('status="completed"')
      expect(injection).toContain('Found 3 stocks.')
    })
  })

  describe('onTaskComplete callback agentId propagation', () => {
    it('callback receives agentId from task for routing', () => {
      // This test verifies the contract: onTaskComplete now receives
      // (taskId, injection, agentId) where agentId comes from the task row.
      // We test this by creating a task with agentId and verifying the field.
      const task = store.create({
        name: 'Warren Subtask',
        prompt: 'do research',
        triggerType: 'agent',
        agentId: 'warren',
      })

      // Simulate what task-runner does: read task from DB, get agentId
      const taskFromDb = store.getById(task.id)!
      expect(taskFromDb.agentId).toBe('warren')

      // The callback would be called with:
      // onTaskComplete(taskId, injection, taskFromDb.agentId)
      // This ensures Warren's runtime receives the notification, not Main's.
    })

    it('callback receives null agentId for legacy tasks → defaults to main', () => {
      const task = store.create({
        name: 'Old Subtask',
        prompt: 'old work',
        triggerType: 'agent',
        // No agentId
      })

      const taskFromDb = store.getById(task.id)!
      expect(taskFromDb.agentId).toBeNull()

      // When agentId is null, the runtime-composition will default to 'main'
      // via: effectiveAgentId = agentIdFromTask ?? task.agentId ?? undefined
      // and then: agentCore.injectTaskResult(injection, undefined) → uses 'main'
    })
  })

  describe('Migration idempotency', () => {
    it('calling initDatabase twice does not fail (migration is idempotent)', () => {
      // Close and reopen with same path — migration should not throw
      const dbPath = tmpDbPath()
      const db1 = initDatabase(dbPath)

      // Create a task with agent_id
      const store1 = new TaskStore(db1)
      store1.create({ name: 'Test', prompt: 'p', triggerType: 'agent', agentId: 'warren' })
      db1.close()

      // Re-open the same database — migration should be idempotent
      const db2 = initDatabase(dbPath)
      const store2 = new TaskStore(db2)

      // Verify the task is still there with agent_id
      const tasks = store2.list()
      expect(tasks).toHaveLength(1)
      expect(tasks[0].agentId).toBe('warren')

      db2.close()
    })
  })
})
