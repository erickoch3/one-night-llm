import { ROLE_DEFINITIONS } from "./roles.js";
import type {
  CardLayout,
  CenterIndex,
  DomainIssue,
  GameEvent,
  GameState,
  GameTransition,
  JsonSchema,
  KnowledgeItem,
  NightAction,
  NightCeremonyStep,
  NightContext,
  NightRole,
  NightTurn,
  PlayerId,
  Result,
  RoleCard,
  ToolDefinition,
} from "./types.js";

const CENTER_INDICES: readonly CenterIndex[] = [0, 1, 2];

export function getCurrentNightCeremonyStep(
  state: GameState,
): NightCeremonyStep | null {
  if (state.phase !== "night") return null;
  return state.night.ceremonySteps[state.night.ceremonyCursor] ?? null;
}

export function getCurrentNightTurn(state: GameState): NightTurn | null {
  const step = getCurrentNightCeremonyStep(state);
  if (!step) return null;
  const turn = state.night.queue[state.night.cursor] ?? null;
  return turn?.role === step.role ? turn : null;
}

/**
 * Returns only decision-time information the current actor is allowed to know.
 * Pass a player id to safely use it in a player-facing projection.
 */
export function getNightContext(
  state: GameState,
  playerId?: PlayerId,
): NightContext | null {
  const turn = getCurrentNightTurn(state);
  if (!turn || (playerId !== undefined && playerId !== turn.actorId)) return null;

  const otherPlayerIds = state.players
    .filter((player) => player.id !== turn.actorId)
    .map((player) => player.id);
  const originalWerewolves = state.players
    .filter((player) => state.initialCards.players[player.id].role === "werewolf")
    .map((player) => player.id);

  return {
    actorId: turn.actorId,
    role: turn.role,
    instructions: ROLE_DEFINITIONS[turn.role].wakeInstructions,
    otherPlayerIds,
    centerIndices: CENTER_INDICES,
    ...(turn.role === "werewolf"
      ? {
          knownWerewolfPlayerIds: originalWerewolves.filter(
            (id) => id !== turn.actorId,
          ),
        }
      : {}),
    ...(turn.role === "minion"
      ? { knownWerewolfPlayerIds: originalWerewolves }
      : {}),
  };
}

export function validateNightAction(
  state: GameState,
  action: NightAction,
): Result<NightTurn> {
  if (state.phase !== "night") {
    return failure("WRONG_PHASE", "Night actions are only valid during the night phase.");
  }
  if (!state.players.some((player) => player.id === action.actorId)) {
    return failure("UNKNOWN_PLAYER", `Unknown player ${action.actorId}.`);
  }

  const turn = getCurrentNightTurn(state);
  if (!turn) {
    return failure("WRONG_PHASE", "There is no remaining night action.");
  }
  if (turn.actorId !== action.actorId) {
    return failure(
      "NOT_CURRENT_ACTOR",
      `It is not ${action.actorId}'s night turn.`,
    );
  }
  if (turn.role !== action.type) {
    return failure(
      "WRONG_ACTION",
      `The ${turn.role} must submit a ${turn.role} action, not ${action.type}.`,
    );
  }

  switch (action.type) {
    case "werewolf": {
      if (action.centerIndex !== undefined && !isCenterIndex(action.centerIndex)) {
        return invalidCenter(action.centerIndex);
      }
      const originalWerewolfCount = state.players.filter(
        (player) => state.initialCards.players[player.id].role === "werewolf",
      ).length;
      if (originalWerewolfCount > 1 && action.centerIndex !== undefined) {
        return failure(
          "INVALID_TARGET",
          "Only a lone Werewolf may inspect a center card.",
        );
      }
      break;
    }
    case "minion":
    case "insomniac":
      break;
    case "seer": {
      if (action.choice.kind === "player") {
        if (!isOtherPlayer(state, action.actorId, action.choice.playerId)) {
          return invalidTarget("The Seer must inspect one other player.");
        }
      } else {
        const [first, second] = action.choice.indices;
        if (!isCenterIndex(first) || !isCenterIndex(second)) {
          return invalidCenter(!isCenterIndex(first) ? first : second);
        }
        if (first === second) {
          return invalidTarget("The Seer must inspect two different center cards.");
        }
      }
      break;
    }
    case "robber":
      if (
        action.targetId !== null &&
        !isOtherPlayer(state, action.actorId, action.targetId)
      ) {
        return invalidTarget("The Robber may only swap with another player.");
      }
      break;
    case "troublemaker":
      if (action.targetIds !== null) {
        const [first, second] = action.targetIds;
        if (
          first === second ||
          !isOtherPlayer(state, action.actorId, first) ||
          !isOtherPlayer(state, action.actorId, second)
        ) {
          return invalidTarget(
            "The Troublemaker must choose two different players other than themself.",
          );
        }
      }
      break;
    case "drunk":
      if (!isCenterIndex(action.centerIndex)) {
        return invalidCenter(action.centerIndex);
      }
      break;
  }

  return { ok: true, value: turn };
}

