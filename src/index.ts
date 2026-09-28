#!/usr/bin/env node
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
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
import { getActiveVerifier } from './verifiers/factory.js';
import type { VerificationResult } from './verifiers/types.js';
import { loadWorkerGuidelines } from './worker-guidelines.js';

export { PROFILES, SavingsTracker, TokenLedger, loadPricingConfig };
export { WORKER_PROFILE, PROVIDER_PRESETS, resolveWorkerProfile } from './profiles.js';
export { loadConfig, saveConfig, clearConfig, configPath } from './config.js';
export type { OperationalMetrics, TokenUsage, PricingConfig, PricingTier } from './core/tokenLedger.js';
export { buildWorkerMessages, HARDENED_WORKER_SYSTEM_PROMPT, WORKER_FILE_END, WORKER_FILE_START, WORKER_FEW_SHOTS, WORKER_STOP_TOKENS } from './prompts/workerPrompt.js';
export { activeEngine, createDecisionEngine, engineRegistry, loadDecisionConfig };
export { getExecutionProviders, createLayaSession } from './router/engine.js';
export { getVerifierBackend, createVerifier, getActiveVerifier } from './verifiers/factory.js';
export { buildDockerArgs, DockerVerifier, DEFAULT_DOCKER_VERIFIER_IMAGE } from './verifiers/dockerVerifier.js';
export { InProcessVerifier, inProcessVerifier } from './verifiers/inProcessVerifier.js';
export type { VerificationResult, VerifierOptions, VerifierStrategy } from './verifiers/types.js';
export type { VerifierBackend } from './verifiers/factory.js';
export type { ISystemOneEngine, RoutingDecision, RoutingState, RoutingDestination } from './decision/types.js';
export { loadWorkerGuidelines, detectProjectDefaults, renderWorkerRules, ARCHITECT_RULES_TEMPLATE } from './worker-guidelines.js';

