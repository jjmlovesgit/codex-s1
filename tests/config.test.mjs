import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearConfig, loadConfig, saveConfig } from '../dist/config.js';
import { resolveWorkerProfile } from '../dist/profiles.js';

test('persistent config writes, reads, and tolerates corrupt JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-precog-config-'));
  const file = path.join(dir, '.precog', 'config.json');
  try {
    saveConfig({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test', keySource: 'file' }, file);
    assert.deepEqual(loadConfig(file), { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test', keySource: 'file' });
    fs.writeFileSync(file, '{broken');
    assert.deepEqual(loadConfig(file), {});
    clearConfig(file);
    assert.deepEqual(loadConfig(file), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker resolution follows env, config, auto-detection, then local fallback', () => {
  const explicit = resolveWorkerProfile({ WORKER_BASE_URL: 'https://example.test/v1', WORKER_MODEL: 'custom-model', WORKER_API_KEY: 'key' }, {});
  assert.equal(explicit.endpoint, 'https://example.test/v1');
  assert.equal(explicit.model, 'custom-model');
  assert.equal(explicit.apiKey, 'key');
  assert.equal(explicit.source, 'explicit process environment');

  const configured = resolveWorkerProfile({}, { provider: 'openai', model: 'gpt-4o', apiKey: 'config-key' });
  assert.equal(configured.endpoint, 'https://api.openai.com/v1');
  assert.equal(configured.provider, 'openai');
  assert.equal(configured.source, 'config file (~/.precog/config.json)');

  const configEnvKey = resolveWorkerProfile({ OPENAI_API_KEY: 'env-key' }, { provider: 'openai', keySource: 'env:OPENAI_API_KEY' });
  assert.equal(configEnvKey.apiKey, 'env-key');

  const auto = resolveWorkerProfile({ OPENAI_API_KEY: 'auto-key' }, {});
  assert.equal(auto.provider, 'openai');
  assert.equal(auto.model, 'gpt-4o');
  assert.equal(auto.source, 'auto-detected ($OPENAI_API_KEY)');

  const local = resolveWorkerProfile({}, {});
  assert.equal(local.provider, 'lm-studio');
  assert.equal(local.endpoint, 'http://127.0.0.1:1234/v1');
  assert.equal(local.source, 'local default');
});
