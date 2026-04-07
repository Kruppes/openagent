import type { Database } from '@openagent/core'
import type { SearchResult } from './db.js'
import { getMessagesForDate, saveDigest } from './db.js'
import type { SalesMemorySettings } from './config.js'
import { loadSalesMemoryConfig } from './config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strips <think>…</think> blocks emitted by qwen3 extended-thinking mode.
 */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * Resolves the effective settings by merging saved config with any per-request overrides.
 */
function resolveSettings(overrides?: Partial<SalesMemorySettings>): SalesMemorySettings {
  const saved = loadSalesMemoryConfig()
  return { ...saved, ...(overrides ?? {}) }
}

/**
 * Calls the configured LLM provider with the given prompt and returns the
 * plain-text response (think-tags stripped for Ollama/qwen3).
 */
async function callLLM(prompt: string, settings: SalesMemorySettings): Promise<string> {
  if (settings.provider === 'openai') {
    return callOpenAI(prompt, settings)
  }
  if (settings.provider === 'anthropic') {
    return callAnthropic(prompt, settings)
  }
  // Default: ollama
  return callOllama(prompt, settings)
}

async function callOllama(prompt: string, settings: SalesMemorySettings): Promise<string> {
  const ollamaUrl = (settings.ollamaUrl ?? 'http://192.168.10.222:11434').replace(/\/+$/, '')
  const ollamaModel = settings.ollamaModel ?? 'qwen3:32b'
  const url = `${ollamaUrl}/api/generate`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 2048,
      },
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Ollama returned ${response.status}: ${text}`)
  }

  const data = (await response.json()) as { response: string }
  return stripThinkTags(data.response?.trim() ?? '')
}

async function callOpenAI(prompt: string, settings: SalesMemorySettings): Promise<string> {
  const apiKey = settings.openaiKey ?? ''
  if (!apiKey) throw new Error('OpenAI API key not configured')

  const model = settings.openaiModel ?? 'gpt-4o-mini'

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2048,
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI returned ${response.status}: ${text}`)
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  return data.choices[0]?.message?.content?.trim() ?? ''
}

async function callAnthropic(prompt: string, settings: SalesMemorySettings): Promise<string> {
  const apiKey = settings.anthropicKey ?? ''
  if (!apiKey) throw new Error('Anthropic API key not configured')

  const model = settings.anthropicModel ?? 'claude-3-haiku-20240307'

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Anthropic returned ${response.status}: ${text}`)
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>
  }
  return data.content.find(c => c.type === 'text')?.text?.trim() ?? ''
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sends search results to the LLM and asks it to produce a natural-language
 * summary of information relevant to the given query.
 *
 * @param results   - Search results from the FTS index
 * @param query     - The original search query
 * @param overrides - Optional per-request settings that override the saved config
 */
export async function summarizeResults(
  results: SearchResult[],
  query: string,
  overrides?: Partial<SalesMemorySettings>,
): Promise<string> {
  if (results.length === 0) {
    return 'Keine relevanten Informationen gefunden.'
  }

  const settings = resolveSettings(overrides)

  const snippets = results
    .slice(0, 10)
    .map((r, i) => {
      const date = r.created_at ? r.created_at.slice(0, 10) : 'unbekannt'
      const content = r.content.slice(0, 500)
      return `[${i + 1}] (${date}, ${r.role}): ${content}`
    })
    .join('\n\n')

  const prompt = `Du bist ein hilfreiches KI-System. Unten findest du relevante Chat-Nachrichten aus dem Gedächtnis.

Fasse die relevanten Informationen zu "${query}" zusammen. Schreibe eine klare, präzise Zusammenfassung auf Deutsch.
Nenne konkrete Fakten, Entscheidungen und Details. Halte die Antwort kurz (max. 3-4 Absätze).

Nachrichten:
${snippets}

Zusammenfassung:`

  return callLLM(prompt, settings)
}

/**
 * Generates a structured daily digest from all messages of the given date,
 * persists it to the database, and returns the digest content.
 *
 * @param db        - Database instance
 * @param date      - ISO date string (YYYY-MM-DD)
 * @param overrides - Optional per-request settings that override the saved config
 */
export async function generateDigest(
  db: Database,
  date: string,
  overrides?: Partial<SalesMemorySettings>,
): Promise<string> {
  const settings = resolveSettings(overrides)
  const messages = getMessagesForDate(db, date)

  if (messages.length === 0) {
    const empty = `# Tagesdigest ${date}\n\nKeine Nachrichten für diesen Tag gefunden.`
    saveDigest(db, date, empty, null)
    return empty
  }

  const conversation = messages
    .map(m => `**${m.role}** (${m.timestamp}): ${m.content.slice(0, 800)}`)
    .join('\n\n')

  const prompt = `Du bist ein KI-Assistent, der Gespräche analysiert und strukturiert zusammenfasst.

Analysiere das folgende Gespräch vom ${date} und erstelle einen strukturierten Tagesdigest auf Deutsch.

Struktur:
## Tagesdigest ${date}

### Entscheidungen
- Konkrete Entscheidungen die getroffen wurden

### Offene Punkte
- Aufgaben oder Fragen die noch offen sind

### Projekte & Entitäten
- Erwähnte Projekte, Personen, Firmen oder andere wichtige Entitäten

### Zusammenfassung
Kurze Zusammenfassung des Tages (2-3 Sätze)

---

Gespräch:
${conversation}

Digest:`

  const content = await callLLM(prompt, settings)

  // Determine model name for the digest record
  let modelName: string
  if (settings.provider === 'openai') {
    modelName = settings.openaiModel ?? 'gpt-4o-mini'
  } else if (settings.provider === 'anthropic') {
    modelName = settings.anthropicModel ?? 'claude-3-haiku-20240307'
  } else {
    modelName = settings.ollamaModel ?? 'qwen3:32b'
  }

  saveDigest(db, date, content, modelName)
  return content
}
