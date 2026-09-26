import assert from 'node:assert/strict';
import { TTLCache } from '../src/TTLCache.js';

export function run(): { passed: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    const cache = new TTLCache<string, number>(100);
    cache.set('key1', 1);
    assert.strictEqual(cache.get('key1'), 1, 'should return the value for a valid key');

    setTimeout(() => {
      assert.strictEqual(cache.get('key1'), undefined, 'should return undefined after TTL');
    }, 150);

    cache.set('key2', 2);
    cache.delete('key2');
    assert.strictEqual(cache.get('key2'), undefined, 'should return undefined after deletion');

    cache.set('key3', 3);
    cache.clear();
    assert.strictEqual(cache.get('key3'), undefined, 'should return undefined after clearing');

    const invalidTTL = () => new TTLCache<string, number>(-1);
    assert.throws(invalidTTL, RangeError, 'should throw RangeError for negative TTL');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { passed: errors.length === 0, errors };
}
