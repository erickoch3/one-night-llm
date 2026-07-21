# Contributing to One Night LLM

Thanks for helping improve the game. Small, focused changes with tests are the
easiest to review and merge.

## Development setup

You need macOS, Node.js 22.13 or newer, and npm.

```bash
git clone https://github.com/erickoch3/one-night-llm.git
cd one-night-llm
npm ci
npm run dev
```

Choose **Rehearsal agents** for a deterministic local game that requires no
account or model runtime.

## Before opening a pull request

1. Create a branch from the latest `main`.
2. Keep unrelated changes out of the same pull request.
3. Add or update tests for behavior changes.
4. Run the project checks:

   ```bash
   npm run lint
   npm test
   ```

5. Explain the player or developer impact in the pull request description.

Pull requests need one approving review before merge. Maintainers may use the
documented repository bypass for exceptional cases.

## Project boundaries

- The deterministic engine in `lib/game` remains authoritative for rules and
  secret state.
- Agent text alone must never mutate game state; changes flow through validated
  phase-specific tools.
- Browser snapshots and prompts must not reveal another participant's private
  role knowledge.
- The stateful service is loopback-only. Do not present it as a hardened public
  multiplayer server without adding authentication and abuse controls.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
privately as described in [SECURITY.md](SECURITY.md).
