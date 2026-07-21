import assert from "node:assert/strict";
import test from "node:test";

import {
  applyNightAction,
  completeNightCeremonyStep,
  getNightContext,
  parseNightActionToolInput,
} from "./night.js";
import { buildRecommendedDeck } from "./roles.js";
import { createAgentPlayer, createHumanPlayer, dealGame } from "./setup.js";
import {
  chooseNextSpeaker,
  completeSpeechTurn,
  createHumanSpeechIntent,
  hearFromToolField,
  parseSpeechIntentToolInput,
  resolveNextSpeaker,
  submitSpeechIntent,
} from "./speech.js";
import type { GameState, NightAction, Player } from "./types.js";
import { getGameView, getPlayerNightHistory } from "./view.js";
import { beginVoting, castVote, resolveVotes } from "./voting.js";

const players: readonly Player[] = [
  createHumanPlayer({
    id: "human",
    name: "Human",
    seat: 0,
    userId: "secret-user-id",
  }),
  createAgentPlayer({
    id: "ada",
    name: "Ada",
    seat: 1,
    model: "secret-model-a",
  }),
  createAgentPlayer({
    id: "bert",
    name: "Bert",
    seat: 2,
    model: "secret-model-b",
  }),
  createAgentPlayer({
    id: "cleo",
    name: "Cleo",
    seat: 3,
    model: "secret-model-c",
  }),
];

test("a complete deterministic game survives a JSON round trip", () => {
  const setup = {
    gameId: "self-test",
    seed: "repeatable-seed",
    players,
    roles: buildRecommendedDeck(players.length),
  } as const;
  const firstDeal = dealGame(setup);
  const secondDeal = dealGame(setup);
  assert.equal(firstDeal.ok, true);
  assert.equal(secondDeal.ok, true);
  if (!firstDeal.ok || !secondDeal.ok) return;
  assert.deepEqual(firstDeal.value.initialCards, secondDeal.value.initialCards);

  let state: GameState = firstDeal.value;
  while (state.phase === "night") {
    const context = getNightContext(state);
    const transition = context
      ? applyNightAction(state, legalActionFor(context))
      : completeNightCeremonyStep(state);
    assert.equal(transition.ok, true);
    if (!transition.ok) return;
    state = transition.value.state;
  }
  assert.equal(state.phase, "discussion");

  for (const player of players) {
    const intentResult =
      player.kind === "human"
        ? createHumanSpeechIntent(players, player.id, state.discussion.turnNumber, {
            isTyping: true,
            hoveredPlayerId: "ada",
          })
        : parseSpeechIntentToolInput(
            players,
            player.id,
            state.discussion.turnNumber,
            Object.fromEntries([
              ["selfDesire", player.id === "ada" ? 9 : 3],
              ...players
                .filter((other) => other.id !== player.id)
                .map((other) => [hearFromToolField(other.id), other.id === "ada" ? 8 : 1]),
            ]),
          );
    assert.equal(intentResult.ok, true);
    if (!intentResult.ok) return;
    const submission = submitSpeechIntent(state, intentResult.value);
    assert.equal(submission.ok, true);
    if (!submission.ok) return;
    state = submission.value.state;
  }

  const speaker = chooseNextSpeaker(state);
  assert.equal(speaker.ok, true);
  if (!speaker.ok) return;
  state = speaker.value.state;
  assert.ok(state.discussion.activeSpeakerId);
  const completed = completeSpeechTurn(
    state,
    state.discussion.activeSpeakerId,
    "I have a theory.",
  );
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  state = completed.value.state;

  const voting = beginVoting(state);
  assert.equal(voting.ok, true);
  if (!voting.ok) return;
  state = voting.value.state;
  for (let index = 0; index < players.length; index += 1) {
    const vote = castVote(
      state,
      players[index].id,
      players[(index + 1) % players.length].id,
    );
    assert.equal(vote.ok, true);
    if (!vote.ok) return;
    state = vote.value.state;
  }
  assert.equal(state.phase, "resolved");
  assert.deepEqual(state.resolution?.eliminatedPlayerIds, []);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);

  const view = getGameView(state, "human");
  assert.equal(view.ok, true);
  if (!view.ok) return;
  const serializedView = JSON.stringify(view.value);
  assert.equal(serializedView.includes("secret-user-id"), false);
  assert.equal(serializedView.includes("secret-model"), false);
});

