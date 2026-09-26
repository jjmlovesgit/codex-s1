export interface TaskQueueOptions {
  concurrency: number;
  maxRetries?: number;
}

export interface TaskStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  attempts: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
}

export class TaskQueue {
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly pending: QueuedTask<unknown>[] = [];
  private running = 0;
  private completed = 0;
  private failed = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: TaskQueueOptions) {
    if (!options || !Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
    if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)) {
      throw new RangeError('maxRetries must be a non-negative integer');
    }
    this.concurrency = options.concurrency;
    this.maxRetries = options.maxRetries ?? 0;
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    let queued!: QueuedTask<T>;
    const result = new Promise<T>((resolve, reject) => {
      queued = { run: task, attempts: 0, resolve, reject, settled: false };
    });
    this.pending.push(queued as QueuedTask<unknown>);
    this.drain();
    return result;
  }

  getStats(): TaskStats {
    return {
      pending: this.pending.length,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
    };
  }

  onIdle(): Promise<void> {
    if (this.pending.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  clear(): void {
    const tasks = this.pending.splice(0);
    for (const task of tasks) {
      if (!task.settled) {
        task.settled = true;
        task.reject(new Error('Task cleared before execution'));
      }
    }
    this.notifyIdle();
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.running += 1;
      void this.execute(task);
    }
  }

  private async execute(task: QueuedTask<unknown>): Promise<void> {
    try {
      const value = await task.run();
      if (task.settled) return;
      task.settled = true;
      this.completed += 1;
      task.resolve(value);
    } catch (error) {
      if (task.settled) return;
      task.attempts += 1;
      if (task.attempts <= this.maxRetries) {
        this.pending.push(task);
      } else {
        task.settled = true;
        this.failed += 1;
        task.reject(error);
      }
    } finally {
      this.running -= 1;
      this.drain();
      this.notifyIdle();
    }
  }

  private notifyIdle(): void {
    if (this.pending.length > 0 || this.running > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

