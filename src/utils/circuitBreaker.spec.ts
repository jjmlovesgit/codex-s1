import assert from 'node:assert/strict';
import { CircuitBreaker } from './circuitBreaker.js';

export async function run(): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];
  try {
    const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 40 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await breaker.execute(() => Promise.reject(new Error(`Failure ${attempt}`)));
        errors.push(`Expected failure ${attempt}`);
      } catch (error: unknown) {
        assert.equal(error instanceof Error ? error.message : String(error), `Failure ${attempt}`);
      }
    }
    assert.equal(breaker.getState(), 'OPEN');

    let invoked = false;
    await assert.rejects(
      breaker.execute(async () => {
        invoked = true;
        return 'unexpected';
      }),
      (error: unknown) => error instanceof Error && error.message === 'Circuit is OPEN',
    );
    assert.equal(invoked, false);

    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(breaker.getState(), 'HALF_OPEN');
    assert.equal(await breaker.execute(async () => 'recovered'), 'recovered');
    assert.equal(breaker.getState(), 'CLOSED');

    breaker.reset();
    assert.equal(breaker.getState(), 'CLOSED');
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { passed: errors.length === 0, errors };
}
