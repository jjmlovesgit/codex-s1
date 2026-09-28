import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inProcessVerifier } from './inProcessVerifier.js';
import type { VerificationResult, VerifierOptions, VerifierStrategy } from './types.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_DOCKER_VERIFIER_IMAGE = 's1-precog-verifier:latest';

export function buildDockerArgs(stageDir: string, testFile: string, image = DEFAULT_DOCKER_VERIFIER_IMAGE): string[] {
  const relative = testFile.replace(/\\/g, '/');
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:\//.test(relative) || relative.split('/').some(segment => segment === '..')) {
    throw new Error(`Invalid Docker verification path: ${testFile}`);
  }
  const executable = /\.ts$/i.test(relative) ? ['--experimental-strip-types'] : [];
  return [
    'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--pids-limit', '100',
    '--memory', '2g',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--volume', `${path.resolve(stageDir)}:/sandbox:rw`,
    '--workdir', '/sandbox',
    image,
    'node', ...executable, `/sandbox/${relative}`,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DockerVerifier implements VerifierStrategy {
  constructor(private readonly image = process.env.DOCKER_VERIFIER_IMAGE || DEFAULT_DOCKER_VERIFIER_IMAGE) {}

  async run(stageDir: string, testFiles: string[], options: VerifierOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    if (!testFiles.length) return { status: 'failed', passed: 0, failed: 1, output: 'Verification requested, but no generated .test/.spec JS or TS assertion scripts were found.', durationMs: Date.now() - started };
    const output: string[] = [];
    let passed = 0;
    let failed = 0;
    let unavailable = false;
    const timeout = Math.min(Math.max(1, options.timeoutMs ?? 5_000), 300_000);
    for (const testFile of testFiles) {
      try {
        const args = buildDockerArgs(stageDir, testFile, options.dockerImage || this.image);
        const result = await execFileAsync('docker', args, { timeout, maxBuffer: 1024 * 1024 });
        if (result.stdout) output.push(result.stdout.trim());
        if (result.stderr) output.push(result.stderr.trim());
        passed++;
      } catch (error: unknown) {
        failed++;
        const detail = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
        const streams = [detail.stdout, detail.stderr].filter(Boolean).join('\n');
        unavailable ||= detail.code === 'ENOENT' || detail.code === 'ECONNREFUSED' || detail.killed === true || /cannot connect|daemon|no such image|unable to find image|pull access denied|is the docker daemon running/i.test(streams);
        output.push(`Docker verification failed for ${testFile}: ${errorMessage(error)}${streams ? `\n${streams}` : ''}`);
      }
    }
    if (!failed) return { status: 'passed', passed, failed, output: output.join('\n').slice(-4000), durationMs: Date.now() - started };

    const dockerOutput = output.join('\n').slice(-4000);
    if (unavailable && options.fallbackToVm) {
      const fallback = await inProcessVerifier.run(stageDir, testFiles, options);
      return { ...fallback, output: `Docker backend unavailable or failed; VM fallback used.\n${dockerOutput}\n${fallback.output}`.slice(-4000), durationMs: Date.now() - started };
    }
    return { status: 'failed', passed, failed, output: `Docker verifier could not complete. Ensure Docker is running and image '${this.image}' exists.\n${dockerOutput}`, durationMs: Date.now() - started, errors: output };
  }
}

export const dockerVerifier = new DockerVerifier();
