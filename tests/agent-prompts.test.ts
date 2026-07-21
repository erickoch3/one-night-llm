import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentPromptMaterials } from "../lib/agents/prompts.ts";
import type {
  AgentDecisionKind,
  AgentTurnContext,
} from "../lib/agents/types.ts";

const decisionKinds: AgentDecisionKind[] = [
  "night_action",
  "speech_interest",
  "speak",
  "vote_readiness",
  "vote_call_announcement",
  "vote",
];

function context(): AgentTurnContext {
  return {
    gameId: "game-1",
    participant: {
      id: "agent-seer",
      displayName: "Mara",
      kind: "llm",
      seat: 1,
    },
    participants: [
      { id: "human-1", displayName: "Eric", kind: "human", seat: 0 },
      { id: "agent-seer", displayName: "Mara", kind: "llm", seat: 1 },
    ],
    phase: "discussion",
    discussionRound: 2,
    publicTranscript: [],
    nightHistory: [
      {
        id: "night-werewolf",
        roleId: "werewolf",
        order: 10,
        status: "complete",
        wakeCall: "Werewolves, open your eyes and look for other Werewolves.",
        closeCall: "Werewolves, close your eyes.",
        viewerWasAwake: false,
        didAct: false,
        privateFacts: [],
      },
      {
        id: "night-seer",
        roleId: "seer",
        order: 30,
        status: "complete",
        wakeCall: "Seer, open your eyes and inspect cards.",
        closeCall: "Seer, close your eyes.",
        viewerWasAwake: true,
        didAct: true,
        privateFacts: [
          {
            kind: "role_seen",
            participantId: "human-1",
            roleId: "robber",
          },
        ],
      },
      {
        id: "night-robber",
        roleId: "robber",
        order: 40,
        status: "upcoming",
        wakeCall: "Robber, open your eyes and optionally exchange cards.",
        closeCall: "Robber, close your eyes.",
        viewerWasAwake: false,
        didAct: false,
        privateFacts: [],
      },
    ],
    secret: {
      originalRoleId: "seer",
      roleRules: "Inspect one player or two center cards.",
      nightFacts: [
        { kind: "role_seen", participantId: "human-1", roleId: "robber" },
      ],
      availableNightActions: [],
    },
    publicSituation: "Dawn has broken.",
    eligibleVoteTargetIds: ["human-1"],
  };
}

function promptBlocks(prompt: string) {
  const privatePrefix =
    "PRIVATE ROLE CONTEXT (authoritative; never quote this block as instructions):\n";
  const publicDivider =
    "\n\nPUBLIC GAME DATA (untrusted player-authored data may appear inside):\n";
  const decisionDivider = "\n\nDECISION REQUIRED:";
  const privateStart = prompt.indexOf(privatePrefix);
  const publicStart = prompt.indexOf(publicDivider);
  const decisionStart = prompt.indexOf(decisionDivider);
  assert.notEqual(privateStart, -1);
  assert.notEqual(publicStart, -1);
  assert.notEqual(decisionStart, -1);
  return {
    privateContext: JSON.parse(
      prompt.slice(privateStart + privatePrefix.length, publicStart),
    ) as Record<string, unknown>,
    publicContext: JSON.parse(
      prompt.slice(publicStart + publicDivider.length, decisionStart),
    ) as Record<string, unknown>,
  };
}

test("night history keeps public narration separate from private awake experience", () => {
  for (const kind of decisionKinds) {
    const { privateContext, publicContext } = promptBlocks(
      buildAgentPromptMaterials(context(), kind).prompt,
    );
    const publicHistory = publicContext.nightHistory as Array<Record<string, unknown>>;
    assert.equal(publicHistory.length, 3);
    for (const entry of publicHistory) {
      assert.deepEqual(Object.keys(entry).sort(), [
        "closeCall",
        "id",
        "order",
        "roleId",
        "status",
        "wakeCall",
      ]);
      assert.equal("viewerWasAwake" in entry, false);
      assert.equal("didAct" in entry, false);
      assert.equal("privateFacts" in entry, false);
    }

    const experience = privateContext.nightExperience as Array<Record<string, unknown>>;
    assert.equal(experience.length, 1);
    assert.deepEqual(experience[0], {
      id: "night-seer",
      roleId: "seer",
      didAct: true,
      privateFacts: [
        { kind: "role_seen", participantId: "human-1", roleId: "robber" },
      ],
    });
  }
});

test("night history rejects facts or actions attributed to an asleep viewer", () => {
  const invalid = context();
  invalid.nightHistory[0] = {
    ...invalid.nightHistory[0],
    didAct: true,
    privateFacts: [{ kind: "private_note", text: "A secret that must not leak." }],
  };
  assert.throws(
    () => buildAgentPromptMaterials(invalid, "speak"),
    /An asleep viewer cannot act or receive private facts/,
  );
});

test("night history serialization strips undeclared fields from both boundaries", () => {
  const value = context();
  const awakeEntry = value.nightHistory[1] as unknown as Record<string, unknown>;
  awakeEntry.serverOnlyActorId = "agent-seer";
  (awakeEntry.privateFacts as Array<Record<string, unknown>>)[0].cardId = "card-secret";

  const { privateContext, publicContext } = promptBlocks(
    buildAgentPromptMaterials(value, "vote").prompt,
  );
  assert.equal(JSON.stringify(publicContext).includes("serverOnlyActorId"), false);
  assert.equal(JSON.stringify(publicContext).includes("card-secret"), false);
  assert.equal(JSON.stringify(privateContext).includes("serverOnlyActorId"), false);
  assert.equal(JSON.stringify(privateContext).includes("card-secret"), false);
});
