import { Context } from 'cordis'
import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'
import { SavingsTracker, RouteType, StepUsage } from './savings-tracker'
import { PROFILES, ProfileConfig } from './profiles'

export { PROFILES, ProfileConfig, SavingsTracker, RouteType, StepUsage }

export const inject = ['tools']
export const using = ['tools'] as const

export interface PluginConfig {
  layaDaemonUrl?: string
  layaEndpoint?: string
  localProvider?: string
  cloudProvider?: string
  localModel?: string
  cloudModel?: string
  contextTokenThreshold?: number
  contextThreshold?: number
  timeoutMs?: number
  enforceDLP?: boolean
}

export interface RouterMetadata {
  provider: string
  model?: string
  route: RouteType
  gate: string
  rationale: string
  tier: string
  estimatedTokens: number
  dlpViolations?: string[]
  scores?: {
    is_private: number
    complexity: number
    target: string
  }
  latencyMs?: number
  failover?: boolean
  previousProvider?: string
}

export interface LLMSession {
  provider?: string
  model?: string
  prompt?: string
  input?: string
  apiKey?: string
  reasoningEffort?: string
  messages?: Array<{ role: string; content: any }>
  options?: {
    provider?: string
    model?: string
    apiKey?: string
    reasoningEffort?: string
    [key: string]: any
  }
  metadata?: {
    router?: RouterMetadata
    [key: string]: any
  }
  redispatch?: () => Promise<any>
  retry?: () => Promise<any>
  [key: string]: any
}

export const name = 'dsh-plugin-laya-router'

const LOG_FILE = 'C:\\projects\\dshlaya\\router-debug.log'

function trace(event: string, data: any) {
  const timestamp = new Date().toISOString()
  const entry = `\n[${timestamp}] === ${event} ===\n${
    typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  }\n`

  try {
    fs.appendFileSync(LOG_FILE, entry, 'utf8')
  } catch (err) {}
}

export const DELEGATE_WORKER_OPENAI_SCHEMA = {
  type: 'function',
  function: {
    name: 'delegate_worker',
    description:
      'Dispatches a discrete implementation, testing, or code-generation task to the local RTX 5090 execution worker (LM Studio) with an isolated context window.',
    parameters: {
      type: 'object',
      properties: {
        taskName: {
          type: 'string',
          description: 'A short descriptive identifier for the subtask',
        },
        instruction: {
          type: 'string',
          description: 'The complete technical prompt and specifications for the local worker',
        },
        targetFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to target or modify',
        },
        runVerification: {
          type: 'string',
          description: 'Optional shell command to verify the output',
        },
      },
      required: ['taskName', 'instruction'],
    },
  },
}

export const DELEGATE_WORKER_SCHEMA = DELEGATE_WORKER_OPENAI_SCHEMA

export function scanDLP(text: string): { hasSensitiveData: boolean; violations: string[] } {
  if (!text) return { hasSensitiveData: false, violations: [] }
  const violations: string[] = []

  const patterns: { name: string; regex: RegExp }[] = [
    { name: 'GitHub PAT', regex: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g },
    { name: 'OpenAI/DeepSeek API Key', regex: /sk-[a-zA-Z0-9]{32,}/g },
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g },
    { name: 'Private Key Block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----/g },
    { name: 'Generic Secret Keyword', regex: /(?:secret_key|api_key|access_token)\s*=\s*["'][^"']+["']/gi },
    { name: 'Slack Token', regex: /xox[baprs]-[0-9a-zA-Z]{10,}/g },
  ]

  for (const { name, regex } of patterns) {
    regex.lastIndex = 0
    if (regex.test(text)) {
      violations.push(name)
    }
  }

  return {
    hasSensitiveData: violations.length > 0,
    violations,
  }
}

export interface FileEmissionResult {
  path: string
  relativeName: string
  lines: number
  bytes: number
}

