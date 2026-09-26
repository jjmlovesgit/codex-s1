import { performance } from 'node:perf_hooks';
import { HeuristicEngine } from './HeuristicEngine.js';
import type { ISystemOneEngine, RoutingDecision, RoutingState } from '../types.js';

export interface LayaOnnxOptions {
  modelPath?: string;
  name?: string;
  evaluator?: (state: RoutingState) => Promise<Pick<RoutingDecision, 'destination' | 'confidence'>> | Pick<RoutingDecision, 'destination' | 'confidence'>;
  fallback?: ISystemOneEngine;
  timeoutMs?: number;
}

export class LayaOnnxEngine implements ISystemOneEngine {
  readonly name: string;
  readonly modelPath?: string;
  private readonly evaluator?: LayaOnnxOptions['evaluator'];
  private readonly fallback: ISystemOneEngine;
  private readonly timeoutMs: number;

  constructor(options: LayaOnnxOptions = {}) {
    this.name = options.name ?? 'laya-onnx';
    this.modelPath = options.modelPath;
    this.evaluator = options.evaluator;
    this.fallback = options.fallback ?? new HeuristicEngine();
    this.timeoutMs = options.timeoutMs ?? 1_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('LayaOnnxEngine timeoutMs must be positive.');
  }

  async route(state: RoutingState): Promise<RoutingDecision> {
    const started = performance.now();
    if (!this.evaluator) {
      const fallback = await this.fallback.route(state);
      return { ...fallback, engine: fallback.engine || this.fallback.name };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(this.evaluator(state)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ONNX routing timed out.')), this.timeoutMs); }),
      ]);
      return {
        destination: result.destination,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        engine: this.name,
        latencyMs: Math.max(0, Number((performance.now() - started).toFixed(3))),
      };
    } catch {
      const fallback = await this.fallback.route(state);
      return { ...fallback, engine: fallback.engine || this.fallback.name };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}


