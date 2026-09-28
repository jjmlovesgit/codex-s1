import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { delegateWorker, extractAndEmitFiles, parseFileBlocks, runSandboxVerification, SavingsTracker, createServer, PROFILES } from '../dist/index.js';
import { ledgerPath } from '../dist/ledger-path.js';

test('package exposes the production binary and legacy alias', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 's1-precog');
  assert.equal(pkg.bin['s1-precog'], './dist/cli.js');
  assert.equal(pkg.bin['codex-s1'], pkg.bin['s1-precog']);
  assert.equal(fs.existsSync(new URL('../dist/cli.js', import.meta.url)), true);
});

test('telemetry migration copies the legacy ledger once and preserves existing new data', t => {
  const dir = workspace(t);
  const legacy = path.join(dir, '.codex-s1');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'ledger.json'), '{"totalTurns":7}');
  const current = ledgerPath(dir);
  assert.equal(current, path.join(dir, '.s1-precog', 'ledger.json'));
  assert.equal(fs.readFileSync(current, 'utf8'), '{"totalTurns":7}');
  fs.writeFileSync(current, '{"totalTurns":8}');
  assert.equal(fs.readFileSync(ledgerPath(dir), 'utf8'), '{"totalTurns":8}');
});

test('telemetry migration recognizes the historical savings ledger filename', t => {
  const dir = workspace(t);
  const legacy = path.join(dir, '.codex-s1');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'savings-ledger.json'), '{"totalTurns":3}');
  assert.equal(fs.readFileSync(ledgerPath(dir), 'utf8'), '{"totalTurns":3}');
});

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexlaya-test-'));
  const previousHome = process.env.S1_PRECOG_HOME;
  process.env.S1_PRECOG_HOME = dir;
  t.after(() => {
    if (previousHome === undefined) delete process.env.S1_PRECOG_HOME;
    else process.env.S1_PRECOG_HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function completion(t, content, extra = {}) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, `${PROFILES.WORKER.endpoint}/chat/completions`);
    const body = JSON.parse(options.body);
    assert.equal(body.enable_thinking, false);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.stream, false);
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10000, completion_tokens: 2000, total_tokens: 12000 }, ...extra });
  });
}
const generated = '```typescript\n// FILE: src/math.ts\nexport const add = (a: number, b: number) => a + b;\n```\n```typescript\n// FILE: tests/math.test.ts\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\nconsole.log("captured test log");\nassert.equal(add(2, 3), 5);\nexport default async () => { assert.equal(await Promise.resolve(add(3, 4)), 7); };\n```';

test('delegation emits nested TS files, verifies async assertions, and persists cumulative savings', async t => {
  const dir = workspace(t);
  completion(t, generated);
  const params = { task: 'Create addition and tests', targetFiles: ['src/math.ts', 'tests/math.test.ts'], workspacePath: dir, runVerification: true };
  const receipt = await delegateWorker(params);
  assert.equal(receipt.success, true, JSON.stringify(receipt));
  assert.equal(receipt.testResults.passed, 1);
  assert.match(receipt.testResults.output, /captured test log/);
  const expectedLocalSavings = PROFILES.WORKER.name === 'WORKER_LOCAL' ? 0.045 : 0;
  assert.equal(receipt.savedUSD, expectedLocalSavings);
  assert.equal(receipt.tokens.estimated, false);
  assert.equal(receipt.benchmark, 'gpt-5.6-luna');
  assert.equal(receipt.operationalMetrics.contextTokensShielded, 2000);
  assert.equal(receipt.operationalMetrics.estimatedCloudMessagesSaved, 1.33);
  assert.equal(receipt.operationalMetrics.savedUSD, 0.045);
  assert.equal(receipt.operationalMetrics.estimatedBytesAvoided, fs.readFileSync(path.join(dir, 'src/math.ts')).length + fs.readFileSync(path.join(dir, 'tests/math.test.ts')).length);
  assert.ok(['WORKER_LOCAL', 'WORKER_CLOUD'].includes(receipt.worker));
  assert.equal(receipt.model, process.env.WORKER_MODEL || process.env.LM_STUDIO_MODEL || PROFILES.WORKER.model);
  assert.equal(receipt.endpoint, PROFILES.WORKER.endpoint);
  assert.ok(receipt.timings.workerInferenceMs >= 0);
  assert.ok(receipt.timings.sandboxVerificationMs >= 0);
  assert.ok(receipt.timings.filePromotionMs >= 0);
  assert.match(receipt.timings.totalExecutionSec, /^\d+\.\d{2}$/);
  assert.ok(receipt.verification.passed >= 1);
  assert.equal(fs.existsSync(path.join(dir, '.precog-stage')), true);
  assert.equal(fs.existsSync(path.join(dir, '.codex-stage')), false);
  await delegateWorker(params);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.s1-precog', 'ledger.json'), 'utf8'));
  const expectedWorkerTurns = PROFILES.WORKER.name === 'WORKER_LOCAL' ? 2 : 0;
  const expectedSaved = PROFILES.WORKER.name === 'WORKER_LOCAL' ? 0.09 : 0;
  assert.equal(ledger.totalTurns, 2);
  assert.equal(ledger.totalTokens, 24000);
  assert.equal(ledger.workerTurns, expectedWorkerTurns);
  assert.equal(ledger.totalSavedUSD, expectedSaved);
  assert.equal(ledger.operationalMetrics.contextTokensShielded, 4000);
  assert.equal(ledger.operationalMetrics.estimatedCloudMessagesSaved, 2.67);
  assert.equal(ledger.operationalMetrics.savedUSD, 0.09);
});

