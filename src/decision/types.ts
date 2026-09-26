export type RoutingDestination = 'local_worker' | 'cloud_architect';

export interface RoutingState {
  task: string;
  targetFiles?: string[];
}

export interface RoutingDecision {
  destination: RoutingDestination;
  confidence: number;
  engine: string;
  latencyMs: number;
}

export interface ISystemOneEngine {
  readonly name: string;
  route(state: RoutingState): Promise<RoutingDecision>;
}
