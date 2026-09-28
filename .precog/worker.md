# Worker Guidelines

## Environment & Syntax
- Module System: ESM (`import` / `export`)
- Language: TypeScript
- Runtime: Node.js (Current LTS)

## Sandbox Safety (Zero External Dependencies)
- All generated code MUST rely exclusively on Node standard library built-ins (e.g., `node:fs`, `node:path`, `node:crypto`).
- Do NOT introduce external npm packages unless explicitly instructed by the Architect.

## Test Contracts
- Always use `node:assert/strict` or `node:test` for verification.
- Tests must be completely self-contained. The staging verifier handles TypeScript; use `tsx <file>` for direct execution only if this project already provides tsx. Do not add a new test dependency.
- Verify standard happy paths and realistic edge cases (null/undefined inputs, empty arrays, malformed strings).

## Output Contract
- Do not output conversational preamble, markdown explanations, or postambles.
- Emit exclusively raw, delimited code file blocks.
