import assert from 'node:assert/strict';
import { TokenLedger, type PricingConfig } from './tokenLedger.js';

export async function run(): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const config: PricingConfig = {
      activeBenchmark: 'gpt-4o',
      benchmarks: {
        'gpt-4o': { name: 'GPT-4o Standard', promptPerMillion: 2.5, completionPerMillion: 10 },
        'claude-3-5-sonnet': { name: 'Claude 3.5 Sonnet', promptPerMillion: 3, completionPerMillion: 15 },
      },
    };
    const ledger = new TokenLedger(config);
    ledger.addUsage({ promptTokens: 600, completionTokens: 100, localModel: 'm1' });
    ledger.addUsage({ promptTokens: 400, completionTokens: 100, localModel: 'm2' });

    const defaultSavings = ledger.calculateSavings();
    assert.equal(defaultSavings.totalPromptTokens, 1000);
    assert.equal(defaultSavings.totalCompletionTokens, 200);
    assert.ok(Math.abs(defaultSavings.totalSavedUsd - 0.0045) < 1e-9, 'configured benchmark savings mismatch');

    const customSavings = ledger.calculateSavings({ promptPerMillion: 2, completionPerMillion: 4 });
    assert.ok(Math.abs(customSavings.totalSavedUsd - 0.0028) < 1e-9, 'custom savings mismatch');

    assert.equal(ledger.estimateMessagesSaved(1425), 0.95);
    assert.equal(ledger.estimateMessagesSaved(3000), 2);
    const metrics = ledger.getMetrics(['hello', '🙂']);
    assert.equal(metrics.contextTokensShielded, 200);
    assert.equal(metrics.estimatedBytesAvoided, Buffer.byteLength('hello', 'utf8') + Buffer.byteLength('🙂', 'utf8'));
    assert.equal(metrics.estimatedCloudMessagesSaved, 0.13);
    assert.equal(metrics.savedUSD, defaultSavings.totalSavedUsd);
    assert.equal(metrics.benchmarkModel, 'gpt-4o');
    assert.equal(typeof ledger.estimateMessagesSaved, 'function');

    const switched = new TokenLedger({ ...config, activeBenchmark: 'claude-3-5-sonnet' });
    switched.addUsage({ promptTokens: 1_000_000, completionTokens: 0, localModel: 'm1' });
    assert.equal(switched.calculateSavings().totalSavedUsd, 3);

    const fallback = TokenLedger.loadConfig('missing-pricing-config-for-test.json');
    const fallbackLedger = new TokenLedger(fallback);
    fallbackLedger.addUsage({ promptTokens: 1_000_000, completionTokens: 1_000_000, localModel: 'fallback' });
    assert.equal(fallback.activeBenchmark, 'gpt-5.6-luna');
    assert.equal(fallbackLedger.calculateSavings().totalSavedUsd, 12.5);

    const ledger2 = new TokenLedger();
    assert.throws(() => ledger2.addUsage({ promptTokens: -1, completionTokens: 0, localModel: 'x' }), /non-negative/);
    assert.throws(() => ledger2.addUsage({ promptTokens: 0, completionTokens: -5, localModel: 'x' }), /non-negative/);
    assert.throws(() => ledger2.addUsage({ promptTokens: NaN, completionTokens: 0, localModel: 'x' }), /non-negative/);
    assert.throws(() => ledger2.addUsage({ promptTokens: Infinity, completionTokens: 0, localModel: 'x' }), /non-negative/);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { passed: errors.length === 0, errors };
}
