import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildWorkerMessages, delegateWorker, loadWorkerGuidelines } from '../dist/index.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precog-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loads project and user rules in order and appends them to the system prompt', t => {
  const root = tempDir(t);
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(workspace, '.precog'), { recursive: true });
  fs.mkdirSync(path.join(home, '.precog'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.precog', 'worker.md'), 'Use TypeScript.');
  fs.writeFileSync(path.join(home, '.precog', 'worker.md'), 'Use node:assert.');
  const rules = loadWorkerGuidelines(workspace, home);
  assert.ok(rules.indexOf('Use TypeScript.') < rules.indexOf('Use node:assert.'));
  const messages = buildWorkerMessages('Create a file', rules);
  assert.match(messages[0].content, /## Project Specific Guidelines/);
  assert.match(messages[0].content, /Use TypeScript\.[\s\S]*Use node:assert\./);
  assert.equal(messages.at(-1).content, 'Create a file');
  assert.equal(loadWorkerGuidelines(root, path.join(root, 'missing')), '');
  assert.doesNotMatch(buildWorkerMessages('Task')[0].content, /## Project Specific Guidelines/);
});

test('delegate_worker sends project guidelines in the worker system message', async t => {
  const workspace = tempDir(t);
  fs.mkdirSync(path.join(workspace, '.precog'));
  fs.writeFileSync(path.join(workspace, '.precog', 'worker.md'), 'Prefer tabs for this project.');
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /## Project Specific Guidelines[\s\S]*Prefer tabs for this project\./);
    return Response.json({ choices: [{ message: { content: '<<<FILE: src/rules.js>>>\nexport const value = 1;\n<<<END_FILE>>>' } }] });
  });
  const receipt = await delegateWorker({ task: 'Create source', targetFiles: ['src/rules.js'], workspacePath: workspace, runVerification: false });
  assert.equal(receipt.success, true, JSON.stringify(receipt));
});

test('dry run verifies staged assertions, prints a diff, and does not promote', async t => {
  const workspace = tempDir(t);
  const previousHome = process.env.S1_PRECOG_HOME;
  process.env.S1_PRECOG_HOME = workspace;
  t.after(() => { if (previousHome === undefined) delete process.env.S1_PRECOG_HOME; else process.env.S1_PRECOG_HOME = previousHome; });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: '<<<FILE: src/ping.js>>>\nexport function ping() { return "pong"; }\n<<<END_FILE>>>\n<<<FILE: src/ping.test.js>>>\nimport assert from "node:assert";\nimport { ping } from "./ping.js";\nassert.equal(ping(), "pong");\n<<<END_FILE>>>' } }] }));
  const params = { task: 'Create ping and test', targetFiles: ['src/ping.js', 'src/ping.test.js'], workspacePath: workspace, runVerification: true };
  const dry = await delegateWorker(params, { dryRun: true, verbose: true });
  assert.equal(dry.success, true, JSON.stringify(dry));
  assert.equal(dry.status, 'DRY_RUN');
  assert.equal(dry.testResults.status, 'passed');
  assert.match(dry.diff, /\+export function ping/);
  assert.match(dry.rawGeneratedBlocks, /<<<FILE:/);
  assert.ok(Array.isArray(dry.promptPayload));
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'ping.js')), false);
  const applied = await delegateWorker(params);
  assert.equal(applied.success, true, JSON.stringify(applied));
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'ping.js')), true);
});

