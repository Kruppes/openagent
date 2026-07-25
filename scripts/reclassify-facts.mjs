#!/usr/bin/env node
/**
 * Retro-reclassification of extracted facts across persona buckets.
 *
 * Classifies every `source='extracted_fact'` row in the memories table into
 * one of the persona buckets (main | bob | gekko | warren) or the
 * cross-persona 'shared' bucket, using a local Ollama model (bulk
 * classification — no frontier model needed).
 *
 * DRY-RUN BY DEFAULT: without --apply the database is opened READ-ONLY and
 * nothing is written. The script produces a proposal JSON for human review.
 *
 * Usage:
 *   # Dry run (classify + write proposal, DB opened read-only):
 *   node scripts/reclassify-facts.mjs \
 *     --db /data/db/axiom.db \
 *     --out /workspace/fact-reclassify-proposal.json
 *
 *   # Apply a REVIEWED proposal file (creates a DB backup first):
 *   node scripts/reclassify-facts.mjs --apply \
 *     --db /data/db/axiom.db \
 *     --from /workspace/fact-reclassify-proposal.json
 *
 * Options:
 *   --db <path>          SQLite DB path (default: /data/db/axiom.db)
 *   --out <path>         Proposal output path (default: ./fact-reclassify-proposal.json)
 *   --from <path>        Proposal file to apply (required with --apply)
 *   --ollama-url <url>   Ollama base URL (default: http://192.168.10.222:11434)
 *   --model <name>       Ollama model (default: gemma4:26b-mlx)
 *   --batch-size <n>     Facts per LLM request (default: 20)
 *   --limit <n>          Only classify the first n facts (debugging)
 *   --resume             Reuse classifications from an existing --out file
 *   --apply              Apply proposals from --from (writes to the DB!)
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'))

const VALID_BUCKETS = new Set(['main', 'bob', 'gekko', 'warren', 'shared'])

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    db: '/data/db/axiom.db',
    out: path.resolve('fact-reclassify-proposal.json'),
    from: null,
    ollamaUrl: 'http://192.168.10.222:11434',
    model: 'gemma4:26b-mlx',
    batchSize: 20,
    limit: null,
    resume: false,
    apply: false,
  }

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--db': args.db = argv[++i]; break
      case '--out': args.out = path.resolve(argv[++i]); break
      case '--from': args.from = path.resolve(argv[++i]); break
      case '--ollama-url': args.ollamaUrl = argv[++i]; break
      case '--model': args.model = argv[++i]; break
      case '--batch-size': args.batchSize = Number(argv[++i]); break
      case '--limit': args.limit = Number(argv[++i]); break
      case '--resume': args.resume = true; break
      case '--apply': args.apply = true; break
      case '--help': case '-h':
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/')
        process.exit(0)
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        process.exit(1)
    }
  }

  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) {
    console.error('--batch-size must be a positive integer')
    process.exit(1)
  }

  return args
}

// ---------------------------------------------------------------------------
// Classification prompt
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = `Du klassifizierst gespeicherte Fakten eines Multi-Persona-Assistenten in Buckets.
Jeder Fakt gehört zu GENAU EINEM Bucket:

- "main": Der Orchestrator / persönliche Assistent von Nicolas. Alles Persönliche
  und Allgemeine: Familie, Wohnort, Karriere/Gehalt (bdtronic), Hobbys (MTB, Bike),
  Haushalt, Home Assistant / Smart Home, Termine, allgemeine Vorlieben, sowie die
  Infrastruktur und Konfiguration des Assistenten-Systems selbst (Axiom, OpenAgent,
  Telegram-Bots, Container, Proxmox/LXC, Backups, Netzwerk/WLAN).
- "bob": Coding-/Entwickler-Persona. Software-Entwicklung, Deployments, Repos,
  Code-Details, Build-Systeme, technische Implementierung von Side-Projekten
  (u.a. Halfway-Technik, SchnitzelBot, Looplab-Code, Artfactory, Scanner-Tools).
- "warren": Finanz-/Investment-Persona. Depot, Aktien, Trades, Portfolio-Scans,
  FIRE-Planung, Kinderdepots, Börsendaten, Ticker, Anlagethesen.
- "gekko": Business-/Pricing-Persona (kikuchilabs). Halfway-Business: Preise,
  Monetarisierung, Conversion, Funnel, Marketing, Umsatz.
- "shared": NUR die seltene Ausnahme, dass ein Fakt für MEHRERE Personas
  gleichzeitig handlungsrelevant ist. Typisch: Schnittstellen-Fakten gemeinsam
  bearbeiteter Projekte (z.B. Halfway: wo im Code die Preise liegen — betrifft
  Gekko UND Bob; Looplab-Fakten die Technik UND Business verbinden).

WICHTIGE REGELN:
1. "shared" ist die AUSNAHME, nicht der Default. Im Zweifel NICHT shared.
   Aufträge an eine Persona, Meinungen/Einschätzungen einer Persona und reine
   Domänen-Fakten bleiben im Persona-Bucket.
2. Viele Fakten liegen historisch fälschlich bei "main", obwohl sie fachlich zu
   einer Persona gehören (z.B. reine Coding-Fakten → bob, reine Depot-Fakten →
   warren). Solche Fehlzuordnungen korrigieren.
3. ABER: Fakten über das Assistenten-System selbst (Axiom/OpenAgent-Konfiguration,
   Telegram-Bot-Setup, Heartbeats, Cronjobs, Memory-System) bleiben bei "main" —
   das ist die Domäne des Orchestrators.
3b. ENTSCHEIDEND ist WEM das Werkzeug dient, NICHT wie technisch der Fakt klingt.
   Werkzeuge, die der Assistent SELBST benutzt, um Nicolas zu helfen, gehören zu
   "main" — auch wenn der Fakt nach Konfiguration/Code/OAuth/Dateipfaden klingt.
   Beispiele die bei "main" BLEIBEN: 'gog' (Gmail-/Kalender-Zugriff des Assistenten),
   Whisper/TTS, Ollama-Setup, SSH-Keys/Zugänge, Vaultwarden, Keyring, Paperless,
   Home Assistant, NAS/Netzwerk.
   Nach "bob" geht nur, was zu einem PRODUKT/PROJEKT gehört, das Nicolas baut
   (Halfway, Looplab, WerkstattLog, SchnitzelBot, Artfactory, Stockpicker-Code).
   Faustregel: "Womit arbeitet der Assistent?" → main.
                "Was baut Nicolas?" → bob.
4. Persönliches über Nicolas (Familie, Job, Gesundheit, Vorlieben, Fahrrad,
   Haushalt, Smart Home) bleibt bei "main".
5. Wenn der aktuelle Bucket plausibel ist, behalte ihn. Nur bei klarer
   Fehlzuordnung oder klarem Shared-Fall ändern.

Antworte NUR mit JSON in diesem Format:
{"classifications":[{"id":<nummer>,"bucket":"main|bob|gekko|warren|shared","reason":"<Kurzbegründung, max 12 Wörter>"}]}
Genau ein Eintrag pro Eingabe-Fakt, in derselben Reihenfolge.`

function buildBatchPrompt(facts) {
  const lines = facts.map(fact =>
    `ID ${fact.id} [aktuell: ${fact.agent_id}]: ${fact.content.replace(/\s+/g, ' ').trim()}`
  )
  return `Klassifiziere die folgenden ${facts.length} Fakten:\n\n${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Ollama call
// ---------------------------------------------------------------------------

async function ollamaChat(ollamaUrl, model, systemPrompt, userPrompt) {
  const response = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`)
  }

  const data = await response.json()
  return data?.message?.content ?? ''
}

/**
 * Salvage individual {"id":N,"bucket":"x","reason":"..."} records from malformed JSON.
 *
 * Local models occasionally emit broken object syntax (observed with gemma4:
 * `"reason klassifiziert als ..."` — missing colon and opening quote). A strict
 * JSON.parse throws away the whole batch for one bad character, so we fall back
 * to per-record regex extraction. Only id+bucket are required; a malformed
 * reason degrades to a placeholder instead of dropping a valid classification.
 */
