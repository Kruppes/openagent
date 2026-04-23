import { describe, it, expect } from 'vitest'
import { stripMarkdownForTts, splitTextForTts, loadVoiceTelegramSettings } from './tts-utils.js'

describe('stripMarkdownForTts', () => {
  it('removes bold markers', () => {
    expect(stripMarkdownForTts('Das ist **wichtig** hier')).toBe('Das ist wichtig hier')
  })

  it('removes italic markers', () => {
    expect(stripMarkdownForTts('Das ist *kursiv* hier')).toBe('Das ist kursiv hier')
  })

  it('removes bold+italic markers', () => {
    expect(stripMarkdownForTts('Das ist ***beides*** hier')).toBe('Das ist beides hier')
  })

  it('removes underscore bold/italic', () => {
    expect(stripMarkdownForTts('Das ist __fett__ und _kursiv_')).toBe('Das ist fett und kursiv')
  })

  it('removes headers', () => {
    expect(stripMarkdownForTts('# Überschrift\n\nText')).toBe('Überschrift\n\nText')
    expect(stripMarkdownForTts('### Dritte Ebene')).toBe('Dritte Ebene')
  })

  it('replaces code blocks with spoken indicator', () => {
    const input = 'Hier ist Code:\n```javascript\nconst x = 1;\n```\nUnd weiter.'
    const result = stripMarkdownForTts(input)
    expect(result).toContain('(Code-Block übersprungen)')
    expect(result).not.toContain('const x = 1')
    expect(result).toContain('Und weiter.')
  })

  it('removes inline code backticks but keeps text', () => {
    expect(stripMarkdownForTts('Nutze `npm install` dafür')).toBe('Nutze npm install dafür')
  })

  it('keeps link text but removes URL', () => {
    expect(stripMarkdownForTts('Schau dir [diese Seite](https://example.com) an')).toBe(
      'Schau dir diese Seite an',
    )
  })

  it('removes images completely', () => {
    expect(stripMarkdownForTts('Ein Bild: ![alt text](https://img.png) hier')).toBe('Ein Bild: hier')
  })

  it('removes blockquote markers', () => {
    expect(stripMarkdownForTts('> Zitat hier\n> Zweite Zeile')).toBe('Zitat hier\nZweite Zeile')
  })

  it('removes horizontal rules', () => {
    expect(stripMarkdownForTts('Text\n---\nMehr Text')).toBe('Text\n\nMehr Text')
  })

  it('removes unordered list markers', () => {
    expect(stripMarkdownForTts('- Punkt eins\n- Punkt zwei')).toBe('Punkt eins\nPunkt zwei')
  })

  it('removes ordered list markers', () => {
    expect(stripMarkdownForTts('1. Erster\n2. Zweiter')).toBe('Erster\nZweiter')
  })

  it('removes emoji', () => {
    expect(stripMarkdownForTts('Hallo 👋 wie gehts 🚀')).toBe('Hallo wie gehts')
  })

  it('removes strikethrough', () => {
    expect(stripMarkdownForTts('Das ist ~~durchgestrichen~~ Text')).toBe('Das ist durchgestrichen Text')
  })

  it('collapses multiple newlines', () => {
    expect(stripMarkdownForTts('A\n\n\n\n\nB')).toBe('A\n\nB')
  })

  it('trims whitespace', () => {
    expect(stripMarkdownForTts('  Hallo  ')).toBe('Hallo')
  })

  it('handles complex real-world agent response', () => {
    const input = `## Zusammenfassung

Hier sind die **wichtigsten Punkte**:

1. Der *erste* Punkt ist relevant
2. Schau dir [die Docs](https://docs.example.com) an

\`\`\`python
print("hello")
\`\`\`

> Das ist ein Zitat

Fazit: Alles klar! 👍`

    const result = stripMarkdownForTts(input)
    expect(result).not.toContain('**')
    expect(result).not.toContain('*')
    expect(result).not.toContain('##')
    expect(result).not.toContain('[')
    expect(result).not.toContain('```')
    expect(result).not.toContain('👍')
    expect(result).toContain('Zusammenfassung')
    expect(result).toContain('wichtigsten Punkte')
    expect(result).toContain('die Docs')
    expect(result).toContain('(Code-Block übersprungen)')
    expect(result).toContain('Fazit: Alles klar!')
  })

  it('returns empty string for empty input', () => {
    expect(stripMarkdownForTts('')).toBe('')
  })

  it('handles text with only emoji', () => {
    expect(stripMarkdownForTts('👋🚀💪')).toBe('')
  })
})

describe('splitTextForTts', () => {
  it('returns single chunk for short text', () => {
    const result = splitTextForTts('Kurzer Text', 100)
    expect(result).toEqual(['Kurzer Text'])
  })

  it('splits at sentence boundary', () => {
    const text = 'Erster Satz. Zweiter Satz. Dritter Satz.'
    const result = splitTextForTts(text, 30)
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should end cleanly
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(30)
    }
  })

  it('splits long text without losing content', () => {
    const text = 'A'.repeat(100) + '. ' + 'B'.repeat(100) + '. ' + 'C'.repeat(100)
    const result = splitTextForTts(text, 150)
    const joined = result.join('')
    // Should preserve all content (allow for whitespace differences)
    expect(joined.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  it('handles text with no good split points', () => {
    const text = 'A'.repeat(300)
    const result = splitTextForTts(text, 100)
    expect(result.length).toBe(3)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
  })

  it('does not return empty chunks', () => {
    const text = 'Hallo. Welt. Test.'
    const result = splitTextForTts(text, 10)
    for (const chunk of result) {
      expect(chunk.length).toBeGreaterThan(0)
    }
  })

  it('uses default maxLength of 2000', () => {
    const text = 'A'.repeat(1999)
    const result = splitTextForTts(text)
    expect(result).toEqual([text])
  })
})

describe('loadVoiceTelegramSettings', () => {
  it('returns defaults when no config exists', () => {
    const settings = loadVoiceTelegramSettings(() => ({}))
    expect(settings.enabled).toBe(true)
    expect(settings.ttsUrl).toBe('http://192.168.10.222:7400')
    expect(settings.triggers.command).toBe(true)
    expect(settings.triggers.toggle).toBe(true)
    expect(settings.triggers.contextAuto).toBe(true)
    expect(settings.timeoutMs).toBe(30000)
    expect(settings.maxChunkLength).toBe(2000)
  })

  it('merges partial config with defaults', () => {
    const settings = loadVoiceTelegramSettings(() => ({
      voiceTelegram: {
        enabled: false,
        ttsUrl: 'http://custom:8080',
      },
    }))
    expect(settings.enabled).toBe(false)
    expect(settings.ttsUrl).toBe('http://custom:8080')
    expect(settings.triggers.command).toBe(true) // defaults
    expect(settings.timeoutMs).toBe(30000) // defaults
  })

  it('overrides trigger settings', () => {
    const settings = loadVoiceTelegramSettings(() => ({
      voiceTelegram: {
        triggers: { command: true, toggle: false, contextAuto: false },
      },
    }))
    expect(settings.triggers.command).toBe(true)
    expect(settings.triggers.toggle).toBe(false)
    expect(settings.triggers.contextAuto).toBe(false)
  })

  it('returns defaults on loadConfig error', () => {
    const settings = loadVoiceTelegramSettings(() => {
      throw new Error('File not found')
    })
    expect(settings.enabled).toBe(true)
    expect(settings.ttsUrl).toBe('http://192.168.10.222:7400')
  })
})
