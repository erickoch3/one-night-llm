import { getNightContext } from "./night.js";
import { ROLE_DEFINITIONS } from "./roles.js";
import type {
  EventVisibility,
  GameEvent,
  GameState,
  GameView,
  KnowledgeItem,
  NightRole,
  PlayerId,
  PlayerNightHistoryEntry,
  PublicPlayer,
  Result,
} from "./types.js";

/**
 * Produces a player-safe, JSON-serializable projection. Never send the full
 * GameState to a browser: it necessarily contains every hidden card.
 */
export function getGameView(
  state: GameState,
  viewerId: PlayerId,
): Result<GameView> {
  if (!state.players.some((player) => player.id === viewerId)) {
    return {
      ok: false,
      error: { code: "UNKNOWN_PLAYER", message: `Unknown player ${viewerId}.` },
    };
  }

  const resolved = state.phase === "resolved";
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      gameId: state.gameId,
      revision: state.revision,
      phase: state.phase,
      players: state.players.map(toPublicPlayer),
      ownKnowledge: state.knowledge[viewerId] ?? [],
      nightContext: getNightContext(state, viewerId),
      nightHistory: getPlayerNightHistory(state, viewerId),
      discussion: {
        turnNumber: state.discussion.turnNumber,
        activeSpeakerId: state.discussion.activeSpeakerId,
        recentSpeakers: state.discussion.recentSpeakers,
        transcript: state.discussion.transcript,
      },
      votesCast: Object.keys(state.voting.votes).length,
      ownVote: Object.hasOwn(state.voting.votes, viewerId)
        ? (state.voting.votes[viewerId] ?? null)
        : null,
      revealedInitialCards: resolved ? state.initialCards : null,
      revealedFinalCards: resolved ? state.cards : null,
      resolution: resolved ? state.resolution : null,
      events: getVisibleEvents(state.events, viewerId),
    },
  };
}

/**
 * Builds the common chronological ceremony plus only the facts this viewer was
 * entitled to learn. No actor list or action belonging to another player is
 * ever copied into this projection.
 */
export function getPlayerNightHistory(
  state: GameState,
  viewerId: PlayerId,
): readonly PlayerNightHistoryEntry[] {
  const viewerCard = state.initialCards.players[viewerId];
  if (!viewerCard) return [];

  const ownKnowledge = state.knowledge[viewerId] ?? [];
  return state.night.ceremonySteps.map((step, index) => {
    const status =
      state.phase === "night" && index === state.night.ceremonyCursor
        ? "active"
        : state.phase === "night" && index > state.night.ceremonyCursor
          ? "upcoming"
          : "complete";
    const viewerWasAwake =
      status !== "upcoming" && viewerCard.role === step.role;
    const didAct =
      viewerWasAwake && state.night.completedPlayerIds.includes(viewerId);
    const privateKnowledge =
      status === "upcoming"
        ? []
        : ownKnowledge.filter((item) => knowledgeBelongsToRole(item, step.role));

    if (status === "active" && viewerWasAwake) {
      addIdentityKnowledgeAvailableOnWake(
        privateKnowledge,
        state,
        viewerId,
        step.role,
      );
    }

    const definition = ROLE_DEFINITIONS[step.role];
    return {
      id: step.id,
      role: step.role,
      order: step.order,
      status,
      wakeCall: definition.wakeCall ?? definition.wakeInstructions,
      closeCall: definition.closeCall ?? `${definition.name}, close your eyes.`,
      viewerWasAwake,
      didAct,
      privateKnowledge,
    };
  });
}

export function getVisibleEvents(
  events: readonly GameEvent[],
  viewerId: PlayerId,
): readonly GameEvent[] {
  return events.filter((event) => isVisibleTo(event.visibility, viewerId));
}

function knowledgeBelongsToRole(item: KnowledgeItem, role: NightRole): boolean {
  switch (item.type) {
    case "starting-role":
      return false;
    case "werewolf-allies":
      return role === "werewolf";
    case "minion-werewolves":
      return role === "minion";
    case "observed-player-card":
    case "observed-center-card":
    case "swap-performed":
    case "action-declined":
      return item.during === role;
  }
}

function addIdentityKnowledgeAvailableOnWake(
  knowledge: KnowledgeItem[],
  state: GameState,
  viewerId: PlayerId,
  role: NightRole,
) {
  const originalWerewolfIds = state.players
    .filter((player) => state.initialCards.players[player.id].role === "werewolf")
    .map((player) => player.id);
  if (
    role === "werewolf" &&
    !knowledge.some((item) => item.type === "werewolf-allies")
  ) {
    const allies = originalWerewolfIds.filter((id) => id !== viewerId);
    knowledge.push({
      type: "werewolf-allies",
      playerIds: allies,
      isLoneWerewolf: allies.length === 0,
    });
  }
  if (
    role === "minion" &&
    !knowledge.some((item) => item.type === "minion-werewolves")
  ) {
    knowledge.push({ type: "minion-werewolves", playerIds: originalWerewolfIds });
  }
}

export function isVisibleTo(
  visibility: EventVisibility,
  viewerId: PlayerId,
): boolean {
  if (visibility.kind === "public") return true;
  if (visibility.kind === "server") return false;
  return visibility.playerIds.includes(viewerId);
}

function toPublicPlayer(player: GameState["players"][number]): PublicPlayer {
  return {
    kind: player.kind,
    id: player.id,
    name: player.name,
    seat: player.seat,
    ...(player.avatar ? { avatar: player.avatar } : {}),
  };
}

/** A backwards-friendly name emphasizing that this function redacts secrets. */
export const projectGameForPlayer = getGameView;
