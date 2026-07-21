import { randomUUID } from "node:crypto";
import {
  announceVoteCall,
  collectSpeechInterest,
  collectVote,
  collectVoteReadiness,
  runNightAction,
  takeSpeakingTurn,
  type AgentModelRuntime,
  type AgentParticipant,
  type AgentTurnContext,
  type NightActionCapability,
  type NightActionDecision,
  type PublicTranscriptEntry,
  type SecretNightFact,
  type SpeechInterestDecision,
} from "../lib/agents/index.ts";
import {
  MAX_AGENT_COUNT,
  agentVoiceProfile,
  findAgentPersonalityProfile,
  selectAgentPersonalityProfiles,
} from "../lib/agents/personalities.ts";
import {
  ROLE_DEFINITIONS,
  applyNightAction,
  beginVoting,
  buildRecommendedDeck,
  castVote,
  chooseNextSpeaker,
  completeNightCeremonyStep,
  completeSpeechTurn,
  createAgentPlayer,
  createHumanPlayer,
  createHumanSpeechIntent,
  dealGame,
  getCurrentNightCeremonyStep,
  getCurrentNightTurn,
  getNightContext,
  getPlayerNightHistory,
  hashSeed,
  submitSpeechIntent,
  type GameState,
  type CardSlot,
  type KnowledgeItem,
  type NightAction,
  type NightRole,
  type PlayerId,
  type Result,
  type RoleId,
  type SpeechIntent,
} from "../lib/game/index.ts";
import type {
  AdvanceDialogueRequest,
  CreateGameRequest,
  GameMode,
  GameSnapshot,
  HumanNightActionRequest,
  NightHistoryEntryView,
  PublicPlayerView,
  ResolutionView,
  RoleView,
  TranscriptEntryView,
} from "../lib/shared/protocol.ts";
import { CodexAgentRuntime } from "./agent-runtime.ts";
import { codexAppServer } from "./codex/client.ts";
import { HttpError } from "./http.ts";
import {
  OpenAIAgentRuntime,
  resolveOpenAIApiKey,
} from "./openai/runtime.ts";

interface GameRoom {
  id: string;
  ownerSessionId: string;
  viewerId: PlayerId;
  mode: GameMode;
  agentRuntime: AgentModelRuntime | null;
  state: GameState;
  voteCallNotice: {
    announcementTurnNumber: number;
    source: "agent-consensus" | "human";
  } | null;
  degradedAgents: boolean;
  notice: string | null;
  operation: Promise<void>;
  closed: boolean;
  abortController: AbortController;
}

const rooms = new Map<string, GameRoom>();
const DISCUSSION_INTEREST_TIMEOUT_MS = 12_000;
const DISCUSSION_SPEECH_TIMEOUT_MS = 18_000;
const DISCUSSION_READINESS_TIMEOUT_MS = 12_000;
const READINESS_CHECK_INTERVAL = 4;

function roomFor(gameId: string, sessionId: string) {
  const room = rooms.get(gameId);
  if (!room || room.ownerSessionId !== sessionId) {
    throw new HttpError(404, "That village no longer exists in this local session.");
  }
  return room;
}

async function locked<T>(room: GameRoom, operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = room.operation;
  room.operation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    assertRoomOpen(room);
    return await operation();
  } finally {
    release();
  }
}

function assertRoomOpen(room: GameRoom) {
  if (room.closed || room.abortController.signal.aborted) {
    throw new HttpError(410, "That village has already dispersed.");
  }
}

function transitionValue<T>(result: Result<T>): T {
  if (!result.ok) throw new HttpError(409, result.error.message);
  return result.value;
}

function rolesForPack(playerCount: number, rolePack: "classic" | "chaos") {
  if (rolePack === "classic") return buildRecommendedDeck(playerCount);
  const chaos: RoleId[] = [
    "werewolf",
    "werewolf",
    "minion",
    "seer",
    "robber",
    "troublemaker",
    "drunk",
    "insomniac",
    "hunter",
    "tanner",
    "villager",
    "villager",
  ];
  const required = playerCount + 3;
  while (chaos.length < required) chaos.push("villager");
  return chaos.slice(0, required);
}