export function applyNightAction(
  state: GameState,
  action: NightAction,
): Result<GameTransition> {
  const validation = validateNightAction(state, action);
  if (!validation.ok) return validation;

  const turn = validation.value;
  let cards = state.cards;
  const gained: KnowledgeItem[] = [];

  switch (action.type) {
    case "werewolf": {
      const allies = state.players
        .filter(
          (player) =>
            player.id !== action.actorId &&
            state.initialCards.players[player.id].role === "werewolf",
        )
        .map((player) => player.id);
      gained.push({
        type: "werewolf-allies",
        playerIds: allies,
        isLoneWerewolf: allies.length === 0,
      });
      if (action.centerIndex !== undefined) {
        const card = cards.center[action.centerIndex];
        gained.push({
          type: "observed-center-card",
          centerIndex: action.centerIndex,
          cardId: card.id,
          role: card.role,
          during: "werewolf",
        });
      }
      break;
    }
    case "minion": {
      gained.push({
        type: "minion-werewolves",
        playerIds: state.players
          .filter(
            (player) => state.initialCards.players[player.id].role === "werewolf",
          )
          .map((player) => player.id),
      });
      break;
    }
    case "seer": {
      if (action.choice.kind === "player") {
        const card = cards.players[action.choice.playerId];
        gained.push({
          type: "observed-player-card",
          playerId: action.choice.playerId,
          cardId: card.id,
          role: card.role,
          during: "seer",
        });
      } else {
        for (const centerIndex of action.choice.indices) {
          const card = cards.center[centerIndex];
          gained.push({
            type: "observed-center-card",
            centerIndex,
            cardId: card.id,
            role: card.role,
            during: "seer",
          });
        }
      }
      break;
    }
    case "robber": {
      if (action.targetId === null) {
        gained.push({ type: "action-declined", during: "robber" });
      } else {
        cards = swapPlayerCards(cards, action.actorId, action.targetId);
        const received = cards.players[action.actorId];
        gained.push(
          {
            type: "swap-performed",
            during: "robber",
            slots: [
              { kind: "player", playerId: action.actorId },
              { kind: "player", playerId: action.targetId },
            ],
          },
          {
            type: "observed-player-card",
            playerId: action.actorId,
            cardId: received.id,
            role: received.role,
            during: "robber",
          },
        );
      }
      break;
    }
    case "troublemaker": {
      if (action.targetIds === null) {
        gained.push({ type: "action-declined", during: "troublemaker" });
      } else {
        const [first, second] = action.targetIds;
        cards = swapPlayerCards(cards, first, second);
        gained.push({
          type: "swap-performed",
          during: "troublemaker",
          slots: [
            { kind: "player", playerId: first },
            { kind: "player", playerId: second },
          ],
        });
      }
      break;
    }
    case "drunk": {
      cards = swapPlayerWithCenter(cards, action.actorId, action.centerIndex);
      gained.push({
        type: "swap-performed",
        during: "drunk",
        slots: [
          { kind: "player", playerId: action.actorId },
          { kind: "center", centerIndex: action.centerIndex },
        ],
      });
      break;
    }
    case "insomniac": {
      const card = cards.players[action.actorId];
      gained.push({
        type: "observed-player-card",
        playerId: action.actorId,
        cardId: card.id,
        role: card.role,
        during: "insomniac",
      });
      break;
    }
  }

  const nextCursor = state.night.cursor + 1;
  let sequence = nextEventSequence(state);
  const newEvents: GameEvent[] = [];
  if (gained.length > 0) {
    newEvents.push({
      sequence,
      type: "knowledge.gained",
      visibility: { kind: "private", playerIds: [action.actorId] },
      data: { playerId: action.actorId, items: gained },
    });
    sequence += 1;
  }
  newEvents.push({
    sequence,
    type: "night.action-completed",
    visibility: { kind: "server" },
    data: { actorId: action.actorId, role: turn.role, action },
  });

  const stateKnowledge = state.knowledge[action.actorId] ?? [];
  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    cards,
    knowledge: {
      ...state.knowledge,
      [action.actorId]: [...stateKnowledge, ...gained],
    },
    night: {
      ...state.night,
      cursor: nextCursor,
      completedPlayerIds: [
        ...state.night.completedPlayerIds,
        action.actorId,
      ],
    },
    events: [...state.events, ...newEvents],
  };

  return { ok: true, value: { state: nextState, events: newEvents } };
}

