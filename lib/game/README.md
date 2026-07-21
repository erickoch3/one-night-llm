# One Night game domain

This directory is the deterministic, framework-independent game core. It does
not call an LLM, use browser APIs, read the clock, or generate randomness. A
server supplies a string seed, persists the returned `GameState`, and sends
clients only `getGameView(...)` projections.

## Main flow

```ts
import {
  applyNightAction,
  beginVoting,
  buildRecommendedDeck,
  castVote,
  chooseNextSpeaker,
  completeSpeechTurn,
  dealGame,
  submitSpeechIntent,
} from "@/lib/game";

const dealt = dealGame({
  gameId,
  seed,
  players,
  roles: buildRecommendedDeck(players.length),
});
if (!dealt.ok) throw new Error(dealt.error.message);
let state = dealt.value;

// Repeat getNightContext -> tool/UI choice -> applyNightAction until discussion.
// During discussion, submit intents and call chooseNextSpeaker to acquire the
// one global speech lock. completeSpeechTurn releases it.
// beginVoting then castVote automatically resolves when the last vote arrives.
```

Every mutating operation is actually a pure reducer. It returns
`Result<GameTransition>` with a new state and the events emitted by that one
transition. Rejected operations leave the input untouched.

## LLM and human adapters

- `getNightActionTool` and `parseNightActionToolInput` expose role-specific
  night choices as validated tool calls.
- `getSpeechIntentTool` has flat `selfDesire` plus one `hear__<playerId>`
  argument per other player. `parseSpeechIntentToolInput` validates all fields.
- `createHumanSpeechIntent` maps typing to `selfDesire = 10` and avatar hover to
  a hear preference.
- `getVoteTool` exposes legal vote targets.

Speech arbitration weights self-interest and audience interest, adds a bounded
waiting bonus, penalizes immediate repeats, and uses rotated seat order only to
break exact ties. `chooseNextSpeaker` refuses to run while a speaker owns the
lock, so simultaneous speech is impossible at the domain layer.

## Privacy and persistence

`GameState` contains all cards and server-only events. It must not be returned
directly to clients. `getGameView` removes account/model/agent-profile metadata,
filters events by visibility, and keeps cards hidden until resolution. All
state, event, view, action, and result types are plain JSON data.

## Self-test

`game.test.ts` covers deterministic dealing, every night-action path reachable
from a shuffled game, speech locking, voting, Hunter chaining, Tanner rules,
redaction, and JSON round trips. It uses only Node's built-in test runner.