export async function createGameRoom(
  ownerSessionId: string,
  request: CreateGameRequest,
): Promise<GameSnapshot> {
  if (request.mode === "codex") {
    const account = await codexAppServer.accountStatus();
    if (!account.signedIn) {
      throw new HttpError(401, "Sign in with ChatGPT before inviting Codex players.");
    }
  }
  const openaiApiKey =
    request.mode === "openai"
      ? resolveOpenAIApiKey(request.openaiApiKey)
      : undefined;
  const agentCount = request.agentCount;
  if (!Number.isInteger(agentCount) || agentCount < 2 || agentCount > MAX_AGENT_COUNT) {
    throw new HttpError(400, "Choose between two and six agent players.");
  }
  const gameId = randomUUID();
  const viewerId = "player-you";
  const agentProfiles = selectAgentPersonalityProfiles(
    agentCount,
    `${gameId}:agent-personalities`,
  );
  const players = [
    createHumanPlayer({
      id: viewerId,
      name: request.playerName,
      seat: 0,
      userId: ownerSessionId,
      avatar: initials(request.playerName),
    }),
    ...agentProfiles.map((profile, index) =>
      createAgentPlayer({
        id: `agent-${index + 1}`,
        name: profile.name,
        seat: index + 1,
        model: request.mode === "rehearsal" ? "rehearsal" : request.agentModel,
        profileId: profile.id,
        persona: profile.tagline,
        voiceProfile: agentVoiceProfile(profile),
        avatar: profile.avatar,
      }),
    ),
  ];
  const dealt = dealGame({
    gameId,
    seed: randomUUID(),
    players,
    roles: rolesForPack(players.length, request.rolePack),
  });
  const state = transitionValue(dealt);
  const room: GameRoom = {
    id: gameId,
    ownerSessionId,
    viewerId,
    mode: request.mode,
    agentRuntime:
      request.mode === "codex"
        ? new CodexAgentRuntime(codexAppServer, {
            model: request.agentModel,
            reasoningEffort: request.agentReasoningEffort,
          })
        : request.mode === "openai" && openaiApiKey
          ? new OpenAIAgentRuntime(openaiApiKey, {
              model: request.agentModel,
              reasoningEffort: request.agentReasoningEffort,
            })
          : null,
    state,
    voteCallNotice: null,
    degradedAgents: false,
    notice: null,
    operation: Promise.resolve(),
    closed: false,
    abortController: new AbortController(),
  };
  rooms.set(gameId, room);
  return snapshot(room);
}

export function getGameRoom(gameId: string, sessionId: string) {
  return snapshot(roomFor(gameId, sessionId));
}

export async function submitHumanNightAction(
  gameId: string,
  sessionId: string,
  request: HumanNightActionRequest,
) {
  const room = roomFor(gameId, sessionId);
  return locked(room, async () => {
    const turn = getCurrentNightTurn(room.state);
    if (!turn || turn.actorId !== room.viewerId) {
      throw new HttpError(409, "You do not currently have a night action.");
    }
    const action = { ...request, actorId: room.viewerId } as NightAction;
    room.state = transitionValue(applyNightAction(room.state, action)).state;
    await resolveActiveNightCeremonyStep(room);
    return snapshot(room);
  });
}

export async function advanceNightCeremony(
  gameId: string,
  sessionId: string,
) {
  const room = roomFor(gameId, sessionId);
  return locked(room, async () => {
    if (room.state.phase !== "night") {
      throw new HttpError(409, "The night ceremony has already ended.");
    }
    const turn = getCurrentNightTurn(room.state);
    if (turn) {
      const player = room.state.players.find((candidate) => candidate.id === turn.actorId);
      if (player?.kind === "human") {
        throw new HttpError(409, "The awake player must complete their private action first.");
      }
    }
    await resolveActiveNightCeremonyStep(room);
    return snapshot(room);
  });
}

export async function advanceDialogue(
  gameId: string,
  sessionId: string,
  request: AdvanceDialogueRequest,
) {
  const room = roomFor(gameId, sessionId);
  return locked(room, async () => {
    if (room.state.phase !== "discussion") {
      throw new HttpError(409, "The village is not currently discussing.");
    }
    if (room.state.discussion.activeSpeakerId) return snapshot(room);

    const humanIntent = transitionValue(
      createHumanSpeechIntent(
        room.state.players,
        room.viewerId,
        room.state.discussion.turnNumber,
        {
          isTyping: request.humanWantsToSpeak,
          hoveredPlayerId: request.hoverTargetId,
        },
      ),
    );
    const agentIntents = await collectAgentSpeechIntents(room);
    assertRoomOpen(room);
    let state = room.state;
    for (const intent of [humanIntent, ...agentIntents]) {
      state = transitionValue(submitSpeechIntent(state, intent)).state;
    }

    let selection = chooseNextSpeaker(state);
    if (!selection.ok && selection.error.code === "NO_SPEAKER") {
      const fallbackActor = state.players.find((player) => player.kind === "agent");
      if (!fallbackActor) throw new HttpError(409, selection.error.message);
      const fallbackIntent: SpeechIntent = {
        playerId: fallbackActor.id,
        selfDesire: 5,
        hearFrom: Object.fromEntries(
          state.players
            .filter((player) => player.id !== fallbackActor.id)
            .map((player) => [player.id, 3]),
        ),
        source: "agent-tool",
        turnNumber: state.discussion.turnNumber,
      };
      state = transitionValue(submitSpeechIntent(state, fallbackIntent)).state;
      selection = chooseNextSpeaker(state);
    }
    state = transitionValue(selection).state;
    room.state = state;
    const speakerId = state.discussion.activeSpeakerId;
    if (speakerId && speakerId !== room.viewerId) {
      const text = await agentSpeech(room, speakerId);
      room.state = transitionValue(
        completeSpeechTurn(room.state, speakerId, text),
      ).state;
      await maybeCallAgentVote(room);
    }
    return snapshot(room);
  });
}

