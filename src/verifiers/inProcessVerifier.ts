import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import assert from 'node:assert';
import { format } from 'node:util';
import ts from 'typescript';
import type { VerificationResult, VerifierOptions, VerifierStrategy } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stageFile(stageDir: string, relativeName: string): string {
  const root = path.resolve(stageDir);
  const resolved = path.resolve(root, relativeName);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Verification file escapes stage directory: ${relativeName}`);
  }
  return resolved;
}

/** The default zero-dependency verifier. VM execution is deliberately local and bounded. */
export class InProcessVerifier implements VerifierStrategy {
  async run(stageDir: string, testFiles: string[], options: VerifierOptions = {}): Promise<VerificationResult> {
    const started = Date.now();
    if (!testFiles.length) {
      return { status: 'failed', passed: 0, failed: 1, output: 'Verification requested, but no generated .test/.spec JS or TS assertion scripts were found.', durationMs: Date.now() - started };
    }
    let passed = 0;
    let failed = 0;
    let output = '';
    const log = (...args: unknown[]) => { output = (output + format(...args) + '\n').slice(-2000); };
    const timeoutMs = Math.min(Math.max(1, options.timeoutMs ?? 5_000), 5_000);

    for (const relativeTest of testFiles) {
      const testPath = stageFile(stageDir, relativeTest);
      const cache = new Map<string, { exports: unknown }>();
      const timeoutHandles = new Set<ReturnType<typeof setTimeout>>();
      const intervalHandles = new Set<ReturnType<typeof setInterval>>();
      const asyncErrors: unknown[] = [];
      const timerLimit = 100;
      const safeQueueMicrotask = (callback: () => void) => queueMicrotask(() => { try { callback(); } catch (error) { asyncErrors.push(error); } });
      const boundedDelay = (delay: unknown) => typeof delay === 'number' && Number.isFinite(delay) ? Math.max(0, Math.min(delay, timeoutMs)) : 0;
      const safeSetTimeout = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (timeoutHandles.size + intervalHandles.size >= timerLimit) throw new Error('Verification timer limit exceeded.');
        let handle!: ReturnType<typeof setTimeout>;
        handle = setTimeout(() => {
          timeoutHandles.delete(handle);
          try { callback(...args); } catch (error) { asyncErrors.push(error); }
        }, boundedDelay(delay));
        timeoutHandles.add(handle);
        return handle;
      };
      const safeSetInterval = (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        if (timeoutHandles.size + intervalHandles.size >= timerLimit) throw new Error('Verification timer limit exceeded.');
        let handle!: ReturnType<typeof setInterval>;
        handle = setInterval(() => { try { callback(...args); } catch (error) { asyncErrors.push(error); } }, boundedDelay(delay));
        intervalHandles.add(handle);
        return handle;
      };
      const safeClearTimeout = (handle: unknown) => {
        if (handle !== undefined && handle !== null) {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
          timeoutHandles.delete(handle as ReturnType<typeof setTimeout>);
        }
      };
      const safeClearInterval = (handle: unknown) => {
        if (handle !== undefined && handle !== null) {
          clearInterval(handle as ReturnType<typeof setInterval>);
          intervalHandles.delete(handle as ReturnType<typeof setInterval>);
        }
      };
      const context = vm.createContext({
        console: { log, error: log, warn: log, info: log, debug: log },
        setTimeout: safeSetTimeout,
        clearTimeout: safeClearTimeout,
        setInterval: safeSetInterval,
        clearInterval: safeClearInterval,
        queueMicrotask: safeQueueMicrotask,
      }, { codeGeneration: { strings: false, wasm: false } });
      const deadline = Date.now() + timeoutMs;
      const load = (requested: string): unknown => {
        const filename = stageFile(stageDir, path.relative(stageDir, requested));
        const previous = cache.get(filename);
        if (previous) return previous.exports;
        const module = { exports: {} as unknown };
        cache.set(filename, module);
        const source = fs.readFileSync(filename, 'utf8');
        if (path.extname(filename) === '.json') { module.exports = JSON.parse(source); return module.exports; }
        const compiled = ts.transpileModule(source, { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
        const localRequire = (specifier: string): unknown => {
          if (specifier === 'node:assert' || specifier === 'assert') return assert;
          if (specifier === 'node:assert/strict' || specifier === 'assert/strict') return assert.strict;
          if (!specifier.startsWith('.')) throw new Error(`Unsupported verification import: ${specifier}. Use standalone node:assert scripts and relative imports.`);
          const base = stageFile(stageDir, path.relative(stageDir, path.resolve(path.dirname(filename), specifier)));
          const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.ts'), path.join(base, 'index.js')];
          if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts');
          const found = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
          if (!found) throw new Error(`Cannot resolve verification import: ${specifier}`);
          return load(found);
        };
        const sandbox = context as vm.Context & Record<string, unknown>;
        Object.assign(sandbox, { __module: module, __require: localRequire, __filenameArg: filename, __dirnameArg: path.dirname(filename) });
        new vm.Script(`(function(module, exports, require, __filename, __dirname) {\n${compiled.outputText}\n})(__module, __module.exports, __require, __filenameArg, __dirnameArg)`, { filename }).runInContext(context, { timeout: Math.min(timeoutMs, Math.max(1, deadline - Date.now())) });
        return module.exports;
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unhandledRejection = (reason: unknown) => { asyncErrors.push(reason); };
      process.on('unhandledRejection', unhandledRejection);
      try {
        const exported = load(testPath) as { default?: unknown; run?: unknown } | undefined;
        const sandbox = context as vm.Context & Record<string, unknown>;
        sandbox.__result = exported && typeof exported === 'object' && 'default' in exported ? exported.default : exported && typeof exported === 'object' && 'run' in exported ? exported.run : exported;
        const result: unknown = new vm.Script('typeof __result === "function" ? __result() : __result').runInContext(context, { timeout: Math.min(timeoutMs, Math.max(1, deadline - Date.now())) });
        const settled = await Promise.race([Promise.resolve(result), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Verification timed out.')), Math.min(timeoutMs, Math.max(1, deadline - Date.now()))); })]);
        await new Promise<void>(resolve => setImmediate(resolve));
        if (asyncErrors.length) throw new Error('Verification async failure: ' + errorMessage(asyncErrors[0]));
        if (settled && typeof settled === 'object' && 'passed' in settled && (settled as { passed?: unknown }).passed === false) {
          const details = 'errors' in settled && Array.isArray((settled as { errors?: unknown }).errors) ? (settled as { errors: unknown[] }).errors.join('; ') : 'run() reported failure';
          throw new Error('Verification reported failure: ' + details);
        }
        passed++;
        log(`PASS ${relativeTest}`);
      } catch (error) {
        failed++;
        log(`FAIL ${relativeTest}: ${errorMessage(error)}`);
      } finally {
        process.off('unhandledRejection', unhandledRejection);
        if (timer) clearTimeout(timer);
        for (const handle of timeoutHandles) safeClearTimeout(handle);
        for (const handle of intervalHandles) safeClearInterval(handle);
      }
    }
    return { status: failed ? 'failed' : 'passed', passed, failed, output, durationMs: Date.now() - started };
  }
}

export const inProcessVerifier = new InProcessVerifier();
