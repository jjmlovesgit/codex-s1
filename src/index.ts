#!/usr/bin/env node
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vm from 'node:vm';
import assert from 'node:assert';
import { format } from 'node:util';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PROFILES } from './profiles.js';
import { SavingsTracker } from './savings-tracker.js';
import { ledgerPath as resolveLedgerPath } from './ledger-path.js';
import { TokenLedger, loadPricingConfig, type OperationalMetrics } from './core/tokenLedger.js';
import { buildWorkerMessages, HARDENED_WORKER_SYSTEM_PROMPT, WORKER_FILE_END, WORKER_FILE_START, WORKER_FEW_SHOTS, WORKER_STOP_TOKENS } from './prompts/workerPrompt.js';
import { activeEngine, createDecisionEngine, engineRegistry, loadDecisionConfig } from './decision/factory.js';
import type { RoutingDecision } from './decision/types.js';

export { PROFILES, SavingsTracker, TokenLedger, loadPricingConfig };
export type { OperationalMetrics, TokenUsage, PricingConfig, PricingTier } from './core/tokenLedger.js';
export { buildWorkerMessages, HARDENED_WORKER_SYSTEM_PROMPT, WORKER_FILE_END, WORKER_FILE_START, WORKER_FEW_SHOTS, WORKER_STOP_TOKENS } from './prompts/workerPrompt.js';
export { activeEngine, createDecisionEngine, engineRegistry, loadDecisionConfig };
export { getExecutionProviders, createLayaSession } from './router/engine.js';
export type { ISystemOneEngine, RoutingDecision, RoutingState, RoutingDestination } from './decision/types.js';

export const DELEGATE_WORKER_SCHEMA = {
  name: 'delegate_worker',
  description: 'PRIMARY CODE GENERATION & EXECUTION ENGINE. MANDATORY: Whenever any code implementation, file creation, refactoring, or test suite needs to be generated and written to disk, you MUST invoke this tool with the task contract rather than outputting source code directly. This offloads implementation and in-process validation to the local runtime.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task: { type: 'string', minLength: 1, description: 'Detailed prompt/specification for the local worker.' },
      targetFiles: { type: 'array', items: { type: 'string', minLength: 1 }, default: [], description: 'Target file paths relative to workspace root.' },
      runVerification: { type: 'boolean', default: true, description: 'Whether to run in-process verification.' },
      testSpec: { type: 'string', minLength: 1, description: 'In-process test verification requirements.' },
      workspacePath: { type: 'string', description: 'Absolute workspace path; defaults to the server process cwd.' },
    },
    required: ['task'],
    additionalProperties: false,
  },
};

export interface DelegateWorkerParams {
  task: string;
  targetFiles?: string[];
  runVerification?: boolean;
  testSpec?: string;
  workspacePath?: string;
}

function validateParams(value: unknown): DelegateWorkerParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be an object.');
  const args = value as Record<string, unknown>;
  const allowed = new Set(['task', 'targetFiles', 'runVerification', 'testSpec', 'workspacePath']);
  if (Object.keys(args).some(key => !allowed.has(key))) throw new Error('Unknown delegate_worker argument.');
  if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('task must be a non-empty string.');
  if (args.targetFiles !== undefined && (!Array.isArray(args.targetFiles) || args.targetFiles.some(file => typeof file !== 'string' || !file.trim()))) {
    throw new Error('targetFiles must be an array of non-empty strings.');
  }
  if (args.runVerification !== undefined && typeof args.runVerification !== 'boolean') throw new Error('runVerification must be a boolean.');
  if (args.testSpec !== undefined && (typeof args.testSpec !== 'string' || !args.testSpec.trim())) throw new Error('testSpec must be a non-empty string.');
  if (args.workspacePath !== undefined && (typeof args.workspacePath !== 'string' || !path.isAbsolute(args.workspacePath))) {
    throw new Error('workspacePath must be an absolute path.');
  }
  return { ...args, targetFiles: (args.targetFiles ?? []) as string[], runVerification: args.runVerification === undefined ? true : args.runVerification as boolean } as unknown as DelegateWorkerParams;
}

