import { teamForRole } from "./roles.js";
import type {
  GameEvent,
  GameResolution,
  GameState,
  GameTransition,
  HunterElimination,
  Player,
  PlayerId,
  Result,
  RoleId,
  TeamId,
  ToolDefinition,
} from "./types.js";

export function beginVoting(state: GameState): Result<GameTransition> {
  if (state.phase !== "discussion") {
    return phaseFailure("Voting can only begin after discussion.");
  }
  if (state.discussion.activeSpeakerId !== null) {
    return {
      ok: false,
      error: {
        code: "SPEAKER_ACTIVE",
        message: "Wait for the active speaker to finish before beginning the vote.",
      },
    };
  }

  const event: GameEvent = {
    sequence: nextEventSequence(state),
    type: "voting.started",
    visibility: { kind: "public" },
    data: {},
  };
  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    phase: "voting",
    voting: { votes: {} },
    events: [...state.events, event],
  };
  return { ok: true, value: { state: nextState, events: [event] } };
}

export function validateVote(
  state: GameState,
  voterId: PlayerId,
  targetId: PlayerId,
): Result<{ readonly voterId: PlayerId; readonly targetId: PlayerId }> {
  if (state.phase !== "voting") {
    return phaseFailure("Votes are only accepted during the voting phase.");
  }
  if (!state.players.some((player) => player.id === voterId)) {
    return unknownPlayer(voterId);
  }
  if (!state.players.some((player) => player.id === targetId)) {
    return unknownPlayer(targetId);
  }
  if (voterId === targetId) {
    return {
      ok: false,
      error: {
        code: "INVALID_TARGET",
        message: "Players cannot vote for themselves.",
      },
    };
  }
  if (Object.hasOwn(state.voting.votes, voterId)) {
    return {
      ok: false,
      error: {
        code: "DUPLICATE_VOTE",
        message: `${voterId} has already cast a vote.`,
      },
    };
  }
  return { ok: true, value: { voterId, targetId } };
}

/** Casts a secret vote and atomically resolves the game when the last vote arrives. */
export function castVote(
  state: GameState,
  voterId: PlayerId,
  targetId: PlayerId,
): Result<GameTransition> {
  const validation = validateVote(state, voterId, targetId);
  if (!validation.ok) return validation;

  const votes = { ...state.voting.votes, [voterId]: targetId };
  let sequence = nextEventSequence(state);
  const events: GameEvent[] = [
    {
      sequence,
      type: "vote.cast",
      visibility: { kind: "server" },
      data: { voterId, targetId },
    },
  ];
  sequence += 1;

  if (Object.keys(votes).length < state.players.length) {
    const nextState: GameState = {
      ...state,
      revision: state.revision + 1,
      voting: { votes },
      events: [...state.events, ...events],
    };
    return { ok: true, value: { state: nextState, events } };
  }

  const resolutionResult = resolveVotes(state.players, state.cards.players, votes);
  if (!resolutionResult.ok) return resolutionResult;
  const resolution = resolutionResult.value;
  events.push({
    sequence,
    type: "game.resolved",
    visibility: { kind: "public" },
    data: { resolution },
  });
  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    phase: "resolved",
    voting: { votes },
    resolution,
    events: [...state.events, ...events],
  };
  return { ok: true, value: { state: nextState, events } };
}

