import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_TOOL_NAMES,
  createVoteReadinessToolRegistry,
} from "../lib/agents/tools.ts";

test("vote readiness is a private boolean-only agent decision", () => {
  const registry = createVoteReadinessToolRegistry();
  const definitions = registry.definitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, AGENT_TOOL_NAMES.voteReadiness);
  assert.deepEqual(definitions[0].inputSchema.properties?.readyToVote, {
    type: "boolean",
    description:
      "True only when another discussion round is unlikely to materially improve the table's decision; otherwise false.",
  });

  assert.deepEqual(
    registry.parse({
      id: "readiness-yes",
      name: AGENT_TOOL_NAMES.voteReadiness,
      arguments: { readyToVote: true },
    }),
    { type: "vote_readiness", readyToVote: true },
  );

  const invalid = registry.safeParse({
    id: "readiness-invalid",
    name: AGENT_TOOL_NAMES.voteReadiness,
    arguments: { readyToVote: "yes" },
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, "invalid_arguments");
    assert.equal(invalid.error.path, "readyToVote");
  }
});
