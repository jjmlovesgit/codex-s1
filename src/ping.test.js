import assert from 'node:assert';
import { ping } from './ping.js';

assert.strictEqual(ping(), 'pong');
