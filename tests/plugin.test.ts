import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  DshLayaRouter,
  LLMSession,
  estimateTokenCount,
  extractPromptText,
  scanDLP,
  delegateWorker,
  extractAndEmitFiles,
  runSandboxVerification,
  parseTestOutput,
  DELEGATE_WORKER_OPENAI_SCHEMA,
  PROFILES,
  SavingsTracker,
  inject,
  using,
  apply,
} from '../src/index'
import * as path from 'path'
import * as fs from 'fs'

describe('DSH Laya Router Cordis Plugin Test Suite', () => {
  let router: DshLayaRouter

  beforeEach(() => {
    router = new DshLayaRouter({
      layaDaemonUrl: 'http://127.0.0.1:11435',
      localProvider: 'lm-studio',
      cloudProvider: 'deepseek-official',
      contextTokenThreshold: 30000,
    })
    vi.restoreAllMocks()
  })

  it('Cordis Service Injection & Schema: Exports inject, using, and DELEGATE_WORKER_OPENAI_SCHEMA', () => {
    expect(inject).toContain('tools')
    expect(using).toContain('tools')
    expect(DELEGATE_WORKER_OPENAI_SCHEMA.function.name).toBe('delegate_worker')
    expect(PROFILES.ARCHITECT.systemInstruction).toContain('delegate_worker')
  })

  it('DSH Tool Registration: Registers delegate_worker with output schema and render on ctx.tools', () => {
    const registerFn = vi.fn()
    const mockCtx: any = {
      tools: { register: registerFn },
      on: vi.fn(),
    }

    apply(mockCtx, {})

    expect(registerFn).toHaveBeenCalled()
    const registeredDef = registerFn.mock.calls[0][0]
    expect(registeredDef.name).toBe('delegate_worker')
    expect(registeredDef.output).toBeDefined()
    expect(registeredDef.output.schema).toBeDefined()
    expect(typeof registeredDef.output.render).toBe('function')
    expect(typeof registeredDef.execute).toBe('function')
  })

  it('Profiles Integrity: Exported ARCHITECT and WORKER profiles match standards', () => {
    expect(PROFILES.ARCHITECT.provider).toBe('deepseek-official')
    expect(PROFILES.ARCHITECT.model).toBe('deepseek-chat')
    expect(PROFILES.ARCHITECT.uncappedContextWindow).toBe(true)

    expect(PROFILES.WORKER.provider).toBe('lm-studio')
    expect(PROFILES.WORKER.model).toBe('qwen/qwen3.8-27b')
    expect(PROFILES.WORKER.contextWindow).toBe(32768)
    expect(PROFILES.WORKER.temperature).toBe(0.2)
    expect(PROFILES.WORKER.max_tokens).toBe(8192)
    expect(PROFILES.WORKER.stop).toContain('<|im_end|>')
    expect(PROFILES.WORKER.enable_thinking).toBe(false)
    expect(PROFILES.WORKER.reasoning_effort).toBe('none')
  })

  it('File Emitter: Parses structured code blocks and writes files to workspace', () => {
    const tmpWorkspace = path.join(process.cwd(), 'tmp_test_workspace')
    if (!fs.existsSync(tmpWorkspace)) fs.mkdirSync(tmpWorkspace, { recursive: true })

    const sampleContent = `Here is the PriorityQueue code:

\`\`\`typescript file="src/PriorityQueue.ts"
export class PriorityQueue<T> {
  private items: T[] = [];
}
\`\`\`

And the test:

\`\`\`typescript
// FILE: tests/PriorityQueue.test.ts
import { PriorityQueue } from '../src/PriorityQueue';
\`\`\`
`

    const res = extractAndEmitFiles(sampleContent, undefined, tmpWorkspace)

    expect(res.filesWritten).toHaveLength(2)
    const queueFile = path.join(tmpWorkspace, 'src', 'PriorityQueue.ts')
    const testFile = path.join(tmpWorkspace, 'tests', 'PriorityQueue.test.ts')

    expect(fs.existsSync(queueFile)).toBe(true)
    expect(fs.existsSync(testFile)).toBe(true)
    expect(fs.readFileSync(queueFile, 'utf8')).toContain('class PriorityQueue')

    fs.rmSync(tmpWorkspace, { recursive: true, force: true })
  })

  it('Test Parser: Parses TAP assertions and counts passes/failures', () => {
    const tapOutput = `TAP version 13
ok 1 - PriorityQueue insert
ok 2 - PriorityQueue extractMin
not ok 3 - PriorityQueue isEmpty
  AssertionError: expected true but got false
`
    const parsed = parseTestOutput(tapOutput)
    expect(parsed.passed).toBe(2)
    expect(parsed.failed).toBe(1)
    expect(parsed.errorSummary).toContain('not ok 3')
  })

  it('Helper: token estimation and text extraction', () => {
    const text = 'Hello world'
    expect(estimateTokenCount(text)).toBe(3)

    const session: LLMSession = {
      prompt: 'Hello from prompt',
      options: {},
    }
    expect(extractPromptText(session)).toBe('Hello from prompt')
  })

  it('DLP Firewall Scanner: Detects sensitive credentials and API keys', () => {
    const cleanText = 'Please write a React button component'
    expect(scanDLP(cleanText).hasSensitiveData).toBe(false)
    expect(scanDLP(cleanText).violations).toHaveLength(0)

    const ghpText = 'Here is my GitHub token: ghp_1234567890abcdef1234567890abcdef1234'
    const ghpResult = scanDLP(ghpText)
    expect(ghpResult.hasSensitiveData).toBe(true)
    expect(ghpResult.violations).toContain('GitHub PAT')

    const skText = 'sk-1234567890abcdef1234567890abcdef1234'
    const skResult = scanDLP(skText)
    expect(skResult.hasSensitiveData).toBe(true)
    expect(skResult.violations).toContain('OpenAI/DeepSeek API Key')

    const keyBlock = '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----'
    const keyResult = scanDLP(keyBlock)
    expect(keyResult.hasSensitiveData).toBe(true)
    expect(keyResult.violations).toContain('Private Key Block')
  })

  it('DLP Privacy Routing: Sensitive credentials force WORKER_LOCAL route', async () => {
    const sensitivePrompt = 'ghp_1234567890abcdef1234567890abcdef1234 secret_key="super_secret_pass"'
    const session: LLMSession = {
      prompt: sensitivePrompt,
      options: {},
    }

    const updated = await router.handleBeforeRequest(session)

    expect(updated.options?.provider).toBe('lm-studio')
    expect(updated.metadata?.router?.route).toBe('WORKER_LOCAL')
    expect(updated.metadata?.router?.dlpViolations).toBeDefined()
    expect(updated.metadata?.router?.dlpViolations?.length).toBeGreaterThan(0)
  })

  it('Architect Primary Thread: Prompts > 30k tokens route to ARCHITECT_CLOUD with uncapped context', async () => {
    const longPrompt = 'A'.repeat(125000)
    const session: LLMSession = {
      prompt: longPrompt,
      options: { provider: 'lm-studio' },
    }

    const updated = await router.handleBeforeRequest(session)

    expect(updated.options?.provider).toBe('deepseek-official')
    expect(updated.metadata?.router?.gate).toContain('Gate 0')
    expect(updated.metadata?.router?.route).toBe('ARCHITECT_CLOUD')
    expect(updated.metadata?.router?.tier).toContain('Cloud Tier')
  })

  it('Delegate Worker Tool: Dispatches task and returns structured receipt', async () => {
    const tmpDir = path.join(process.cwd(), 'tmp_test_delegate')
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

    const tracker = new SavingsTracker(tmpDir)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '```typescript file="src/math.ts"\nfunction add(a, b) { return a + b }\n```' } }],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        }),
      })
    )

    const res = await delegateWorker(
      {
        taskName: 'AddFunction',
        instruction: 'Write a helper function to add two numbers',
        targetFiles: ['src/math.ts'],
        endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
        workspaceDir: tmpDir,
      },
      tracker
    )

    expect(res.success).toBe(true)
    expect(res.status).toBe('SUCCESS')
    expect(res.filesWritten).toContain('src\\math.ts')
    expect(res.tokens.prompt).toBe(30)
    expect(res.tokens.completion).toBe(15)
    expect(res.summary).toContain('Wrote 1 file')

    const ledgerFile = path.join(tmpDir, 'savings-ledger.json')
    expect(fs.existsSync(ledgerFile)).toBe(true)
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
    expect(ledger.workerTurns).toBe(1)

    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Delegate Worker Tool: Returns clean ERROR receipt when LM Studio is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:1234')))

    const res = await delegateWorker({
      taskName: 'TestUnreachable',
      instruction: 'Run test',
    })

    expect(res.success).toBe(false)
    expect(res.status).toBe('ERROR')
    expect(res.message).toContain('LM Studio at 127.0.0.1:1234 was unreachable')
    expect(res.tokens.prompt).toBe(0)
  })

  it('Scenario 3: High complexity scores route to ARCHITECT_CLOUD', async () => {
    const complexPrompt = 'Refactor multi-threaded async state machine algorithm with deadlock resolution'
    const session: LLMSession = {
      prompt: complexPrompt,
      options: {},
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        route: 'cloud',
        rationale: 'High complexity score (complexity = 3 >= 2). Routing to DeepSeek Cloud.',
        gate: 'Gate 1 (Laya System 1 Inference - High Complexity)',
        scores: { is_private: 0.05, complexity: 3, target: 'CLOUD_DEEPSEEK' },
        latency_ms: 15.1,
      }),
    }))

    const updated = await router.handleBeforeRequest(session)

    expect(updated.options?.provider).toBe('deepseek-official')
    expect(updated.metadata?.router?.route).toBe('ARCHITECT_CLOUD')
    expect(updated.metadata?.router?.scores?.complexity).toBe(3)
  })

  it('Scenario 4: Simulated LM Studio failure triggers Cloud fallback', async () => {
    const session: LLMSession = {
      prompt: 'Simple query',
      options: { provider: 'lm-studio' },
      metadata: {
        router: {
          provider: 'lm-studio',
          route: 'WORKER_LOCAL',
          gate: 'Gate 1',
          rationale: 'Local route chosen',
          tier: 'Local Tier (RTX 5090 Worker)',
          estimatedTokens: 100,
        },
      },
      redispatch: vi.fn().mockResolvedValue({ ok: true }),
    }

    const oomError = new Error('ECONNREFUSED: LM Studio local server down or CUDA OOM')

    const updated = await router.handleError(session, oomError)

    expect(updated.options?.provider).toBe('deepseek-official')
    expect(updated.metadata?.router?.route).toBe('cloud-failover')
    expect(updated.metadata?.router?.failover).toBe(true)
    expect(updated.metadata?.router?.previousProvider).toBe('lm-studio')
  })
})