export async function submitHumanSpeech(
  gameId: string,
  sessionId: string,
  text: string,
) {
  const room = roomFor(gameId, sessionId);
  return locked(room, async () => {
    const bounded = text.trim();
    if (!bounded || bounded.length > 500) {
      throw new HttpError(400, "Your statement must contain 1 to 500 characters.");
    }
    room.state = transitionValue(
      completeSpeechTurn(room.state, room.viewerId, bounded),
    ).state;
    await maybeCallAgentVote(room);
    return snapshot(room);
  });
}

export async function startVoting(gameId: string, sessionId: string) {
  const room = roomFor(gameId, sessionId);
  return locked(room, async () => {
    if (room.state.discussion.turnNumber < 3) {
      throw new HttpError(409, "Give the village at least three statements first.");
    }
    await announceAndBeginVoting(room, "human");
    return snapshot(room);
  });
}

export async function submitHumanVote(
  gameId: string,
  sessionId: string,
  targetId: PlayerId,
) {
  const room = roomFor(gameId, sessionId);
  return locked(room, async () => {
    room.state = transitionValue(
      castVote(room.state, room.viewerId, targetId),
    ).state;
    const voters = room.state.players.filter(
      (player) =>
        player.kind === "agent" &&
        !Object.hasOwn(room.state.voting.votes, player.id),
    );
    const decisions = await Promise.all(
      voters.map(async (player) => ({
        playerId: player.id,
        targetId: await agentVote(room, player.id),
      })),
    );
    assertRoomOpen(room);
    for (const decision of decisions) {
      room.state = transitionValue(
        castVote(room.state, decision.playerId, decision.targetId),
      ).state;
    }
    return snapshot(room);
  });
}

export function removeGameRoom(gameId: string, sessionId: string) {
  const room = roomFor(gameId, sessionId);
  room.closed = true;
  room.abortController.abort();
  rooms.delete(gameId);
}

async function resolveActiveNightCeremonyStep(room: GameRoom) {
  const step = getCurrentNightCeremonyStep(room.state);
  if (!step) throw new HttpError(409, "There is no active night ceremony step.");

  while (room.state.phase === "night") {
    assertRoomOpen(room);
    const turn = getCurrentNightTurn(room.state);
    if (!turn) break;
    const player = room.state.players.find((candidate) => candidate.id === turn.actorId);
    if (!player) throw new Error("Night action references an unknown player.");
    if (player.kind === "human") return;
    const action = await agentNightAction(room, turn.actorId, turn.role);
    room.state = transitionValue(applyNightAction(room.state, action)).state;
  }

  room.state = transitionValue(completeNightCeremonyStep(room.state)).state;
}

async function agentNightAction(
  room: GameRoom,
  actorId: PlayerId,
  role: NightRole,
): Promise<NightAction> {
  if (room.agentRuntime) {
    try {
      const context = buildAgentContext(room, actorId, "night");
      const result = await runNightAction(room.agentRuntime, context, {
        maximumAttempts: 2,
        signal: room.abortController.signal,
        night: {
          allowFinishWithoutAction: [
            "werewolf",
            "minion",
            "robber",
            "troublemaker",
            "insomniac",
          ].includes(role),
        },
      });
      assertRoomOpen(room);
      return mapNightDecision(room.state, actorId, role, result.decision);
    } catch (error) {
      assertRoomOpen(room);
      degrade(room, error);
    }
  }
  return fallbackNightAction(room.state, actorId, role);
}

async function collectAgentSpeechIntents(room: GameRoom): Promise<SpeechIntent[]> {
  const agents = room.state.players.filter((player) => player.kind === "agent");
  const results = await Promise.all(
    agents.map(async (player): Promise<SpeechIntent> => {
      if (room.agentRuntime) {
        try {
          const decision = await collectSpeechInterest(
            room.agentRuntime,
            buildAgentContext(room, player.id, "discussion"),
            {
              // Discussion state changes quickly; a fresh deterministic intent
              // is preferable to making the whole table wait on a retry.
              maximumAttempts: 1,
              signal: room.abortController.signal,
              turnTimeoutMs: DISCUSSION_INTEREST_TIMEOUT_MS,
            },
          );
          assertRoomOpen(room);
          return engineSpeechIntent(
            room.state,
            player.id,
            decision.decision,
          );
        } catch (error) {
          assertRoomOpen(room);
          degrade(room, error);
        }
      }
      return fallbackSpeechIntent(room.state, player.id);
    }),
  );
  return results;
}

async function agentSpeech(room: GameRoom, actorId: PlayerId) {
  if (room.agentRuntime) {
    try {
      const result = await takeSpeakingTurn(
        room.agentRuntime,
        buildAgentContext(room, actorId, "discussion"),
        {
          maximumAttempts: 1,
          signal: room.abortController.signal,
          turnTimeoutMs: DISCUSSION_SPEECH_TIMEOUT_MS,
          speech: { maximumCharacters: 420 },
        },
      );
      assertRoomOpen(room);
      return result.decision.text;
    } catch (error) {
      assertRoomOpen(room);
      degrade(room, error);
    }
  }
  return fallbackSpeech(room.state, actorId);
}