export const DELEGATE_WORKER_SCHEMA = {
  name: 'delegate_worker',
  description: 'Delegates file implementation and verification to the worker. CRITICAL INSTRUCTION: You MUST quote the entire returned receipt text block verbatim in your final message to the user. Do not summarize or omit the timings.',
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
export interface TestResults extends VerificationResult {}

export async function runSandboxVerification(files: FileEmissionResult[], workspace: string, timeoutMs = 5_000): Promise<TestResults> {
  const tests = files
    .filter(file => /\.(?:test|spec)\.(?:[cm]?js|ts)$/i.test(file.relativeName))
    .map(file => file.relativeName);
  const fallbackToVm = /^(?:1|true|yes)$/i.test(process.env.DOCKER_VERIFIER_FALLBACK_VM ?? '');
  return getActiveVerifier().run(workspace, tests, { timeoutMs, fallbackToVm });
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isConnectionRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return /ECONNREFUSED/i.test(String(error));
  const value = error as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  return value.code === 'ECONNREFUSED' || value.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(String(value.message ?? value.cause?.message ?? error));
}
interface WorkerReportReceipt {
  status?: string;
  worker?: string;
  model?: string;
  timings?: { workerInferenceMs?: number; sandboxVerificationMs?: number; filePromotionMs?: number; totalExecutionSec?: string };
  testResults?: { status?: string; output?: string; passed?: number };
  operationalMetrics?: { retryWastePromptTokens?: number; retryWasteCompletionTokens?: number };
}
function formatWorkerReport(receipt: WorkerReportReceipt): string {
  const timings = receipt.timings ?? {};
  const verification = receipt.testResults;
  const retryWaste = (receipt.operationalMetrics?.retryWastePromptTokens ?? 0) + (receipt.operationalMetrics?.retryWasteCompletionTokens ?? 0);
  const verificationStatus = verification?.status === 'passed' ? 'PASSED' : verification?.status?.toUpperCase() ?? 'NOT RUN';
  return [
    `Status: ${receipt.status ?? 'UNKNOWN'}`,
    `Worker: ${receipt.worker ?? 'unknown'} (${receipt.model ?? 'unknown'})`,
    'Timings:',
    `  • Inference / Thinking: ${timings.workerInferenceMs ?? 0} ms`,
    `  • Staging Test:         ${timings.sandboxVerificationMs ?? 0} ms`,
    `  • Promotion I/O:        ${timings.filePromotionMs ?? 0} ms`,
    `  • Total Worker Time:    ${timings.totalExecutionSec ?? '0.00'} s`,
    `Staging Verification: ${verificationStatus} (${verification?.output ?? 'not run'})`,
    `Retry Waste: ${retryWaste} tokens`,
  ].join('\n');
}
export function estimateTokenCount(text: string): number { return Math.ceil(text.length / 3.8); }
function tokenCount(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback; }

export interface DelegateWorkerOptions { dryRun?: boolean; verbose?: boolean }

function stagedDiff(files: FileEmissionResult[], workspace: string): string {
  return files.map(file => {
    const destination = workspaceFile(workspace, file.relativeName);
    const before = fs.existsSync(destination) ? fs.readFileSync(destination, 'utf8') : '';
    const after = fs.readFileSync(file.path, 'utf8');
    if (before === after) return `--- a/${file.relativeName}\n+++ b/${file.relativeName}\n(no changes)`;
    const lines = (value: string) => value.replace(/\n$/, '').split('\n');
    return [`--- a/${file.relativeName}`, `+++ b/${file.relativeName}`,
      ...(before ? lines(before).map(line => `-${line}`) : []),
      ...(after ? lines(after).map(line => `+${line}`) : [])].join('\n');
  }).join('\n\n');
}

export async function delegateWorker(input: DelegateWorkerParams, options: DelegateWorkerOptions = {}) {
  const tStart = performance.now();
  let workerInferenceMs = 0;
  let sandboxVerificationMs = 0;
  let filePromotionMs = 0;
  let workerModel = process.env.WORKER_MODEL || process.env.LM_STUDIO_MODEL || PROFILES.WORKER.model;
  const executionMetadata = () => {
    const totalToolMs = Math.round(performance.now() - tStart);
    return {
      worker: PROFILES.WORKER.name,
      model: workerModel,
      endpoint: PROFILES.WORKER.endpoint,
      source: PROFILES.WORKER.source,
      timings: {
        workerInferenceMs,
        sandboxVerificationMs,
        filePromotionMs,
        totalExecutionSec: (totalToolMs / 1000).toFixed(2),
        totalExecutionMs: totalToolMs,
      },
    };
  };
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
  let promptPayload: ReturnType<typeof buildWorkerMessages> | undefined;
  let stagingDir: string | undefined;
  try {
    const params = validateParams(input);
    const workspace = path.resolve(params.workspacePath ?? process.cwd());
    const guidelines = loadWorkerGuidelines(workspace);
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
      const messages = buildWorkerMessages(prompt, guidelines);
      if (options.verbose) promptPayload = messages;
      const response = await fetch(PROFILES.WORKER.endpoint + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(PROFILES.WORKER.apiKey ? { Authorization: `Bearer ${PROFILES.WORKER.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: process.env.WORKER_MODEL || process.env.LM_STUDIO_MODEL || PROFILES.WORKER.model,
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
      const tInferStart = performance.now();
      let completion: Awaited<ReturnType<typeof requestCompletion>>;
      try {
        completion = await requestCompletion(prompt);
      } finally {
        workerInferenceMs += Math.round(performance.now() - tInferStart);
      }
      workerModel = completion.model;
      rawOutput = completion.content;
      tokens.prompt += completion.promptTokens;
      tokens.completion += completion.completionTokens;
      tokens.total += completion.totalTokens;
      tokens.estimated = tokens.estimated || completion.estimated;
      filesWritten = [];
      let parseError = '';
      const tStageStart = performance.now();
      let missingFiles: string[] = [];
      let testResults: TestResults;
      try {
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
        missingFiles = (params.targetFiles ?? []).filter(file => !writtenNames.has(canonicalPathKey(file)));
        testResults = shouldVerify && filesWritten.length > 0
          ? await runSandboxVerification(filesWritten, stagingDir!)
          : filesWritten.length === 0
            ? { status: 'failed', passed: 0, failed: 1, output: parseError || 'No files were found in worker output.', durationMs: 0 }
            : { status: 'skipped', passed: 0, failed: 0, output: 'Verification not requested.', durationMs: 0 };
      } finally {
        sandboxVerificationMs += Math.round(performance.now() - tStageStart);
      }
      let failed = Boolean(parseError) || filesWritten.length === 0 || missingFiles.length > 0 || testResults.status === 'failed';
      const diff = !failed && options.dryRun ? stagedDiff(filesWritten, workspace) : undefined;
      if (!failed && !options.dryRun) {
        const tPromoteStart = performance.now();
        try {
          filesWritten = commitStagedFiles(filesWritten, stagingDir!, workspace);
        } catch (error) {
          filesWritten = error instanceof FileEmissionError ? error.filesWritten : [];
          parseError = errorMessage(error);
          failed = true;
        } finally {
          filePromotionMs += Math.round(performance.now() - tPromoteStart);
        }
      }
      if (!options.dryRun) {
        const accountingOutcome = failed ? 'retry' : 'accepted';
        tokenLedger.addUsage({ promptTokens: completion.promptTokens, completionTokens: completion.completionTokens, localModel: completion.model }, accountingOutcome);
        const record = tracker.recordUsage({ route: 'WORKER_LOCAL', model: completion.model, reason: attempt === 0 ? 'SUBAGENT_DELEGATION' : 'SUBAGENT_DELEGATION_RETRY', promptTokens: completion.promptTokens, completionTokens: completion.completionTokens, totalTokens: completion.totalTokens, turn: Date.now() + attempt, accepted: !failed });
        if (!failed) savedUSD = parseFloat((savedUSD + record.savedUSD).toFixed(6));
      }
      if (!failed) {
        const receipt = { success: true, status: options.dryRun ? 'DRY_RUN' : 'SUCCESS', filesWritten: filesWritten.map(file => file.relativeName), missingFiles, testResults, verification: { passed: testResults.passed, testOutput: testResults.output }, tokens, savedUSD, benchmark, routingDecision, operationalMetrics: finalizeMetrics!(options.dryRun ? [] : filesWritten.map(file => fs.readFileSync(file.path, 'utf8'))), ledgerPath, ...(options.dryRun ? { diff } : {}), ...(options.verbose ? { rawGeneratedBlocks: rawOutput, promptPayload } : {}), ...executionMetadata() };
        return { ...receipt, formattedReport: formatWorkerReport(receipt) };
      }
      const reason = parseError || (missingFiles.length ? 'Missing target files: ' + missingFiles.join(', ') : testResults.output || 'Verification failed.');
      if (attempt === 0) {
        retryFeedback = 'The previous output failed verification: ' + reason.slice(0, 300) + '. Emit the complete files now using standard delimiters <<<FILE: path>>> ... <<<END_FILE>>>.';
        continue;
      }
      const finalStatus = missingFiles.length ? 'MISSING_FILES' : testResults.status === 'failed' ? 'VERIFICATION_FAILED' : 'ERROR';
      const receipt = { success: false, status: finalStatus, message: reason + (rawOutput ? ' Raw output preview: ' + rawOutput.slice(0, 300) : ''), filesWritten: filesWritten.map(file => file.relativeName), missingFiles, testResults, verification: { passed: testResults.passed, testOutput: testResults.output }, tokens, savedUSD, benchmark, routingDecision, operationalMetrics: finalizeMetrics!([]), ledgerPath, ...executionMetadata() };
      return { ...receipt, formattedReport: formatWorkerReport(receipt) };
    }
    throw new Error('Worker retry loop ended unexpectedly.');
  } catch (error) {
    if (!operationalMetrics && tokenLedger && tracker) {
      try {
        operationalMetrics = tokenLedger.getMetrics([]);
        tracker.recordOperationalMetrics(operationalMetrics);
      } catch { /* Preserve the primary worker error in the receipt. */ }
    }
    if (isConnectionRefused(error) && !process.env.WORKER_API_KEY && !process.env.DEEPSEEK_API_KEY && !PROFILES.WORKER.apiKey) {
      const receipt = {
        success: false,
        status: 'NO_WORKER_AVAILABLE',
        error: 'NO_WORKER_AVAILABLE',
        message: 's1-precog could not reach a worker. Either:\n1. Start LM Studio on http://127.0.0.1:1234 (Local Mode)\n2. Set WORKER_API_KEY in your Codex MCP settings (Cloud Mode)',
        filesWritten: filesWritten.map(file => file.relativeName),
        tokens,
        savedUSD,
        benchmark,
        routingDecision,
        operationalMetrics,
        ledgerPath,
        ...executionMetadata(),
      };
      return { ...receipt, formattedReport: formatWorkerReport(receipt) };
    }
    const message = errorMessage(error);
    const receipt = { success: false, status: 'ERROR', message: message + (rawOutput && /parse|file|verification|truncated/i.test(message) ? ' Raw output preview: ' + rawOutput.slice(0, 300) : ''), filesWritten: filesWritten.map(file => file.relativeName), tokens, savedUSD, benchmark, routingDecision, operationalMetrics, ledgerPath, ...executionMetadata() };
    return { ...receipt, formattedReport: formatWorkerReport(receipt) };
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
      const report = 'formattedReport' in receipt && typeof receipt.formattedReport === 'string' ? receipt.formattedReport : undefined;
      return { isError: !receipt.success, content: [{ type: 'text' as const, text: JSON.stringify(receipt) }, ...(report ? [{ type: 'text' as const, text: report }] : [])] };
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

