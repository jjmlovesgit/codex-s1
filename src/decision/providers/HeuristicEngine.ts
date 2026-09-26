import { performance } from 'node:perf_hooks';
import type { ISystemOneEngine, RoutingDecision, RoutingState } from '../types.js';

const CLOUD_SIGNAL = /(?:system architecture|architecture review|threat model|security audit|multi[- ]service|distributed system|migration plan|product strategy|broad design)/i;
const LOCAL_SIGNAL = /(?:implement|fix|refactor|test|file|typescript|javascript|css|json|function|class|module)/i;

export interface HeuristicOptions {
  name?: string;
}

export class HeuristicEngine implements ISystemOneEngine {
  readonly name: string;

  constructor(options: HeuristicOptions = {}) {
    this.name = options.name ?? 'heuristic';
  }

  async route(state: RoutingState): Promise<RoutingDecision> {
    const started = performance.now();
    const task = typeof state.task === 'string' ? state.task : '';
    const hasTargets = Array.isArray(state.targetFiles) && state.targetFiles.length > 0;
    const cloud = CLOUD_SIGNAL.test(task);
    const local = hasTargets || LOCAL_SIGNAL.test(task);
    const destination = cloud ? 'cloud_architect' : 'local_worker';
    const confidence = cloud ? 0.82 : local ? 0.9 : 0.6;
    return {
      destination,
      confidence,
      engine: this.name,
      latencyMs: Math.max(0, Number((performance.now() - started).toFixed(3))),
    };
  }
}

