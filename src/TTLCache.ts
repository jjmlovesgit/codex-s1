export class TTLCache<K, V> {
  private cache: Map<K, { value: V; expires: number }> = new Map();

  constructor(private ttl: number) {
    if (typeof ttl !== 'number' || ttl < 0) throw new RangeError('TTL must be a non-negative number');
  }

  public set(key: K, value: V): void {
    const expires = Date.now() + this.ttl;
    this.cache.set(key, { value, expires });
  }

  public get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (entry && entry.expires > Date.now()) {
      return entry.value;
    }
    this.cache.delete(key);
    return undefined;
  }

  public delete(key: K): void {
    this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }
}
