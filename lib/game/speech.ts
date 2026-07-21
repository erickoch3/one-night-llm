import type {
  GameEvent,
  GameState,
  GameTransition,
  Player,
  PlayerId,
  Result,
  SpeakerSelection,
  SpeechAlgorithmConfig,
  SpeechIntent,
  SpeechScore,
  ToolDefinition,
} from "./types.js";

export const DEFAULT_SPEECH_ALGORITHM: SpeechAlgorithmConfig = {
  selfWeight: 0.65,
  audienceWeight: 0.35,
  waitingBonusPerTurn: 0.25,
  maximumWaitingBonus: 1.5,
  repeatPenalty: 2.5,
  minimumScore: 0.01,
};

/** Stable flat tool field name: selfDesire plus one field per other player. */
export function hearFromToolField(playerId: PlayerId): string {
  return `hear__${playerId}`;
}

/**
 * Produces the requested 1 + (number of other players) flat arguments. Flat
 * fields make incomplete LLM calls easy to reject and repair.
 */
export function getSpeechIntentTool(
  players: readonly Player[],
  actorId: PlayerId,
): ToolDefinition | null {
  if (!players.some((player) => player.id === actorId)) return null;
  const others = players.filter((player) => player.id !== actorId);
  const properties = Object.fromEntries([
    [
      "selfDesire",
      {
        type: "integer" as const,
        minimum: 0,
        maximum: 10,
        description: "How strongly you want to speak next (0-10).",
      },
    ],
    ...others.map((player) => [
      hearFromToolField(player.id),
      {
        type: "integer" as const,
        minimum: 0,
        maximum: 10,
        description: `How strongly you want to hear from ${player.name} next (0-10).`,
      },
    ]),
  ]);

  return {
    name: "submit_speech_intent",
    description:
      "Privately score how much you want to speak and how much you want to hear from every other player. This does not grant the floor; the game chooses exactly one speaker.",
    inputSchema: {
      type: "object",
      properties,
      required: ["selfDesire", ...others.map((player) => hearFromToolField(player.id))],
      additionalProperties: false,
    },
  };
}

/** Converts an untrusted LLM tool payload into a validated domain intent. */
export function parseSpeechIntentToolInput(
  players: readonly Player[],
  actorId: PlayerId,
  turnNumber: number,
  input: unknown,
): Result<SpeechIntent> {
  if (!isPlainRecord(input)) {
    return intentFailure("Speech intent arguments must be an object.");
  }
  const actor = players.find((player) => player.id === actorId);
  if (!actor) {
    return {
      ok: false,
      error: { code: "UNKNOWN_PLAYER", message: `Unknown player ${actorId}.` },
    };
  }
  if (actor.kind !== "agent") {
    return intentFailure("Only agent players submit the LLM speech-intent tool.");
  }

  const otherIds = players
    .filter((player) => player.id !== actorId)
    .map((player) => player.id);
  const expectedKeys = new Set([
    "selfDesire",
    ...otherIds.map((playerId) => hearFromToolField(playerId)),
  ]);
  if (
    Object.keys(input).some((key) => !expectedKeys.has(key)) ||
    Object.keys(input).length !== expectedKeys.size
  ) {
    return intentFailure(
      "Speech intent must contain selfDesire and exactly one hear score for every other player.",
    );
  }

  if (!isDesire(input.selfDesire)) {
    return intentFailure("selfDesire must be an integer from 0 through 10.");
  }
  const hearFrom: Record<PlayerId, number> = {};
  for (const playerId of otherIds) {
    const value = input[hearFromToolField(playerId)];
    if (!isDesire(value)) {
      return intentFailure(
        `${hearFromToolField(playerId)} must be an integer from 0 through 10.`,
      );
    }
    hearFrom[playerId] = value;
  }

  return {
    ok: true,
    value: {
      playerId: actorId,
      selfDesire: input.selfDesire,
      hearFrom,
      source: "agent-tool",
      turnNumber,
    },
  };
}

/**
 * Adapts UI signals to the same intent protocol as agents. Typing is exactly
 * selfDesire=10. Hovering is a strong request to hear the hovered player.
 */
export function createHumanSpeechIntent(
  players: readonly Player[],
  humanId: PlayerId,
  turnNumber: number,
  signals: {
    readonly isTyping: boolean;
    readonly hoveredPlayerId?: PlayerId | null;
    readonly hoverStrength?: number;
  },
): Result<SpeechIntent> {
  const human = players.find((player) => player.id === humanId);
  if (!human) {
    return {
      ok: false,
      error: { code: "UNKNOWN_PLAYER", message: `Unknown player ${humanId}.` },
    };
  }
  if (human.kind !== "human") {
    return intentFailure("Human UI signals can only be submitted for a human player.");
  }
  const hoverStrength = signals.hoverStrength ?? 10;
  if (!isDesire(hoverStrength)) {
    return intentFailure("hoverStrength must be an integer from 0 through 10.");
  }
  if (
    signals.hoveredPlayerId !== undefined &&
    signals.hoveredPlayerId !== null &&
    !players.some(
      (player) => player.id === signals.hoveredPlayerId && player.id !== humanId,
    )
  ) {
    return intentFailure("The hovered player must be another player in this game.");
  }

  const hearFrom: Record<PlayerId, number> = Object.fromEntries(
    players
      .filter((player) => player.id !== humanId)
      .map((player) => [
        player.id,
        !signals.isTyping && player.id === signals.hoveredPlayerId
          ? hoverStrength
          : 0,
      ]),
  );
  return {
    ok: true,
    value: {
      playerId: humanId,
      selfDesire: signals.isTyping ? 10 : 0,
      hearFrom,
      source: "human-signals",
      turnNumber,
    },
  };
}

