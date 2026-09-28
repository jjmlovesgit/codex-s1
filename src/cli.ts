#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, delegateWorker, normalizeRelativePath } from './index.js';
import { ARCHITECT_RULES_TEMPLATE, detectProjectDefaults, renderWorkerRules } from './worker-guidelines.js';
import { loadPricingConfig } from './core/pricing.js';
import { ledgerPath } from './ledger-path.js';
import { clearConfig, configPath, loadConfig, saveConfig } from './config.js';
import { PROVIDER_PRESETS, resolveWorkerProfile, type ProviderPreset } from './profiles.js';

interface OperationalMetrics {
  contextTokensShielded?: number;
  estimatedBytesAvoided?: number;
  estimatedCloudMessagesSaved?: number;
  savedUSD?: number;
  acceptedCompletionTokens?: number;
  acceptedPromptTokens?: number;
  retryWasteCompletionTokens?: number;
  retryWastePromptTokens?: number;
  benchmarkModel?: string;
}

interface Ledger {
  totalTurns?: number;
  localTurns?: number;
  workerTurns?: number;
  history?: unknown[];
  operationalMetrics?: OperationalMetrics;
  totalSavedUSD?: number;
}

function readLedger(): Ledger {
  const file = ledgerPath();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${file}: ${message}`);
  }
}

function numeric(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function renderStats(ledger: Ledger): string {
  const metrics = ledger.operationalMetrics ?? {};
  const delegations = numeric(ledger.workerTurns ?? ledger.localTurns);
  const sessions = numeric(ledger.totalTurns ?? ledger.history?.length);
  const bytesKb = numeric(metrics.estimatedBytesAvoided) / 1024;
  const activeBenchmark = metrics.benchmarkModel ?? loadPricingConfig().activeBenchmark;
  const rows: Array<[string, string]> = [
    ['Total delegations', delegations.toLocaleString()],
    ['Total sessions', sessions.toLocaleString()],
    ['Accepted completion tokens shielded', numeric(metrics.acceptedCompletionTokens ?? metrics.contextTokensShielded).toLocaleString()],
    ['Accepted prompt tokens shielded', numeric(metrics.acceptedPromptTokens).toLocaleString()],
    ['Local retry completion overhead', numeric(metrics.retryWasteCompletionTokens).toLocaleString()],
    ['Local retry prompt overhead', numeric(metrics.retryWastePromptTokens).toLocaleString()],
    ['Source code bytes avoided', `${bytesKb.toFixed(2)} KB`],
    ['Cloud message turns saved', numeric(metrics.estimatedCloudMessagesSaved).toFixed(2)],
    ['Active benchmark model', activeBenchmark],
    ['Estimated avoided USD', `$${numeric(metrics.savedUSD ?? ledger.totalSavedUSD).toFixed(6)}`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = ['S1 Precog statistics', ''];
  for (const [label, value] of rows) {
    lines.push(`${label.padEnd(width)}  ${value}`);
  }
  return lines.join('\n');
}

async function serve(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 3)}...${value.slice(-5)}`;
}

function detectedProviders(env: NodeJS.ProcessEnv = process.env): ProviderPreset[] {
  return (Object.values(PROVIDER_PRESETS) as ProviderPreset[]).filter(preset => Boolean(preset.envKey && env[preset.envKey]));
}

export function renderConfig(): string {
  const profile = resolveWorkerProfile();
  const config = loadConfig();
  const detected = detectedProviders();
  const lines = [
    'S1 Precog worker configuration',
    '',
    `Config file: ${configPath()}`,
    `Provider:    ${profile.provider}`,
    `Base URL:    ${profile.endpoint}`,
    `Model:       ${profile.model}`,
    `API key:     ${maskSecret(profile.apiKey)}`,
    `Source:      ${profile.source}`,
    `Saved config: ${config.provider ? 'present' : 'not set'}`,
    `Detected keys: ${detected.length ? detected.map(provider => `${provider.name} (${provider.envKey})`).join(', ') : 'none'}`,
  ];
  return lines.join('\n');
}

