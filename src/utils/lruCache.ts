export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;
  private order: K[];

  constructor(options: { capacity: number }) {
    if (!Number.isInteger(options.capacity) || options.capacity <= 0) {
      throw new RangeError('Capacity must be a positive integer');
    }
    this.capacity = options.capacity;
    this.cache = new Map<K, V>();
    this.order = [];
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.updateRecency(key);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      this.updateRecency(key);
    } else {
      if (this.order.length >= this.capacity) {
        const oldestKey = this.order.shift();
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
      this.cache.set(key, value);
      this.order.push(key);
    }
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.order.length = 0;
  }

  private updateRecency(key: K): void {
    const index = this.order.indexOf(key);
    if (index !== -1) {
      this.order.splice(index, 1);
      this.order.push(key);
    }
  }
}
