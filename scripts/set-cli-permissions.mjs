import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_CODE_MISSING_CLI = 2;
const EXIT_CODE_PERMISSION_FAILURE = 3;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(projectRoot, 'dist', 'cli.js');

try {
  fs.chmodSync(cliPath, 0o755);
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'ENOENT') {
    console.error(`[s1-precog] CLI build output not found: ${cliPath}`);
    process.exitCode = EXIT_CODE_MISSING_CLI;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[s1-precog] Failed to set executable permissions on ${cliPath}: ${message}`);
    process.exitCode = EXIT_CODE_PERMISSION_FAILURE;
  }
}