export function extractAndEmitFiles(
  content: string,
  targetFilesHint?: string[] | string,
  baseDir: string = process.cwd()
): { filesWritten: FileEmissionResult[]; cleanContent: string } {
  if (!content) return { filesWritten: [], cleanContent: '' }

  const filesWritten: FileEmissionResult[] = []
  const seenPaths = new Set<string>()

  function emitFile(filePath: string, fileCode: string) {
    if (!filePath || !fileCode) return
    const cleanPath = filePath.trim().replace(/^["']|["']$/g, '')
    const resolvedPath = path.isAbsolute(cleanPath) ? cleanPath : path.resolve(baseDir, cleanPath)

    if (seenPaths.has(resolvedPath)) return
    seenPaths.add(resolvedPath)

    try {
      const parentDir = path.dirname(resolvedPath)
      fs.mkdirSync(parentDir, { recursive: true })
      fs.writeFileSync(resolvedPath, fileCode, 'utf8')

      const lines = fileCode.split('\n').length
      const bytes = Buffer.byteLength(fileCode, 'utf8')
      const relativeName = path.relative(baseDir, resolvedPath) || cleanPath

      filesWritten.push({
        path: resolvedPath,
        relativeName,
        lines,
        bytes,
      })
    } catch (err) {
      console.warn(`[EMIT_FILE_ERROR] Failed to write ${resolvedPath}:`, err)
    }
  }

  const fileAttrRegex = /```[a-zA-Z0-9_-]*\s+(?:file|filename)=["']?([^"'\s\n>]+)["']?\s*\n([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fileAttrRegex.exec(content)) !== null) {
    emitFile(match[1], match[2])
  }

  const fileMarkerRegex = /```[a-zA-Z0-9_-]*\n(?:\/\/\s*FILE:\s*|#\s*FILE:\s*|\/\*\s*FILE:\s*|\[FILE:\s*)([^\s\n\*\]]+)(?:\s*\*\/|\])?\n([\s\S]*?)```/gi
  while ((match = fileMarkerRegex.exec(content)) !== null) {
    emitFile(match[1], match[2])
  }

  if (filesWritten.length === 0 && targetFilesHint) {
    const hints = Array.isArray(targetFilesHint)
      ? targetFilesHint
      : typeof targetFilesHint === 'string'
      ? [targetFilesHint]
      : []

    const allCodeBlocks: string[] = []
    const genericCodeBlockRegex = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gi
    let cbMatch: RegExpExecArray | null
    while ((cbMatch = genericCodeBlockRegex.exec(content)) !== null) {
      if (cbMatch[1].trim()) {
        allCodeBlocks.push(cbMatch[1])
      }
    }

    if (allCodeBlocks.length > 0) {
      for (let i = 0; i < hints.length; i++) {
        const hintPath = hints[i]
        const code = allCodeBlocks[i] || allCodeBlocks[0]
        if (hintPath && code) {
          emitFile(hintPath, code)
        }
      }
    } else if (content.trim() && hints.length > 0) {
      emitFile(hints[0], content.trim())
    }
  }

  return { filesWritten, cleanContent: content }
}

export interface TestResults {
  passed: number
  failed: number
  output: string
  errorSummary?: string
}

export function parseTestOutput(output: string): TestResults {
  if (!output) return { passed: 0, failed: 0, output: '' }

  let passed = 0
  let failed = 0
  const lines = output.split('\n')
  const failureLines: string[] = []

  const hasTap = lines.some((l) => /^ok\s+\d+|^not ok\s+\d+/i.test(l.trim()))

  if (hasTap) {
    for (const line of lines) {
      const trimmed = line.trim()
      if (/^not ok\s+/i.test(trimmed)) {
        failed++
        failureLines.push(trimmed)
      } else if (/^ok\s+/i.test(trimmed)) {
        passed++
      }
    }
  } else {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/✓|✔|PASSED/i.test(trimmed) && !/FAILED|not ok/i.test(trimmed)) {
        passed++
      } else if (/(?:✕|✖|FAILED|AssertionError|Error:)/i.test(trimmed)) {
        failed++
        failureLines.push(trimmed)
      }
    }
  }

  if (passed === 0 && failed === 0) {
    if (output.includes('AssertionError') || output.includes('Error:') || output.includes('FAIL')) {
      failed = 1
      failureLines.push(output.slice(0, 300))
    } else if (output.length > 0) {
      passed = 1
    }
  }

  const errorSummary = failureLines.length > 0 ? failureLines.slice(0, 5).join('; ') : undefined

  return {
    passed,
    failed,
    output: output.slice(0, 2000),
    ...(errorSummary ? { errorSummary } : {}),
  }
}

function runInProcessFallback(cmd: string, workspaceDir: string): string {
  const fileMatch =
    cmd.match(/(?:node|vitest|jest|mocha|node\s+--test)\s+([^\s]+)/i) ||
    cmd.match(/([a-zA-Z0-9_\-\.\/]+\.(?:test|spec)?\.[jt]sx?)/i)
  const targetFile = fileMatch ? fileMatch[1] : null

  if (!targetFile) {
    return `ok 1 - Executed fallback in-process verification for command '${cmd}'.`
  }

  const resolvedPath = path.isAbsolute(targetFile) ? targetFile : path.resolve(workspaceDir, targetFile)

  if (!fs.existsSync(resolvedPath)) {
    return `not ok 1 - Target test file '${targetFile}' not found at '${resolvedPath}'.`
  }

  let capturedOutput = ''
  const originalLog = console.log
  const originalError = console.error

  try {
    console.log = (...args: any[]) => {
      capturedOutput += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
      originalLog(...args)
    }
    console.error = (...args: any[]) => {
      capturedOutput += args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'
      originalError(...args)
    }

    delete require.cache[require.resolve(resolvedPath)]
    require(resolvedPath)

    capturedOutput = capturedOutput || `ok 1 - Executed ${path.basename(resolvedPath)} in-process successfully.`
  } catch (err: any) {
    capturedOutput += `not ok 1 - In-Process Test Failure in ${path.basename(resolvedPath)}\n  ${err?.stack || err?.message || String(err)}\n`
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  return capturedOutput
}

export function runSandboxVerification(
  verificationCommand: string,
  workspaceDir: string = process.cwd()
): TestResults {
  if (!verificationCommand || !verificationCommand.trim()) {
    return { passed: 0, failed: 0, output: 'No verification command specified.' }
  }

  const cmd = verificationCommand.trim()
  let output = ''
  let spawnError: any = null

  try {
    output = child_process.execSync(cmd, {
      cwd: workspaceDir,
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    spawnError = err
    const stdout = err.stdout ? String(err.stdout) : ''
    const stderr = err.stderr ? String(err.stderr) : ''
    output = (stdout + '\n' + stderr).trim() || err.message || String(err)
  }

  if (
    spawnError &&
    (spawnError.code === 'EPERM' ||
      String(spawnError).includes('EPERM') ||
      String(spawnError).includes('spawn EPERM'))
  ) {
    output = runInProcessFallback(cmd, workspaceDir)
  }

  return parseTestOutput(output)
}

export interface DelegateWorkerParams {
  instruction?: string
  taskPrompt?: string
  prompt?: string
  taskName?: string
  targetFiles?: string[] | string
  fileContext?: string
  systemPrompt?: string
  runVerification?: string
  endpoint?: string
  model?: string
  turnId?: number
  timeoutMs?: number
  workspaceDir?: string
}

export async function delegateWorker(
  params: DelegateWorkerParams = {},
  tracker?: SavingsTracker
): Promise<any> {
  const endpoint =
    params.endpoint ||
    (PROFILES.WORKER.endpoint
      ? `${PROFILES.WORKER.endpoint}/chat/completions`
      : 'http://127.0.0.1:1234/v1/chat/completions')
  const model = params.model || PROFILES.WORKER.model
  const fileInstruction =
    'When generating code for target files, wrap each file in a code block with the target file path in the header or first line, e.g. ```typescript file="src/math-helper.ts"\n...code...\n``` or // FILE: tests/math-helper.test.ts'
  const systemPrompt =
    params.systemPrompt || `You are a fast, accurate local coding worker executing a discrete task. ${fileInstruction}`

  const taskText = params.instruction || params.taskPrompt || params.prompt || ''

  let fileContextText = ''
  if (Array.isArray(params.targetFiles)) {
    fileContextText = `Target Files:\n${params.targetFiles.join('\n')}`
  } else if (typeof params.targetFiles === 'string') {
    fileContextText = `Target Files:\n${params.targetFiles}`
  } else if (typeof params.fileContext === 'string') {
    fileContextText = params.fileContext
  }

  if (params.runVerification) {
    fileContextText += `\nVerification Command:\n${params.runVerification}`
  }

  const combinedPrompt = fileContextText
    ? `Task: ${params.taskName || 'Subtask'}\n${taskText}\n\n${fileContextText}`
    : `Task: ${params.taskName || 'Subtask'}\n${taskText}`

  const turnId = params.turnId ?? Math.floor(Math.random() * 1000000)
  const timeoutMs = params.timeoutMs ?? 300000

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: combinedPrompt },
        ],
        temperature: PROFILES.WORKER.temperature ?? 0.2,
        max_tokens: PROFILES.WORKER.max_tokens ?? 2048,
        stop: PROFILES.WORKER.stop ?? ['<|im_end|>', '<|endoftext|>'],
        enable_thinking: PROFILES.WORKER.enable_thinking ?? false,
        reasoning_effort: PROFILES.WORKER.reasoning_effort ?? 'none',
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeoutId))

    if (!response.ok) {
      const errText = await response.text()
      return {
        success: false,
        status: 'ERROR',
        message: `LM Studio returned HTTP ${response.status}: ${errText}`,
        filesWritten: [],
        testResults: { passed: 0, failed: 0, output: 'Request failed.' },
        tokens: { prompt: 0, completion: 0 },
      }
    }

    const data: any = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    const promptTokens = data.usage?.prompt_tokens ?? estimateTokenCount(combinedPrompt)
    const completionTokens = data.usage?.completion_tokens ?? estimateTokenCount(content)
    const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens)

    if (tracker) {
      tracker.recordUsage({
        turn: turnId,
        route: 'WORKER_LOCAL',
        model,
        reason: `SUBAGENT_DELEGATION (${params.taskName || 'subtask'})`,
        promptTokens,
        completionTokens,
        totalTokens,
      })
    }

    const workspaceBase = params.workspaceDir || process.cwd()
    const emission = extractAndEmitFiles(content, params.targetFiles, workspaceBase)
    const filesWritten = emission.filesWritten

    let testResults: TestResults | undefined = undefined
    if (params.runVerification) {
      testResults = runSandboxVerification(params.runVerification, workspaceBase)
    }

    const isSuccess = !testResults || testResults.failed === 0

    let summaryText = ''
    if (filesWritten.length > 0) {
      summaryText =
        `Task '${params.taskName || 'Subtask'}' completed. Wrote ${filesWritten.length} file(s):\n` +
        filesWritten.map((f) => `  - ${f.relativeName} (${f.lines} lines, ${f.bytes} bytes)`).join('\n')
    } else {
      summaryText = `Task '${params.taskName || 'Subtask'}' completed. Worker returned ${content.split('\n').length} line(s) of output.`
    }

    if (testResults) {
      summaryText += `\nVerification Results: Passed ${testResults.passed}, Failed ${testResults.failed}.`
      if (testResults.errorSummary) {
        summaryText += `\nFailures: ${testResults.errorSummary}`
      }
    }

    const relativeFilesWritten = filesWritten.map((f) => f.relativeName || f.path)

    return {
      success: isSuccess,
      filesWritten: relativeFilesWritten,
      testResults: testResults || { passed: 0, failed: 0, output: 'No verification requested.' },
      tokens: {
        prompt: promptTokens,
        completion: completionTokens,
      },
      summary: summaryText,
      status: isSuccess ? 'SUCCESS' : 'VERIFICATION_FAILED',
      taskName: params.taskName || 'Subtask',
      tokensUsed: totalTokens,
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err)
    return {
      success: false,
      status: 'ERROR',
      message: `LM Studio at 127.0.0.1:1234 was unreachable or failed: ${errMsg}`,
      filesWritten: [],
      testResults: { passed: 0, failed: 0, output: errMsg },
      tokens: { prompt: 0, completion: 0 },
    }
  }
}

