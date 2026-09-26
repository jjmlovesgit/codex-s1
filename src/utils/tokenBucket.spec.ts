import assert from 'node:assert/strict';
import { TokenBucket } from './tokenBucket.js';

export async function run(): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    // Test burst capacity
    const bucket1 = new TokenBucket({ capacity: 10, refillRatePerSecond: 10 });
    for (let i = 0; i < 10; i++) {
      assert(bucket1.consume(), `consume ${i + 1} should succeed`);
    }
    assert(!bucket1.consume(), 'consume 11 should fail');

    // Test excess false responses
    const bucket2 = new TokenBucket({ capacity: 5, refillRatePerSecond: 5 });
    assert(bucket2.consume(5), 'consume 5 should succeed');
    assert(!bucket2.consume(1), 'consume 1 should fail after 5');

    // Test roughly 50ms proportional refill
    const bucket3 = new TokenBucket({ capacity: 10, refillRatePerSecond: 10 });
    bucket3.consume(5);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(bucket3.getTokens() >= 5 && bucket3.getTokens() <= 6, 'should have roughly 5 tokens after 50ms');

    // Test clamping
    const bucket4 = new TokenBucket({ capacity: 5, refillRatePerSecond: 10 });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(bucket4.getTokens() === 5, 'should be clamped to capacity');

    // Test reset
    const bucket5 = new TokenBucket({ capacity: 10, refillRatePerSecond: 10 });
    bucket5.consume(5);
    bucket5.reset();
    assert(bucket5.getTokens() === 10, 'should reset to full capacity');

    // Test invalid options
    try {
      new TokenBucket({ capacity: -1, refillRatePerSecond: 10 });
      errors.push('negative capacity should throw');
    } catch (error: unknown) {
      assert(error instanceof RangeError, 'negative capacity should throw RangeError');
    }

    try {
      new TokenBucket({ capacity: 10, refillRatePerSecond: -1 });
      errors.push('negative refillRatePerSecond should throw');
    } catch (error: unknown) {
      assert(error instanceof RangeError, 'negative refillRatePerSecond should throw RangeError');
    }

    try {
      new TokenBucket({ capacity: NaN, refillRatePerSecond: 10 });
      errors.push('NaN capacity should throw');
    } catch (error: unknown) {
      assert(error instanceof RangeError, 'NaN capacity should throw RangeError');
    }

    try {
      new TokenBucket({ capacity: 10, refillRatePerSecond: NaN });
      errors.push('NaN refillRatePerSecond should throw');
    } catch (error: unknown) {
      assert(error instanceof RangeError, 'NaN refillRatePerSecond should throw RangeError');
    }

    try {
      new TokenBucket({ capacity: 10, refillRatePerSecond: Infinity });
      errors.push('Infinity refillRatePerSecond should throw');
    } catch (error: unknown) {
      assert(error instanceof RangeError, 'Infinity refillRatePerSecond should throw RangeError');
    }

    try {
      new TokenBucket({ capacity: Infinity, refillRatePerSecond: 10 });
      errors.push('Infinity capacity should throw');
    } catch (error: unknown) {
      assert(error instanceof RangeError, 'Infinity capacity should throw RangeError');
    }

    // Test safe unknown catch narrowing
    try {
      new TokenBucket({ capacity: '10' as unknown as number, refillRatePerSecond: 10 });
      errors.push('string capacity should throw');
    } catch (error: unknown) {
      assert(error instanceof TypeError, 'string capacity should throw TypeError');
    }

    try {
      new TokenBucket({ capacity: 10, refillRatePerSecond: '10' as unknown as number });
      errors.push('string refillRatePerSecond should throw');
    } catch (error: unknown) {
      assert(error instanceof TypeError, 'string refillRatePerSecond should throw TypeError');
    }
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { passed: errors.length === 0, errors };
}

