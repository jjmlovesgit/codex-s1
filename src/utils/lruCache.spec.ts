import assert from 'node:assert/strict';
import { LRUCache } from './lruCache.js';

export async function run(): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    // Test constructor
    const cache = new LRUCache<number, string>({ capacity: 3 });
    assert.equal(cache.size, 0, 'Initial size should be 0');

    // Test basic get/set
    cache.set(1, 'one');
    cache.set(2, 'two');
    cache.set(3, 'three');
    assert.equal(cache.get(1), 'one', 'get(1) should return "one"');
    assert.equal(cache.get(2), 'two', 'get(2) should return "two"');
    assert.equal(cache.get(3), 'three', 'get(3) should return "three"');
    assert.equal(cache.size, 3, 'Size should be 3 after setting 1, 2, 3');

    // Test eviction
    cache.set(4, 'four');
    assert.equal(cache.get(1), undefined, 'get(1) should return undefined after setting 4');
    assert.equal(cache.get(2), 'two', 'get(2) should return "two" after setting 4');
    assert.equal(cache.get(3), 'three', 'get(3) should return "three" after setting 4');
    assert.equal(cache.get(4), 'four', 'get(4) should return "four" after setting 4');
    assert.equal(cache.size, 3, 'Size should be 3 after setting 4');

    // Test recency updates
    cache.get(2);
    cache.set(5, 'five');
    assert.equal(cache.get(3), undefined, 'get(3) should return undefined after get(2) and set(5)');
    assert.equal(cache.get(2), 'two', 'get(2) should return "two" after get(2) and set(5)');
    assert.equal(cache.get(4), 'four', 'get(4) should return "four" after get(2) and set(5)');
    assert.equal(cache.get(5), 'five', 'get(5) should return "five" after get(2) and set(5)');
    assert.equal(cache.size, 3, 'Size should be 3 after get(2) and set(5)');

    // Test has
    assert.ok(cache.has(2), 'has(2) should return true');
    assert.ok(cache.has(4), 'has(4) should return true');
    assert.ok(cache.has(5), 'has(5) should return true');
    assert.ok(!cache.has(3), 'has(3) should return false');

    // Test clear
    cache.clear();
    assert.equal(cache.size, 0, 'Size should be 0 after clear');
    assert.ok(!cache.has(2), 'has(2) should return false after clear');
    assert.ok(!cache.has(4), 'has(4) should return false after clear');
    assert.ok(!cache.has(5), 'has(5) should return false after clear');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { passed: errors.length === 0, errors };
}