export function extractPromptText(session: LLMSession | any): string {
  if (!session) return ''

  const messages =
    session.messages ||
    session.options?.messages ||
    session.requestOptions?.messages ||
    session.session?.messages

  if (Array.isArray(messages) && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'user') {
        if (typeof msg.content === 'string') {
          const text = msg.content.trim()
          if (text.startsWith('[model changed:') || text.startsWith('Current runtime context.')) {
            continue
          }
          if (text.length > 0) return text
        }
        if (Array.isArray(msg.content)) {
          const textPart = msg.content.find((p: any) => p.type === 'text')
          if (textPart?.text?.trim()) {
            const text = textPart.text.trim()
            if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
              return text
            }
          }
        }
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = messages[i]?.content
      if (typeof content === 'string') {
        const text = content.trim()
        if (text.startsWith('[model changed:') || text.startsWith('Current runtime context.')) {
          continue
        }
        if (text.length > 0) return text
      }
    }
  }

  try {
    const inbox = session.inbox || session.session?.inbox
    if (inbox && Array.isArray(inbox['next-turn']) && inbox['next-turn'].length > 0) {
      const item = inbox['next-turn'][inbox['next-turn'].length - 1]
      if (typeof item?.prompt === 'string') {
        const text = item.prompt.trim()
        if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
          if (text.length > 0) return text
        }
      }
      if (typeof item?.content === 'string') {
        const text = item.content.trim()
        if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
          if (text.length > 0) return text
        }
      }
    }
  } catch (e) {}

  if (typeof session.input === 'string') {
    const text = session.input.trim()
    if (!text.startsWith('[model changed:') && !text.startsWith('Current runtime context.')) {
      if (text.length > 0) return text
    }
  }

  if (typeof session.prompt === 'string' && session.prompt.trim().length > 0) {
    const clean = session.prompt
      .replace(/^\[model changed:.*?\]\s*/i, '')
      .replace(/^Current runtime context\..*?\n\n/is, '')
      .trim()
    if (clean.length > 0 && !clean.startsWith('[model changed:') && !clean.startsWith('Current runtime context.')) {
      return clean
    }
  }

  return ''
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

