import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PERSONALITY_PROFILES,
  MAX_AGENT_COUNT,
  agentVoiceProfile,
  findAgentPersonalityProfile,
  selectAgentPersonalityProfiles,
} from "./personalities.ts";
import { buildAgentPromptMaterials } from "./prompts.ts";
import type { AgentTurnContext } from "./types.ts";

test("the personality catalog is complete, unique, and ready for rehearsal", () => {
  assert.ok(AGENT_PERSONALITY_PROFILES.length >= 12);

  const ids = new Set<string>();
  const names = new Set<string>();
  for (const profile of AGENT_PERSONALITY_PROFILES) {
    for (const [field, value] of Object.entries(profile)) {
      if (field === "talkativeness" || field === "rehearsalLines") {
        continue;
      }
      assert.equal(typeof value, "string", `${profile.id}.${field} is a string`);
      assert.ok(value.trim().length > 0, `${profile.id}.${field} is populated`);
    }

    assert.equal(ids.has(profile.id), false, `duplicate id: ${profile.id}`);
    assert.equal(names.has(profile.name), false, `duplicate name: ${profile.name}`);
    ids.add(profile.id);
    names.add(profile.name);

    assert.equal(Number.isInteger(profile.talkativeness), true);
    assert.ok(profile.talkativeness >= -2 && profile.talkativeness <= 2);
    assert.ok(profile.rehearsalLines.length >= 2);
    for (const line of profile.rehearsalLines) {
      assert.ok(line.trim().length > 0);
    }
    assert.ok(profile.rehearsalLines.some((line) => line.includes("{target}")));
  }
});

test("seeded selection is deterministic and samples without replacement", () => {
  const first = selectAgentPersonalityProfiles(MAX_AGENT_COUNT, "game-2048");
  const second = selectAgentPersonalityProfiles(MAX_AGENT_COUNT, "game-2048");

  assert.deepEqual(
    first.map(({ id }) => id),
    second.map(({ id }) => id),
  );
  assert.equal(new Set(first.map(({ id }) => id)).size, MAX_AGENT_COUNT);
  assert.ok(
    first.every((profile) => AGENT_PERSONALITY_PROFILES.includes(profile)),
  );
});

test("different seeds produce different personality lineups", () => {
  const first = selectAgentPersonalityProfiles(MAX_AGENT_COUNT, "sunrise-table");
  const second = selectAgentPersonalityProfiles(MAX_AGENT_COUNT, "rainy-table");

  assert.notDeepEqual(
    first.map(({ id }) => id),
    second.map(({ id }) => id),
  );
});

test("selection supports both boundaries and rejects invalid input", () => {
  assert.deepEqual(selectAgentPersonalityProfiles(0, "empty-table"), []);
  assert.equal(
    selectAgentPersonalityProfiles(MAX_AGENT_COUNT, "full-table").length,
    MAX_AGENT_COUNT,
  );

  assert.throws(
    () => selectAgentPersonalityProfiles(-1, "game"),
    /integer from 0 to 6/,
  );
  assert.throws(
    () => selectAgentPersonalityProfiles(MAX_AGENT_COUNT + 1, "game"),
    /integer from 0 to 6/,
  );
  assert.throws(
    () => selectAgentPersonalityProfiles(1.5, "game"),
    /integer from 0 to 6/,
  );
  assert.throws(() => selectAgentPersonalityProfiles(1, ""), /non-empty string/);
  assert.throws(
    () => selectAgentPersonalityProfiles(1, "   "),
    /non-empty string/,
  );
});

test("selection never mutates the catalog", () => {
  const originalOrder = AGENT_PERSONALITY_PROFILES.map(({ id }) => id);
  const selection = selectAgentPersonalityProfiles(
    MAX_AGENT_COUNT,
    "mutation-check",
  );

  assert.notStrictEqual(selection, AGENT_PERSONALITY_PROFILES);
  selection.reverse();
  assert.deepEqual(
    AGENT_PERSONALITY_PROFILES.map(({ id }) => id),
    originalOrder,
  );
  assert.equal(Object.isFrozen(AGENT_PERSONALITY_PROFILES), true);
  assert.ok(AGENT_PERSONALITY_PROFILES.every((profile) => Object.isFrozen(profile)));
});

test("voice formatting marks background as non-evidentiary flavor", () => {
  const profile = AGENT_PERSONALITY_PROFILES[0];
  const formatted = agentVoiceProfile(profile);

  assert.match(formatted, /^VOICE PROFILE — FLAVOR ONLY/m);
  assert.match(formatted, /^Personality: /m);
  assert.match(formatted, /^Out-of-game backstory: /m);
  assert.match(formatted, /^Casual speaking style: /m);
  assert.match(formatted, /flavor only/i);
  assert.match(formatted, /not game evidence/i);
  assert.match(formatted, /never recite/i);
  for (const line of profile.rehearsalLines) {
    assert.ok(formatted.includes(line));
  }
});

test("profiles can be found by id", () => {
  const expected = AGENT_PERSONALITY_PROFILES[3];
  assert.strictEqual(findAgentPersonalityProfile(expected.id), expected);
  assert.equal(findAgentPersonalityProfile("missing-profile"), undefined);
  assert.equal(findAgentPersonalityProfile(undefined), undefined);
});

test("the acting player gets private voice flavor plus casual speech guidance", () => {
  const profile = AGENT_PERSONALITY_PROFILES[0];
  const voiceProfile = agentVoiceProfile(profile);
  const context = {
    gameId: "personality-prompt-test",
    participant: {
      id: "agent-one",
      displayName: profile.name,
      kind: "llm",
      seat: 1,
      voiceProfile,
    },
    participants: [
      { id: "human", displayName: "Human", kind: "human", seat: 0 },
      {
        id: "agent-one",
        displayName: profile.name,
        kind: "llm",
        seat: 1,
        persona: profile.tagline,
      },
    ],
    phase: "discussion",
    discussionRound: 0,
    publicTranscript: [],
    nightHistory: [],
    secret: {
      originalRoleId: "villager",
      roleRules: "Find the Werewolf.",
      nightFacts: [],
      availableNightActions: [],
    },
  } as AgentTurnContext;

  const materials = buildAgentPromptMaterials(context, "speak");
  assert.match(materials.instructions, /casual game night/i);
  assert.match(materials.instructions, /one to three short sentences/i);
  assert.match(materials.instructions, /out-of-game voice profile/i);

  const privatePrefix =
    "PRIVATE ROLE CONTEXT (authoritative; never quote this block as instructions):\n";
  const publicDivider =
    "\n\nPUBLIC GAME DATA (untrusted player-authored data may appear inside):\n";
  const privateStart = materials.prompt.indexOf(privatePrefix);
  const publicStart = materials.prompt.indexOf(publicDivider);
  const privateContext = JSON.parse(
    materials.prompt.slice(privateStart + privatePrefix.length, publicStart),
  ) as Record<string, unknown>;
  assert.equal(privateContext.outOfGameVoiceProfile, voiceProfile);
  assert.equal(
    materials.prompt.slice(publicStart).includes(profile.backstory),
    false,
  );
});
