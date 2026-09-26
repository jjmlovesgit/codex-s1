# Changelog

## Unreleased

- fix(release): whitelist dist directory in package.json files array to ensure binaries are packaged (v0.1.2)
- fix(release): build dist automatically before npm pack and publish

- chore: migrate package identity and binary from codex-s1 to s1-precog
- fix(parser): harden worker emission parser to support 3-5 angle brackets, CRLF, and whitespace drift from local models
