## Autonomous Delegation Protocol

- For all code authoring, file modifications, and test suite execution, do not write raw file contents directly into the chat or use fallback file-writing tools.
- Formulate the interface contract, target paths, and acceptance tests, then immediately invoke `delegate_worker`.
- Once the worker completes, inspect the returned JSON receipt and summarize the validation status and token ledger impact.
