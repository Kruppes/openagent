import type { Express } from 'express'
import type { Database } from '@openagent/core'

export interface OpenAgentPlugin {
  name: string
  version: string
  /**
   * Optional lifecycle hook called before `register`.
   * Plugins that need database access should implement this.
   */
  init?(db: Database): void | Promise<void>
  register(app: Express): void | Promise<void>
}