async function maybeCallAgentVote(room: GameRoom) {
  if (!shouldCheckVoteReadiness(room.state)) return;
  const agents = room.state.players.filter((player) => player.kind === "agent");
  const ballots = await Promise.all(
    agents.map(async (player) => ({
      playerId: player.id,
      readyToVote: await agentVoteReadiness(room, player.id),
    })),
  );
  assertRoomOpen(room);
  const ready = ballots.filter((ballot) => ballot.readyToVote);
  const required = Math.ceil((agents.length * 2) / 3);
  if (ready.length < required) return;
  const announcer = ready[
    stableNumber(
      room.state,
      `vote-call-announcer:${room.state.discussion.turnNumber}`,
    ) % ready.length
  ];
  await announceAndBeginVoting(room, "agent-consensus", announcer.playerId);
}

async function agentVoteReadiness(room: GameRoom, actorId: PlayerId) {
  if (room.agentRuntime) {
    try {
      const result = await collectVoteReadiness(
        room.agentRuntime,
        buildAgentContext(
          room,
          actorId,
          "discussion",
          `This is a scheduled private readiness check after ${room.state.discussion.turnNumber} public statements. Discussion has no fixed ending. Decide whether another round is still likely to improve the table's final choice.`,
        ),
        {
          maximumAttempts: 1,
          signal: room.abortController.signal,
          turnTimeoutMs: DISCUSSION_READINESS_TIMEOUT_MS,
        },
      );
      assertRoomOpen(room);
      return result.decision.readyToVote;
    } catch (error) {
      assertRoomOpen(room);
      degrade(room, error);
    }
  }
  return fallbackVoteReadiness(room.state, actorId);
}

async function announceAndBeginVoting(
  room: GameRoom,
  source: "agent-consensus" | "human",
  preferredAnnouncerId?: PlayerId,
) {
  const agents = room.state.players.filter((player) => player.kind === "agent");
  const announcer =
    agents.find((player) => player.id === preferredAnnouncerId) ??
    agents[
      stableNumber(
        room.state,
        `vote-call:${source}:${room.state.discussion.turnNumber}`,
      ) % agents.length
    ];
  if (!announcer) throw new HttpError(409, "No village agent can call the vote.");

  const intent: SpeechIntent = {
    playerId: announcer.id,
    selfDesire: 10,
    hearFrom: Object.fromEntries(
      room.state.players
        .filter((player) => player.id !== announcer.id)
        .map((player) => [player.id, 0]),
    ),
    source: "agent-tool",
    turnNumber: room.state.discussion.turnNumber,
  };
  room.state = transitionValue(submitSpeechIntent(room.state, intent)).state;
  room.state = transitionValue(chooseNextSpeaker(room.state)).state;
  if (room.state.discussion.activeSpeakerId !== announcer.id) {
    throw new HttpError(409, "The vote announcer could not acquire the floor.");
  }

  const statement = await agentVoteCallAnnouncement(room, announcer.id, source);
  const announcementTurnNumber = room.state.discussion.turnNumber;
  room.state = transitionValue(
    completeSpeechTurn(room.state, announcer.id, statement),
  ).state;
  room.voteCallNotice = { announcementTurnNumber, source };
  room.state = transitionValue(beginVoting(room.state)).state;
}

async function agentVoteCallAnnouncement(
  room: GameRoom,
  actorId: PlayerId,
  source: "agent-consensus" | "human",
) {
  const human = room.state.players.find((player) => player.id === room.viewerId)!;
  if (room.agentRuntime) {
    try {
      const situation =
        source === "agent-consensus"
          ? "The private readiness ballot reached the required consensus. You were selected to tell the table that discussion is over and everyone should vote now."
          : `${human.name} has called the vote. Briefly acknowledge that decision and tell everyone it is time to vote.`;
      const result = await announceVoteCall(
        room.agentRuntime,
        buildAgentContext(room, actorId, "discussion", situation),
        {
          maximumAttempts: 1,
          signal: room.abortController.signal,
          turnTimeoutMs: DISCUSSION_SPEECH_TIMEOUT_MS,
          speech: { maximumCharacters: 180 },
        },
      );
      assertRoomOpen(room);
      if (/\b(vote|voting|ballot)\b/i.test(result.decision.text)) {
        return result.decision.text;
      }
    } catch (error) {
      assertRoomOpen(room);
      degrade(room, error);
    }
  }
  return source === "agent-consensus"
    ? "Sounds like we're ready. Let's stop there and vote."
    : `${human.name}'s calling it. All right, let's vote.`;
}

