import assert from 'node:assert/strict';
import { isValidUuid } from './uuid_v4.js';

export async function run() {
  const errors = [];
  const check = (label, fn) => {
    try {
      fn();
    } catch (error) {
      errors.push(`${label}: ${error && error.message ? error.message : String(error)}`);
    }
  };

  const valid = [
    'a987fbc9-4bed-4074-9b07-4c455b099bc9',
    'A987FBC9-4BED-4074-9B07-4C455B099BC9',
    '00000000-0000-4000-8000-000000000000',
    'ffffffff-ffff-4fff-bfff-ffffffffffff',
    '123e4567-e89b-42d3-a456-426614174000',
  ];

  const invalid = [
    ['wrong version', 'a987fbc9-4bed-3074-9b07-4c455b099bc9'],
    ['wrong variant', 'a987fbc9-4bed-4074-1b07-4c455b099bc9'],
    ['malformed grouping', 'a987fbc94bed40749b074c455b099bc9'],
    ['too short', 'a987fbc9-4bed-4074-9b07-4c455b099bc'],
    ['too long', 'a987fbc9-4bed-4074-9b07-4c455b099bc9a'],
    ['leading whitespace', ' a987fbc9-4bed-4074-9b07-4c455b099bc9'],
    ['trailing whitespace', 'a987fbc9-4bed-4074-9b07-4c455b099bc9 '],
    ['non-hex character', 'g987fbc9-4bed-4074-9b07-4c455b099bc9'],
    ['braces', '{a987fbc9-4bed-4074-9b07-4c455b099bc9}'],
    ['empty string', ''],
    ['non-string number', 123],
    ['non-string null', null],
    ['non-string undefined', undefined],
    ['non-string object', {}],
    ['non-string array', []],
  ];

  for (const value of valid) {
    check(`expected valid: ${value}`, () => {
      assert.equal(isValidUuid(value), true);
    });
  }

  for (const [label, value] of invalid) {
    check(`expected invalid (${label}): ${String(value)}`, () => {
      assert.equal(isValidUuid(value), false);
    });
  }

  return { passed: errors.length === 0, errors };
}

export default run;