export function validateSpeechIntent(
  players: readonly Player[],
  expectedTurnNumber: number,
  intent: SpeechIntent,
): Result<SpeechIntent> {
  const player = players.find((candidate) => candidate.id === intent.playerId);
  if (!player) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_PLAYER",
        message: `Unknown player ${intent.playerId}.`,
      },
    };
  }
  if (intent.turnNumber !== expectedTurnNumber) {
    return intentFailure(
      `Speech intent is for turn ${intent.turnNumber}; expected ${expectedTurnNumber}.`,
    );
  }
  if (!isDesire(intent.selfDesire)) {
    return intentFailure("selfDesire must be an integer from 0 through 10.");
  }
  if (
    (player.kind === "human" && intent.source !== "human-signals") ||
    (player.kind === "agent" && intent.source !== "agent-tool")
  ) {
    return intentFailure("Speech intent source does not match the player controller.");
  }

  const expectedIds = players
    .filter((candidate) => candidate.id !== intent.playerId)
    .map((candidate) => candidate.id);
  const submittedIds = Object.keys(intent.hearFrom);
  if (
    submittedIds.length !== expectedIds.length ||
    expectedIds.some((playerId) => !submittedIds.includes(playerId)) ||
    submittedIds.some((playerId) => !expectedIds.includes(playerId))
  ) {
    return intentFailure("hearFrom must contain exactly one score for every other player.");
  }
  for (const [playerId, desire] of Object.entries(intent.hearFrom)) {
    if (!isDesire(desire)) {
      return intentFailure(`Hear desire for ${playerId} must be an integer from 0 through 10.`);
    }
  }
  return { ok: true, value: intent };
}

/**
 * Scores all candidates and deterministically selects at most one. Missing
 * intents count as zero, so the UI can react immediately to typing/hovering.
 */
export function resolveNextSpeaker(
  players: readonly Player[],
  intents: Readonly<Partial<Record<PlayerId, SpeechIntent>>>,
  recentSpeakers: readonly PlayerId[],
  turnNumber: number,
  config: SpeechAlgorithmConfig = DEFAULT_SPEECH_ALGORITHM,
): SpeakerSelection | null {
  if (players.length === 0) return null;
  const intentFor = (playerId: PlayerId) =>
    Object.hasOwn(intents, playerId) ? intents[playerId] : undefined;

  const scores = players.map((candidate): SpeechScore => {
    const own = intentFor(candidate.id)?.selfDesire ?? 0;
    const audienceValues = players
      .filter((player) => player.id !== candidate.id)
      .map((player) => intentFor(player.id)?.hearFrom[candidate.id] ?? 0);
    const audienceAverage =
      audienceValues.length === 0
        ? 0
        : audienceValues.reduce((sum, value) => sum + value, 0) /
          audienceValues.length;

    const lastSpokeAt = recentSpeakers.lastIndexOf(candidate.id);
    const turnsWaiting =
      lastSpokeAt < 0
        ? recentSpeakers.length
        : recentSpeakers.length - lastSpokeAt - 1;
    const waitingBonus = Math.min(
      config.maximumWaitingBonus,
      turnsWaiting * config.waitingBonusPerTurn,
    );
    const repeatPenalty =
      recentSpeakers.at(-1) === candidate.id ? config.repeatPenalty : 0;
    const selfComponent = own * config.selfWeight;
    const audienceComponent = audienceAverage * config.audienceWeight;
    const total = roundScore(
      selfComponent + audienceComponent + waitingBonus - repeatPenalty,
    );
    return {
      playerId: candidate.id,
      selfComponent: roundScore(selfComponent),
      audienceComponent: roundScore(audienceComponent),
      waitingBonus: roundScore(waitingBonus),
      repeatPenalty: roundScore(repeatPenalty),
      total,
    };
  });

  // Waiting alone never manufactures a desire to speak. At least one current
  // self or audience signal must support the candidate.
  const signaledScores = scores.filter((score) => {
    const selfSignal = intentFor(score.playerId)?.selfDesire ?? 0;
    const audienceSignal = players.some(
      (player) => (intentFor(player.id)?.hearFrom[score.playerId] ?? 0) > 0,
    );
    return selfSignal > 0 || audienceSignal;
  });
  if (signaledScores.length === 0) return null;

  const seatById = Object.fromEntries(players.map((player) => [player.id, player.seat]));
  const rotation = turnNumber % players.length;
  const sorted = [...signaledScores].sort((left, right) => {
    if (right.total !== left.total) return right.total - left.total;
    const leftRotated = positiveModulo((seatById[left.playerId] ?? 0) - rotation, players.length);
    const rightRotated = positiveModulo((seatById[right.playerId] ?? 0) - rotation, players.length);
    return leftRotated - rightRotated || left.playerId.localeCompare(right.playerId);
  });
  if (sorted[0].total < config.minimumScore) return null;

  return { playerId: sorted[0].playerId, turnNumber, scores };
}

