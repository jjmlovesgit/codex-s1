import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDockerArgs, createVerifier, getVerifierBackend, DockerVerifier, InProcessVerifier } from '../dist/index.js';

test('verifier selection defaults to the in-process VM backend', () => {
  assert.equal(getVerifierBackend({}), 'vm');
  assert.ok(createVerifier({}) instanceof InProcessVerifier);
  assert.equal(getVerifierBackend({ VERIFIER_BACKEND: 'docker' }), 'docker');
  assert.ok(createVerifier({ VERIFIER_BACKEND: 'docker', DOCKER_VERIFIER_IMAGE: 'custom/verifier:test' }) instanceof DockerVerifier);
});

test('Docker command builder applies air-gap and resource hardening flags', () => {
  const args = buildDockerArgs('C:\\stages\\run-1', 'tests/example.test.ts', 'verifier:test');
  const joined = args.join(' ');
  for (const token of ['--network none', '--read-only', '--pids-limit 100', '--memory 2g', '--tmpfs /tmp:rw,noexec,nosuid,size=256m', '--cap-drop ALL', '--security-opt no-new-privileges']) {
    assert.match(joined, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(joined, /verifier:test/);
  assert.match(joined, /--experimental-strip-types/);
  assert.match(joined, /\/sandbox\/tests\/example\.test\.ts/);
  assert.throws(() => buildDockerArgs('C:\\stages\\run-1', '../escape.test.js'), /Invalid Docker verification path/);
});