function salvageClassifications(text) {
  const items = []
  const recordRe = /\{[^{}]*?"id"\s*:\s*(\d+)[^{}]*?\}/g
  let match
  while ((match = recordRe.exec(text)) !== null) {
    const chunk = match[0]
    const bucket = chunk.match(/"bucket"\s*:\s*"([^"]+)"/)
    if (!bucket) continue
    const reason = chunk.match(/"reason"\s*:\s*"([^"]*)"/)
    items.push({
      id: Number(match[1]),
      bucket: bucket[1],
      reason: reason ? reason[1] : '(Begründung unlesbar — aus defektem JSON geborgen)',
    })
  }
  return items
}

/** Extract a JSON object from a possibly fenced/prefixed LLM response. */
function extractJson(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  const candidate = fenced ? fenced[1] : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object found in response: ${trimmed.slice(0, 200)}`)
  }
  const slice = candidate.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch (error) {
    const salvaged = salvageClassifications(slice)
    if (salvaged.length === 0) throw error
    console.log(`  ⚠ malformed JSON — ${salvaged.length} Einträge per Regex geborgen`)
    return { classifications: salvaged }
  }
}

async function classifyBatch(args, facts, attempt = 1) {
  const MAX_ATTEMPTS = 3
  try {
    const raw = await ollamaChat(args.ollamaUrl, args.model, CLASSIFY_SYSTEM_PROMPT, buildBatchPrompt(facts))
    const parsed = extractJson(raw)
    const items = Array.isArray(parsed?.classifications) ? parsed.classifications : null
    if (!items) throw new Error('Response missing "classifications" array')

    const byId = new Map()
    for (const item of items) {
      const id = Number(item?.id)
      const bucket = String(item?.bucket ?? '').toLowerCase().trim()
      if (!Number.isInteger(id) || !VALID_BUCKETS.has(bucket)) continue
      byId.set(id, { bucket, reason: String(item?.reason ?? '').trim() || '(keine Begründung)' })
    }

    const missing = facts.filter(fact => !byId.has(fact.id))
    if (missing.length > 0 && attempt < MAX_ATTEMPTS) {
      console.warn(`  batch: ${missing.length}/${facts.length} facts missing in response, retrying those (attempt ${attempt + 1})`)
      const retried = await classifyBatch(args, missing, attempt + 1)
      for (const [id, value] of retried) byId.set(id, value)
    }

    return byId
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`  batch failed (${err.message}), retrying (attempt ${attempt + 1})`)
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
      return classifyBatch(args, facts, attempt + 1)
    }
    // Never abort the whole run for one bad batch: with ~1000 facts a single
    // unparseable response would otherwise discard all prior work. Unclassified
    // facts simply keep their current bucket (reported as skipped at the end).
    console.warn(`  ⚠ batch endgültig fehlgeschlagen (${err.message}) — ${facts.length} Fakten behalten ihren Bucket`)
    return new Map()
  }
}

// ---------------------------------------------------------------------------
// Dry run: classify + write proposal
// ---------------------------------------------------------------------------

async function runDryRun(args) {
  console.log(`[dry-run] Opening DB READ-ONLY: ${args.db}`)
  const db = new Database(args.db, { readonly: true, fileMustExist: true })

  let sql = "SELECT id, agent_id, content FROM memories WHERE source = 'extracted_fact' ORDER BY id"
  if (args.limit) sql += ` LIMIT ${args.limit}`
  const facts = db.prepare(sql).all()
  db.close()

  console.log(`[dry-run] ${facts.length} facts to classify (model: ${args.model} @ ${args.ollamaUrl})`)

  // Resume support: reuse prior classifications from an existing output file.
  const done = new Map()
  if (args.resume && fs.existsSync(args.out)) {
    try {
      const prior = JSON.parse(fs.readFileSync(args.out, 'utf8'))
      for (const proposal of prior?.proposals ?? []) {
        if (proposal?.id !== undefined && VALID_BUCKETS.has(proposal?.proposed_agent_id)) {
          done.set(proposal.id, { bucket: proposal.proposed_agent_id, reason: proposal.reason })
        }
      }
      console.log(`[dry-run] Resuming: ${done.size} facts already classified in ${args.out}`)
    } catch {
      console.warn('[dry-run] Could not parse existing output file, starting fresh')
    }
  }

  const pending = facts.filter(fact => !done.has(fact.id))
  const batches = []
  for (let i = 0; i < pending.length; i += args.batchSize) {
    batches.push(pending.slice(i, i + args.batchSize))
  }

  const startedAt = Date.now()
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const results = await classifyBatch(args, batch)
    for (const fact of batch) {
      const result = results.get(fact.id)
      done.set(fact.id, result ?? { bucket: fact.agent_id, reason: 'classification_failed: keep current' })
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
    console.log(`[dry-run] batch ${i + 1}/${batches.length} done (${done.size}/${facts.length} facts, ${elapsed}s elapsed)`)

    // Write partial progress after every batch so --resume can pick it up.
    writeProposal(args, facts, done, { partial: i + 1 < batches.length })
  }

  const { summary } = writeProposal(args, facts, done, { partial: false })
  console.log('[dry-run] Summary:')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`[dry-run] Proposal written to ${args.out}`)
  console.log('[dry-run] NOTHING was written to the database. Review the proposal, then run with --apply --from <file>.')
}

function writeProposal(args, facts, done, { partial }) {
  const proposals = facts
    .filter(fact => done.has(fact.id))
    .map(fact => {
      const result = done.get(fact.id)
      return {
        id: fact.id,
        content: fact.content,
        current_agent_id: fact.agent_id,
        proposed_agent_id: result.bucket,
        changed: result.bucket !== fact.agent_id,
        reason: result.reason,
      }
    })

  const byProposed = {}
  const byCurrent = {}
  const transitions = {}
  let changed = 0
  for (const proposal of proposals) {
    byProposed[proposal.proposed_agent_id] = (byProposed[proposal.proposed_agent_id] ?? 0) + 1
    byCurrent[proposal.current_agent_id] = (byCurrent[proposal.current_agent_id] ?? 0) + 1
    if (proposal.changed) {
      changed += 1
      const key = `${proposal.current_agent_id} -> ${proposal.proposed_agent_id}`
      transitions[key] = (transitions[key] ?? 0) + 1
    }
  }

  const summary = {
    total: facts.length,
    classified: proposals.length,
    unchanged: proposals.length - changed,
    changed,
    sharedProposed: byProposed.shared ?? 0,
    byCurrent,
    byProposed,
    transitions,
  }

  const output = {
    generatedAt: new Date().toISOString(),
    partial,
    db: args.db,
    model: args.model,
    summary,
    proposals,
  }

  fs.writeFileSync(args.out, JSON.stringify(output, null, 2))
  return { summary }
}

// ---------------------------------------------------------------------------
// Apply mode: write reviewed proposals to the DB (with backup)
// ---------------------------------------------------------------------------

function runApply(args) {
  if (!args.from) {
    console.error('--apply requires --from <proposal.json> (a reviewed dry-run output)')
    process.exit(1)
  }

  const proposalFile = JSON.parse(fs.readFileSync(args.from, 'utf8'))
  if (proposalFile.partial) {
    console.error('Refusing to apply: proposal file is marked partial (incomplete dry run).')
    process.exit(1)
  }

  const changes = (proposalFile.proposals ?? []).filter(proposal =>
    proposal.changed && VALID_BUCKETS.has(proposal.proposed_agent_id))

  console.log(`[apply] ${changes.length} changes to apply from ${args.from}`)

  // Backup first — always.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = `${args.db}.bak-reclassify-${stamp}`
  fs.copyFileSync(args.db, backupPath)
  console.log(`[apply] DB backup created: ${backupPath}`)

  const db = new Database(args.db)
  const update = db.prepare("UPDATE memories SET agent_id = ? WHERE id = ? AND source = 'extracted_fact' AND agent_id = ?")
  let applied = 0
  let skipped = 0

  const run = db.transaction(() => {
    for (const change of changes) {
      // Guard on the current agent_id so stale proposals never clobber rows
      // that changed since the dry run.
      const result = update.run(change.proposed_agent_id, change.id, change.current_agent_id)
      if (result.changes === 1) applied += 1
      else skipped += 1
    }
  })
  run()
  db.close()

  console.log(`[apply] Applied: ${applied}, skipped (row changed since dry run): ${skipped}`)
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv)
if (args.apply) {
  runApply(args)
} else {
  await runDryRun(args)
}
