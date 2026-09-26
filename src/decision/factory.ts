import * as fs from 'node:fs';
import * as path from 'node:path';
import { HeuristicEngine } from './providers/HeuristicEngine.js';
import { HttpSidecarEngine } from './providers/HttpSidecarEngine.js';
import { LayaOnnxEngine } from './providers/LayaOnnxEngine.js';
import type { ISystemOneEngine } from './types.js';

export interface DecisionProviderConfig {
  endpoint?: string;
  modelPath?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface DecisionConfig {
  activeProvider?: string;
  providers?: Record<string, DecisionProviderConfig>;
}

export type EngineFactory = (config: DecisionProviderConfig) => ISystemOneEngine;

export const engineRegistry: Record<string, EngineFactory> = {
  heuristic: config => new HeuristicEngine({ name: 'heuristic' }),
  'http-sidecar': config => new HttpSidecarEngine({
    endpoint: config.endpoint!,
    timeoutMs: config.timeoutMs,
    headers: config.headers,
  }),
  http_sidecar: config => new HttpSidecarEngine({
    endpoint: config.endpoint!,
    timeoutMs: config.timeoutMs,
    headers: config.headers,
  }),
  'laya-onnx': config => new LayaOnnxEngine({ modelPath: config.modelPath }),
  laya_onnx: config => new LayaOnnxEngine({ modelPath: config.modelPath }),
};

function defaultConfig(): DecisionConfig {
  return { activeProvider: 'heuristic', providers: { heuristic: {} } };
}

export function loadDecisionConfig(configPath?: string): DecisionConfig {
  const resolved = path.resolve(configPath ?? path.join(process.cwd(), '.codex', 'decision.json'));
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return defaultConfig();
    const source = parsed as Record<string, unknown>;
    const rawProviders = source.providers ?? source.engines;
    const providers = rawProviders && typeof rawProviders === 'object' && !Array.isArray(rawProviders)
      ? Object.fromEntries(Object.entries(rawProviders).flatMap(([key, value]) => {
          if (typeof value === 'string') return [[key, { endpoint: value }]];
          return value && typeof value === 'object' ? [[key, value]] : [];
        })) as Record<string, DecisionProviderConfig>
      : {};
    return {
      activeProvider: typeof source.activeProvider === 'string' ? source.activeProvider : typeof source.activeEngine === 'string' ? source.activeEngine : typeof source.provider === 'string' ? source.provider : 'heuristic',
      providers,
    };
  } catch {
    return defaultConfig();
  }
}

export function createDecisionEngine(configOrPath?: DecisionConfig | string): ISystemOneEngine {
  const config = typeof configOrPath === 'string' || configOrPath === undefined
    ? loadDecisionConfig(configOrPath)
    : configOrPath;
  const active = config.activeProvider ?? 'heuristic';
  const providerConfig = config.providers?.[active] ?? {};
  const factory = engineRegistry[active];
  if (!factory || providerConfig.enabled === false) return new HeuristicEngine();
  if ((active === 'http-sidecar' || active === 'http_sidecar') && !providerConfig.endpoint) return new HeuristicEngine();
  if ((active === 'laya-onnx' || active === 'laya_onnx') && !providerConfig.modelPath) return new HeuristicEngine();
  if ((active === 'laya-onnx' || active === 'laya_onnx') && providerConfig.modelPath && !fs.existsSync(path.resolve(providerConfig.modelPath))) return new HeuristicEngine();
  try {
    return factory(providerConfig);
  } catch {
    return new HeuristicEngine();
  }
}

export const activeEngine: ISystemOneEngine = createDecisionEngine();