async function agentVote(room: GameRoom, actorId: PlayerId) {
  const eligible = room.state.players
    .filter((player) => player.id !== actorId)
    .map((player) => player.id);
  if (room.agentRuntime) {
    try {
      const result = await collectVote(
        room.agentRuntime,
        buildAgentContext(room, actorId, "vote"),
        {
          maximumAttempts: 2,
          signal: room.abortController.signal,
        },
      );
      assertRoomOpen(room);
      if (eligible.includes(result.decision.targetParticipantId)) {
        return result.decision.targetParticipantId;
      }
    } catch (error) {
      assertRoomOpen(room);
      degrade(room, error);
    }
  }
  return eligible[stableNumber(room.state, `${actorId}:vote`) % eligible.length];
}

function buildAgentContext(
  room: GameRoom,
  actorId: PlayerId,
  phase: "night" | "discussion" | "vote",
  situationOverride?: string,
): AgentTurnContext {
  const player = room.state.players.find((candidate) => candidate.id === actorId);
  if (!player || player.kind !== "agent") throw new Error("Unknown game agent.");
  const originalRole = room.state.initialCards.players[actorId].role;
  const knownCurrent = knownCurrentRole(room.state.knowledge[actorId] ?? [], actorId);
  const nightHistory = getPlayerNightHistory(room.state, actorId).map((entry) => ({
    id: entry.id,
    roleId: entry.role,
    order: entry.order,
    status: entry.status,
    wakeCall: entry.wakeCall,
    closeCall: entry.closeCall,
    viewerWasAwake: entry.viewerWasAwake,
    didAct: entry.didAct,
    privateFacts: secretFacts(entry.privateKnowledge),
  }));
  const activeNightStep = nightHistory.find((entry) => entry.status === "active");
  return {
    gameId: room.id,
    participant: toAgentParticipant(player, true),
    participants: room.state.players.map((candidate) =>
      toAgentParticipant(candidate),
    ),
    phase,
    discussionRound: room.state.discussion.turnNumber,
    publicTranscript: publicTranscript(room.state),
    nightHistory,
    publicSituation:
      situationOverride ??
      (phase === "discussion"
        ? `Statement ${room.state.discussion.turnNumber + 1}. Discussion has no fixed statement limit; one player at a time may speak.`
        : phase === "vote"
          ? "Discussion is over. Choose one other player for elimination."
          : activeNightStep
            ? `${activeNightStep.wakeCall} This is the current public ceremony step. Take only the private action permitted by your original role.`
            : "The village is asleep. Take only the private action permitted by your original role."),
    secret: {
      originalRoleId: originalRole,
      ...(knownCurrent ? { knownCurrentRoleId: knownCurrent } : {}),
      roleRules: ROLE_DEFINITIONS[originalRole].wakeInstructions,
      nightFacts: nightHistory.flatMap((entry) => entry.privateFacts),
      availableNightActions:
        phase === "night" ? nightCapabilities(room.state, actorId, originalRole) : [],
    },
    ...(phase === "vote"
      ? {
          eligibleVoteTargetIds: room.state.players
            .filter((candidate) => candidate.id !== actorId)
            .map((candidate) => candidate.id),
        }
      : {}),
  };
}

function toAgentParticipant(
  player: GameState["players"][number],
  includeVoiceProfile = false,
): AgentParticipant {
  return {
    id: player.id,
    displayName: player.name,
    kind: player.kind === "agent" ? "llm" : "human",
    seat: player.seat,
    ...(player.kind === "agent" && player.persona ? { persona: player.persona } : {}),
    ...(includeVoiceProfile && player.kind === "agent" && player.voiceProfile
      ? { voiceProfile: player.voiceProfile }
      : {}),
  };
}

function publicTranscript(state: GameState): PublicTranscriptEntry[] {
  return state.discussion.transcript.map((message, index) => ({
    id: `speech-${message.turnNumber}-${index}`,
    kind: "speech",
    speakerId: message.speakerId,
    text: message.text,
    discussionRound: message.turnNumber,
    sequence: index + 1,
  }));
}

function secretFacts(knowledge: readonly KnowledgeItem[]): SecretNightFact[] {
  return knowledge.flatMap((item): SecretNightFact[] => {
    switch (item.type) {
      case "starting-role":
        return [];
      case "werewolf-allies":
        return [{ kind: "teammates_seen", participantIds: [...item.playerIds], team: "werewolf" }];
      case "minion-werewolves":
        return [{ kind: "teammates_seen", participantIds: [...item.playerIds], team: "werewolf" }];
      case "observed-player-card":
        return [{ kind: "role_seen", participantId: item.playerId, roleId: item.role }];
      case "observed-center-card":
        return [{ kind: "center_role_seen", centerCardId: `center-${item.centerIndex}`, roleId: item.role }];
      case "swap-performed":
        return [{ kind: "card_moved", from: slotName(item.slots[0]), to: slotName(item.slots[1]) }];
      case "action-declined":
        return [{ kind: "private_note", text: `You declined the ${item.during} swap.` }];
    }
  });
}

function slotName(slot: CardSlot) {
  return slot.kind === "player"
    ? String(slot.playerId)
    : `center-${String(slot.centerIndex)}`;
}