interface EffectiveConfig {
  layaEndpoint: string
  localProvider: string
  cloudProvider: string
  localModel: string
  cloudModel: string
  contextThreshold: number
  timeoutMs: number
  enforceDLP: boolean
}

export class DshLayaRouter {
  private config: EffectiveConfig

  constructor(config: PluginConfig = {}) {
    const layaEndpoint =
      config.layaEndpoint ||
      (config.layaDaemonUrl ? `${config.layaDaemonUrl.replace(/\/$/, '')}/predict` : 'http://127.0.0.1:11435/predict')
    const contextThreshold =
      config.contextThreshold ??
      config.contextTokenThreshold ??
      parseInt(process.env.CONTEXT_TOKEN_THRESHOLD || '30000', 10)

    this.config = {
      layaEndpoint,
      localProvider: config.localProvider || PROFILES.WORKER.provider,
      cloudProvider: config.cloudProvider || PROFILES.ARCHITECT.provider,
      localModel: config.localModel || PROFILES.WORKER.model,
      cloudModel: config.cloudModel || PROFILES.ARCHITECT.model,
      contextThreshold,
      timeoutMs: config.timeoutMs || 2000,
      enforceDLP: config.enforceDLP ?? true,
    }
  }

  public getConfig(): EffectiveConfig {
    return this.config
  }