test("all seven wake roles validate and resolve in official night order", () => {
  const largeTable: Player[] = [
    createHumanPlayer({ id: "p0", name: "P0", seat: 0, userId: "user-0" }),
    ...Array.from({ length: 6 }, (_, index) =>
      createAgentPlayer({
        id: `p${index + 1}`,
        name: `P${index + 1}`,
        seat: index + 1,
        model: "test-model",
      }),
    ),
  ];
  const allWakeRoles = [
    "werewolf",
    "minion",
    "seer",
    "robber",
    "troublemaker",
    "drunk",
    "insomniac",
  ] as const;
  const roles = [...allWakeRoles, "villager", "hunter", "tanner"] as const;

  let state: GameState | undefined;
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const deal = dealGame({
      gameId: "all-night-actions",
      seed: `seed-${attempt}`,
      players: largeTable,
      roles,
    });
    assert.equal(deal.ok, true);
    if (deal.ok && deal.value.night.queue.length === allWakeRoles.length) {
      state = deal.value;
      break;
    }
  }
  assert.ok(state, "Expected to find a deterministic deal with all wake roles in play.");
  assert.deepEqual(
    state.night.ceremonySteps.map((step) => step.role),
    allWakeRoles,
  );
  const futureSeer = state.night.queue.find((turn) => turn.role === "seer");
  assert.ok(futureSeer);
  const futureSeerStep = getPlayerNightHistory(state, futureSeer.actorId).find(
    (step) => step.role === "seer",
  );
  assert.deepEqual(
    futureSeerStep && {
      status: futureSeerStep.status,
      viewerWasAwake: futureSeerStep.viewerWasAwake,
      didAct: futureSeerStep.didAct,
      privateKnowledge: futureSeerStep.privateKnowledge,
    },
    {
      status: "upcoming",
      viewerWasAwake: false,
      didAct: false,
      privateKnowledge: [],
    },
  );

  const seenRoles: string[] = [];
  while (state.phase === "night") {
    const context = getNightContext(state);
    if (!context) {
      const transition = completeNightCeremonyStep(state);
      assert.equal(transition.ok, true);
      if (!transition.ok) return;
      state = transition.value.state;
      continue;
    }
    seenRoles.push(context.role);
    const action = legalActionFor(context);
    const parsed = parseNightActionToolInput(state, context.actorId, toolInputFor(action));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const transition = applyNightAction(state, parsed.value);
    assert.equal(transition.ok, true);
    if (!transition.ok) return;
    state = transition.value.state;
    const personalStep = getPlayerNightHistory(state, context.actorId).find(
      (step) => step.role === context.role,
    );
    assert.equal(personalStep?.viewerWasAwake, true);
    assert.equal(personalStep?.didAct, true);
    assert.ok(
      personalStep && personalStep.privateKnowledge.length > 0,
      `${context.role} should retain its entitled observation or action memory.`,
    );
  }

  assert.deepEqual(seenRoles, allWakeRoles);
  assert.equal(state.phase, "discussion");
});

test("the public ceremony includes a wake role dealt only to the center", () => {
  const smallTable = players.slice(0, 3);
  const roles = [
    "seer",
    "villager",
    "villager",
    "villager",
    "villager",
    "villager",
  ] as const;
  let state: GameState | undefined;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const dealt = dealGame({
      gameId: "center-only-ceremony",
      seed: `center-${attempt}`,
      players: smallTable,
      roles,
    });
    assert.equal(dealt.ok, true);
    if (
      dealt.ok &&
      dealt.value.initialCards.center.some((card) => card.role === "seer")
    ) {
      state = dealt.value;
      break;
    }
  }
  assert.ok(state, "Expected to deal the sole Seer to the center.");
  assert.equal(state.phase, "night");
  assert.deepEqual(state.night.ceremonySteps, [
    { id: "night-seer", role: "seer", order: 30 },
  ]);
  assert.deepEqual(state.night.queue, []);
  assert.equal(getNightContext(state), null);
  assert.equal(
    state.events.filter((event) => event.type === "night.role-opened").length,
    1,
  );

  for (const player of smallTable) {
    assert.deepEqual(getPlayerNightHistory(state, player.id)[0], {
      id: "night-seer",
      role: "seer",
      order: 30,
      status: "active",
      wakeCall: "Seer, open your eyes and inspect the village or the center.",
      closeCall: "Seer, close your eyes.",
      viewerWasAwake: false,
      didAct: false,
      privateKnowledge: [],
    });
  }

  const completion = completeNightCeremonyStep(state);
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  assert.equal(completion.value.state.phase, "discussion");
  assert.deepEqual(
    completion.value.events.map((event) => event.type),
    ["night.role-closed", "night.completed"],
  );
});