function nightCapabilities(
  state: GameState,
  actorId: PlayerId,
  role: RoleId,
): NightActionCapability[] {
  const otherIds = state.players.filter((player) => player.id !== actorId).map((player) => player.id);
  const centers = ["center-0", "center-1", "center-2"];
  switch (role) {
    case "werewolf": {
      const allies = state.players.filter(
        (player) => player.id !== actorId && state.initialCards.players[player.id].role === "werewolf",
      );
      return allies.length
        ? []
        : [{ kind: "view_center", minTargets: 1, maxTargets: 1, allowedCenterCardIds: centers }];
    }
    case "seer":
      return [
        { kind: "view_players", minTargets: 1, maxTargets: 1, allowedParticipantIds: otherIds },
        { kind: "view_center", minTargets: 2, maxTargets: 2, allowedCenterCardIds: centers },
      ];
    case "robber":
      return [{ kind: "swap_self_with_player", allowedParticipantIds: otherIds }];
    case "troublemaker":
      return [{ kind: "swap_players", allowedParticipantIds: otherIds }];
    case "drunk":
      return [{ kind: "swap_self_with_center", allowedCenterCardIds: centers }];
    default:
      return [];
  }
}

function mapNightDecision(
  state: GameState,
  actorId: PlayerId,
  role: NightRole,
  decision: NightActionDecision,
): NightAction {
  switch (role) {
    case "werewolf":
      return {
        type: "werewolf",
        actorId,
        ...(decision.type === "night_view_center"
          ? { centerIndex: centerIndex(decision.centerCardIds[0]) }
          : {}),
      };
    case "minion":
      return { type: "minion", actorId };
    case "seer":
      if (decision.type === "night_view_players") {
        return { type: "seer", actorId, choice: { kind: "player", playerId: decision.targetParticipantIds[0] } };
      }
      if (decision.type === "night_view_center") {
        return {
          type: "seer",
          actorId,
          choice: {
            kind: "center",
            indices: [centerIndex(decision.centerCardIds[0]), centerIndex(decision.centerCardIds[1])],
          },
        };
      }
      return fallbackNightAction(state, actorId, role);
    case "robber":
      return {
        type: "robber",
        actorId,
        targetId:
          decision.type === "night_swap_self_with_player"
            ? decision.targetParticipantId
            : null,
      };
    case "troublemaker":
      return {
        type: "troublemaker",
        actorId,
        targetIds:
          decision.type === "night_swap_players"
            ? [decision.firstParticipantId, decision.secondParticipantId]
            : null,
      };
    case "drunk":
      return decision.type === "night_swap_self_with_center"
        ? { type: "drunk", actorId, centerIndex: centerIndex(decision.centerCardId) }
        : fallbackNightAction(state, actorId, role);
    case "insomniac":
      return { type: "insomniac", actorId };
  }
}

function centerIndex(value: string): 0 | 1 | 2 {
  if (value === "center-0") return 0;
  if (value === "center-1") return 1;
  if (value === "center-2") return 2;
  throw new Error("Invalid center card id.");
}

function fallbackNightAction(
  state: GameState,
  actorId: PlayerId,
  role: NightRole,
): NightAction {
  const others = state.players.filter((player) => player.id !== actorId).map((player) => player.id);
  const pick = stableNumber(state, `${actorId}:night`);
  switch (role) {
    case "werewolf": {
      const alone = !state.players.some(
        (player) => player.id !== actorId && state.initialCards.players[player.id].role === "werewolf",
      );
      return { type: "werewolf", actorId, ...(alone ? { centerIndex: (pick % 3) as 0 | 1 | 2 } : {}) };
    }
    case "minion":
      return { type: "minion", actorId };
    case "seer":
      return pick % 2
        ? { type: "seer", actorId, choice: { kind: "player", playerId: others[pick % others.length] } }
        : { type: "seer", actorId, choice: { kind: "center", indices: [0, 2] } };
    case "robber":
      return { type: "robber", actorId, targetId: others[pick % others.length] };
    case "troublemaker": {
      const first = pick % others.length;
      const second = (first + 1) % others.length;
      return { type: "troublemaker", actorId, targetIds: [others[first], others[second]] };
    }
    case "drunk":
      return { type: "drunk", actorId, centerIndex: (pick % 3) as 0 | 1 | 2 };
    case "insomniac":
      return { type: "insomniac", actorId };
  }
}

function engineSpeechIntent(
  state: GameState,
  playerId: PlayerId,
  decision: SpeechInterestDecision,
): SpeechIntent {
  return {
    playerId,
    selfDesire: Math.round(decision.desireToSpeak),
    hearFrom: Object.fromEntries(
      state.players
        .filter((player) => player.id !== playerId)
        .map((player) => [player.id, Math.round(decision.desireToHear[player.id] ?? 0)]),
    ),
    source: "agent-tool",
    turnNumber: state.discussion.turnNumber,
  };
}