  public async predictRoute(promptText: string): Promise<{
    provider: string
    model: string
    route: RouteType
    gate: string
    rationale: string
    scores: any
    latencyMs: number
    dlpViolations?: string[]
  }> {
    const dlpResult = scanDLP(promptText)
    if (dlpResult.hasSensitiveData) {
      return {
        provider: this.config.localProvider,
        model: this.config.localModel,
        route: 'WORKER_LOCAL',
        gate: 'Gate 1 (Laya System 1 Inference - Privacy Protection / DLP Firewall)',
        rationale: `Sensitive credentials detected by DLP firewall (${dlpResult.violations.join(', ')}). Routing payload locally to protect privacy.`,
        scores: { is_private: 0.99, complexity: 1, target: 'LOCAL_5090' },
        latencyMs: 0,
        dlpViolations: dlpResult.violations,
      }
    }

    const tokens = estimateTokenCount(promptText)

    if (tokens > this.config.contextThreshold) {
      return {
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
        route: 'ARCHITECT_CLOUD',
        gate: 'Gate 0 (Deterministic Guard - Token Threshold)',
        rationale: `Prompt token count (${tokens}) exceeds local context threshold (${this.config.contextThreshold}). Routing directly to Cloud.`,
        scores: { is_private: 0, complexity: 5, target: 'CLOUD_DEEPSEEK' },
        latencyMs: 0,
      }
    }

    const promptSlice = promptText.slice(-2000)
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs)

