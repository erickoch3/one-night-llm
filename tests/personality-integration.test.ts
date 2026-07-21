import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PERSONALITY_PROFILES,
  agentVoiceProfile,
} from "../lib/agents/personalities.ts";
import {
  createGameRoom,
  getGameRoom,
  removeGameRoom,
} from "../server/game-service.ts";

test("a room keeps one unique random personality assignment for the match", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000099";
  const created = await createGameRoom(sessionId, {
    playerName: "Tester",
    agentCount: 6,
    mode: "rehearsal",
    rolePack: "classic",
    agentModel: "gpt-5.6-luna",
    agentReasoningEffort: "medium",
  });

  const agents = created.players.filter((player) => player.kind === "agent");
  assert.equal(agents.length, 6);
  assert.equal(new Set(agents.map((player) => player.name)).size, agents.length);
  assert.equal(new Set(agents.map((player) => player.persona)).size, agents.length);
  assert.equal(agents.every((player) => Boolean(player.persona?.trim())), true);
  const serializedSnapshot = JSON.stringify(created);
  assert.equal(serializedSnapshot.includes("VOICE PROFILE"), false);
  for (const profile of AGENT_PERSONALITY_PROFILES) {
    assert.equal(serializedSnapshot.includes(profile.backstory), false);
    assert.equal(serializedSnapshot.includes(agentVoiceProfile(profile)), false);
  }

  const later = getGameRoom(created.gameId, sessionId);
  assert.deepEqual(
    later.players.map(({ id, name, persona }) => ({ id, name, persona })),
    created.players.map(({ id, name, persona }) => ({ id, name, persona })),
  );

  removeGameRoom(created.gameId, sessionId);
});