export function normalizeRelativePath(name: string): string {
  const raw = name.trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Invalid relative file path: ${name}`);
  }
  if (raw.split('/').some(segment => segment === '..')) {
    throw new Error(`File path traversal is not allowed: ${name}`);
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`Invalid relative file path: ${name}`);
  }
  return normalized;
}

function normalizeTargetFiles(targetFiles: string[]): string[] {
  const normalized = targetFiles.map(normalizeRelativePath);
  const keys = normalized.map(canonicalPathKey);
  if (new Set(keys).size !== normalized.length) throw new Error('targetFiles contains duplicate paths.');
  return normalized;
}

function canonicalPathKey(name: string): string {
  const normalized = normalizeRelativePath(name);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Check both lexical containment and existing symlinks/junctions before any writes.
export function workspaceFile(workspace: string, name: string): string {
  const root = path.resolve(workspace);
  const resolved = path.isAbsolute(name) ? path.resolve(name) : path.resolve(root, normalizeRelativePath(name));
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`File escapes workspace: ${name}`);
  }
  const segments = relative.split(path.sep);
  // Block Windows alternate data streams and ambiguous aliases on every platform.
  if (segments.some(segment => /[:]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`Unsupported file path: ${name}`);
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink or junction in file path: ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

interface FileBlock { name: string; code: string }

function enforceFileAllowlist(blocks: FileBlock[], targetFiles: string[]): FileBlock[] {
  const normalizedTargets = normalizeTargetFiles(targetFiles);
  const allowed = new Set(normalizedTargets.map(canonicalPathKey));
  const normalizedBlocks = blocks.map(block => ({ ...block, name: normalizeRelativePath(block.name) }));
  if (normalizedTargets.length > 0) {
    for (const block of normalizedBlocks) {
      if (!allowed.has(canonicalPathKey(block.name))) throw new Error(`Worker emitted undeclared file: ${block.name}`);
    }
  }
  return normalizedBlocks;
}

export function parseFileBlocks(content: string, targetFiles: string[] = []): FileBlock[] {
  const text = content.replace(/\r\n/g, '\n');
  const cleanName = (name: string) => name.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  const finish = (blocks: FileBlock[]) => enforceFileAllowlist(blocks, targetFiles);
  const strictStart = /^<{3,5}\s*FILE:\s*([^>\r\n]+?)\s*>{3,5}[ \t]*\r?$/gm;
  const strictEnd = /^<{3,5}\s*(?:END_FILE|FILE_END|END)\s*>{3,5}[ \t]*\r?$/gm;
  const hasStrictDelimiter = strictStart.test(text) || strictEnd.test(text);
  if (hasStrictDelimiter) {
    const strictFiles: FileBlock[] = [];
    let cursor = 0;
    strictStart.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = strictStart.exec(text)) !== null) {
      if (text.slice(cursor, match.index).trim()) throw new Error('Strict worker output contains text outside file blocks.');
      const name = cleanName(match[1]);
      normalizeRelativePath(name);
      const contentStart = strictStart.lastIndex + (text[strictStart.lastIndex] === '\n' ? 1 : 0);
      strictEnd.lastIndex = contentStart;
      const endMatch = strictEnd.exec(text);
      if (!endMatch) throw new Error('Missing <<<END_FILE>>> for ' + name + ' before end of output.');
      strictFiles.push({ name, code: text.slice(contentStart, endMatch.index) });
      cursor = endMatch.index + endMatch[0].length + (text[endMatch.index + endMatch[0].length] === '\n' ? 1 : 0);
      strictStart.lastIndex = cursor;
    }
    if (!strictFiles.length) throw new Error('Strict worker output contains no complete file blocks.');
    const trailing = text.slice(cursor).trim();
    if (trailing && trailing !== '<<<END_DELEGATION>>>') throw new Error('Strict worker output contains text after the final file block.');
    return finish(strictFiles);
  }
  type AnonymousBlock = { code: string; language: string };
  const namedFiles: FileBlock[] = [];
  const anonymous: AnonymousBlock[] = [];
  const fence = /^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm;
  let sawFence = false;
  const leadingFencePaths: string[] = [];
  let previousFenceEnd = 0;
  for (const fenceMatch of text.matchAll(fence)) {
    sawFence = true;
    const outside = text.slice(previousFenceEnd, fenceMatch.index);
    const outsideLines = outside.trim().split('\n');
    const outsideMarker = /^\s*(?:\/\/|#)\s*FILE\s*:\s*(.+?)\s*$/i.exec(outsideLines.at(-1) ?? '');
    if (outsideMarker) leadingFencePaths.push(cleanName(outsideMarker[1]));
    const header = fenceMatch[1].trim();
    const body = fenceMatch[2];
    const attr = /(?:file|filename)\s*=\s*(?:["']([^"']+)["']|(\S+))/i.exec(header);
    const colonPath = /^(?:[A-Za-z0-9_+.-]+):(.+)$/.exec(header);
    let name = attr ? cleanName(attr[1] ?? attr[2]) : colonPath?.[1] ? cleanName(colonPath[1]) : undefined;
    let code = body;
    const firstLine = body.split('\n', 1)[0];
    const commentPath = /^\s*(?:\/\/|#)\s*(?:filepath|file|path)?\s*:?\s*(\S+\.[A-Za-z0-9_-]+)\s*$/i.exec(firstLine);
    if (!name && commentPath) {
      name = cleanName(commentPath[1]);
      code = body.slice(firstLine.length).replace(/^\n/, '');
    }
    const language = (header.split(/[:\s]/, 1)[0] || '').toLowerCase();
    if (name) namedFiles.push({ name, code });
    else anonymous.push({ code, language });
    previousFenceEnd = fenceMatch.index! + fenceMatch[0].length;
  }
  if (namedFiles.length) return finish(namedFiles);
  if (!namedFiles.length && leadingFencePaths.length === anonymous.length && anonymous.length > 0) return finish(leadingFencePaths.map((name, index) => ({ name, code: anonymous[index].code })));
  if (!sawFence) {
    const marker = /^\s*(?:\/\/|#)\s*FILE\s*:\s*(.+?)\s*$/i;
    const markerFiles: FileBlock[] = [];
    let current: FileBlock | undefined;
    for (const line of text.split('\n')) {
      const markerMatch = marker.exec(line);
      if (markerMatch) {
        current = { name: cleanName(markerMatch[1]), code: '' };
        markerFiles.push(current);
      } else if (current) {
        current.code += (current.code ? '\n' : '') + line;
      }
    }
    if (markerFiles.length) return finish(markerFiles);
  }
  const extensionMatches = (target: string, language: string) => {
    if (!language) return true;
    const ext = path.extname(target).toLowerCase();
    const groups: Record<string, string[]> = {
      ts: ['.ts', '.tsx'], typescript: ['.ts', '.tsx'], tsx: ['.tsx'],
      js: ['.js', '.mjs', '.cjs', '.jsx'], javascript: ['.js', '.mjs', '.cjs', '.jsx'], jsx: ['.jsx'],
      json: ['.json'], css: ['.css'], html: ['.html', '.htm'], markdown: ['.md', '.markdown'], md: ['.md', '.markdown'],
    };
    return !groups[language] || groups[language].includes(ext);
  };
  if (targetFiles.length > 0) {
    if (anonymous.length === targetFiles.length && targetFiles.every((target, index) => extensionMatches(target, anonymous[index].language))) {
      return normalizeTargetFiles(targetFiles).map((name, index) => ({ name, code: anonymous[index].code }));
    }
    if (anonymous.length === 0 && !sawFence && targetFiles.length === 1 && text.trim()) return finish([{ name: targetFiles[0], code: text.trim() }]);
    throw new Error('Cannot unambiguously match worker output to targetFiles.');
  }
  return finish([]);
}

export interface FileEmissionResult { path: string; relativeName: string; lines: number; bytes: number }

class FileEmissionError extends Error {
  constructor(message: string, public readonly filesWritten: FileEmissionResult[]) { super(message); }
}

export function extractAndEmitFiles(content: string, targetFiles: string[] = [], baseDir = process.cwd()): { filesWritten: FileEmissionResult[] } {
  const blocks = parseFileBlocks(content, targetFiles);
  const destinations = new Set<string>();
  const reserved = [workspaceFile(baseDir, 'savings-ledger.json'), workspaceFile(baseDir, '.s1-precog/ledger.json')];
  const prepared = blocks.map(block => {
    const destination = workspaceFile(baseDir, block.name);
    const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
    if (reserved.some(file => key === (process.platform === 'win32' ? file.toLowerCase() : file) || destination.startsWith(`${file}.`))) throw new Error('Worker cannot overwrite the savings ledger.');
    if (destinations.has(key)) throw new Error(`Duplicate emitted file: ${block.name}`);
    destinations.add(key);
    return { ...block, destination };
  });
  const filesWritten: FileEmissionResult[] = [];
  for (const { destination, code } of prepared) {
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, code, 'utf8');
      filesWritten.push({ path: destination, relativeName: path.relative(baseDir, destination), lines: code.split('\n').length, bytes: Buffer.byteLength(code) });
    } catch (error) {
      throw new FileEmissionError(`Failed to write ${path.relative(baseDir, destination)}: ${errorMessage(error)}`, filesWritten);
    }
  }
  return { filesWritten };
}

function createStagingDirectory(workspace: string): string {
  const parent = workspaceFile(workspace, '.precog-stage');
  fs.mkdirSync(parent, { recursive: true });
  const staging = workspaceFile(workspace, path.posix.join('.precog-stage', randomUUID()));
  fs.mkdirSync(staging, { recursive: true });
  return staging;
}

function preflightCommit(files: FileEmissionResult[], workspace: string): void {
  for (let index = 0; index < files.length; index += 1) {
    const destination = workspaceFile(workspace, files[index].relativeName);
    if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) {
      throw new FileEmissionError(`Failed to write ${files[index].relativeName}: destination is a directory`, files.slice(0, index));
    }
  }
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function removePathWithRetry(target: string, attempts = 5): void {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === attempts - 1) throw error;
      sleepSync(25 * (attempt + 1));
    }
  }
}

function commitStagedFiles(files: FileEmissionResult[], staging: string, workspace: string): FileEmissionResult[] {
  const backups = new Map<string, string>();
  const created: string[] = [];
  const temporaries = new Set<string>();
  const committed: FileEmissionResult[] = [];
  try {
    for (const file of files) {
      const source = workspaceFile(staging, file.relativeName);
      const destination = workspaceFile(workspace, file.relativeName);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) {
        const backup = path.join(staging, '.backup-' + randomUUID());
        fs.copyFileSync(destination, backup);
        backups.set(destination, backup);
      }
      const temporary = destination + '.' + randomUUID() + '.tmp';
      temporaries.add(temporary);
      fs.copyFileSync(source, temporary);
      fs.renameSync(temporary, destination);
      temporaries.delete(temporary);
      created.push(destination);
      committed.push({ ...file, path: destination, relativeName: path.relative(workspace, destination) });
    }
    return committed;
  } catch (error) {
    for (const destination of created.reverse()) {
      const backup = backups.get(destination);
      try {
        if (backup) {
          removePathWithRetry(destination);
          fs.copyFileSync(backup, destination);
        } else {
          removePathWithRetry(destination);
        }
      } catch {
        // Preserve the primary commit error; cleanup is retried by the caller.
      }
    }
    throw new FileEmissionError('Failed to commit staged files: ' + errorMessage(error), committed);
  } finally {
    for (const temporary of temporaries) {
      try { removePathWithRetry(temporary); } catch { /* Preserve the primary error. */ }
    }
  }
}
export interface TestResults { status: 'passed' | 'failed' | 'skipped'; passed: number; failed: number; output: string }

// Standalone assertion scripts only: no shell, subprocesses, or test framework globals.
// VM provides execution controls, not a security boundary against hostile code.
export async function runSandboxVerification(files: FileEmissionResult[], workspace: string, timeoutMs = 5_000): Promise<TestResults> {
  const tests = files.filter(file => /\.(?:test|spec)\.(?:[cm]?js|ts)$/i.test(file.relativeName));
  if (!tests.length) return { status: 'failed', passed: 0, failed: 1, output: 'Verification requested, but no generated .test/.spec JS or TS assertion scripts were found.' };
  let passed = 0;
  let failed = 0;
  let output = '';
  const log = (...args: unknown[]) => { output = (output + format(...args) + '\n').slice(-2000); };
  for (const test of tests) {
    const cache = new Map<string, { exports: unknown }>();
    const executionTimeoutMs = Math.min(Math.max(1, timeoutMs), 5_000);
    const timeoutHandles = new Set<ReturnType<typeof setTimeout>>();
    const intervalHandles = new Set<ReturnType<typeof setInterval>>();
    const asyncErrors: unknown[] = [];
    const timerLimit = 100;
      const safeQueueMicrotask = (callback: () => void) => queueMicrotask(() => { try { callback(); } catch (error) { asyncErrors.push(error); } });
    const boundedDelay = (delay: unknown) => typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, Math.min(delay, executionTimeoutMs)) : 0;
    const safeSetTimeout = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (timeoutHandles.size + intervalHandles.size >= timerLimit) throw new Error('Verification timer limit exceeded.');
      let handle!: ReturnType<typeof setTimeout>;
      handle = setTimeout(() => {
        timeoutHandles.delete(handle);
        try { callback(...args); } catch (error) { asyncErrors.push(error); }
      }, boundedDelay(delay));
      timeoutHandles.add(handle);
      return handle;
    };
    const safeSetInterval = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (timeoutHandles.size + intervalHandles.size >= timerLimit) throw new Error('Verification timer limit exceeded.');
      let handle!: ReturnType<typeof setInterval>;
      handle = setInterval(() => {
        try { callback(...args); } catch (error) { asyncErrors.push(error); }
      }, boundedDelay(delay));
      intervalHandles.add(handle);
      return handle;
    };
    const safeClearTimeout = (handle: unknown) => {
      if (handle !== undefined && handle !== null) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
        timeoutHandles.delete(handle as ReturnType<typeof setTimeout>);
      }
    };
    const safeClearInterval = (handle: unknown) => {
      if (handle !== undefined && handle !== null) {
        clearInterval(handle as ReturnType<typeof setInterval>);
        intervalHandles.delete(handle as ReturnType<typeof setInterval>);
      }
    };
    const context = vm.createContext({ console: { log, error: log, warn: log, info: log, debug: log }, setTimeout: safeSetTimeout, clearTimeout: safeClearTimeout, setInterval: safeSetInterval, clearInterval: safeClearInterval, queueMicrotask: safeQueueMicrotask }, { codeGeneration: { strings: false, wasm: false } });
    const deadline = Date.now() + executionTimeoutMs;
    function load(filename: string): unknown {
      filename = workspaceFile(workspace, filename);
      const previous = cache.get(filename);
      if (previous) return previous.exports;
      const module = { exports: {} as unknown };
      cache.set(filename, module);
      const source = fs.readFileSync(filename, 'utf8');
      if (path.extname(filename) === '.json') { module.exports = JSON.parse(source); return module.exports; }
      const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
      const localRequire = (specifier: string): unknown => {
        if (specifier === 'node:assert' || specifier === 'assert') return assert;
        if (specifier === 'node:assert/strict' || specifier === 'assert/strict') return assert.strict;
        if (!specifier.startsWith('.')) throw new Error(`Unsupported verification import: ${specifier}. Use standalone node:assert scripts and relative imports.`);
        const base = workspaceFile(workspace, path.resolve(path.dirname(filename), specifier));
        const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
        if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
        const found = candidates.find(candidate => { workspaceFile(workspace, candidate); return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); });
        if (!found) throw new Error(`Cannot resolve verification import: ${specifier}`);
        return load(found);
      };
      // Arguments are captured before nested relative imports reuse the context slots.
      Object.assign(context, { __module: module, __require: localRequire, __filenameArg: filename, __dirnameArg: path.dirname(filename) });
      new vm.Script(`(function(module, exports, require, __filename, __dirname) {\n${compiled.outputText}\n})(__module, __module.exports, __require, __filenameArg, __dirnameArg)`, { filename }).runInContext(context, { timeout: Math.min(executionTimeoutMs, Math.max(1, deadline - Date.now())) });
      return module.exports;
    }    let timer: ReturnType<typeof setTimeout> | undefined;
    const unhandledRejection = (reason: unknown) => { asyncErrors.push(reason); };
    process.on('unhandledRejection', unhandledRejection);
    try {
      const exported = load(test.path) as { default?: unknown } | undefined;
      context.__result = exported && typeof exported === 'object' && 'default' in exported ? exported.default : exported && typeof exported === 'object' && 'run' in exported ? (exported as { run: unknown }).run : exported;
      const result: unknown = new vm.Script('typeof __result === "function" ? __result() : __result').runInContext(context, { timeout: Math.min(executionTimeoutMs, Math.max(1, deadline - Date.now())) });
      const settled = await Promise.race([Promise.resolve(result), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Verification timed out.')), Math.min(executionTimeoutMs, Math.max(1, deadline - Date.now()))); })]);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (asyncErrors.length) throw new Error('Verification async failure: ' + errorMessage(asyncErrors[0]));
      if (settled && typeof settled === 'object' && 'passed' in settled && (settled as { passed?: unknown }).passed === false) {
        const details = 'errors' in settled && Array.isArray((settled as { errors?: unknown }).errors) ? (settled as { errors: unknown[] }).errors.join('; ') : 'run() reported failure';
        throw new Error('Verification reported failure: ' + details);
      }
      passed++;
      log(`PASS ${test.relativeName}`);
    } catch (error) {
      failed++;
      log(`FAIL ${test.relativeName}: ${errorMessage(error)}`);
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      if (timer) clearTimeout(timer);
      for (const handle of timeoutHandles) safeClearTimeout(handle);
      for (const handle of intervalHandles) safeClearInterval(handle);
    }
  }
  return { status: failed ? 'failed' : 'passed', passed, failed, output };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function estimateTokenCount(text: string): number { return Math.ceil(text.length / 3.8); }
function tokenCount(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback; }

export async function delegateWorker(input: DelegateWorkerParams) {
  let filesWritten: FileEmissionResult[] = [];
  const tokens = { prompt: 0, completion: 0, total: 0, estimated: false };
  let savedUSD = 0;
  let ledgerPath: string | undefined;
  let benchmark: string | undefined;
  let routingDecision: RoutingDecision | undefined;
  let operationalMetrics: OperationalMetrics | undefined;
  let tracker: SavingsTracker | undefined;
  let tokenLedger: TokenLedger | undefined;
  let finalizeMetrics: ((fileContents?: string[]) => OperationalMetrics) | undefined;
  let rawOutput = '';
  let stagingDir: string | undefined;
  try {
    const params = validateParams(input);
    const workspace = path.resolve(params.workspacePath ?? process.cwd());
    params.targetFiles = normalizeTargetFiles(params.targetFiles ?? []);
    if (params.targetFiles.length === 0) throw new Error('targetFiles must contain at least one workspace-relative path.');
    ledgerPath = resolveLedgerPath();
    fs.mkdirSync(workspace, { recursive: true });
    routingDecision = await activeEngine.route({ task: params.task, targetFiles: params.targetFiles });
    if (routingDecision.destination === 'cloud_architect') {
      return { success: false, status: 'ROUTE_CLOUD', routingDecision };
    }
    stagingDir = createStagingDirectory(workspace);
    tracker = new SavingsTracker();
    benchmark = tracker.getBenchmark();
    tokenLedger = new TokenLedger();
    finalizeMetrics = (fileContents?: string[]): OperationalMetrics => {
      operationalMetrics = tokenLedger!.getMetrics(fileContents ?? filesWritten.map(file => fs.readFileSync(file.path, 'utf8')));
      tracker!.recordOperationalMetrics(operationalMetrics);
      return operationalMetrics;
    };
    const userPrompt = params.task +
      (params.targetFiles?.length ? '\n\nExpected files:\n' + params.targetFiles.join('\n') : '') +
      (params.runVerification ? '\n\nInclude generated assertion scripts for in-process verification.' : '');
    const taskRequestsVerification = /\b(?:test|tests|testing|spec|verify|verification|assert)\b/i.test(params.task);
    const shouldVerify = params.runVerification === true || Boolean(params.testSpec) || taskRequestsVerification;
    const separator = String.fromCharCode(10);
    const workerUserPrompt = [userPrompt, params.testSpec ? 'Verification requirements:' + separator + params.testSpec : '', shouldVerify ? 'Include generated assertion scripts for in-process verification.' : ''].filter(Boolean).join(separator + separator);
    const requestCompletion = async (prompt: string) => {
      const messages = buildWorkerMessages(prompt);
      const response = await fetch(PROFILES.WORKER.endpoint + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.LM_STUDIO_MODEL || PROFILES.WORKER.model,
          messages,
          temperature: 0.2,
          enable_thinking: false,
          reasoning_effort: 'none',
          max_tokens: 8192,
          stop: [...WORKER_STOP_TOKENS],
          stream: false,
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error('LM Studio HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500));
      const data = await response.json() as { model?: string; choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('LM Studio response contains no text completion.');
      const promptTokens = tokenCount(data.usage?.prompt_tokens, estimateTokenCount(messages.map(message => message.content).join('\n')));
      const completionTokens = tokenCount(data.usage?.completion_tokens, estimateTokenCount(content));
      return { content, model: data.model || process.env.LM_STUDIO_MODEL || PROFILES.WORKER.model, finishReason: data.choices?.[0]?.finish_reason, promptTokens, completionTokens, totalTokens: tokenCount(data.usage?.total_tokens, promptTokens + completionTokens), estimated: tokenCount(data.usage?.prompt_tokens, -1) === -1 || tokenCount(data.usage?.completion_tokens, -1) === -1 };
    };
    let retryFeedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = retryFeedback ? workerUserPrompt + separator + separator + retryFeedback : workerUserPrompt;
      const completion = await requestCompletion(prompt);
      rawOutput = completion.content;
      tokens.prompt += completion.promptTokens;
      tokens.completion += completion.completionTokens;
      tokens.total += completion.totalTokens;
      tokens.estimated = tokens.estimated || completion.estimated;
      filesWritten = [];
      let parseError = '';
      if (completion.finishReason === 'length') {
        parseError = 'Worker output was truncated at the token limit.';
      } else {
        try {
          filesWritten = extractAndEmitFiles(completion.content, params.targetFiles, stagingDir!).filesWritten;
          preflightCommit(filesWritten, workspace);
        }
        catch (error) {
          filesWritten = error instanceof FileEmissionError ? error.filesWritten : [];
          parseError = errorMessage(error);
        }
      }
      const writtenNames = new Set(filesWritten.map(file => canonicalPathKey(file.relativeName)));
      const missingFiles = (params.targetFiles ?? []).filter(file => !writtenNames.has(canonicalPathKey(file)));
      const testResults: TestResults = shouldVerify && filesWritten.length > 0
        ? await runSandboxVerification(filesWritten, stagingDir!)
        : filesWritten.length === 0
          ? { status: 'failed', passed: 0, failed: 1, output: parseError || 'No files were found in worker output.' }
          : { status: 'skipped', passed: 0, failed: 0, output: 'Verification not requested.' };
      let failed = Boolean(parseError) || filesWritten.length === 0 || missingFiles.length > 0 || testResults.status === 'failed';
      if (!failed) {
        try {
          filesWritten = commitStagedFiles(filesWritten, stagingDir!, workspace);
        } catch (error) {
          filesWritten = error instanceof FileEmissionError ? error.filesWritten : [];
          parseError = errorMessage(error);
          failed = true;
        }
      }
      const accountingOutcome = failed ? 'retry' : 'accepted';
      tokenLedger.addUsage({ promptTokens: completion.promptTokens, completionTokens: completion.completionTokens, localModel: completion.model }, accountingOutcome);
      const record = tracker.recordUsage({ route: 'WORKER_LOCAL', model: completion.model, reason: attempt === 0 ? 'SUBAGENT_DELEGATION' : 'SUBAGENT_DELEGATION_RETRY', promptTokens: completion.promptTokens, completionTokens: completion.completionTokens, totalTokens: completion.totalTokens, turn: Date.now() + attempt, accepted: !failed });
      if (!failed) savedUSD = parseFloat((savedUSD + record.savedUSD).toFixed(6));
      if (!failed) {
        return { success: true, status: 'SUCCESS', filesWritten: filesWritten.map(file => file.relativeName), missingFiles, testResults, tokens, savedUSD, benchmark, routingDecision, operationalMetrics: finalizeMetrics!(filesWritten.map(file => fs.readFileSync(file.path, 'utf8'))), ledgerPath };
      }
      const reason = parseError || (missingFiles.length ? 'Missing target files: ' + missingFiles.join(', ') : testResults.output || 'Verification failed.');
      if (attempt === 0) {
        retryFeedback = 'The previous output failed verification: ' + reason.slice(0, 300) + '. Emit the complete files now using standard delimiters <<<FILE: path>>> ... <<<END_FILE>>>.';
        continue;
      }
      const finalStatus = missingFiles.length ? 'MISSING_FILES' : testResults.status === 'failed' ? 'VERIFICATION_FAILED' : 'ERROR';
      return { success: false, status: finalStatus, message: reason + (rawOutput ? ' Raw output preview: ' + rawOutput.slice(0, 300) : ''), filesWritten: filesWritten.map(file => file.relativeName), missingFiles, testResults, tokens, savedUSD, benchmark, routingDecision, operationalMetrics: finalizeMetrics!([]), ledgerPath };
    }
    throw new Error('Worker retry loop ended unexpectedly.');
  } catch (error) {
    if (!operationalMetrics && tokenLedger && tracker) {
      try {
        operationalMetrics = tokenLedger.getMetrics([]);
        tracker.recordOperationalMetrics(operationalMetrics);
      } catch { /* Preserve the primary worker error in the receipt. */ }
    }
    const message = errorMessage(error);
    return { success: false, status: 'ERROR', message: message + (rawOutput && /parse|file|verification|truncated/i.test(message) ? ' Raw output preview: ' + rawOutput.slice(0, 300) : ''), filesWritten: filesWritten.map(file => file.relativeName), tokens, savedUSD, benchmark, routingDecision, operationalMetrics, ledgerPath };
  } finally {
    if (stagingDir) {
      try { removePathWithRetry(stagingDir); } catch (cleanupError) { console.error('Unable to clean staging directory: ' + errorMessage(cleanupError)); }
    }
  }
}

export function createServer(): Server {
  const server = new Server({ name: 's1-precog', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [DELEGATE_WORKER_SCHEMA] }));
  // Serialize writes/ledger updates and verification within this server instance.
  let queue = Promise.resolve();
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const work = queue.then(async () => {
      if (request.params.name !== 'delegate_worker') return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ success: false, status: 'ERROR', message: `Unknown tool: ${request.params.name}` }) }] };
      const receipt = await delegateWorker(request.params.arguments as unknown as DelegateWorkerParams);
      return { isError: !receipt.success, content: [{ type: 'text' as const, text: JSON.stringify(receipt) }] };
    });
    queue = work.then(() => undefined, () => undefined);
    return work;
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  createServer().connect(new StdioServerTransport()).catch(error => {
    console.error(`[s1-precog] startup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