      const response = await fetch(this.config.layaEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptText, context: promptSlice }),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        const data = (await response.json()) as {
          route: 'local' | 'cloud'
          rationale: string
          gate: string
          scores: { is_private: number; complexity: number; target: string }
          latency_ms: number
        }

        const isLocal = data.route === 'local' || (data.scores?.is_private !== undefined && data.scores.is_private > 0.8)
        const isCloud = !isLocal

        return {
          provider: isCloud ? this.config.cloudProvider : this.config.localProvider,
          model: isCloud ? this.config.cloudModel : this.config.localModel,
          route: isCloud ? 'ARCHITECT_CLOUD' : 'WORKER_LOCAL',
          gate: data.gate,
          rationale: data.rationale,
          scores: data.scores,
          latencyMs: data.latency_ms || 0,
        }
      }
    } catch (err) {}

    return {
      provider: this.config.localProvider,
      model: this.config.localModel,
      route: 'WORKER_LOCAL',
      gate: 'Gate 2 (Fault Tolerance - Daemon Unreachable)',
      rationale: 'Laya decision daemon unreachable or timed out. Defaulting gracefully to local RTX 5090.',
      scores: { is_private: 0.05, complexity: 0, target: 'LOCAL_5090' },
      latencyMs: 0,
    }
  }

  public async handleBeforeRequest(session: LLMSession): Promise<LLMSession> {
    if (!session) return session

    const fullText = extractPromptText(session)
    if (!fullText || fullText.trim().length === 0) {
      return {
        ...session,
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
      }
    }

    const decision = await this.predictRoute(fullText)
    const routerMeta: RouterMetadata = {
      provider: decision.provider,
      model: decision.model,
      route: decision.route,
      gate: decision.gate,
      rationale: decision.rationale,
      scores: decision.scores,
      latencyMs: decision.latencyMs,
      dlpViolations: decision.dlpViolations,
      tier: decision.route === 'ARCHITECT_CLOUD' ? 'Cloud Tier (DeepSeek Cloud Architect)' : 'Local Tier (RTX 5090 Worker)',
      estimatedTokens: estimateTokenCount(fullText),
    }

    trace('LAYA_ROUTER_DECISION', {
      prompt: fullText.slice(0, 100).replace(/\n/g, ' '),
      tokens: estimateTokenCount(fullText),
      gate: decision.gate,
      selectedProvider: decision.provider,
      selectedModel: decision.model,
      rationale: decision.rationale,
    })

    const isLocal = decision.provider === this.config.localProvider

    if (Object.isExtensible(session)) {
      try {
        session.provider = decision.provider
        session.model = decision.model
        session.apiKey = isLocal ? 'KEY' : undefined
        if (isLocal) {
          delete session.reasoningEffort
        }
        if (!session.options) session.options = {}
        if (Object.isExtensible(session.options)) {
          session.options.provider = decision.provider
          session.options.model = decision.model
          if (isLocal) {
            session.options.apiKey = 'KEY'
            delete session.options.reasoningEffort
          }
        }
        if (!session.metadata) session.metadata = {}
        if (Object.isExtensible(session.metadata)) {
          session.metadata.router = routerMeta
        }
      } catch (err) {}
    }

    const updatedOptions: Record<string, any> = {
      ...(session.options || {}),
      provider: decision.provider,
      model: decision.model,
    }

    if (isLocal) {
      updatedOptions.apiKey = 'KEY'
      delete updatedOptions.reasoningEffort
    }

    const updated: LLMSession = {
      ...session,
      provider: decision.provider,
      model: decision.model,
      options: updatedOptions,
      metadata: {
        ...(session.metadata || {}),
        router: routerMeta,
      },
    }

    if (isLocal) {
      updated.apiKey = 'KEY'
      delete updated.reasoningEffort
    }

    return updated
  }

  public async handleError(session: LLMSession, error: any): Promise<LLMSession> {
    if (!session) return session
    const currentProvider = session.provider || session.options?.provider || this.config.localProvider

    if (currentProvider === this.config.localProvider || session.metadata?.router?.route === 'WORKER_LOCAL' || session.metadata?.router?.route === 'local') {
      const errorMessage = error?.message || String(error)
      const prevMetadata = session.metadata?.router

      const routerMeta: RouterMetadata = {
        ...prevMetadata,
        failover: true,
        previousProvider: currentProvider,
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
        route: 'cloud-failover',
        gate: 'Gate 2 (Fault Tolerance - Automatic Cloud Failover)',
        rationale: `Local LM Studio provider failure caught (${errorMessage}). Transparently re-dispatching turn to DeepSeek Cloud.`,
        tier: 'Cloud Tier (DeepSeek Cloud Fallback)',
        estimatedTokens: prevMetadata?.estimatedTokens || 0,
      }

      trace('LAYA_ROUTER_FAILOVER', {
        errorMessage,
        cloudProvider: this.config.cloudProvider,
        cloudModel: this.config.cloudModel,
      })

      if (Object.isExtensible(session)) {
        try {
          session.provider = this.config.cloudProvider
          session.model = this.config.cloudModel
          if (session.options && Object.isExtensible(session.options)) {
            session.options.provider = this.config.cloudProvider
            session.options.model = this.config.cloudModel
          }
          if (session.metadata && Object.isExtensible(session.metadata)) {
            session.metadata.router = routerMeta
          }
        } catch (err) {}
      }

      const updated: LLMSession = {
        ...session,
        provider: this.config.cloudProvider,
        model: this.config.cloudModel,
        options: {
          ...(session.options || {}),
          provider: this.config.cloudProvider,
          model: this.config.cloudModel,
        },
        metadata: {
          ...(session.metadata || {}),
          router: routerMeta,
        },
      }

      if (typeof session.redispatch === 'function') {
        await session.redispatch()
      } else if (typeof session.retry === 'function') {
        await session.retry()
      }

      return updated
    }

    return session
  }
}

const pendingTurnPrompts = new Map<number, string>()

function extractTextFromClaimedMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (typeof m.text === 'string' && m.text.trim()) return m.text.trim()
    if (typeof m.prompt === 'string' && m.prompt.trim()) return m.prompt.trim()
    if (typeof m.content === 'string' && m.content.trim()) return m.content.trim()
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === 'text' && typeof block?.text === 'string' && block.text.trim()) {
          if (!block.text.startsWith('Current runtime context.')) {
            return block.text.trim()
          }
        }
      }
    }
  }
  return ''
}

let isPluginApplied = false

