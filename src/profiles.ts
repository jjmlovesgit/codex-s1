export interface ProfileConfig {
  name: string
  provider: string
  model: string
  endpoint?: string
  contextWindow?: number
  uncappedContextWindow?: boolean
  systemInstruction?: string
  temperature?: number
  max_tokens?: number
  stop?: string[]
  enable_thinking?: boolean
  reasoning_effort?: string
}

export interface Profiles {
  ARCHITECT: ProfileConfig
  WORKER: ProfileConfig
}

export const PROFILES: Profiles = {
  ARCHITECT: {
    name: 'ARCHITECT_CLOUD',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    uncappedContextWindow: true,
    systemInstruction:
      'You are the Lead Architect. You have access to the `delegate_worker` tool. For implementation, component code, file generation, test writing, or heavy algorithmic coding tasks, you MUST call the `delegate_worker` tool to delegate execution to the local worker on the RTX 5090 rather than outputting all code directly in chat markdown.',
  },
  WORKER: {
    name: 'WORKER_LOCAL',
    provider: 'lm-studio',
    model: 'qwen/qwen3.8-27b',
    endpoint: 'http://127.0.0.1:1234/v1',
    contextWindow: 32768,
    temperature: 0.2,
    max_tokens: 8192,
    stop: ['<<<END_DELEGATION>>>', '<|im_end|>', '<|endoftext|>'],
    enable_thinking: false,
    reasoning_effort: 'none',
  },
} as const
