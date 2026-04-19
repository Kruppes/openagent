import type { AgentTool } from '@mariozechner/pi-agent-core'
import type { Api, Model } from '@mariozechner/pi-ai'
import { Type, completeSimple } from '@mariozechner/pi-ai'
import { loadPersona, getPersonaDir } from './persona-loader.js'
import { resolveBackgroundReasoning } from './thinking-level.js'
import fs from 'node:fs'
import path from 'node:path'

/** Maximum cross-agent call depth */
const MAX_CALL_DEPTH = 3

export interface AskAgentToolOptions {
  /** The agentId of the calling agent (to prevent self-queries) */
  getCurrentAgentId: () => string
  /** Provides the LLM model for the nested call */
  getModel: () => Model<Api>
  /** Provides the API key for the nested call */
  getApiKey: () => string
  /** Current call chain for recursion detection */
  callChain?: string[]
}

/**
 * List all available agent IDs by scanning /data/agents/ directories.
 * Always includes 'main' as the default agent.
 */
export function listAvailableAgents(baseDir?: string): string[] {
  const dataDir = baseDir ?? path.join(process.env.DATA_DIR ?? '/data', 'agents')
  const agents: string[] = ['main']

  try {
    if (!fs.existsSync(dataDir)) return agents

    const entries = fs.readdirSync(dataDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'main') {
        agents.push(entry.name)
      }
    }
  } catch {
    // Directory not readable, return just main
  }

  return agents
}

/**
 * Build a short hint for the system prompt listing available personas.
 */
export function buildAskAgentPromptHint(currentAgentId: string, baseDir?: string): string {
  const agents = listAvailableAgents(baseDir)
  const otherAgents = agents.filter(id => id !== currentAgentId)

  if (otherAgents.length === 0) return ''

  return `\n\n<cross_persona>\nYou can ask other personas for their perspective using the ask_agent tool. Available personas: ${otherAgents.join(', ')}.\n</cross_persona>`
}

/**
 * Create the ask_agent tool for cross-persona communication.
 *
 * This tool allows one persona to query another persona for its perspective.
 * The target agent responds in character using a stateless, one-shot LLM call.
 * No session is created and no facts are extracted from the response.
 *
 * Guards:
 * - Self-query is forbidden (agent cannot ask itself)
 * - Maximum call depth of 3 to prevent infinite recursion
 * - Feature is only available when multiPersona is enabled
 */
export function createAskAgentTool(options: AskAgentToolOptions): AgentTool {
  const { getCurrentAgentId, getModel, getApiKey } = options
  const callChain = options.callChain ?? []

  return {
    name: 'ask_agent',
    label: 'Ask Another Agent',
    description:
      'Ask another persona agent a question. Use this when you need another agent\'s perspective, expertise, or opinion. ' +
      'The other agent will respond in character.',
    parameters: Type.Object({
      agent_id: Type.String({
        description: 'ID of the target agent (e.g. \'gekko\', \'spider\'). Must be a configured agent under /data/agents/<id>/.',
      }),
      question: Type.String({
        description: 'The question or message to send to the target agent. Be clear and specific.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const { agent_id: targetAgentId, question } = params as { agent_id: string; question: string }

      if (!targetAgentId || typeof targetAgentId !== 'string') {
        return {
          content: [{ type: 'text' as const, text: 'Error: agent_id is required.' }],
          details: { error: true },
        }
      }

      if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: question must be a non-empty string.' }],
          details: { error: true },
        }
      }

      const currentAgentId = getCurrentAgentId()

      // Guard: self-query
      if (targetAgentId === currentAgentId) {
        return {
          content: [{ type: 'text' as const, text: `Error: Cannot ask yourself (agent '${currentAgentId}'). Use ask_agent to query a different persona.` }],
          details: { error: true, reason: 'self_query' },
        }
      }

      // Guard: recursion depth
      const currentChain = [...callChain, currentAgentId]
      if (currentChain.length >= MAX_CALL_DEPTH) {
        return {
          content: [{ type: 'text' as const, text: `Error: Maximum cross-agent call depth (${MAX_CALL_DEPTH}) exceeded. Call chain: ${currentChain.join(' → ')}.` }],
          details: { error: true, reason: 'max_depth', callChain: currentChain },
        }
      }

      // Guard: target in call chain (prevent A→B→A loops)
      if (currentChain.includes(targetAgentId)) {
        return {
          content: [{ type: 'text' as const, text: `Error: Agent '${targetAgentId}' is already in the call chain (${currentChain.join(' → ')}). Circular calls are not allowed.` }],
          details: { error: true, reason: 'circular', callChain: currentChain },
        }
      }

      // Load target persona
      const persona = loadPersona(targetAgentId, { skipFeatureCheck: true })

      // Check if persona directory exists
      if (!persona.hasPersonaDir && targetAgentId !== 'main') {
        return {
          content: [{ type: 'text' as const, text: `Error: Agent '${targetAgentId}' is not configured. No persona directory found at ${getPersonaDir(targetAgentId)}.` }],
          details: { error: true, reason: 'not_found' },
        }
      }

      // Build a system prompt for the target agent from its persona files
      const systemPromptParts: string[] = []

      if (persona.soul) {
        systemPromptParts.push(persona.soul)
      } else {
        systemPromptParts.push('You are a helpful AI assistant.')
      }

      if (persona.identity) {
        systemPromptParts.push(persona.identity)
      }

      if (persona.agents) {
        systemPromptParts.push(persona.agents)
      }

      // Add a context note about cross-agent communication
      systemPromptParts.push(
        `\nYou are being asked a question by another agent (${currentAgentId}). ` +
        'Respond in character, concisely and helpfully. ' +
        'This is a one-shot query — you have no conversation history for this exchange.'
      )

      const systemPrompt = systemPromptParts.join('\n\n')

      console.log(`[ask_agent] ${currentAgentId} → ${targetAgentId}: "${question.slice(0, 100)}${question.length > 100 ? '...' : ''}"`)

      try {
        const model = getModel()
        const apiKey = getApiKey()

        const response = await completeSimple(model, {
          systemPrompt,
          messages: [{
            role: 'user' as const,
            content: question,
            timestamp: Date.now(),
          }],
        }, {
          apiKey,
          temperature: 0.7,
          reasoning: resolveBackgroundReasoning(),
        })

        const responseText = response.content
          .filter(item => item.type === 'text')
          .map(item => (item as { type: 'text'; text: string }).text)
          .join('')
          .trim()

        if (!responseText) {
          return {
            content: [{ type: 'text' as const, text: `Agent '${targetAgentId}' returned an empty response.` }],
            details: { targetAgentId, empty: true },
          }
        }

        console.log(`[ask_agent] ${targetAgentId} responded (${responseText.length} chars)`)

        return {
          content: [{ type: 'text' as const, text: `[Response from ${targetAgentId}]\n\n${responseText}` }],
          details: {
            targetAgentId,
            responseLength: responseText.length,
            callChain: [...currentChain, targetAgentId],
          },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        console.error(`[ask_agent] Error querying ${targetAgentId}:`, err)
        return {
          content: [{ type: 'text' as const, text: `Error querying agent '${targetAgentId}': ${errorMessage}` }],
          details: { error: true, targetAgentId },
        }
      }
    },
  }
}
