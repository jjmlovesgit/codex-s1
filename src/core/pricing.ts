import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PricingTier {
  promptPerMillion: number;
  completionPerMillion: number;
  name?: string;
}

export interface CloudPricing {
  inputPerMillion: number;
  inputCachedPerMillion: number;
  outputPerMillion: number;
}

export interface PricingConfig {
  activeBenchmark: string;
  benchmarks: Record<string, PricingTier>;
  cloudRates?: CloudPricing;
}

export const SAFE_FALLBACK_BENCHMARK = 'gpt-5.6-luna';
export const SAFE_FALLBACK_TIER: PricingTier = {
  name: 'GPT-5.6 Luna High',
  promptPerMillion: 2.5,
  completionPerMillion: 10,
};

function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeTier(value: unknown): PricingTier | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (!validRate(candidate.promptPerMillion) || !validRate(candidate.completionPerMillion)) return undefined;
  return {
    promptPerMillion: candidate.promptPerMillion,
    completionPerMillion: candidate.completionPerMillion,
    ...(typeof candidate.name === 'string' && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
  };
}

function fallbackConfig(): PricingConfig {
  return {
    activeBenchmark: SAFE_FALLBACK_BENCHMARK,
    benchmarks: { [SAFE_FALLBACK_BENCHMARK]: { ...SAFE_FALLBACK_TIER } },
  };
}

export function loadPricingConfig(configPath?: string): PricingConfig {
  const resolvedPath = path.resolve(configPath ?? path.join(process.cwd(), '.codex', 'pricing.json'));
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return fallbackConfig();
    const source = parsed as Record<string, unknown>;
    const sourceBenchmarks = source.benchmarks;
    if (!sourceBenchmarks || typeof sourceBenchmarks !== 'object' || Array.isArray(sourceBenchmarks)) return fallbackConfig();
    const benchmarks: Record<string, PricingTier> = {};
    for (const [id, value] of Object.entries(sourceBenchmarks)) {
      const tier = normalizeTier(value);
      if (tier) benchmarks[id] = tier;
    }
    const requested = typeof source.activeBenchmark === 'string' ? source.activeBenchmark : '';
    const activeBenchmark = requested && benchmarks[requested] ? requested : benchmarks[SAFE_FALLBACK_BENCHMARK] ? SAFE_FALLBACK_BENCHMARK : Object.keys(benchmarks)[0];
    if (!activeBenchmark) return fallbackConfig();
    const cloudSource = source.cloudRates;
    const cloudRates = cloudSource && typeof cloudSource === 'object'
      ? {
          inputPerMillion: validRate((cloudSource as Record<string, unknown>).inputPerMillion) ? (cloudSource as Record<string, number>).inputPerMillion : benchmarks[activeBenchmark].promptPerMillion,
          inputCachedPerMillion: validRate((cloudSource as Record<string, unknown>).inputCachedPerMillion) ? (cloudSource as Record<string, number>).inputCachedPerMillion : benchmarks[activeBenchmark].promptPerMillion,
          outputPerMillion: validRate((cloudSource as Record<string, unknown>).outputPerMillion) ? (cloudSource as Record<string, number>).outputPerMillion : benchmarks[activeBenchmark].completionPerMillion,
        } as CloudPricing
      : undefined;
    return { activeBenchmark, benchmarks, ...(cloudRates ? { cloudRates } : {}) };
  } catch {
    return fallbackConfig();
  }
}

export function resolveActivePricing(config: PricingConfig): { benchmark: string; tier: PricingTier } {
  const tier = config.benchmarks[config.activeBenchmark];
  if (tier && validRate(tier.promptPerMillion) && validRate(tier.completionPerMillion)) {
    return { benchmark: config.activeBenchmark, tier };
  }
  return { benchmark: SAFE_FALLBACK_BENCHMARK, tier: { ...SAFE_FALLBACK_TIER } };
}