test("duplicate Werewolves share one ceremony and only awake viewers receive pack knowledge", () => {
  const smallTable = players.slice(0, 3);
  const roles = [
    "werewolf",
    "werewolf",
    "villager",
    "villager",
    "villager",
    "villager",
  ] as const;
  let state: GameState | undefined;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const dealt = dealGame({
      gameId: "grouped-werewolves",
      seed: `wolves-${attempt}`,
      players: smallTable,
      roles,
    });
    assert.equal(dealt.ok, true);
    if (dealt.ok && dealt.value.night.queue.length === 2) {
      state = dealt.value;
      break;
    }
  }
  assert.ok(state, "Expected both Werewolves to be dealt to players.");
  assert.deepEqual(state.night.ceremonySteps, [
    { id: "night-werewolf", role: "werewolf", order: 10 },
  ]);
  assert.deepEqual(Object.keys(state.night.ceremonySteps[0]).sort(), [
    "id",
    "order",
    "role",
  ]);

  const [firstWolf, secondWolf] = state.night.queue.map((turn) => turn.actorId);
  const sleepingPlayer = smallTable.find(
    (player) => ![firstWolf, secondWolf].includes(player.id),
  );
  assert.ok(sleepingPlayer);
  const firstHistory = getPlayerNightHistory(state, firstWolf)[0];
  assert.equal(firstHistory.viewerWasAwake, true);
  assert.equal(firstHistory.didAct, false);
  assert.deepEqual(firstHistory.privateKnowledge, [
    {
      type: "werewolf-allies",
      playerIds: [secondWolf],
      isLoneWerewolf: false,
    },
  ]);
  const sleepingHistory = getPlayerNightHistory(state, sleepingPlayer.id)[0];
  assert.equal(sleepingHistory.viewerWasAwake, false);
  assert.deepEqual(sleepingHistory.privateKnowledge, []);

  const premature = completeNightCeremonyStep(state);
  assert.equal(premature.ok, false);
  if (!premature.ok) assert.equal(premature.error.code, "INCOMPLETE_NIGHT_STEP");

  const firstAction = applyNightAction(state, {
    type: "werewolf",
    actorId: firstWolf,
  });
  assert.equal(firstAction.ok, true);
  if (!firstAction.ok) return;
  state = firstAction.value.state;
  assert.equal(getPlayerNightHistory(state, firstWolf)[0].didAct, true);
  const sleepingView = getGameView(state, sleepingPlayer.id);
  assert.equal(sleepingView.ok, true);
  if (!sleepingView.ok) return;
  assert.deepEqual(sleepingView.value.nightHistory[0].privateKnowledge, []);
  assert.equal(
    sleepingView.value.events.some((event) => event.type === "night.action-completed"),
    false,
  );
  assert.equal(completeNightCeremonyStep(state).ok, false);

  const secondAction = applyNightAction(state, {
    type: "werewolf",
    actorId: secondWolf,
  });
  assert.equal(secondAction.ok, true);
  if (!secondAction.ok) return;
  state = secondAction.value.state;
  const completion = completeNightCeremonyStep(state);
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  assert.equal(completion.value.state.phase, "discussion");
  assert.equal(
    completion.value.state.events.filter((event) => event.type === "night.role-opened")
      .length,
    1,
  );
  assert.equal(
    completion.value.state.events.filter((event) => event.type === "night.role-closed")
      .length,
    1,
  );
});

test("an eliminated Hunter recursively takes their target", () => {
  const cards = {
    human: { role: "hunter" as const },
    ada: { role: "werewolf" as const },
    bert: { role: "villager" as const },
    cleo: { role: "villager" as const },
  };
  const resolution = resolveVotes(players, cards, {
    human: "ada",
    ada: "human",
    bert: "human",
    cleo: "bert",
  });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.deepEqual(resolution.value.initiallyEliminatedPlayerIds, ["human"]);
  assert.deepEqual(resolution.value.eliminatedPlayerIds, ["human", "ada"]);
  assert.deepEqual(resolution.value.winningTeams, ["village"]);
});