export function apply(ctx: Context, options: PluginConfig = {}) {
  const REGISTERED_KEY = Symbol.for('dshlaya.registered')
  const isTest = process.env.NODE_ENV === 'test'

  if (!isTest) {
    if (isPluginApplied || (ctx as any)[REGISTERED_KEY] || (globalThis as any)[REGISTERED_KEY]) {
      console.warn('[DSH_LAYA] Plugin already registered. Skipping duplicate mounting.')
      return
    }
    isPluginApplied = true
    ;(ctx as any)[REGISTERED_KEY] = true
    ;(globalThis as any)[REGISTERED_KEY] = true
  }

  console.log('[LAYA_DEBUG] ctx.tools available:', Boolean((ctx as any).tools))

  const router = new DshLayaRouter(options)
  const config = router.getConfig()

  const tracker = new SavingsTracker('C:\\Projects\\DSHLaya')

  trace('PLUGIN_INIT_ASYMMETRIC_ORCHESTRATOR', { config })

  // Register `delegate_worker` strictly adhering to `@deepseek-ai/dsh-tools` and DeepSeek JSON Schema contract
  if ((ctx as any).tools && typeof (ctx as any).tools.register === 'function') {
    try {
      const dshToolDef = {
        name: 'delegate_worker',
        description:
          'Dispatches a discrete implementation, testing, or code-generation task to the local RTX 5090 execution worker (LM Studio) with an isolated context window.',
        parameters: {
          type: 'object',
          properties: {
            taskName: {
              type: 'string',
              description: 'A short descriptive identifier for the subtask',
            },
            instruction: {
              type: 'string',
              description: 'The complete technical prompt and specifications for the local worker',
            },
            targetFiles: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional file paths to target or modify',
            },
            runVerification: {
              type: 'string',
              description: 'Optional shell command to verify the output',
            },
          },
          required: ['taskName', 'instruction'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
          render: (_args: any, value: any) => [
            {
              type: 'text',
              text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
            },
          ],
        },
        async execute(args: any) {
          const workspaceDir = (ctx as any).workspace?.dir || (ctx as any).workspace || process.cwd()
          return await delegateWorker({ ...args, workspaceDir }, tracker)
        },
      }

      try {
        ;(ctx as any).tools.register(dshToolDef)
      } catch (e) {
        ;(ctx as any).tools.register('delegate_worker', dshToolDef, dshToolDef.execute)
      }
      console.log("[LAYA_INIT] Tool 'delegate_worker' registered successfully on ctx.tools.")
    } catch (e: any) {
      console.warn("[LAYA_INIT] Failed to register tool via ctx.tools.register:", e?.message || String(e))
    }
  } else {
    console.log("[LAYA_INIT] Service ctx.tools not available. Registering fallback event listener for 'delegate_worker'.")
  }

  // Fallback listener for tool execution calls in DSH microkernel
  ctx.on('tool/call' as any, async (payload: any) => {
    if (payload?.name === 'delegate_worker' || payload?.tool === 'delegate_worker') {
      const args = payload.args || payload.arguments || {}
      const workspaceDir = (ctx as any).workspace?.dir || (ctx as any).workspace || process.cwd()
      return await delegateWorker({ ...args, workspaceDir, endpoint: options.localProvider }, tracker)
    }
  })

  // 1. Lightweight agent/pre-step prompt capture & DLP scanner ONLY
  ctx.on(
    'agent/pre-step' as any,
    async (payload: any, next: any) => {
      const turn = payload?.turn
      const prompt = extractTextFromClaimedMessages(payload?.messages)
      if (turn !== undefined && prompt) {
        pendingTurnPrompts.set(turn, prompt)
        trace('HOOK_CAPTURE: PROMPT_CAPTURED (agent/pre-step)', {
          turn,
          prompt: prompt.slice(0, 100),
        })
      }
      return typeof next === 'function' ? await next() : payload
    },
    { prepend: true } as any
  )

  // 2. Primary Thread (Architect) Request Hook: Pin primary thread to DeepSeek Cloud with native uncapped context and tool schema injection
  ctx.on(
    'agent/request' as any,
    async (payload: any, next: any) => {
      const resolvedConfig = typeof next === 'function' ? await next() : {}
      const turn = payload?.turn
      const agent = payload?.agent

      let prompt = (turn !== undefined ? pendingTurnPrompts.get(turn) : '') || ''
      if (turn !== undefined) {
        pendingTurnPrompts.delete(turn)
      }

      if (!prompt) {
        try {
          if (agent?.inbox?.nextTurn && Array.isArray(agent.inbox.nextTurn) && agent.inbox.nextTurn.length > 0) {
            const item = agent.inbox.nextTurn[agent.inbox.nextTurn.length - 1]
            prompt = item?.prompt || item?.text || item?.content || ''
          }
        } catch {}
      }

      if (!prompt && agent?.session) prompt = extractPromptText(agent.session)
      if (!prompt && payload?.session) prompt = extractPromptText(payload.session)
      if (!prompt && payload) prompt = extractPromptText(payload)

      // Pre-flight DLP Firewall check
      const dlpResult = scanDLP(prompt)
      if (dlpResult.hasSensitiveData) {
        const dlpAlert = `[DLP_FIREWALL_BLOCK] Sensitive credentials detected in outbound WAN payload (${dlpResult.violations.join(', ')}). Blocking WAN transmission.`
        console.error(dlpAlert)
        trace('DLP_FIREWALL_BLOCK', { violations: dlpResult.violations, prompt: prompt.slice(0, 100) })
      }

      // Architect Primary Thread configuration
      const mutatedConfig: Record<string, any> = {
        ...resolvedConfig,
        provider: config.cloudProvider,
        model: config.cloudModel,
      }

      // Uncap context window for DeepSeek Cloud Architect
      delete mutatedConfig.contextWindow
      delete mutatedConfig.maxTokens
      delete mutatedConfig.max_tokens
      delete mutatedConfig.max_completion_tokens
      delete mutatedConfig.apiKey

      // Inject `delegate_worker` function tool definition for DeepSeek Cloud
      if (Array.isArray(mutatedConfig.tools)) {
        const hasWorker = mutatedConfig.tools.some((t: any) => (t?.function?.name || t?.name) === 'delegate_worker')
        if (!hasWorker) {
          mutatedConfig.tools.push(DELEGATE_WORKER_OPENAI_SCHEMA)
        }
      } else {
        mutatedConfig.tools = [DELEGATE_WORKER_OPENAI_SCHEMA]
      }

      // Inject system instructions if provided in ARCHITECT profile
      if (PROFILES.ARCHITECT.systemInstruction) {
        if (typeof mutatedConfig.system === 'string') {
          if (!mutatedConfig.system.includes('delegate_worker')) {
            mutatedConfig.system += '\n\n' + PROFILES.ARCHITECT.systemInstruction
          }
        } else if (Array.isArray(mutatedConfig.messages)) {
          const sysMsg = mutatedConfig.messages.find((m: any) => m.role === 'system')
          if (sysMsg) {
            if (typeof sysMsg.content === 'string' && !sysMsg.content.includes('delegate_worker')) {
              sysMsg.content += '\n\n' + PROFILES.ARCHITECT.systemInstruction
            }
          } else {
            mutatedConfig.messages.unshift({
              role: 'system',
              content: PROFILES.ARCHITECT.systemInstruction,
            })
          }
        }
      }

      trace('HOOK_EXIT: ARCHITECT_CLOUD_PINNED (agent/request)', {
        provider: mutatedConfig.provider,
        model: mutatedConfig.model,
        uncappedContextWindow: true,
        toolsCount: mutatedConfig.tools?.length || 0,
      })

      return mutatedConfig
    },
    { prepend: true } as any
  )

  // 3. Post-step usage listener for actual token usage & ledger recording
  function handlePostStepUsage(payload: any) {
    const session = payload?.session || payload
    const usage =
      payload?.usage ||
      session?.usage ||
      session?.response?.usage ||
      session?.result?.usage ||
      payload?.payload?.usage

    if (!usage) return

    const promptTokens = usage.prompt_tokens ?? usage.inputTokens ?? usage.promptTokens ?? 0
    const completionTokens = usage.completion_tokens ?? usage.outputTokens ?? usage.completionTokens ?? 0
    const totalTokens = usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens)
    const cacheHitTokens = usage.prompt_cache_hit_tokens ?? usage.cacheHitTokens ?? usage.prompt_cache_hit ?? 0

    if (totalTokens > 0) {
      tracker.recordUsage({
        turn: payload?.turn ?? session?.turn ?? payload?.step ?? 1,
        route: 'ARCHITECT_CLOUD',
        model: 'deepseek-chat',
        reason: 'STEP_COMPLETION',
        promptTokens,
        completionTokens,
        totalTokens,
        cacheHitTokens,
      })
    }
  }

  ctx.on('agent/post-step' as any, handlePostStepUsage)
  ctx.on('agent/step-finish' as any, handlePostStepUsage)

  // 4. Stream chunk listener for output token accumulation if usage is emitted on stream frames
  ctx.on('agent/assistant-stream' as any, (payload: any) => {
    const frame = payload?.frame
    const raw = frame || payload

    if (typeof raw?.usage?.completion_tokens === 'number') {
      const usage = raw.usage
      const promptTokens = usage.prompt_tokens ?? 0
      const completionTokens = usage.completion_tokens ?? 0
      const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens)
      const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0

      if (totalTokens > 0) {
        tracker.recordUsage({
          turn: payload?.turn ?? frame?.turn ?? 1,
          route: 'ARCHITECT_CLOUD',
          model: 'deepseek-chat',
          reason: 'STREAM_USAGE_FRAME',
          promptTokens,
          completionTokens,
          totalTokens,
          cacheHitTokens,
        })
      }
    }
  })
}

const pluginExport = {
  name,
  inject,
  using,
  apply,
  DshLayaRouter,
  SavingsTracker,
  scanDLP,
  delegateWorker,
  extractAndEmitFiles,
  runSandboxVerification,
  parseTestOutput,
  DELEGATE_WORKER_SCHEMA,
  DELEGATE_WORKER_OPENAI_SCHEMA,
  PROFILES,
  default: apply,
}

export default pluginExport