test('parser supports file headers, markers outside fences, CRLF, bare markers and exact hint mapping', () => {
  assert.deepEqual(parseFileBlocks('```js file="folder/a b.js"\r\nhello\r\n```'), [{ name: 'folder/a b.js', code: 'hello\n' }]);
  assert.deepEqual(parseFileBlocks('// FILE: a.js\n```js\na\n```\n// FILE: b.js\n```js\nb\n```').map(f => f.name), ['a.js', 'b.js']);
  assert.deepEqual(parseFileBlocks('// FILE: a.js\na\n// FILE: b.js\nb').map(f => f.name), ['a.js', 'b.js']);
  assert.equal(parseFileBlocks('```js\na\n```', ['a.js'])[0].code, 'a\n');
  assert.throws(() => parseFileBlocks('```js\na\n```', ['a.js', 'b.js']), /unambiguously/);
});

test('parser accepts balanced 3-5 angle delimiters, whitespace, alternate end tags, and line endings', () => {
  const cases = [
    ['<<<FILE: src/index.ts>>>\nconst a = 1;\n<<<END_FILE>>>\n', 'const a = 1;\n'],
    ['<<<<FILE: src/index.ts>>>>\r\nconst b = 2;\r\n<<<<END_FILE>>>>\r\n', 'const b = 2;\n'],
    ['<<< FILE: `src/index.ts` >>>\nconst c = 3;\n<<< FILE_END >>>\n', 'const c = 3;\n'],
    ['<<<<<  FILE:  src/index.ts  >>>>>\r\nconst d = 4;\r\n<<<<< END >>>>>\r\n', 'const d = 4;\n'],
  ];
  for (const [emission, expectedCode] of cases) {
    assert.deepEqual(parseFileBlocks(emission, ['src/index.ts']), [{ name: 'src/index.ts', code: expectedCode }]);
  }
  assert.deepEqual(
    parseFileBlocks('<<<FILE: src/index.ts>>>\nconst comparison = a < b && c > d;\n<<<END_FILE>>>\n', ['src/index.ts']),
    [{ name: 'src/index.ts', code: 'const comparison = a < b && c > d;\n' }],
  );
});

test('emission rejects traversal, duplicate destinations, ledger writes, and junction escapes before writing', t => {
  const dir = workspace(t);
  for (const name of ['../escape.js', 'savings-ledger.json', '.s1-precog/ledger.json', 'file.js:stream']) {
    assert.throws(() => extractAndEmitFiles(`// FILE: good.js\ngood\n// FILE: ${name}\nbad`, [], dir));
    assert.equal(fs.existsSync(path.join(dir, 'good.js')), false);
  }
  assert.throws(() => extractAndEmitFiles('// FILE: a.js\none\n// FILE: a.js\ntwo', [], dir), /Duplicate/);
  const outside = workspace(t);
  fs.symlinkSync(outside, path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => extractAndEmitFiles('// FILE: link/escape.js\nbad', [], dir), /Symlink|junction/);
});

