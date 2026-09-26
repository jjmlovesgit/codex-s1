import assert from 'node:assert/strict';
import { TaskQueue } from './taskQueue.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function run(): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];

  try {
    const queue = new TaskQueue({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, (_, index) => queue.add(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(25);
      active -= 1;
      return index;
    }));
    const values = await Promise.all(tasks);
    assert.deepEqual(values, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.deepEqual(queue.getStats(), { pending: 0, running: 0, completed: 6, failed: 0 });
  } catch (error) {
    errors.push('concurrency: ' + (error instanceof Error ? error.message : String(error)));
  }

  try {
    const queue = new TaskQueue({ concurrency: 1, maxRetries: 2 });
    let calls = 0;
    const value = await queue.add(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });
    assert.equal(value, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(queue.getStats(), { pending: 0, running: 0, completed: 1, failed: 0 });
  } catch (error) {
    errors.push('retries: ' + (error instanceof Error ? error.message : String(error)));
  }

  try {
    const queue = new TaskQueue({ concurrency: 1 });
    const task = queue.add(async () => {
      await sleep(20);
      return 42;
    });
    let idleResolved = false;
    const idle = queue.onIdle().then(() => { idleResolved = true; });
    await sleep(5);
    assert.equal(idleResolved, false);
    await task;
    await idle;
    assert.equal(idleResolved, true);
    assert.deepEqual(queue.getStats(), { pending: 0, running: 0, completed: 1, failed: 0 });
  } catch (error) {
    errors.push('lifecycle: ' + (error instanceof Error ? error.message : String(error)));
  }

  try {
    const queue = new TaskQueue({ concurrency: 1 });
    const running = queue.add(async () => { await sleep(20); return 'running'; });
    const pending = queue.add(async () => 'pending');
    const runningHandled = running.catch(() => undefined);
    const pendingHandled = pending.catch(() => undefined);
    queue.clear();
    await Promise.all([runningHandled, pendingHandled, queue.onIdle()]);
    assert.deepEqual(queue.getStats(), { pending: 0, running: 0, completed: 1, failed: 0 });
  } catch (error) {
    errors.push('clear: ' + (error instanceof Error ? error.message : String(error)));
  }

  return { passed: errors.length === 0, errors };
}