/**
 * Closes the active public ceremony role after every player holding that
 * original role has acted. Empty (center-only) steps can be closed directly.
 */
export function completeNightCeremonyStep(
  state: GameState,
): Result<GameTransition> {
  if (state.phase !== "night") {
    return failure("WRONG_PHASE", "A night ceremony step can only complete at night.");
  }
  const step = getCurrentNightCeremonyStep(state);
  if (!step) {
    return failure("WRONG_PHASE", "There is no active night ceremony step.");
  }

  const actorStillWaiting = state.night.queue
    .slice(state.night.cursor)
    .some((turn) => turn.role === step.role);
  if (actorStillWaiting) {
    return failure(
      "INCOMPLETE_NIGHT_STEP",
      `The ${ROLE_DEFINITIONS[step.role].name} ceremony cannot close while an entitled player still has an action.`,
    );
  }

  let sequence = nextEventSequence(state);
  const definition = ROLE_DEFINITIONS[step.role];
  const newEvents: GameEvent[] = [
    {
      sequence,
      type: "night.role-closed",
      visibility: { kind: "public" },
      data: {
        stepId: step.id,
        role: step.role,
        order: step.order,
        closeCall: definition.closeCall ?? `${definition.name}, close your eyes.`,
      },
    },
  ];
  sequence += 1;

  const nextCeremonyCursor = state.night.ceremonyCursor + 1;
  const nextStep = state.night.ceremonySteps[nextCeremonyCursor];
  if (nextStep) {
    const nextDefinition = ROLE_DEFINITIONS[nextStep.role];
    newEvents.push({
      sequence,
      type: "night.role-opened",
      visibility: { kind: "public" },
      data: {
        stepId: nextStep.id,
        role: nextStep.role,
        order: nextStep.order,
        wakeCall: nextDefinition.wakeCall ?? nextDefinition.wakeInstructions,
      },
    });
  } else {
    newEvents.push({
      sequence,
      type: "night.completed",
      visibility: { kind: "public" },
      data: {},
    });
  }

  const nextState: GameState = {
    ...state,
    revision: state.revision + 1,
    phase: nextStep ? "night" : "discussion",
    night: {
      ...state.night,
      ceremonyCursor: nextCeremonyCursor,
    },
    events: [...state.events, ...newEvents],
  };
  return { ok: true, value: { state: nextState, events: newEvents } };
}

