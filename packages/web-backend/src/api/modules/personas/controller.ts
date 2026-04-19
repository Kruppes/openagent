import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseAgentId, parseCreatePersonaPayload, parseUpdatePersonaPayload } from './schema.js'
import * as service from './service.js'

export interface PersonasController {
  list: (req: AuthenticatedRequest, res: Response) => void
  get: (req: AuthenticatedRequest, res: Response) => void
  update: (req: AuthenticatedRequest, res: Response) => void
  create: (req: AuthenticatedRequest, res: Response) => void
  remove: (req: AuthenticatedRequest, res: Response) => void
}

export function createPersonasController(): PersonasController {
  return {
    list(_req, res) {
      try {
        const personas = service.listPersonas()
        res.json(personas)
      } catch (err) {
        res.status(500).json({ error: `Failed to list personas: ${(err as Error).message}` })
      }
    },

    get(req, res) {
      const idResult = parseAgentId(req.params.id)
      if (!idResult.ok) {
        res.status(400).json({ error: idResult.error })
        return
      }

      try {
        const persona = service.getPersona(idResult.value)
        res.json(persona)
      } catch (error) {
        res.status(500).json({ error: `Failed to get persona: ${(error as Error).message}` })
      }
    },

    update(req, res) {
      const idResult = parseAgentId(req.params.id)
      if (!idResult.ok) {
        res.status(400).json({ error: idResult.error })
        return
      }

      const bodyResult = parseUpdatePersonaPayload(req.body)
      if (!bodyResult.ok) {
        res.status(400).json({ error: bodyResult.error })
        return
      }

      try {
        const persona = service.updatePersona(idResult.value, bodyResult.value.files)
        console.log(JSON.stringify({
          prefix: '[personas-audit]',
          action: 'update',
          agentId: idResult.value,
          user: req.user?.username ?? 'unknown',
          timestamp: new Date().toISOString(),
        }))
        res.json(persona)
      } catch (error) {
        res.status(500).json({ error: `Failed to update persona: ${(error as Error).message}` })
      }
    },

    create(req, res) {
      const bodyResult = parseCreatePersonaPayload(req.body)
      if (!bodyResult.ok) {
        res.status(400).json({ error: bodyResult.error })
        return
      }

      try {
        const persona = service.createPersona(bodyResult.value.id)
        console.log(JSON.stringify({
          prefix: '[personas-audit]',
          action: 'create',
          agentId: bodyResult.value.id,
          user: req.user?.username ?? 'unknown',
          timestamp: new Date().toISOString(),
        }))
        res.status(201).json(persona)
      } catch (error) {
        const msg = (error as Error).message
        if (msg.includes('already exists')) {
          res.status(409).json({ error: msg })
        } else {
          res.status(500).json({ error: `Failed to create persona: ${msg}` })
        }
      }
    },

    remove(req, res) {
      const idResult = parseAgentId(req.params.id)
      if (!idResult.ok) {
        res.status(400).json({ error: idResult.error })
        return
      }

      try {
        service.deletePersona(idResult.value)
        console.log(JSON.stringify({
          prefix: '[personas-audit]',
          action: 'delete',
          agentId: idResult.value,
          user: req.user?.username ?? 'unknown',
          timestamp: new Date().toISOString(),
        }))
        res.json({ message: `Persona "${idResult.value}" deleted` })
      } catch (error) {
        const msg = (error as Error).message
        if (msg.includes('Cannot delete the main')) {
          res.status(403).json({ error: msg })
        } else if (msg.includes('not found')) {
          res.status(404).json({ error: msg })
        } else if (msg.includes('active Telegram binding')) {
          res.status(409).json({ error: msg })
        } else {
          res.status(500).json({ error: `Failed to delete persona: ${msg}` })
        }
      }
    },
  }
}