test("a killed Tanner suppresses an otherwise surviving Werewolf win", () => {
  const cards = {
    human: { role: "tanner" as const },
    ada: { role: "werewolf" as const },
    bert: { role: "villager" as const },
    cleo: { role: "villager" as const },
  };
  const resolution = resolveVotes(players, cards, {
    human: "ada",
    ada: "human",
    bert: "human",
    cleo: "bert",
  });
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.deepEqual(resolution.value.winningTeams, ["tanner"]);
  assert.deepEqual(resolution.value.winnerPlayerIds, ["human"]);
});

test("typing gives the human desire 10 and clears every hear desire", () => {
  const intent = createHumanSpeechIntent(players, "human", 4, {
    isTyping: true,
    hoveredPlayerId: "ada",
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) return;
  assert.equal(intent.value.selfDesire, 10);
  assert.deepEqual(intent.value.hearFrom, { ada: 0, bert: 0, cleo: 0 });
});

test("prototype-named player ids can cast their first vote", () => {
  const unusualPlayers: readonly Player[] = [
    createHumanPlayer({
      id: "toString",
      name: "Prototype",
      seat: 0,
      userId: "prototype-user",
    }),
    createAgentPlayer({ id: "alpha", name: "Alpha", seat: 1, model: "test" }),
    createAgentPlayer({ id: "beta", name: "Beta", seat: 2, model: "test" }),
  ];
  const dealt = dealGame({
    gameId: "prototype-id",
    seed: "prototype-id-seed",
    players: unusualPlayers,
    roles: [
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
      "villager",
    ],
  });
  assert.equal(dealt.ok, true);
  if (!dealt.ok) return;
  const voting = beginVoting(dealt.value);
  assert.equal(voting.ok, true);
  if (!voting.ok) return;
  const vote = castVote(voting.value.state, "toString", "alpha");
  assert.equal(vote.ok, true);

  const speaker = resolveNextSpeaker(
    unusualPlayers,
    {
      alpha: {
        playerId: "alpha",
        selfDesire: 8,
        hearFrom: { toString: 0, beta: 0 },
        source: "agent-tool",
        turnNumber: 0,
      },
    },
    [],
    0,
  );
  assert.equal(speaker?.playerId, "alpha");
});

function legalActionFor(context: NonNullable<ReturnType<typeof getNightContext>>): NightAction {
  switch (context.role) {
    case "werewolf":
      return {
        type: "werewolf",
        actorId: context.actorId,
        ...((context.knownWerewolfPlayerIds?.length ?? 0) === 0
          ? { centerIndex: 0 as const }
          : {}),
      };
    case "minion":
      return { type: "minion", actorId: context.actorId };
    case "seer":
      return {
        type: "seer",
        actorId: context.actorId,
        choice: { kind: "center", indices: [0, 1] },
      };
    case "robber":
      return {
        type: "robber",
        actorId: context.actorId,
        targetId: context.otherPlayerIds[0],
      };
    case "troublemaker":
      return {
        type: "troublemaker",
        actorId: context.actorId,
        targetIds: [context.otherPlayerIds[0], context.otherPlayerIds[1]],
      };
    case "drunk":
      return { type: "drunk", actorId: context.actorId, centerIndex: 0 };
    case "insomniac":
      return { type: "insomniac", actorId: context.actorId };
  }
  throw new Error("Unsupported night role.");
}

function toolInputFor(action: NightAction): Record<string, unknown> {
  switch (action.type) {
    case "werewolf":
      return action.centerIndex === undefined ? {} : { centerIndex: action.centerIndex };
    case "minion":
    case "insomniac":
      return {};
    case "seer":
      return action.choice.kind === "player"
        ? { mode: "player", playerId: action.choice.playerId }
        : { mode: "center", centerIndices: action.choice.indices };
    case "robber":
      return { targetId: action.targetId };
    case "troublemaker":
      return { targetIds: action.targetIds };
    case "drunk":
      return { centerIndex: action.centerIndex };
  }
}
