import { performance } from 'node:perf_hooks';
import { HeuristicEngine } from './HeuristicEngine.js';
import type { ISystemOneEngine, RoutingDecision, RoutingState } from '../types.js';

export interface HttpSidecarOptions {
  endpoint: string;
  name?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fallback?: ISystemOneEngine;
}

function normalizeDestination(value: unknown): RoutingDecision['destination'] | undefined {
  if (value === 'local_worker' || value === 'local' || value === 'worker') return 'local_worker';
  if (value === 'cloud_architect' || value === 'cloud' || value === 'architect') return 'cloud_architect';
  return undefined;
}

export class HttpSidecarEngine implements ISystemOneEngine {
  readonly name: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fallback: ISystemOneEngine;

  constructor(options: HttpSidecarOptions) {
    if (!options.endpoint || !/^https?:\/\//i.test(options.endpoint)) {
      throw new Error('HttpSidecarEngine requires an HTTP endpoint.');
    }
    this.name = options.name ?? 'http-sidecar';
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
    this.fallback = options.fallback ?? new HeuristicEngine();
  }

  async route(state: RoutingState): Promise<RoutingDecision> {
    const started = performance.now();
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(state),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error('sidecar HTTP ' + response.status);
      const payload = await response.json() as Record<string, unknown>;
      const raw = (payload.decision && typeof payload.decision === 'object' ? payload.decision : payload) as Record<string, unknown>;
      const destination = normalizeDestination(raw.destination ?? raw.route);
      if (!destination) throw new Error('sidecar response did not contain a supported destination');
      const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.5;
      return {
        destination,
        confidence,
        engine: typeof raw.engine === 'string' && raw.engine ? raw.engine : this.name,
        latencyMs: Math.max(0, Number((performance.now() - started).toFixed(3))),
      };
    } catch {
      const fallback = await this.fallback.route(state);
      return { ...fallback, engine: `${this.name}:fallback:${fallback.engine || this.fallback.name}` };
    }
  }
}


