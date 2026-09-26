# CodexLaya

Node 22+ stdio MCP server exposing `delegate_worker` for local code generation through LM Studio.

```sh
npm install
npm run build
npm test
node dist/index.js
```

Launch the built entrypoint with Node from your MCP client. Set the working directory to the intended workspace, or pass an absolute `workspacePath` with each call. Stdout is reserved for MCP JSON-RPC; diagnostics go to stderr.

The tool accepts required `task` and optional `targetFiles` (string array), `runVerification` (boolean), and `workspacePath` (absolute string). Generated files are written directly and existing files can be replaced. The receipt reports written paths, missing expected files, verification results, token counts, and estimated savings.

Requests use `http://127.0.0.1:1234/v1/chat/completions`, model `qwen/qwen3.8-27b` from the reference profile, temperature `0.2`, `enable_thinking: false`, and `reasoning_effort: "none"`. Set `LM_STUDIO_MODEL` to use another loaded model. The reference output limit is 8,192 tokens; completions marked truncated are logged but not written. Requests time out after five minutes.

Worker output uses strict blocks: `<<<FILE: relative/path>>>>`, the complete file contents, `<<<END_FILE>>>`, and a final `<<<END_DELEGATION>>>`. Strict output rejects conversational text, malformed delimiters, absolute paths, and traversal. The parser retains legacy fenced and `// FILE:`/`# FILE:` compatibility for existing callers. Paths are checked for traversal, symlinks/junctions, duplicates, and attempts to replace the ledger before writing. Filesystem writes are not transactional.

Verification executes generated `.test.js`, `.test.cjs`, `.test.mjs`, `.test.ts` (and `.spec.*`) standalone assertion scripts in-process. TypeScript and ESM syntax are transpiled to CommonJS in memory. Scripts may import `node:assert`, `node:assert/strict`, and relative JS/TS/JSON modules. Async tests must export an async function or promise. Counts refer to scripts, not individual assertions. Jest, Vitest, `node:test`, external packages, and Node process/filesystem/network APIs are not supported by this runner; unsupported imports fail explicitly. Each script has a five-second execution budget, and logs are captured in the receipt. VM execution is not a security boundary for hostile code; use a trusted local model and review generated code. Timed-out promises are not forcibly cancellable.

Each workspace gets `savings-ledger.json`, retaining the reference totals, latest 500 history records and latest 50 events. Local API cost is treated as zero; estimated avoided cloud cost uses the reference baseline of $0.14/million input tokens and $0.28/million output tokens (not a claim about current pricing or electricity/hardware cost). Missing token usage is estimated as characters / 3.8. Ledger writes use atomic replacement and corrupt ledgers produce errors instead of silently resetting totals. Calls are serialized within one server; use only one server process per workspace ledger.

`npm test` runs the new Node test suite, including a real stdio handshake and mocked LM Studio calls. The pre-existing `tests/*.test.ts` files exercise the old Cordis plugin and are preserved as reference; they are not part of the MCP test suite. The mentioned `reference/tools/lm-client.mjs` was absent, so the server uses Node's built-in `fetch`.
