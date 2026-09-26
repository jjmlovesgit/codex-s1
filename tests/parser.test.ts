import assert from 'node:assert/strict';
import { parseFileBlocks } from '../src/index.js';

export async function run(): Promise<{ passed: boolean; errors: string[] }> {
  const errors: string[] = [];
  const cases: Array<[string, string]> = [
    ['<<<FILE: src/index.ts>>>\nconst value = 1;\n<<<END_FILE>>>\n', 'const value = 1;\n'],
    ['<<<<FILE: src/index.ts>>>>\r\nconst value = 2;\r\n<<<<END_FILE>>>>\r\n', 'const value = 2;\n'],
    ['<<<<<FILE: src/index.ts>>>>>\nconst value = 3;\n<<<<<END_FILE>>>>>\n', 'const value = 3;\n'],
    ['<<< FILE: `src/index.ts` >>>\nconst value = 4;\n<<< FILE_END >>>\n', 'const value = 4;\n'],
    ['<<<FILE: src/index.ts>>>\nconst comparison = a < b && c > d;\n<<<END_FILE>>>\n', 'const comparison = a < b && c > d;\n'],
  ];

  for (const [emission, expectedCode] of cases) {
    try {
      assert.deepEqual(parseFileBlocks(emission, ['src/index.ts']), [
        { name: 'src/index.ts', code: expectedCode },
      ]);
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { passed: errors.length === 0, errors };
}

