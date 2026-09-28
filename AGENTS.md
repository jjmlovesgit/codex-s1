# Agent Delegation Rules

## Primary Delegation Directive
- Use the `delegate_worker` MCP tool whenever creating new files, scaffolding modules, implementing pure utility functions, or writing unit tests.
- Formulate a precise interface contract, expected inputs and outputs, and required test assertions before delegation.
- Read `.precog/worker.md` and include its project rules in the worker task.

## Negative Boundaries (When NOT to Delegate)
- Do not use `delegate_worker` for single-line tweaks or edits to existing multi-thousand-line files; use native editing tools.
- Do not delegate architectural planning, system design, or git repository operations.

## Output Verbatim Enforcement
- Display the complete verification receipt, including timings, pass/fail status, and tokens shielded, verbatim in the response to the user.