async function runConfigWizard(args: string[] = process.argv.slice(3)): Promise<void> {
  if (args.includes('--show')) {
    console.log(renderConfig());
    return;
  }
  if (args.includes('--reset')) {
    clearConfig();
    console.log(`Cleared ${configPath()}. Auto-detection and local fallback are active.`);
    return;
  }
  if (args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'local') {
    saveConfig({ provider: 'local' });
    console.log('Saved local LM Studio mode.');
    return;
  }

  console.log(renderConfig());
  const detected = detectedProviders();
  console.log('\nChoose a worker configuration:');
  console.log('1. Use auto-detected provider' + (detected.length ? ` (${detected.map(provider => provider.name).join(', ')})` : ' (none detected)'));
  console.log('2. Local LM Studio (http://127.0.0.1:1234/v1)');
  console.log('3. Custom provider');
  console.log('4. Reset / clear configuration');

  const rl = createInterface({ input, output });
  try {
    const choice = (await rl.question('Selection [1-4]: ')).trim();
    if (choice === '1') {
      if (!detected.length) {
        console.log('No provider API keys were detected; choose local or custom mode.');
        return;
      }
      const provider = detected[0];
      saveConfig({ provider: provider.provider, keySource: `env:${provider.envKey}` });
      console.log(`Saved auto-detected ${provider.name} mode using ${provider.envKey}.`);
    } else if (choice === '2') {
      saveConfig({ provider: 'local' });
      console.log('Saved local LM Studio mode.');
    } else if (choice === '3') {
      const baseUrl = (await rl.question('Base URL: ')).trim();
      const model = (await rl.question('Model name: ')).trim();
      const apiKey = (await rl.question('API key (optional): ')).trim();
      saveConfig({ provider: 'custom', baseUrl, model, apiKey: apiKey || undefined, keySource: apiKey ? 'file' : undefined });
      console.log('Saved custom worker mode.');
    } else if (choice === '4') {
      clearConfig();
      console.log(`Cleared ${configPath()}.`);
    } else {
      throw new Error('Choose 1, 2, 3, or 4.');
    }
  } finally {
    rl.close();
  }
}

function initWorkspace(workspace = process.cwd()): void {
  const rulesPath = path.join(workspace, '.precog', 'worker.md');
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  try {
    fs.writeFileSync(rulesPath, renderWorkerRules(detectProjectDefaults(workspace)), { flag: 'wx' });
    console.log(`Created ${rulesPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    console.log(`Kept existing ${rulesPath}`);
  }
  const agentsPath = path.join(workspace, 'AGENTS.md');
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const legacyScaffold = '# Agent instructions\n\n- Before delegating implementation with `delegate_worker`, read `.precog/worker.md` and follow its project rules.';
  if (!existing || existing.trim() === legacyScaffold) {
    fs.writeFileSync(agentsPath, ARCHITECT_RULES_TEMPLATE);
    console.log(`Updated ${agentsPath}`);
  } else {
    const additions: string[] = [];
    if (!existing.includes('## Primary Delegation Directive')) additions.push(ARCHITECT_RULES_TEMPLATE);
    if (!existing.includes('.precog/worker.md')) additions.push('- Before delegating implementation, read `.precog/worker.md` and follow its project rules.\n');
    if (additions.length) {
      fs.appendFileSync(agentsPath, `${existing.endsWith('\n') ? '\n' : '\n\n'}${additions.join('\n')}`);
      console.log(`Updated ${agentsPath}`);
    }
  }
}

function parseTestWorkerArgs(args: string[]): { task: string; targets: string[]; apply: boolean; verbose: boolean } {
  const taskParts: string[] = [];
  const targets: string[] = [];
  let apply = false;
  let dryRun = false;
  let verbose = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--target') {
      const target = args[++index];
      if (!target || target.startsWith('--')) throw new Error('--target requires a workspace-relative file path.');
      targets.push(normalizeRelativePath(target));
    } else if (arg.startsWith('--')) throw new Error(`Unknown test-worker option: ${arg}`);
    else taskParts.push(arg);
  }
  if (apply && dryRun) throw new Error('Choose either --apply or --dry-run.');
  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('Usage: s1-precog test-worker <task> [--target path] [--dry-run|--apply] [--verbose]');
  if (!targets.length) {
    for (const match of task.matchAll(/(?:^|[\s`"'])([\w.-]+(?:\/[\w.-]+)+\.(?:[cm]?js|tsx?|json|md))(?:$|[\s`"',.:;])/g)) {
      targets.push(normalizeRelativePath(match[1]));
    }
  }
  if (!targets.length) throw new Error('Name target files in the task or pass --target for each expected file.');
  return { task, targets: [...new Set(targets)], apply, verbose };
}

async function testWorker(args: string[]): Promise<void> {
  const { task, targets, apply, verbose } = parseTestWorkerArgs(args);
  const receipt = await delegateWorker({ task, targetFiles: targets, workspacePath: process.cwd(), runVerification: true }, { dryRun: !apply, verbose });
  if (verbose && 'promptPayload' in receipt) console.log(`Prompt payload:\n${JSON.stringify(receipt.promptPayload, null, 2)}`);
  if (verbose && 'rawGeneratedBlocks' in receipt) console.log(`Raw generated file blocks:\n${receipt.rawGeneratedBlocks}`);
  if ('diff' in receipt && receipt.diff) console.log(`Staged diff:\n${receipt.diff}`);
  console.log(`Receipt:\n${JSON.stringify(receipt, null, 2)}`);
  if (!receipt.success) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === 'stats') {
    console.log(renderStats(readLedger()));
    return;
  }
  if (command === 'serve') {
    await serve();
    return;
  }
  if (command === 'config') {
    await runConfigWizard(process.argv.slice(3));
    return;
  }
  if (command === 'init') {
    initWorkspace();
    return;
  }
  if (command === 'test-worker') {
    await testWorker(process.argv.slice(3));
    return;
  }
  throw new Error(`Unknown command: ${command}. Use "serve", "stats", "config", "init", or "test-worker".`);
}

main().catch(error => {
  console.error(`[s1-precog] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