function fallbackSpeechIntent(state: GameState, playerId: PlayerId): SpeechIntent {
  const base = stableNumber(state, `${playerId}:intent:${state.discussion.turnNumber}`);
  const player = state.players.find((candidate) => candidate.id === playerId);
  const profile = player?.kind === "agent"
    ? findAgentPersonalityProfile(player.profileId)
    : undefined;
  const originalRole = state.initialCards.players[playerId].role;
  let selfDesire = 3 + (base % 7) + (profile?.talkativeness ?? 0);
  if (["seer", "robber", "troublemaker", "insomniac"].includes(originalRole)) selfDesire += 1;
  if (state.discussion.recentSpeakers.at(-1) === playerId) selfDesire = Math.max(1, selfDesire - 5);
  return {
    playerId,
    selfDesire: Math.min(10, selfDesire),
    hearFrom: Object.fromEntries(
      state.players
        .filter((player) => player.id !== playerId)
        .map((player, index) => [player.id, (base + index * 3) % 8]),
    ),
    source: "agent-tool",
    turnNumber: state.discussion.turnNumber,
  };
}

function shouldCheckVoteReadiness(state: GameState) {
  const firstCheck = Math.max(8, state.players.length * 2);
  const statements = state.discussion.turnNumber;
  return (
    state.phase === "discussion" &&
    statements >= firstCheck &&
    (statements - firstCheck) % READINESS_CHECK_INTERVAL === 0
  );
}

function fallbackVoteReadiness(state: GameState, actorId: PlayerId) {
  const speakers = new Set(
    state.discussion.transcript.map((message) => message.speakerId),
  );
  const broadParticipation =
    speakers.size >= Math.ceil(state.players.length * 0.6);
  return broadParticipation && speakers.has(actorId);
}

function fallbackSpeech(state: GameState, actorId: PlayerId) {
  const actor = state.players.find((player) => player.id === actorId)!;
  const others = state.players.filter((player) => player.id !== actorId);
  const priorSpeakerIds = new Set(
    state.discussion.transcript
      .map((message) => message.speakerId)
      .filter((speakerId) => speakerId !== actorId),
  );
  const priorSpeakers = others.filter((player) => priorSpeakerIds.has(player.id));
  const profile = actor.kind === "agent"
    ? findAgentPersonalityProfile(actor.profileId)
    : undefined;
  if (priorSpeakers.length === 0) {
    const openings = [
      "Okay, who actually learned something last night?",
      "I've got no read yet. Did anyone see a card?",
      "So, does anyone have a real night claim, or are we all guessing?",
      "I'm starting with nothing. Someone give me one useful fact.",
      "All right, what's the strongest thing anyone actually knows?",
    ];
    return openings[
      stableNumber(state, `${actorId}:opening:${state.discussion.turnNumber}`) % openings.length
    ];
  }

  const target = priorSpeakers[
    stableNumber(state, `${actorId}:speech`) % priorSpeakers.length
  ];
  const templates = profile?.rehearsalLines ?? [
    "Okay, {target}, what made you land there?",
    "I'm not totally buying that. Something feels off.",
    "Wait, {target} — did your card move, or are you guessing?",
    "Hang on. I think those stories clash.",
  ];
  return templates[
    stableNumber(state, `${actorId}:line:${state.discussion.turnNumber}`) % templates.length
  ].replaceAll("{target}", target.name);
}

function stableNumber(state: GameState, salt: string) {
  return hashSeed(`${state.seed}:${salt}`);
}

function degrade(room: GameRoom, error: unknown) {
  room.degradedAgents = true;
  const provider = room.mode === "openai" ? "OpenAI API" : "Codex";
  room.notice = `One or more ${provider} turns failed, so a deterministic understudy completed that move.`;
  const detail = error instanceof Error ? error.message : "Unknown agent error";
  console.error(`[game-agent] ${detail.slice(0, 500)}`);
}

function knownCurrentRole(
  knowledge: readonly KnowledgeItem[],
  playerId: PlayerId,
): RoleId | null {
  const observed = [...knowledge].reverse().find(
    (item): item is Extract<KnowledgeItem, { type: "observed-player-card" }> =>
      item.type === "observed-player-card" &&
      item.playerId === playerId &&
      item.during === "insomniac",
  );
  return observed?.role ?? null;
}

function roleView(role: RoleId): RoleView {
  const definition = ROLE_DEFINITIONS[role];
  return {
    id: role,
    name: definition.name,
    team: definition.team,
    wakeInstructions: definition.wakeInstructions,
  };
}