/** Dynamic JSON schema suitable for an LLM function/tool declaration. */
export function getNightActionTool(
  state: GameState,
  actorId: PlayerId,
): ToolDefinition | null {
  const context = getNightContext(state, actorId);
  if (!context) return null;

  const playerIdSchema: JsonSchema = {
    type: "string",
    enum: context.otherPlayerIds,
  };
  const centerIndexSchema: JsonSchema = {
    type: "integer",
    enum: CENTER_INDICES,
  };
  let inputSchema: JsonSchema;

  switch (context.role) {
    case "werewolf":
      inputSchema = {
        type: "object",
        properties:
          (context.knownWerewolfPlayerIds?.length ?? 0) === 0
            ? {
                centerIndex: {
                  ...centerIndexSchema,
                  description: "Optional center card to inspect as the lone Werewolf.",
                },
              }
            : {},
        additionalProperties: false,
      };
      break;
    case "minion":
    case "insomniac":
      inputSchema = { type: "object", properties: {}, additionalProperties: false };
      break;
    case "seer":
      inputSchema = {
        oneOf: [
          {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["player"] },
              playerId: playerIdSchema,
            },
            required: ["mode", "playerId"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["center"] },
              centerIndices: {
                type: "array",
                items: centerIndexSchema,
                minItems: 2,
                maxItems: 2,
                uniqueItems: true,
              },
            },
            required: ["mode", "centerIndices"],
            additionalProperties: false,
          },
        ],
      };
      break;
    case "robber":
      inputSchema = {
        type: "object",
        properties: {
          targetId: {
            oneOf: [playerIdSchema, { type: "null" }],
            description: "Another player to rob, or null to decline.",
          },
        },
        required: ["targetId"],
        additionalProperties: false,
      };
      break;
    case "troublemaker":
      inputSchema = {
        type: "object",
        properties: {
          targetIds: {
            oneOf: [
              {
                type: "array",
                items: playerIdSchema,
                minItems: 2,
                maxItems: 2,
                uniqueItems: true,
              },
              { type: "null" },
            ],
            description: "Two other players to swap, or null to decline.",
          },
        },
        required: ["targetIds"],
        additionalProperties: false,
      };
      break;
    case "drunk":
      inputSchema = {
        type: "object",
        properties: { centerIndex: centerIndexSchema },
        required: ["centerIndex"],
        additionalProperties: false,
      };
      break;
  }

  return {
    name: "perform_night_action",
    description: context.instructions,
    inputSchema,
  };
}

