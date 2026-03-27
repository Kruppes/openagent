import { describe, it, expect, afterEach } from 'vitest'
import { loadProviders, getActiveProvider, buildModel, estimateCost } from './provider-config.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('provider-config', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  function setupTmpConfig(providersContent: object): void {
    tmpDir = path.join(os.tmpdir(), `openagent-provider-test-${Date.now()}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify(providersContent, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('loadProviders returns empty providers when file does not exist', () => {
    tmpDir = path.join(os.tmpdir(), `openagent-provider-test-${Date.now()}`)
    process.env.DATA_DIR = tmpDir
    const result = loadProviders()
    expect(result.providers).toEqual([])
  })

  it('loadProviders reads providers.json correctly', () => {
    setupTmpConfig({
      providers: [
        {
          name: 'my-openai',
          type: 'openai-completions',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          defaultModel: 'gpt-4o',
        },
      ],
    })

    const result = loadProviders()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].name).toBe('my-openai')
    expect(result.providers[0].apiKey).toBe('sk-test')
  })

  it('getActiveProvider returns null when no providers configured', () => {
    setupTmpConfig({ providers: [] })
    expect(getActiveProvider()).toBeNull()
  })

  it('getActiveProvider returns first provider by default', () => {
    setupTmpConfig({
      providers: [
        { name: 'first', type: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', defaultModel: 'gpt-4o' },
        { name: 'second', type: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' },
      ],
    })

    const active = getActiveProvider()
    expect(active?.name).toBe('first')
  })

  it('getActiveProvider respects activeProvider field', () => {
    setupTmpConfig({
      providers: [
        { name: 'first', type: 'openai-completions', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', defaultModel: 'gpt-4o' },
        { name: 'second', type: 'anthropic-messages', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-2', defaultModel: 'claude-3-5-sonnet-20241022' },
      ],
      activeProvider: 'second',
    })

    const active = getActiveProvider()
    expect(active?.name).toBe('second')
  })

  it('buildModel creates a valid Model object', () => {
    const provider = {
      name: 'test',
      type: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    }

    const model = buildModel(provider)
    expect(model.id).toBe('gpt-4o')
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('openai')
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
    expect(model.cost.input).toBe(2.50)
    expect(model.cost.output).toBe(10.00)
  })

  it('buildModel uses model config overrides', () => {
    const provider = {
      name: 'test',
      type: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'custom-model',
      models: [
        {
          id: 'custom-model',
          name: 'Custom Model',
          contextWindow: 256000,
          maxTokens: 32768,
          reasoning: true,
          cost: { input: 5.0, output: 15.0, cacheRead: 1.0, cacheWrite: 2.0 },
        },
      ],
    }

    const model = buildModel(provider)
    expect(model.id).toBe('custom-model')
    expect(model.name).toBe('Custom Model')
    expect(model.contextWindow).toBe(256000)
    expect(model.maxTokens).toBe(32768)
    expect(model.reasoning).toBe(true)
    expect(model.cost.input).toBe(5.0)
    expect(model.cost.cacheRead).toBe(1.0)
  })

  it('buildModel allows overriding model ID', () => {
    const provider = {
      name: 'test',
      type: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    }

    const model = buildModel(provider, 'gpt-4o-mini')
    expect(model.id).toBe('gpt-4o-mini')
    expect(model.cost.input).toBe(0.15)
  })

  it('estimateCost calculates correctly', () => {
    const model = buildModel({
      name: 'test',
      type: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o',
    })

    // 1000 input tokens at $2.50/M = $0.0025
    // 500 output tokens at $10.00/M = $0.005
    const cost = estimateCost(model, 1000, 500)
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  it('estimateCost includes cache costs', () => {
    const provider = {
      name: 'test',
      type: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'custom',
      models: [
        {
          id: 'custom',
          cost: { input: 10.0, output: 30.0, cacheRead: 2.5, cacheWrite: 5.0 },
        },
      ],
    }

    const model = buildModel(provider)
    const cost = estimateCost(model, 1000, 500, 2000, 1000)
    // input: 1000/1M * 10 = 0.01
    // output: 500/1M * 30 = 0.015
    // cacheRead: 2000/1M * 2.5 = 0.005
    // cacheWrite: 1000/1M * 5 = 0.005
    expect(cost).toBeCloseTo(0.035, 6)
  })
})
