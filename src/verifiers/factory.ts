import { dockerVerifier, DockerVerifier } from './dockerVerifier.js';
import { inProcessVerifier } from './inProcessVerifier.js';
import type { VerifierStrategy } from './types.js';

export type VerifierBackend = 'vm' | 'docker';

export function getVerifierBackend(env: NodeJS.ProcessEnv = process.env): VerifierBackend {
  return env.VERIFIER_BACKEND?.toLowerCase() === 'docker' ? 'docker' : 'vm';
}

export function createVerifier(env: NodeJS.ProcessEnv = process.env): VerifierStrategy {
  if (getVerifierBackend(env) === 'docker') {
    return new DockerVerifier(env.DOCKER_VERIFIER_IMAGE);
  }
  return inProcessVerifier;
}

export function getActiveVerifier(env: NodeJS.ProcessEnv = process.env): VerifierStrategy {
  return createVerifier(env);
}

export { dockerVerifier, inProcessVerifier };
export type { VerificationResult, VerifierOptions, VerifierStrategy } from './types.js';
