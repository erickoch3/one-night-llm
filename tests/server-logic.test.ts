import assert from "node:assert/strict";
import test from "node:test";

import type { HumanNightActionRequest } from "../lib/shared/protocol.ts";
import {
  advanceDialogue,
  advanceNightCeremony,
  createGameRoom,
  getGameRoom,
  removeGameRoom,
  startVoting,
  submitHumanNightAction,
  submitHumanSpeech,
  submitHumanVote,
} from "../server/game-service.ts";

test("an OpenAI room keeps its API key out of the public game snapshot", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000003";
  const apiKey = "test-secret-openai-api-key";
  const view = await createGameRoom(sessionId, {
    playerName: "Keyholder",
    agentCount: 2,
    mode: "openai",
    rolePack: "classic",
    agentModel: "gpt-5.6-luna",
    agentReasoningEffort: "medium",
    openaiApiKey: apiKey,
  });

  assert.equal(view.mode, "openai");
  assert.equal(JSON.stringify(view).includes(apiKey), false);

  removeGameRoom(view.gameId, sessionId);
});

test("a rehearsal room preserves secrets and completes the full game loop", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000001";
  let view = await createGameRoom(sessionId, {
    playerName: "Tester",
    agentCount: 3,
    mode: "rehearsal",
    rolePack: "classic",
    agentModel: "gpt-5.6-luna",
    agentReasoningEffort: "medium",
  });

  assert.equal(view.players.length, 4);
  assert.equal(view.centerCards.every((card) => card.role === null), true);
  assert.equal(view.resolution, null);
  assert.throws(() => getGameRoom(view.gameId, "another-session"), /no longer exists/i);

  assert.ok(view.nightHistory.length > 0);
  assert.deepEqual(
    view.nightHistory.map((entry) => entry.order),
    [...view.nightHistory.map((entry) => entry.order)].sort((left, right) => left - right),
  );
  assert.equal(new Set(view.nightHistory.map((entry) => entry.role)).size, view.nightHistory.length);

  let nightSafety = 0;
  while (view.phase === "night" && nightSafety < 12) {
    nightSafety += 1;
    const active = view.nightHistory.filter((entry) => entry.status === "active");
    assert.equal(active.length, 1, "Exactly one public role call is active.");
    if (view.nightPrompt) {
      assert.equal(active[0].role, view.nightPrompt.role);
      assert.equal(active[0].viewerWasAwake, true);
      view = await submitHumanNightAction(
        view.gameId,
        sessionId,
        legalHumanNightAction(view),
      );
    } else {
      assert.equal(view.mayAdvanceNight, true);
      view = await advanceNightCeremony(view.gameId, sessionId);
    }
  }
  assert.ok(nightSafety < 12, "The staged night ceremony must reach dawn.");
  assert.equal(view.phase, "discussion");
  assert.equal(view.mayAdvanceNight, false);
  assert.equal(view.nightHistory.every((entry) => entry.status === "complete"), true);

  let safety = 0;
  while (view.phase === "discussion" && view.dialogue.turnNumber < 3 && safety < 12) {
    safety += 1;
    view = view.dialogue.humanMaySpeak
      ? await submitHumanSpeech(view.gameId, sessionId, "I want one concrete night claim.")
      : await advanceDialogue(view.gameId, sessionId, {
          humanWantsToSpeak: false,
          hoverTargetId: null,
        });
  }
  assert.ok(view.dialogue.turnNumber >= 3);

  if (view.phase === "discussion") {
    view = await startVoting(view.gameId, sessionId);
  }
  assert.equal(view.phase, "voting");
  const voteAnnouncement = [...view.dialogue.transcript]
    .reverse()
    .find((entry) => entry.kind === "speech");
  assert.ok(voteAnnouncement);
  assert.match(voteAnnouncement.text, /vote|voting|ballot/i);
  assert.equal(
    view.dialogue.transcript.at(-1)?.text,
    "The vote has been called. Voting begins.",
  );
  const target = view.players.find((player) => !player.isYou)!;
  view = await submitHumanVote(view.gameId, sessionId, target.id);
  assert.equal(view.phase, "resolved");
  assert.ok(view.resolution);
  assert.equal(view.centerCards.every((card) => card.role !== null), true);
  assert.equal(Object.keys(view.resolution!.votes).length, view.players.length);
  assert.equal(Object.keys(view.resolution!.rolesAtEnd).length, view.players.length);

  removeGameRoom(view.gameId, sessionId);
});

test("rehearsal agents periodically agree to vote and announce it in chat", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000002";
  let view = await createGameRoom(sessionId, {
    playerName: "Listener",
    agentCount: 3,
    mode: "rehearsal",
    rolePack: "classic",
    agentModel: "gpt-5.6-luna",
    agentReasoningEffort: "medium",
  });

  let nightSafety = 0;
  while (view.phase === "night" && nightSafety < 12) {
    nightSafety += 1;
    view = view.nightPrompt
      ? await submitHumanNightAction(
          view.gameId,
          sessionId,
          legalHumanNightAction(view),
        )
      : await advanceNightCeremony(view.gameId, sessionId);
  }
  assert.equal(view.phase, "discussion");

  let discussionSafety = 0;
  while (view.phase === "discussion" && discussionSafety < 32) {
    discussionSafety += 1;
    view = view.dialogue.humanMaySpeak
      ? await submitHumanSpeech(
          view.gameId,
          sessionId,
          "I still want to hear where the claims point.",
        )
      : await advanceDialogue(view.gameId, sessionId, {
          humanWantsToSpeak: false,
          hoverTargetId: null,
        });
  }

  assert.ok(discussionSafety < 32, "Agent readiness should eventually end rehearsal discussion.");
  assert.equal(view.phase, "voting");
  assert.equal("turnLimit" in view.dialogue, false);
  const publicMessages = view.dialogue.transcript.slice(-2);
  assert.equal(publicMessages[0].kind, "speech");
  assert.match(publicMessages[0].text, /vote|voting|ballot/i);
  assert.equal(
    publicMessages[1].text,
    "The village agrees: discussion is over, and voting begins.",
  );

  removeGameRoom(view.gameId, sessionId);
});

function legalHumanNightAction(
  view: Awaited<ReturnType<typeof createGameRoom>>,
): HumanNightActionRequest {
  const prompt = view.nightPrompt!;
  switch (prompt.role) {
    case "werewolf":
      return prompt.knownWerewolfPlayerIds?.length
        ? { type: "werewolf" }
        : { type: "werewolf", centerIndex: 0 };
    case "minion":
      return { type: "minion" };
    case "seer":
      return { type: "seer", choice: { kind: "center", indices: [0, 1] } };
    case "robber":
      return { type: "robber", targetId: prompt.otherPlayerIds[0] };
    case "troublemaker":
      return {
        type: "troublemaker",
        targetIds: [prompt.otherPlayerIds[0], prompt.otherPlayerIds[1]],
      };
    case "drunk":
      return { type: "drunk", centerIndex: 0 };
    case "insomniac":
      return { type: "insomniac" };
  }
}
