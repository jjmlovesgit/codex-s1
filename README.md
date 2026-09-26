# codex-s1

[![npm version](https://img.shields.io/npm/v/codex-s1.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/codex-s1)
[![npm monthly downloads](https://img.shields.io/npm/dm/codex-s1.svg?style=flat-square&color=green)](https://www.npmjs.com/package/codex-s1)
[![Node.js](https://img.shields.io/node/v/codex-s1.svg?style=flat-square&color=339933)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-jjmlovesgit%2Fcodex--s1-181717?style=flat-square&logo=github)](https://github.com/jjmlovesgit/codex-s1)
[![MCP](https://img.shields.io/badge/MCP-1.0.0-purple?style=flat-square)](https://modelcontextprotocol.io/)

Codex S1 is an asymmetric AI delegation gateway. It connects cloud frontier reasoning models such as GPT-5.6-Luna and Claude 3.7 with local GPU workers running through LM Studio or Ollama. Cloud models handle architectural judgment while local models handle implementation and verification close to the developer's workspace.

## Overview

Codex S1 is a local Model Context Protocol (MCP) server exposing a `delegate_worker` tool. A System 1 routing layer classifies work, sends implementation tasks to a local model, extracts emitted files, verifies generated tests in-process, and promotes validated output into the workspace.

The server is designed for local developer workflows. It keeps source files and token accounting on the local machine while providing a compact receipt to the calling MCP client.

## Core capabilities

- **Heuristic and ML routing:** A fast heuristic engine handles common decisions, while configurable HTTP sidecars and ONNX providers can route between a local worker and a cloud architect.
- **Hardened in-process verification:** Generated assertion scripts run in a bounded V8 context with host constructors stripped, dynamic string and WebAssembly code generation disabled, timer handles tracked, and asynchronous failures reported.
- **Batch-atomic workspace staging:** Generated files are written under `.codex-stage/`, verified there, and promoted with per-file atomic replacement and rollback on promotion failure.
- **Honest quota accounting:** Accepted shielded tokens and local retry waste are tracked separately. Savings are calculated from accepted output only, while retry attempts remain visible as local compute overhead.
- **Strict file ingress:** Delegations declare a non-empty `targetFiles` allowlist. Paths are normalized across Windows and POSIX separators, and emitted files are rejected when they are undeclared or escape the workspace.
- **Local-first operation:** LM Studio is the default HTTP worker endpoint, with configuration suitable for other local runtimes such as Ollama-compatible gateways.

## Quickstart

### Zero-install execution

View the local savings ledger without installing globally:

```powershell
npx -y codex-s1 stats
```

Start the stdio MCP server:

```powershell
npx -y codex-s1
```

The default command is equivalent to:

```powershell
npx -y codex-s1 serve
```

### Global installation

```powershell
npm install -g codex-s1
codex-s1 stats
codex-s1 serve
```

### Add as a development dependency

```powershell
npm install --save-dev codex-s1
```

Example `package.json` scripts:

```json
{
  "scripts": {
    "mcp:serve": "codex-s1 serve",
    "mcp:stats": "codex-s1 stats"
  }
}
```

## MCP client configuration

Codex S1 communicates over standard input/output. Configure the client to launch `codex-s1 serve`.

### Claude Desktop

Add a server entry to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codex-s1": {
      "command": "codex-s1",
      "args": ["serve"],
      "env": {
        "LM_STUDIO_URL": "http://127.0.0.1:1234/v1",
        "LOCAL_MODEL_NAME": "qwen2.5-coder-32b-instruct"
      }
    }
  }
}
```

If the package is not installed globally, use an absolute command path or invoke it through `npx`:

```json
{
  "mcpServers": {
    "codex-s1": {
      "command": "npx",
      "args": ["-y", "codex-s1", "serve"]
    }
  }
}
```

### Cursor

Create or update `.cursor/mcp.json` in the workspace:

```json
{
  "mcpServers": {
    "codex-s1": {
      "command": "codex-s1",
      "args": ["serve"],
      "env": {
        "LM_STUDIO_URL": "http://127.0.0.1:1234/v1",
        "LOCAL_MODEL_NAME": "qwen2.5-coder-32b-instruct"
      }
    }
  }
}
```

## Environment variables

| Variable | Example | Purpose |
| --- | --- | --- |
| `LM_STUDIO_URL` | `http://127.0.0.1:1234/v1` | Base URL for the local OpenAI-compatible worker endpoint. |
| `LOCAL_MODEL_NAME` | `qwen2.5-coder-32b-instruct` | Local model identifier sent to the worker endpoint. |
| `STAGE_DIR` | `.codex-stage` | Workspace staging directory used for generated files before promotion. |
| `BENCHMARK_MODEL` | `gpt-5.6-luna` | Benchmark tier used when presenting avoided cloud cost. |

Pricing tiers are stored in `.codex/pricing.json`. The active benchmark can be changed there without recompiling the server.

## CLI reference

### `codex-s1 serve`

Starts the stdio MCP server. This is the default command.

### `codex-s1 stats`

Reads `savings-ledger.json` and prints cumulative delegation and savings metrics:

```text
Codex S1 statistics

Total delegations                    12
Total sessions                       12
Accepted completion tokens shielded  18,420
Accepted prompt tokens shielded       31,600
Local retry completion overhead       1,204
Local retry prompt overhead           2,180
Source code bytes avoided             42.18 KB
Cloud message turns saved             12.28
Active benchmark model                gpt-5.6-luna
Estimated avoided USD                 $0.148320
```

## Worker contract

The `delegate_worker` tool accepts:

- `task`: Detailed implementation contract and acceptance criteria.
- `targetFiles`: Required non-empty list of workspace-relative output paths.
- `runVerification`: Whether generated assertion scripts should run in-process.
- `testSpec`: Additional verification requirements.
- `workspacePath`: Optional absolute workspace root.

The local worker emits files using explicit `<<<FILE: path>>>` and `<<<END_FILE>>>` delimiters or supported Markdown code fences. A compact JSON receipt reports routing, written files, verification, token usage, retry overhead, and operational metrics.

## Security and isolation model

Codex S1 uses an in-process V8 `vm` context with host constructors such as `Buffer`, `process`, and `URL` stripped from the verifier context. Dynamic string and WebAssembly code generation is disabled, timer handles are tracked and cleared, and unhandled promise or timer failures fail verification.

- **Primary goal:** Sub-second contract verification, type regression detection, and safe atomic promotion without triggering OS process-spawning restrictions such as `spawn EPERM`.
- **Isolation scope:** Designed for local developer workflows where the operator controls the prompts, local model, and workspace.
- **Threat model:** The verifier is a runtime contract checker and regression guard, not a cryptographic jail for hostile third-party code.
- **Stronger isolation:** Untrusted third-party prompts or code should run in a dedicated process, container, or other OS-level sandbox with restricted filesystem and network permissions.

The staging directory is cleaned after each delegation. The savings ledger records accepted output separately from failed or corrective worker attempts so operational reports remain auditable.

## Development

```powershell
npm install
npm run build
npm test
```

The build emits compiled runtime files under `dist/`. Runtime artifacts, staging data, local ledgers, logs, and npm pack tarballs are excluded by `.gitignore`.

## License

See `LICENSE` when distributed with the package.

