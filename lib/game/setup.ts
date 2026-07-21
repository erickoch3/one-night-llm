import { isNightRole, ROLE_DEFINITIONS } from "./roles.js";
import {
  ROLE_IDS,
  type AgentPlayer,
  type CardLayout,
  type DomainIssue,
  type GameEvent,
  type GameSetup,
  type GameState,
  type HumanPlayer,
  type KnowledgeItem,
  type NightCeremonyStep,
  type NightTurn,
  type Player,
  type PlayerId,
  type Result,
  type RoleCard,
  type RoleId,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function createHumanPlayer(input: {
  readonly id: string;
  readonly name: string;
  readonly seat: number;
  readonly userId: string;
  readonly avatar?: string;
}): HumanPlayer {
  return { kind: "human", ...input };
}

export function createAgentPlayer(input: {
  readonly id: string;
  readonly name: string;
  readonly seat: number;
  readonly model: string;
  readonly profileId?: string;
  readonly persona?: string;
  readonly voiceProfile?: string;
  readonly avatar?: string;
}): AgentPlayer {
  return { kind: "agent", ...input };
}

export function validateSetup(setup: GameSetup): readonly DomainIssue[] {
  const issues: DomainIssue[] = [];

  if (!setup.gameId.trim()) {
    issues.push(issue("gameId", "A non-empty gameId is required."));
  }
  if (!setup.seed.trim()) {
    issues.push(issue("seed", "A non-empty deterministic shuffle seed is required."));
  }
  if (setup.players.length < 3) {
    issues.push(issue("players", "One Night requires at least three total players."));
  }
  if (setup.roles.length !== setup.players.length + 3) {
    issues.push(
      issue(
        "roles",
        `Expected ${setup.players.length + 3} roles (${setup.players.length} players plus three center cards), received ${setup.roles.length}.`,
      ),
    );
  }

  const ids = new Set<string>();
  const seats = new Set<number>();
  setup.players.forEach((player, index) => {
    const path = `players.${index}`;
    if (!SAFE_ID.test(player.id)) {
      issues.push(
        issue(
          `${path}.id`,
          "Player ids must start with a letter or number and contain only letters, numbers, underscores, or hyphens (maximum 64 characters).",
        ),
      );
    }
    if (ids.has(player.id)) {
      issues.push(issue(`${path}.id`, `Duplicate player id ${player.id}.`));
    }
    ids.add(player.id);

    if (!player.name.trim()) {
      issues.push(issue(`${path}.name`, "Player names cannot be empty."));
    }
    if (!Number.isInteger(player.seat) || player.seat < 0) {
      issues.push(issue(`${path}.seat`, "Seats must be non-negative integers."));
    }
    if (seats.has(player.seat)) {
      issues.push(issue(`${path}.seat`, `Seat ${player.seat} is already occupied.`));
    }
    seats.add(player.seat);

    if (player.kind === "human" && !player.userId.trim()) {
      issues.push(issue(`${path}.userId`, "Human players require a userId."));
    }
    if (player.kind === "agent" && !player.model.trim()) {
      issues.push(issue(`${path}.model`, "Agent players require a model identifier."));
    }
  });

  const validRoles = new Set<string>(ROLE_IDS);
  setup.roles.forEach((role, index) => {
    if (!validRoles.has(role)) {
      issues.push(issue(`roles.${index}`, `Unknown role ${String(role)}.`));
    }
  });

  return issues;
}

/** Deterministic, platform-independent FNV-1a hash. */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Fisher-Yates using a seeded mulberry32 stream; it never calls Math.random. */
export function deterministicShuffle<T>(
  input: readonly T[],
  seed: string,
): readonly T[] {
  const result = [...input];
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(next() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/**
 * Validates, deterministically shuffles, and deals the complete game. The
 * returned state begins at the first publicly announced ceremony role. A role
 * remains in the ceremony even when every copy was dealt to the center.
 */
export function dealGame(setup: GameSetup): Result<GameState> {
  const setupIssues = validateSetup(setup);
  if (setupIssues.length > 0) {
    return { ok: false, error: setupIssues[0] };
  }

  const players = [...setup.players].sort(
    (left, right) => left.seat - right.seat || left.id.localeCompare(right.id),
  );
  const cards: RoleCard[] = setup.roles.map((role, index) => ({
    id: `card-${String(index + 1).padStart(2, "0")}`,
    role,
  }));
  const shuffled = deterministicShuffle(cards, `${setup.gameId}:${setup.seed}`);

  const playerCards: Record<PlayerId, RoleCard> = Object.fromEntries(
    players.map((player, index) => [player.id, shuffled[index]]),
  );
  const centerOffset = players.length;
  const center = [
    shuffled[centerOffset],
    shuffled[centerOffset + 1],
    shuffled[centerOffset + 2],
  ] as const;
  const initialCards: CardLayout = { players: playerCards, center };

  const knowledge: Record<PlayerId, readonly KnowledgeItem[]> = Object.fromEntries(
    players.map((player) => {
      const card = playerCards[player.id];
      return [
        player.id,
        [{ type: "starting-role", cardId: card.id, role: card.role } satisfies KnowledgeItem],
      ];
    }),
  );

  const queue: NightTurn[] = players
    .flatMap((player): NightTurn[] => {
      const role = playerCards[player.id].role;
      if (!isNightRole(role)) return [];
      return [
        {
          actorId: player.id,
          role,
          order: ROLE_DEFINITIONS[role].nightOrder ?? Number.MAX_SAFE_INTEGER,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.order - right.order ||
        (players.find((player) => player.id === left.actorId)?.seat ?? 0) -
          (players.find((player) => player.id === right.actorId)?.seat ?? 0),
    );

  const ceremonySteps: NightCeremonyStep[] = [
    ...new Set(setup.roles.filter(isNightRole)),
  ]
    .map((role) => ({
      id: `night-${role}`,
      role,
      order: ROLE_DEFINITIONS[role].nightOrder ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => left.order - right.order || left.role.localeCompare(right.role));

  const events: GameEvent[] = [
    {
      sequence: 1,
      type: "game.dealt",
      visibility: { kind: "public" },
      data: { playerIds: players.map((player) => player.id), centerCardCount: 3 },
    },
    ...players.map(
      (player, index): GameEvent => ({
        sequence: index + 2,
        type: "knowledge.gained",
        visibility: { kind: "private", playerIds: [player.id] },
        data: { playerId: player.id, items: knowledge[player.id] },
      }),
    ),
  ];

  const startsInDiscussion = ceremonySteps.length === 0;
  const firstCeremonyStep = ceremonySteps[0];
  if (firstCeremonyStep) {
    const definition = ROLE_DEFINITIONS[firstCeremonyStep.role];
    events.push({
      sequence: events.length + 1,
      type: "night.role-opened",
      visibility: { kind: "public" },
      data: {
        stepId: firstCeremonyStep.id,
        role: firstCeremonyStep.role,
        order: firstCeremonyStep.order,
        wakeCall: definition.wakeCall ?? definition.wakeInstructions,
      },
    });
  } else {
    events.push({
      sequence: events.length + 1,
      type: "night.completed",
      visibility: { kind: "public" },
      data: {},
    });
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      gameId: setup.gameId,
      revision: 0,
      seed: setup.seed,
      phase: startsInDiscussion ? "discussion" : "night",
      players,
      deckRoles: [...setup.roles],
      initialCards,
      cards: initialCards,
      knowledge,
      night: {
        queue,
        cursor: 0,
        completedPlayerIds: [],
        ceremonySteps,
        ceremonyCursor: 0,
      },
      discussion: {
        turnNumber: 0,
        activeSpeakerId: null,
        intents: {},
        recentSpeakers: [],
        transcript: [],
      },
      voting: { votes: {} },
      resolution: null,
      events,
    },
  };
}

function issue(path: string, message: string): DomainIssue {
  return { code: "INVALID_SETUP", path, message };
}

/** Runtime role guard for untyped request payloads. */
export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);
}

export function playerById(
  players: readonly Player[],
  playerId: PlayerId,
): Player | undefined {
  return players.find((player) => player.id === playerId);
}
