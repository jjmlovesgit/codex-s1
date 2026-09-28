export interface VerifierOptions {
  timeoutMs?: number;
  dockerImage?: string;
  fallbackToVm?: boolean;
}

export interface VerificationResult {
  status: 'passed' | 'failed' | 'skipped';
  passed: number;
  failed: number;
  output: string;
  durationMs: number;
  errors?: string[];
}

export interface VerifierStrategy {
  run(stageDir: string, testFiles: string[], options?: VerifierOptions): Promise<VerificationResult>;
}