function snapshot(room: GameRoom): GameSnapshot {
  const state = room.state;
  const ownInitialRole = state.initialCards.players[room.viewerId].role;
  const ownKnowledge = [...(state.knowledge[room.viewerId] ?? [])];
  const knownCurrent = knownCurrentRole(ownKnowledge, room.viewerId);
  const nightPrompt = playerNightPrompt(state, room.viewerId);
  const currentNightTurn = getCurrentNightTurn(state);
  const nightHistory: NightHistoryEntryView[] = getPlayerNightHistory(
    state,
    room.viewerId,
  ).map((entry) => ({
    id: entry.id,
    role: entry.role,
    roleName: ROLE_DEFINITIONS[entry.role].name,
    order: entry.order,
    status: entry.status,
    wakeCall: entry.wakeCall,
    closeCall: entry.closeCall,
    viewerWasAwake: entry.viewerWasAwake,
    didAct: entry.didAct,
    privateKnowledge: [...entry.privateKnowledge],
  }));
  const resolved = state.phase === "resolved" && state.resolution;
  const publicPlayers: PublicPlayerView[] = state.players.map((player) => {
    const lastMessage = [...state.discussion.transcript]
      .reverse()
      .find((message) => message.speakerId === player.id);
    return {
      id: player.id,
      name: player.name,
      kind: player.kind,
      seat: player.seat,
      avatar: player.avatar || initials(player.name),
      ...(player.kind === "agent" && player.persona ? { persona: player.persona } : {}),
      isYou: player.id === room.viewerId,
      lastSpokeTurn: lastMessage?.turnNumber ?? null,
      hasVoted: Object.hasOwn(state.voting.votes, player.id),
    };
  });
  const transcript: TranscriptEntryView[] = [
    ...(state.phase !== "night"
      ? [
          {
            id: "system-dawn",
            turnNumber: -1,
            speakerId: null,
            speakerName: "The village",
            text: "Dawn breaks. The cards have stopped moving, but nobody knows where every role now rests.",
            kind: "system" as const,
          },
        ]
      : []),
    ...state.discussion.transcript.map((message, index) => ({
      id: `message-${message.turnNumber}-${index}`,
      turnNumber: message.turnNumber,
      speakerId: message.speakerId,
      speakerName:
        state.players.find((player) => player.id === message.speakerId)?.name ?? "Unknown",
      text: message.text,
      kind: "speech" as const,
    })),
    ...(room.voteCallNotice
      ? [
          {
            id: "system-vote-called",
            turnNumber: room.voteCallNotice.announcementTurnNumber,
            speakerId: null,
            speakerName: "The village",
            text:
              room.voteCallNotice.source === "agent-consensus"
                ? "The village agrees: discussion is over, and voting begins."
                : "The vote has been called. Voting begins.",
            kind: "system" as const,
          },
        ]
      : []),
  ];
  const resolution: ResolutionView | null = resolved
    ? {
        eliminatedPlayerIds: [...resolved.eliminatedPlayerIds],
        winnerPlayerIds: [...resolved.winnerPlayerIds],
        winningTeams: [...resolved.winningTeams],
        reasons: [...resolved.reasons],
        rolesAtEnd: { ...resolved.rolesAtEnd },
        votes: { ...resolved.votes },
        tally: { ...resolved.tally },
        playerWon: resolved.winnerPlayerIds.includes(room.viewerId),
      }
    : null;
  return {
    gameId: room.id,
    revision: state.revision,
    mode: room.mode,
    phase: state.phase,
    phaseLabel: phaseLabel(state.phase),
    viewerId: room.viewerId,
    players: publicPlayers,
    ownInitialRole: roleView(ownInitialRole),
    ownKnownCurrentRole: knownCurrent ? roleView(knownCurrent) : null,
    ownKnowledge,
    nightPrompt,
    nightHistory,
    mayAdvanceNight:
      state.phase === "night" &&
      !nightPrompt &&
      (!currentNightTurn ||
        state.players.find((player) => player.id === currentNightTurn.actorId)?.kind ===
          "agent"),
    centerCards: ([0, 1, 2] as const).map((index) => ({
      index,
      role: resolved ? state.cards.center[index].role : null,
    })),
    dialogue: {
      turnNumber: state.discussion.turnNumber,
      activeSpeakerId: state.discussion.activeSpeakerId,
      humanMaySpeak: state.discussion.activeSpeakerId === room.viewerId,
      busy: false,
      recentSpeakerIds: [...state.discussion.recentSpeakers],
      transcript,
      lastScores: [],
    },
    votesCast: Object.keys(state.voting.votes).length,
    ownVote: Object.hasOwn(state.voting.votes, room.viewerId)
      ? (state.voting.votes[room.viewerId] ?? null)
      : null,
    resolution,
    degradedAgents: room.degradedAgents,
    notice: room.notice,
  };
}

function phaseLabel(phase: GameState["phase"]) {
  switch (phase) {
    case "night":
      return "Night actions";
    case "discussion":
      return "Open discussion";
    case "voting":
      return "Final vote";
    case "resolved":
      return "The reckoning";
  }
}

function playerNightPrompt(state: GameState, playerId: PlayerId) {
  if (state.phase !== "night" || getCurrentNightTurn(state)?.actorId !== playerId) {
    return null;
  }
  const context = getNightContext(state, playerId);
  if (!context) return null;
  return {
    actorId: context.actorId,
    role: context.role,
    instructions: context.instructions,
    otherPlayerIds: [...context.otherPlayerIds],
    centerIndices: [...context.centerIndices],
    ...(context.knownWerewolfPlayerIds
      ? { knownWerewolfPlayerIds: [...context.knownWerewolfPlayerIds] }
      : {}),
  };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}