/** Converts an untrusted tool payload into the action union used by the reducer. */
export function parseNightActionToolInput(
  state: GameState,
  actorId: PlayerId,
  input: unknown,
): Result<NightAction> {
  if (state.phase !== "night") {
    return failure("WRONG_PHASE", "Night actions are only valid during the night phase.");
  }
  const turn = getCurrentNightTurn(state);
  if (!turn || turn.actorId !== actorId) {
    return failure("NOT_CURRENT_ACTOR", `${actorId} is not the current night actor.`);
  }
  if (!isPlainRecord(input)) {
    return malformedAction("Night action arguments must be an object.");
  }

  let action: NightAction;
  switch (turn.role) {
    case "werewolf": {
      if (!hasOnlyKeys(input, ["centerIndex"])) {
        return malformedAction("Werewolf arguments may only contain centerIndex.");
      }
      if (input.centerIndex !== undefined && !isCenterIndex(input.centerIndex)) {
        return invalidCenter(input.centerIndex);
      }
      action = {
        type: "werewolf",
        actorId,
        ...(input.centerIndex === undefined
          ? {}
          : { centerIndex: input.centerIndex }),
      };
      break;
    }
    case "minion":
    case "insomniac": {
      if (!hasOnlyKeys(input, [])) {
        return malformedAction(`${turn.role} takes no arguments.`);
      }
      action = { type: turn.role, actorId };
      break;
    }
    case "seer": {
      if (input.mode === "player") {
        if (
          !hasExactKeys(input, ["mode", "playerId"]) ||
          typeof input.playerId !== "string"
        ) {
          return malformedAction("Seer player mode requires exactly mode and playerId.");
        }
        action = {
          type: "seer",
          actorId,
          choice: { kind: "player", playerId: input.playerId },
        };
      } else if (input.mode === "center") {
        if (
          !hasExactKeys(input, ["mode", "centerIndices"]) ||
          !Array.isArray(input.centerIndices) ||
          input.centerIndices.length !== 2 ||
          !isCenterIndex(input.centerIndices[0]) ||
          !isCenterIndex(input.centerIndices[1])
        ) {
          return malformedAction(
            "Seer center mode requires exactly two valid centerIndices.",
          );
        }
        action = {
          type: "seer",
          actorId,
          choice: {
            kind: "center",
            indices: [input.centerIndices[0], input.centerIndices[1]],
          },
        };
      } else {
        return malformedAction("Seer mode must be player or center.");
      }
      break;
    }
    case "robber": {
      if (
        !hasExactKeys(input, ["targetId"]) ||
        (input.targetId !== null && typeof input.targetId !== "string")
      ) {
        return malformedAction("Robber targetId must be another player id or null.");
      }
      action = { type: "robber", actorId, targetId: input.targetId };
      break;
    }
    case "troublemaker": {
      if (!hasExactKeys(input, ["targetIds"])) {
        return malformedAction("Troublemaker requires targetIds.");
      }
      if (input.targetIds === null) {
        action = { type: "troublemaker", actorId, targetIds: null };
      } else if (
        Array.isArray(input.targetIds) &&
        input.targetIds.length === 2 &&
        typeof input.targetIds[0] === "string" &&
        typeof input.targetIds[1] === "string"
      ) {
        action = {
          type: "troublemaker",
          actorId,
          targetIds: [input.targetIds[0], input.targetIds[1]],
        };
      } else {
        return malformedAction("Troublemaker targetIds must be two player ids or null.");
      }
      break;
    }
    case "drunk": {
      if (!hasExactKeys(input, ["centerIndex"]) || !isCenterIndex(input.centerIndex)) {
        return malformedAction("Drunk centerIndex must be 0, 1, or 2.");
      }
      action = { type: "drunk", actorId, centerIndex: input.centerIndex };
      break;
    }
  }

  const validation = validateNightAction(state, action);
  return validation.ok ? { ok: true, value: action } : validation;
}

function swapPlayerCards(
  cards: CardLayout,
  firstId: PlayerId,
  secondId: PlayerId,
): CardLayout {
  const players = { ...cards.players };
  [players[firstId], players[secondId]] = [players[secondId], players[firstId]];
  return { players, center: cards.center };
}

function swapPlayerWithCenter(
  cards: CardLayout,
  playerId: PlayerId,
  centerIndex: CenterIndex,
): CardLayout {
  const players = { ...cards.players };
  const center: [RoleCard, RoleCard, RoleCard] = [...cards.center];
  [players[playerId], center[centerIndex]] = [center[centerIndex], players[playerId]];
  return { players, center };
}

function isCenterIndex(index: unknown): index is CenterIndex {
  return index === 0 || index === 1 || index === 2;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isOtherPlayer(
  state: GameState,
  actorId: PlayerId,
  targetId: PlayerId,
): boolean {
  return (
    targetId !== actorId && state.players.some((player) => player.id === targetId)
  );
}

function nextEventSequence(state: GameState): number {
  return (state.events[state.events.length - 1]?.sequence ?? 0) + 1;
}

function failure<T = never>(
  code: DomainIssue["code"],
  message: string,
): Result<T> {
  return { ok: false, error: { code, message } };
}

function invalidTarget(message: string): Result<never> {
  return failure("INVALID_TARGET", message);
}

function invalidCenter(value: unknown): Result<never> {
  return failure(
    "INVALID_CENTER_CARD",
    `Center index must be 0, 1, or 2; received ${String(value)}.`,
  );
}

function malformedAction(message: string): Result<never> {
  return failure("WRONG_ACTION", message);
}

/** Maps a wake role to its corresponding action discriminator. */
export function actionTypeForNightRole(role: NightRole): NightAction["type"] {
  return role;
}
