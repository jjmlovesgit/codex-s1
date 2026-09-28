import assert from 'node:assert/strict';
import { ping } from './cloud_ping.js';

assert.equal(ping(), "pong");

export async function run() {
  const errors = [];
  try {
    assert.equal(ping(), "pong");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { passed: errors.length === 0, errors };
}