test('init creates editable rules and references them without overwriting', t => {
  const workspace = tempDir(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = () => spawnSync(process.execPath, [cli, 'init'], { cwd: workspace, encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const rules = path.join(workspace, '.precog', 'worker.md');
  const bareRules = fs.readFileSync(rules, 'utf8');
  assert.match(bareRules, /Module System: ESM \(`import` \/ `export`\)/);
  assert.match(bareRules, /Language: JavaScript/);
  assert.match(bareRules, /Zero External Dependencies[\s\S]*node:assert\/strict[\s\S]*raw, delimited code file blocks/);
  const agentsPath = path.join(workspace, 'AGENTS.md');
  const originalAgents = fs.readFileSync(agentsPath, 'utf8');
  assert.match(originalAgents, /\.precog\/worker\.md/);
  assert.match(originalAgents, /Primary Delegation Directive[\s\S]*Negative Boundaries[\s\S]*Output Verbatim Enforcement/);
  fs.writeFileSync(rules, 'custom');
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(rules, 'utf8'), 'custom');
  assert.equal(fs.readFileSync(agentsPath, 'utf8'), originalAgents);
});

test('init detects Next.js TypeScript ESM and legacy CommonJS projects', t => {
  const root = tempDir(t);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const esm = path.join(root, 'esm');
  const cjs = path.join(root, 'cjs');
  fs.mkdirSync(esm);
  fs.mkdirSync(cjs);
  fs.writeFileSync(path.join(esm, 'package.json'), JSON.stringify({ dependencies: { next: '^15.0.0' } }));
  fs.writeFileSync(path.join(esm, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(cjs, 'package.json'), JSON.stringify({ name: 'legacy' }));
  for (const workspace of [esm, cjs]) {
    const result = spawnSync(process.execPath, [cli, 'init'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const esmRules = fs.readFileSync(path.join(esm, '.precog', 'worker.md'), 'utf8');
  const cjsRules = fs.readFileSync(path.join(cjs, '.precog', 'worker.md'), 'utf8');
  assert.match(esmRules, /Module System: ESM[\s\S]*Language: TypeScript/);
  assert.match(esmRules, /tsx <file>/);
  assert.match(cjsRules, /Module System: CommonJS \(`require\(\)` \/ `module\.exports`\)/);
  assert.match(cjsRules, /Language: JavaScript[\s\S]*node <file>/);
  assert.doesNotMatch(cjsRules, /Language: TypeScript/);
});

test('init recognizes a TypeScript dependency and preserves custom AGENTS.md', t => {
  const workspace = tempDir(t);
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { typescript: '^5.0.0' } }));
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# My rules\n\nKeep this instruction.\n');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = () => spawnSync(process.execPath, [cli, 'init'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Keep this instruction/);
  assert.match(agents, /Primary Delegation Directive[\s\S]*Negative Boundaries/);
  assert.match(fs.readFileSync(path.join(workspace, '.precog', 'worker.md'), 'utf8'), /Language: TypeScript/);
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), agents);
});

test('test-worker CLI defaults to dry-run and --apply promotes verified files', async t => {
  const workspace = tempDir(t);
  const generated = '<<<FILE: src/cli-ping.js>>>\nexport function ping() { return "pong"; }\n<<<END_FILE>>>\n<<<FILE: src/cli-ping.test.js>>>\nimport assert from "node:assert";\nimport { ping } from "./cli-ping.js";\nassert.equal(ping(), "pong");\n<<<END_FILE>>>';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: generated } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'test-worker', 'Create src/cli-ping.js and src/cli-ping.test.js', ...args], {
      cwd: workspace, env: { ...process.env, WORKER_BASE_URL: `http://127.0.0.1:${address.port}/v1`, WORKER_MODEL: 'test-model', S1_PRECOG_HOME: workspace },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const dry = await run(['--verbose']);
  assert.equal(dry.code, 0, dry.stderr + dry.stdout);
  assert.match(dry.stdout, /Staged diff:[\s\S]*Receipt:/);
  assert.match(dry.stdout, /Prompt payload:[\s\S]*Raw generated file blocks:/);
  assert.match(dry.stdout, /"status": "DRY_RUN"/);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'cli-ping.js')), false);
  const applied = await run(['--apply']);
  assert.equal(applied.code, 0, applied.stderr + applied.stdout);
  assert.match(applied.stdout, /"status": "SUCCESS"/);
  assert.equal(fs.existsSync(path.join(workspace, 'src', 'cli-ping.js')), true);
});
