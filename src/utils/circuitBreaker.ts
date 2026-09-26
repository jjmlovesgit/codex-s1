export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private recoveryTimeoutId: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      failureThreshold: number;
      recoveryTimeoutMs: number;
      successThreshold?: number;
    },
  ) {
    if (!Number.isInteger(options.failureThreshold) || options.failureThreshold <= 0) {
      throw new RangeError('failureThreshold must be a positive integer');
    }
    if (!Number.isInteger(options.recoveryTimeoutMs) || options.recoveryTimeoutMs <= 0) {
      throw new RangeError('recoveryTimeoutMs must be a positive integer');
    }
    if (
      options.successThreshold !== undefined &&
      (!Number.isInteger(options.successThreshold) || options.successThreshold <= 0)
    ) {
      throw new RangeError('successThreshold must be a positive integer');
    }
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      throw new Error('Circuit is OPEN');
    }

    try {
      const result = await fn();
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        if (this.successCount >= (this.options.successThreshold ?? 1)) {
          this.state = 'CLOSED';
          this.successCount = 0;
        }
      }
      this.failureCount = 0;
      return result;
    } catch (error) {
      this.failureCount++;
      if (this.failureCount >= this.options.failureThreshold) {
        this.state = 'OPEN';
        this.recoveryTimeoutId = setTimeout(() => {
          this.state = 'HALF_OPEN';
          this.failureCount = 0;
        }, this.options.recoveryTimeoutMs);
      }
      throw error;
    }
  }

  public getState(): CircuitState {
    return this.state;
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    if (this.recoveryTimeoutId !== undefined) {
      clearTimeout(this.recoveryTimeoutId);
      this.recoveryTimeoutId = undefined;
    }
  }
}