test('verification reports thrown assertions, missing tests, unsupported imports and timeouts', async t => {
  const dir = workspace(t);
  const emit = code => extractAndEmitFiles(code, ['case.test.js'], dir).filesWritten;
  assert.equal((await runSandboxVerification(emit('require("node:assert/strict").equal(1, 2)'), dir)).failed, 1);
  assert.equal((await runSandboxVerification([], dir)).status, 'failed');
  assert.match((await runSandboxVerification(emit('require("node:test")'), dir)).output, /Unsupported verification import/);
  assert.match((await runSandboxVerification(emit('while (true) {}'), dir, 30)).output, /timed out/);
  assert.match((await runSandboxVerification(emit('module.exports = new Promise(() => {})'), dir, 30)).output, /timed out/);
});

test('missing files and missing tests never report successful delegation', async t => {
  const dir = workspace(t);
  completion(t, '// FILE: a.js\nmodule.exports = 1;');
  const missing = await delegateWorker({ task: 'generate', targetFiles: ['a.js', 'b.js'], workspacePath: dir });
  assert.equal(missing.status, 'MISSING_FILES');
  assert.deepEqual(missing.missingFiles, ['b.js']);
  const noTests = await delegateWorker({ task: 'generate', targetFiles: ['a.js'], workspacePath: dir, runVerification: true });
  assert.equal(noTests.status, 'VERIFICATION_FAILED');
});

test('truncated completions are accounted for but never written', async t => {
  const dir = workspace(t);
  completion(t, generated, { choices: [{ message: { content: generated }, finish_reason: 'length' }] });
  const receipt = await delegateWorker({ task: 'generate', targetFiles: ['src/math.ts', 'tests/math.test.ts'], workspacePath: dir });
  assert.equal(receipt.success, false);
  assert.match(receipt.message, /truncated/);
  assert.equal(fs.existsSync(path.join(dir, 'src')), false);
  assert.equal(receipt.tokens.total, 24000);
});



test('retry emits feedback and aggregates usage across both completions', async t => {
  const dir = workspace(t);
  const first = `<<<FILE: src/retry-value.js>>>
module.exports = 1;
<<<END_FILE>>>
<<<FILE: tests/retry-value.test.js>>>
const assert = require("node:assert/strict");
assert.equal(1, 2);
<<<END_FILE>>>
<<<END_DELEGATION>>>`;
  const second = `<<<FILE: src/retry-value.js>>>
module.exports = 1;
<<<END_FILE>>>
<<<FILE: tests/retry-value.test.js>>>
const assert = require("node:assert/strict");
assert.equal(1, 1);
<<<END_FILE>>>
<<<END_DELEGATION>>>`;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(url, `${PROFILES.WORKER.endpoint}/chat/completions`);
    assert.equal(body.max_tokens, 8192);
    if (calls === 2) assert.match(body.messages.at(-1).content, /previous output failed verification/);
    const content = calls === 1 ? first : second;
    const promptTokens = calls === 1 ? 10 : 20;
    const completionTokens = calls === 1 ? 2 : 3;
    return Response.json({ model: 'retry-model', choices: [{ message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });
  });
  const receipt = await delegateWorker({ task: 'generate and verify retry files', targetFiles: ['src/retry-value.js', 'tests/retry-value.test.js'], workspacePath: dir, runVerification: true });
  assert.equal(receipt.success, true, JSON.stringify(receipt));
  assert.equal(calls, 2);
  assert.deepEqual(receipt.tokens, { prompt: 30, completion: 5, total: 35, estimated: false });
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, '.s1-precog', 'ledger.json'), 'utf8'));
  assert.equal(ledger.totalTurns, 2);
  assert.equal(ledger.totalTokens, 35);
});
test('disk write failure receipts retain paths already written', async t => {
  const dir = workspace(t);
  fs.mkdirSync(path.join(dir, 'occupied.js'));
  completion(t, '// FILE: good.js\nconst good = true;\n// FILE: occupied.js\nconst bad = true;');
  const receipt = await delegateWorker({ task: 'generate', targetFiles: ['good.js', 'occupied.js'], workspacePath: dir });
  assert.equal(receipt.success, false);
  assert.deepEqual(receipt.filesWritten, ['good.js']);
  assert.match(receipt.message, /Failed to write occupied.js/);
});

