import type { Database } from '@openagent/core'
import type { SearchResult } from './db.js'
import { getMessagesForDate, saveDigest } from './db.js'

// ── Config ────────────────────────────────────────────────────────────────────

type Provider = 'ollama' | 'openai' | 'anthropic'

const PROVIDER = (process.env.SALESMEMORY_PROVIDER ?? 'ollama') as Provider
const OLLAMA_URL = (process.env.SALESMEMORY_OLLAMA_URL ?? 'http://192.168.10.222:11434').replace(/\/+$/, '')
const OLLAMA_MODEL = process.env.SALESMEMORY_OLLAMA_MODEL ?? 'qwen3:32b'
const OPENAI_KEY = process.env.SALESMEMORY_OPENAI_KEY ?? ''
const OPENAI_MODEL = process.env.SALESMEMORY_OPENAI_MODEL ?? 'gpt-4o-mini'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strips <think>…</think> blocks emitted by qwen3 extended-thinking mode.
 */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

/**
 * Calls the configured LLM provider with the given prompt and returns the
 * plain-text response (think-tags stripped for Ollama/qwen3).
 */
async function callLLM(prompt: string): Promise<string> {
  if (PROVIDER === 'openai') {
    return callOpenAI(prompt)
  }
  if (PROVIDER === 'anthropic') {
    return callAnthropic(prompt)
  }
  // Default: ollama
  return callOllama(prompt)
}

async function callOllama(prompt: string): Promise<string> {
  const url = `${OLLAMA_URL}/api/generate`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
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

async function callOpenAI(prompt: string): Promise<string> {
  if (!OPENAI_KEY) throw new Error('SALESMEMORY_OPENAI_KEY not set')

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
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

async function callAnthropic(prompt: string): Promise<string> {
  const apiKey = process.env.SALESMEMORY_ANTHROPIC_KEY ?? ''
  if (!apiKey) throw new Error('SALESMEMORY_ANTHROPIC_KEY not set')

  const model = process.env.SALESMEMORY_ANTHROPIC_MODEL ?? 'claude-3-haiku-20240307'

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
 */
export async function summarizeResults(
  results: SearchResult[],
  query: string,
): Promise<string> {
  if (results.length === 0) {
    return 'Keine relevanten Informationen gefunden.'
  }

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

  return callLLM(prompt)
}

/**
 * Generates a structured daily digest from all messages of the given date,
 * persists it to the database, and returns the digest content.
 */
export async function generateDigest(db: Database, date: string): Promise<string> {
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

  const content = await callLLM(prompt)
  const model = PROVIDER === 'openai' ? OPENAI_MODEL : PROVIDER === 'ollama' ? OLLAMA_MODEL : 'anthropic'

  saveDigest(db, date, content, model)
  return content
}
