import { loadPricingConfig, resolveActivePricing, type PricingConfig, type PricingTier } from './pricing.js';

export type { PricingConfig, PricingTier };
export { loadPricingConfig };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  localModel: string;
}

export type AccountingOutcome = 'accepted' | 'retry';

export interface OperationalMetrics {
  contextTokensShielded: number;
  estimatedBytesAvoided: number;
  estimatedCloudMessagesSaved: number;
  savedUSD: number;
  benchmarkModel: string;
  acceptedCompletionTokens: number;
  acceptedPromptTokens: number;
  retryWasteCompletionTokens: number;
  retryWastePromptTokens: number;
}

export class TokenLedger {
  private readonly records: Array<TokenUsage & { outcome: AccountingOutcome }> = [];
  private readonly pricing: PricingConfig | PricingTier;
  private acceptedPromptTokens = 0;
  private acceptedCompletionTokens = 0;
  private retryWastePromptTokens = 0;
  private retryWasteCompletionTokens = 0;

  constructor(pricing?: PricingConfig | PricingTier) {
    this.pricing = pricing ?? loadPricingConfig();
  }

  static loadConfig(configPath?: string): PricingConfig {
    return loadPricingConfig(configPath);
  }

  addUsage(usage: TokenUsage, outcome: AccountingOutcome = 'accepted'): void {
    if (
      !Number.isFinite(usage.promptTokens) ||
      usage.promptTokens < 0 ||
      !Number.isFinite(usage.completionTokens) ||
      usage.completionTokens < 0
    ) {
      throw new Error('Token counts must be non-negative finite numbers');
    }
    if (outcome !== 'accepted' && outcome !== 'retry') throw new Error('Invalid accounting outcome');
    this.records.push({ ...usage, outcome });
    if (outcome === 'accepted') {
      this.acceptedPromptTokens += usage.promptTokens;
      this.acceptedCompletionTokens += usage.completionTokens;
    } else {
      this.retryWastePromptTokens += usage.promptTokens;
      this.retryWasteCompletionTokens += usage.completionTokens;
    }
  }

  estimateMessagesSaved(completionTokens: number, tokensPerTurnBaseline = 1500): number {
    if (!Number.isFinite(completionTokens) || completionTokens < 0) {
      throw new Error('completionTokens must be a non-negative finite number');
    }
    if (!Number.isFinite(tokensPerTurnBaseline) || tokensPerTurnBaseline <= 0) {
      throw new Error('tokensPerTurnBaseline must be a positive finite number');
    }
    return Number((completionTokens / tokensPerTurnBaseline).toFixed(2));
  }

  calculateSavings(rates?: Pick<PricingTier, 'promptPerMillion' | 'completionPerMillion'>): {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalSavedUsd: number;
  } {
    const active = 'benchmarks' in this.pricing
      ? resolveActivePricing(this.pricing)
      : { benchmark: 'custom', tier: this.pricing };
    const promptRate = rates?.promptPerMillion ?? active.tier.promptPerMillion;
    const completionRate = rates?.completionPerMillion ?? active.tier.completionPerMillion;

    if (!Number.isFinite(promptRate) || promptRate < 0 || !Number.isFinite(completionRate) || completionRate < 0) {
      throw new Error('Pricing rates must be non-negative finite numbers');
    }

    return {
      totalPromptTokens: this.acceptedPromptTokens,
      totalCompletionTokens: this.acceptedCompletionTokens,
      totalSavedUsd: (this.acceptedPromptTokens / 1_000_000) * promptRate + (this.acceptedCompletionTokens / 1_000_000) * completionRate,
    };
  }

  getMetrics(fileContents: string[] = []): OperationalMetrics {
    const active = 'benchmarks' in this.pricing
      ? resolveActivePricing(this.pricing)
      : { benchmark: 'custom', tier: this.pricing };
    const savings = this.calculateSavings();
    const estimatedBytesAvoided = fileContents.reduce((total, content) => {
      if (typeof content !== 'string') throw new Error('fileContents must contain only strings');
      return total + Buffer.byteLength(content, 'utf8');
    }, 0);
    return {
      contextTokensShielded: this.acceptedCompletionTokens,
      estimatedBytesAvoided,
      estimatedCloudMessagesSaved: this.estimateMessagesSaved(this.acceptedCompletionTokens),
      savedUSD: savings.totalSavedUsd,
      benchmarkModel: active.benchmark,
      acceptedCompletionTokens: this.acceptedCompletionTokens,
      acceptedPromptTokens: this.acceptedPromptTokens,
      retryWasteCompletionTokens: this.retryWasteCompletionTokens,
      retryWastePromptTokens: this.retryWastePromptTokens,
    };
  }
}