/** Pure vote tally, Hunter-chain, and team outcome resolver. */
export function resolveVotes(
  players: readonly Player[],
  finalCards: Readonly<Record<PlayerId, { readonly role: RoleId }>>,
  submittedVotes: Readonly<Partial<Record<PlayerId, PlayerId>>>,
): Result<GameResolution> {
  const playerIds = players.map((player) => player.id);
  const playerIdSet = new Set(playerIds);
  const submittedVoterIds = Object.keys(submittedVotes);
  if (
    submittedVoterIds.length !== players.length ||
    submittedVoterIds.some((id) => !playerIdSet.has(id)) ||
    playerIds.some((id) => submittedVotes[id] === undefined)
  ) {
    return {
      ok: false,
      error: {
        code: "INCOMPLETE_VOTE",
        message: "Exactly one vote from every player is required to resolve the game.",
      },
    };
  }
  for (const playerId of playerIds) {
    if (!finalCards[playerId]) {
      return {
        ok: false,
        error: {
          code: "INVALID_SETUP",
          message: `No final card exists for ${playerId}.`,
        },
      };
    }
    const targetId = submittedVotes[playerId];
    if (!targetId || !playerIdSet.has(targetId) || targetId === playerId) {
      return {
        ok: false,
        error: {
          code: "INVALID_TARGET",
          message: `${playerId} has an invalid vote target.`,
        },
      };
    }
  }

  const votes = Object.fromEntries(
    playerIds.map((playerId) => [playerId, submittedVotes[playerId] as PlayerId]),
  );
  const tally: Record<PlayerId, number> = Object.fromEntries(
    playerIds.map((playerId) => [playerId, 0]),
  );
  for (const targetId of Object.values(votes)) {
    tally[targetId] += 1;
  }

  const highestVoteCount = Math.max(...Object.values(tally));
  // Official One Night rule: a full circle of one-vote results kills nobody.
  const initiallyEliminatedPlayerIds =
    highestVoteCount <= 1
      ? []
      : players
          .filter((player) => tally[player.id] === highestVoteCount)
          .map((player) => player.id);

  const eliminated = [...initiallyEliminatedPlayerIds];
  const eliminatedSet = new Set(eliminated);
  const processedHunters = new Set<PlayerId>();
  const hunterEliminations: HunterElimination[] = [];
  for (let cursor = 0; cursor < eliminated.length; cursor += 1) {
    const eliminatedId = eliminated[cursor];
    if (
      finalCards[eliminatedId].role !== "hunter" ||
      processedHunters.has(eliminatedId)
    ) {
      continue;
    }
    processedHunters.add(eliminatedId);
    const hunterTargetId = votes[eliminatedId];
    hunterEliminations.push({ hunterId: eliminatedId, targetId: hunterTargetId });
    if (!eliminatedSet.has(hunterTargetId)) {
      eliminatedSet.add(hunterTargetId);
      eliminated.push(hunterTargetId);
    }
  }

  const rolesAtEnd: Record<PlayerId, RoleId> = Object.fromEntries(
    players.map((player) => [player.id, finalCards[player.id].role]),
  );
  const werewolves = playerIds.filter((id) => rolesAtEnd[id] === "werewolf");
  const minions = playerIds.filter((id) => rolesAtEnd[id] === "minion");
  const killedWerewolves = werewolves.filter((id) => eliminatedSet.has(id));
  const killedMinions = minions.filter((id) => eliminatedSet.has(id));
  const killedTanners = playerIds.filter(
    (id) => rolesAtEnd[id] === "tanner" && eliminatedSet.has(id),
  );

  let villageWins = false;
  let werewolfTeamWins = false;
  const reasons: GameResolution["reasons"][number][] = [];

  if (werewolves.length > 0) {
    if (killedWerewolves.length > 0) {
      villageWins = true;
      reasons.push("werewolf-killed");
    } else {
      werewolfTeamWins = true;
      reasons.push("werewolves-survived");
    }
  } else if (minions.length > 0) {
    if (eliminated.length === 0) {
      villageWins = true;
      reasons.push("no-werewolf-no-death");
    } else if (killedMinions.length > 0) {
      villageWins = true;
      reasons.push("minion-killed-without-werewolf");
    } else {
      werewolfTeamWins = true;
      reasons.push("minion-survived-without-werewolf");
    }
  } else if (eliminated.length === 0) {
    villageWins = true;
    reasons.push("no-werewolf-no-death");
  } else {
    reasons.push("innocent-killed-without-werewolf");
  }

  if (killedTanners.length > 0) {
    reasons.push("tanner-killed");
    // The Tanner is the sole winner unless the Village independently killed a
    // Werewolf (or a lone Minion); in that case those wins are shared.
    werewolfTeamWins = false;
  }

  const winningTeams: TeamId[] = [];
  if (villageWins) winningTeams.push("village");
  if (werewolfTeamWins) winningTeams.push("werewolf");
  if (killedTanners.length > 0) winningTeams.push("tanner");

  const winnerSet = new Set<PlayerId>();
  for (const player of players) {
    const team = teamForRole(rolesAtEnd[player.id]);
    if (
      (team === "village" && villageWins) ||
      (team === "werewolf" && werewolfTeamWins) ||
      (team === "tanner" && killedTanners.includes(player.id))
    ) {
      winnerSet.add(player.id);
    }
  }

  return {
    ok: true,
    value: {
      votes,
      tally,
      initiallyEliminatedPlayerIds,
      eliminatedPlayerIds: eliminated,
      hunterEliminations,
      rolesAtEnd,
      winningTeams,
      winnerPlayerIds: players
        .filter((player) => winnerSet.has(player.id))
        .map((player) => player.id),
      reasons,
    },
  };
}

export function getVoteTool(
  state: GameState,
  actorId: PlayerId,
): ToolDefinition | null {
  if (
    state.phase !== "voting" ||
    !state.players.some((player) => player.id === actorId) ||
    Object.hasOwn(state.voting.votes, actorId)
  ) {
    return null;
  }
  const targets = state.players
    .filter((player) => player.id !== actorId)
    .map((player) => player.id);
  return {
    name: "cast_vote",
    description:
      "Vote for exactly one other player to eliminate. Votes remain secret until everyone has voted.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: {
          type: "string",
          enum: targets,
          description: "The player you believe should be eliminated.",
        },
      },
      required: ["targetId"],
      additionalProperties: false,
    },
  };
}

function nextEventSequence(state: GameState): number {
  return (state.events[state.events.length - 1]?.sequence ?? 0) + 1;
}

function phaseFailure<T = never>(message: string): Result<T> {
  return { ok: false, error: { code: "WRONG_PHASE", message } };
}

function unknownPlayer<T = never>(playerId: PlayerId): Result<T> {
  return {
    ok: false,
    error: { code: "UNKNOWN_PLAYER", message: `Unknown player ${playerId}.` },
  };
}

/** Human-facing helper for concise outcome copy. */
export function describeResolution(resolution: GameResolution): string {
  if (resolution.winningTeams.length === 0) return "Nobody wins this village.";
  if (resolution.winningTeams.length === 1) {
    const [team] = resolution.winningTeams;
    if (team === "tanner") return "The Tanner engineered their own elimination and wins!";
    if (team === "werewolf") return "The Werewolf team survives the vote and wins!";
    return "The Village uncovered the threat and wins!";
  }
  return `Shared victory: ${resolution.winningTeams.join(" and ")}.`;
}

/** Exposed for UI badges and model prompts. */
export function finalTeamByPlayer(
  resolution: GameResolution,
): Readonly<Record<PlayerId, TeamId>> {
  return Object.fromEntries(
    Object.entries(resolution.rolesAtEnd).map(([playerId, role]) => [
      playerId,
      teamForRole(role),
    ]),
  );
}
