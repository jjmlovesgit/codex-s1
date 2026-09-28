import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

export interface ProjectDefaults { isEsm: boolean; isTs: boolean }

/** A bare directory defaults to modern ESM JavaScript. */
export function detectProjectDefaults(workspace: string): ProjectDefaults {
  const pkgPath = path.join(workspace, 'package.json');
  const tsPath = path.join(workspace, 'tsconfig.json');
  let isEsm = !fs.existsSync(pkgPath);
  let isTs = fs.existsSync(tsPath);
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        type?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      isEsm = pkg.type === 'module' || Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);
      isTs = isTs || Boolean(pkg.dependencies?.typescript || pkg.devDependencies?.typescript);
    } catch {
      // A malformed manifest must not stop workspace initialization.
    }
  }
  if (fs.existsSync(tsPath)) {
    const parsed = ts.readConfigFile(tsPath, ts.sys.readFile);
    const moduleKind = parsed.config?.compilerOptions?.module;
    if (typeof moduleKind === 'string' && /^(?:es\d+|esnext|preserve)$/i.test(moduleKind)) isEsm = true;
  }
  return { isEsm, isTs };
}

export function renderWorkerRules({ isEsm, isTs }: ProjectDefaults): string {
  const moduleSystem = isEsm ? 'ESM (`import` / `export`)' : 'CommonJS (`require()` / `module.exports`)';
  const language = isTs ? 'TypeScript' : 'JavaScript';
  const testCommand = isTs
    ? 'The staging verifier handles TypeScript; use `tsx <file>` for direct execution only if this project already provides tsx.'
    : 'Run JavaScript assertion files directly with `node <file>`.';
  return `# Worker Guidelines

## Environment & Syntax
- Module System: ${moduleSystem}
- Language: ${language}
- Runtime: Node.js (Current LTS)

## Sandbox Safety (Zero External Dependencies)
- All generated code MUST rely exclusively on Node standard library built-ins (e.g., \`node:fs\`, \`node:path\`, \`node:crypto\`).
- Do NOT introduce external npm packages unless explicitly instructed by the Architect.

## Test Contracts
- Always use \`node:assert/strict\` or \`node:test\` for verification.
- Tests must be completely self-contained. ${testCommand} Do not add a new test dependency.
- Verify standard happy paths and realistic edge cases (null/undefined inputs, empty arrays, malformed strings).

## Output Contract
- Do not output conversational preamble, markdown explanations, or postambles.
- Emit exclusively raw, delimited code file blocks.
`;
}

export const ARCHITECT_RULES_TEMPLATE = `# Agent Delegation Rules

## Primary Delegation Directive
- Use the \`delegate_worker\` MCP tool whenever creating new files, scaffolding modules, implementing pure utility functions, or writing unit tests.
- Formulate a precise interface contract, expected inputs and outputs, and required test assertions before delegation.
- Read \`.precog/worker.md\` and include its project rules in the worker task.

## Negative Boundaries (When NOT to Delegate)
- Do not use \`delegate_worker\` for single-line tweaks or edits to existing multi-thousand-line files; use native editing tools.
- Do not delegate architectural planning, system design, or git repository operations.

## Output Verbatim Enforcement
- Display the complete verification receipt, including timings, pass/fail status, and tokens shielded, verbatim in the response to the user.
`;

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function loadWorkerGuidelines(workspace: string, homeDirectory = os.homedir()): string {
  const sources: Array<[string, string]> = [
    ['Project', path.join(workspace, '.precog', 'worker.md')],
    ['User', path.join(homeDirectory, '.precog', 'worker.md')],
  ];
  return sources.flatMap(([label, file]) => {
    const content = readOptional(file);
    return content ? [`### ${label} guidelines (${file})\n${content}`] : [];
  }).join('\n\n');
}