export function submitSpeechIntent(
  state: GameState,
  intent: SpeechIntent,
): Result<GameTransition> {
  if (state.phase !== "discussion") {
    return phaseFailure("Speech intents are only accepted during discussion.");
  }
  if (state.discussion.activeSpeakerId !== null) {
    return {
      ok: false,
      error: {
        code: "SPEAKER_ACTIVE",
        message: `${state.discussion.activeSpeakerId} currently has the floor.`,
      },
    };
  }
  const validation = validateSpeechIntent(
    state.players,
    state.discussion.turnNumber,
    intent,
  );
  if (!validation.ok) return validation;

  const event: GameEvent = {
    sequence: nextEventSequence(state),
    type: "discussion.intent-submitted",
    visibility: { kind: "server" },
    data: { playerId: intent.playerId, turnNumber: intent.turnNumber },
  };
  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    discussion: {
      ...state.discussion,
      intents: { ...state.discussion.intents, [intent.playerId]: intent },
    },
    events: [...state.events, event],
  };
  return { ok: true, value: { state: nextState, events: [event] } };
}

/** Acquires the single global speech lock. It can never select two speakers. */
export function chooseNextSpeaker(
  state: GameState,
  config: SpeechAlgorithmConfig = DEFAULT_SPEECH_ALGORITHM,
): Result<GameTransition> {
  if (state.phase !== "discussion") {
    return phaseFailure("A speaker can only be chosen during discussion.");
  }
  if (state.discussion.activeSpeakerId !== null) {
    return {
      ok: false,
      error: {
        code: "SPEAKER_ACTIVE",
        message: `${state.discussion.activeSpeakerId} already has the floor.`,
      },
    };
  }

  const selection = resolveNextSpeaker(
    state.players,
    state.discussion.intents,
    state.discussion.recentSpeakers,
    state.discussion.turnNumber,
    config,
  );
  if (!selection) {
    return {
      ok: false,
      error: {
        code: "NO_SPEAKER",
        message: "No player currently wants to speak or be heard.",
      },
    };
  }

  const event: GameEvent = {
    sequence: nextEventSequence(state),
    type: "discussion.speaker-selected",
    // Scores contain private preferences. The public projection exposes only
    // discussion.activeSpeakerId.
    visibility: { kind: "server" },
    data: { selection },
  };
  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    discussion: {
      ...state.discussion,
      activeSpeakerId: selection.playerId,
    },
    events: [...state.events, event],
  };
  return { ok: true, value: { state: nextState, events: [event] } };
}

/** Releases the speech lock, records one utterance, and opens a fresh intent window. */
export function completeSpeechTurn(
  state: GameState,
  speakerId: PlayerId,
  text: string,
): Result<GameTransition> {
  if (state.phase !== "discussion") {
    return phaseFailure("Speech can only complete during discussion.");
  }
  if (state.discussion.activeSpeakerId !== speakerId) {
    return {
      ok: false,
      error: {
        code: "NOT_CURRENT_ACTOR",
        message: `${speakerId} does not currently have the floor.`,
      },
    };
  }

  const message = {
    turnNumber: state.discussion.turnNumber,
    speakerId,
    text: text.trim(),
  } as const;
  const event: GameEvent = {
    sequence: nextEventSequence(state),
    type: "discussion.message",
    visibility: { kind: "public" },
    data: { message },
  };
  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    discussion: {
      turnNumber: state.discussion.turnNumber + 1,
      activeSpeakerId: null,
      intents: {},
      recentSpeakers: [...state.discussion.recentSpeakers, speakerId].slice(-20),
      transcript: [...state.discussion.transcript, message],
    },
    events: [...state.events, event],
  };
  return { ok: true, value: { state: nextState, events: [event] } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDesire(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 10;
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function nextEventSequence(state: GameState): number {
  return (state.events[state.events.length - 1]?.sequence ?? 0) + 1;
}

function intentFailure<T = never>(message: string): Result<T> {
  return { ok: false, error: { code: "INVALID_INTENT", message } };
}

function phaseFailure<T = never>(message: string): Result<T> {
  return { ok: false, error: { code: "WRONG_PHASE", message } };
}
