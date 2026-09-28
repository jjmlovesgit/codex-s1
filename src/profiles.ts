import { loadConfig, type ConfigProvider, type PrecogConfig } from './config.js'

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
  apiKey?: string
  source?: string
}

export interface Profiles {
  ARCHITECT: ProfileConfig
  WORKER: ProfileConfig
}

export interface ProviderPreset {
  provider: ConfigProvider;
  envKey?: string;
  baseUrl: string;
  defaultModel: string;
  name: string;
}

export const PROVIDER_PRESETS: Record<ConfigProvider, ProviderPreset> = {
  deepseek: { provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-flash', name: 'DeepSeek' },
  openai: { provider: 'openai', envKey: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o', name: 'OpenAI' },
  openrouter: { provider: 'openrouter', envKey: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat', name: 'OpenRouter' },
  groq: { provider: 'groq', envKey: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'qwen-2.5-coder-32b', name: 'Groq' },
  local: { provider: 'local', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'qwen/qwen3.8-27b', name: 'Local LM Studio' },
  custom: { provider: 'custom', baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: 'qwen/qwen3.8-27b', name: 'Custom worker' },
}

export interface ResolvedWorkerProfile extends ProfileConfig {
  source: string;
}

function keyFromConfig(config: PrecogConfig, env: NodeJS.ProcessEnv): string {
  if (config.keySource?.startsWith('env:')) return env[config.keySource.slice(4)] || '';
  return config.apiKey || '';
}

function presetForBase(baseUrl: string | undefined): ProviderPreset | undefined {
  if (!baseUrl) return undefined;
  return Object.values(PROVIDER_PRESETS).find(preset => preset.baseUrl === baseUrl);
}

function makeProfile(preset: ProviderPreset, values: { baseUrl?: string; model?: string; apiKey?: string; source: string }): ResolvedWorkerProfile {
  const apiKey = values.apiKey || '';
  return {
    name: apiKey ? 'WORKER_CLOUD' : 'WORKER_LOCAL',
    provider: preset.provider === 'local' ? 'lm-studio' : preset.provider,
    model: values.model || preset.defaultModel,
    endpoint: values.baseUrl || preset.baseUrl,
    apiKey,
    source: values.source,
    contextWindow: 32768,
    temperature: 0.2,
    max_tokens: 8192,
    stop: ['<<<END_DELEGATION>>>', '<|im_end|>', '<|endoftext|>'],
    enable_thinking: false,
    reasoning_effort: 'none',
  };
}

export function resolveWorkerProfile(env: NodeJS.ProcessEnv = process.env, config: PrecogConfig = loadConfig()): ResolvedWorkerProfile {
  const explicitBase = env.WORKER_BASE_URL;
  const explicitModel = env.WORKER_MODEL;
  const explicitKey = env.WORKER_API_KEY;
  if (explicitBase || explicitModel || explicitKey) {
    const preset = presetForBase(explicitBase) || (explicitKey ? PROVIDER_PRESETS.custom : PROVIDER_PRESETS.local);
    return makeProfile(preset, { baseUrl: explicitBase, model: explicitModel, apiKey: explicitKey, source: 'explicit process environment' });
  }

  if (config.provider || config.baseUrl || config.model || config.apiKey || config.keySource) {
    const preset = PROVIDER_PRESETS[config.provider || 'custom'];
    return makeProfile(preset, { baseUrl: config.baseUrl, model: config.model, apiKey: keyFromConfig(config, env), source: 'config file (~/.precog/config.json)' });
  }

  for (const provider of ['deepseek', 'openai', 'openrouter', 'groq'] as const) {
    const preset = PROVIDER_PRESETS[provider];
    if (preset.envKey && env[preset.envKey]) {
      return makeProfile(preset, { apiKey: env[preset.envKey], source: `auto-detected ($${preset.envKey})` });
    }
  }
  return makeProfile(PROVIDER_PRESETS.local, { source: 'local default' });
}

export const WORKER_PROFILE: ResolvedWorkerProfile = resolveWorkerProfile()

export const PROFILES: Profiles = {
  ARCHITECT: {
    name: 'ARCHITECT_CLOUD',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    uncappedContextWindow: true,
    systemInstruction:
      'You are the Lead Architect. You have access to the `delegate_worker` tool. For implementation, component code, file generation, test writing, or heavy algorithmic coding tasks, you MUST call the `delegate_worker` tool to delegate execution to the local worker on the RTX 5090 rather than outputting all code directly in chat markdown.',
  },
  WORKER: WORKER_PROFILE,
} as const
