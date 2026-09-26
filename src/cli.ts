#!/usr/bin/env node
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';
import { loadPricingConfig } from './core/pricing.js';
import { ledgerPath } from './ledger-path.js';

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
  throw new Error(`Unknown command: ${command}. Use "serve" or "stats".`);
}

main().catch(error => {
  console.error(`[s1-precog] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