test('invalid arguments, HTTP errors, and unavailable usage produce accurate receipts', async t => {
  const dir = workspace(t);
  const stub = t.mock.method(globalThis, 'fetch', async () => new Response('offline', { status: 503 }));
  for (const args of [{ task: '' }, { task: 'x', runVerification: 'yes' }, { task: 'x', workspacePath: 'relative' }, { task: 'x', targetFiles: [4] }]) {
    assert.equal((await delegateWorker(args)).success, false);
  }
  assert.equal(stub.mock.callCount(), 0);
  assert.match((await delegateWorker({ task: 'x', targetFiles: ['a.js'], workspacePath: dir })).message, /HTTP 503/);
  stub.mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: '// FILE: a.js\nconst a = 1;' } }] }));
  const receipt = await delegateWorker({ task: 'x', targetFiles: ['a.js'], workspacePath: dir, runVerification: false });
  assert.equal(receipt.success, true);
  assert.equal(receipt.tokens.estimated, true);
  assert.ok(receipt.tokens.prompt > 0);
});

test('local worker connection refusal returns actionable setup guidance', async t => {
  if (process.env.WORKER_API_KEY || process.env.DEEPSEEK_API_KEY) return;
  const dir = workspace(t);
  const stub = t.mock.method(globalThis, 'fetch', async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNREFUSED' };
    throw error;
  });
  const receipt = await delegateWorker({ task: 'generate', targetFiles: ['a.js'], workspacePath: dir });
  assert.equal(receipt.success, false);
  assert.equal(receipt.status, 'NO_WORKER_AVAILABLE');
  assert.equal(receipt.error, 'NO_WORKER_AVAILABLE');
  assert.match(receipt.message, /Start LM Studio/);
  assert.match(receipt.message, /WORKER_API_KEY/);
  assert.equal(stub.mock.callCount(), 1);
});

test('ledger keeps the reference cloud math, honors custom rates, and preserves corrupt data', t => {
  const dir = workspace(t);
  const tracker = new SavingsTracker(dir);
  const usage = { route: 'ARCHITECT_CLOUD', promptTokens: 10000, completionTokens: 2000, totalTokens: 12000, cacheHitTokens: 8000 };
  assert.equal(tracker.recordUsage(usage).costUSD, 0.000952);
  assert.equal(new SavingsTracker(dir, { inputPerMillion: 1, outputPerMillion: 2 }).recordUsage({ ...usage, route: 'WORKER_LOCAL' }).savedUSD, 0.014);
  const file = path.join(dir, '.s1-precog', 'ledger.json');
  fs.writeFileSync(file, 'broken ledger');
  assert.throws(() => tracker.recordUsage(usage));
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken ledger');
});

test('MCP client receives tool schema, compact successful receipt and error receipts', async t => {
  const dir = workspace(t);
  completion(t, generated);
  const server = createServer();
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal(client.getServerVersion()?.name, 's1-precog');
  t.after(async () => { await client.close(); await server.close(); });
  const listed = await client.listTools();
  assert.equal(listed.tools[0].name, 'delegate_worker');
  assert.deepEqual(listed.tools[0].inputSchema.required, ['task']);
  const result = await client.callTool({ name: 'delegate_worker', arguments: { task: 'generate', targetFiles: ['src/math.ts', 'tests/math.test.ts'], workspacePath: dir, runVerification: true } });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Status: SUCCESS/);
  assert.match(result.content[0].text, /Inference \/ Thinking:/);
  assert.match(result.content[0].text, /Staging Verification: PASSED/);
  assert.match(result.content[0].text, /Tokens Shielded: \d+/);
  assert.match(result.content[0].text, /Turn Tokens: Prompt: \d+, Completion: \d+/);
  assert.equal(result.content[0].text.includes('ledgerPath'), false);
  assert.equal(result._meta.receipt.status, 'SUCCESS');
  const invalid = await client.callTool({ name: 'delegate_worker', arguments: { task: 42 } });
  assert.equal(invalid.isError, true);
});

test('built entrypoint supports a real stdio MCP handshake with clean stdout', async t => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))], stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 's1-precog');
  const tools = await client.listTools();
  assert.equal(tools.tools[0].name, 'delegate_worker');
  const result = await client.callTool({ name: 'delegate_worker', arguments: { task: '' } });
  assert.equal(result.isError, true);
});
