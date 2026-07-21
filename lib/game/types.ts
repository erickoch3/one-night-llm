/**
 * Serializable domain types for a One Night-style game.
 *
 * This module deliberately contains no Date, Map, Set, class, or function
 * values. A GameState can therefore be persisted or sent over the wire with a
 * plain JSON round trip.
 */

export const ROLE_IDS = [
  "werewolf",
  "villager",
  "seer",
  "robber",
  "troublemaker",
  "drunk",
  "insomniac",
  "minion",
  "hunter",
  "tanner",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];
export type TeamId = "village" | "werewolf" | "tanner";
export type PlayerId = string;
export type CardId = string;
export type CenterIndex = 0 | 1 | 2;

export interface HumanPlayer {
  readonly kind: "human";
  readonly id: PlayerId;
  readonly name: string;
  readonly seat: number;
  /** Stable application/account identifier; it is never shown to other players. */
  readonly userId: string;
  readonly avatar?: string;
}

export interface AgentPlayer {
  readonly kind: "agent";
  readonly id: PlayerId;
  readonly name: string;
  readonly seat: number;
  /** Model is metadata only; the game engine never calls a model directly. */
  readonly model: string;
  /** Stable catalog key for the voice assigned when the room was created. */
  readonly profileId?: string;
  /** Short, public personality summary suitable for the game UI. */
  readonly persona?: string;
  /** Server-authored, out-of-game voice guidance. Never treat it as game evidence. */
  readonly voiceProfile?: string;
  readonly avatar?: string;
}

export type Player = HumanPlayer | AgentPlayer;

/** Safe lobby/profile shape; excludes account ids, model ids, and agent profiles. */
export interface PublicPlayer {
  readonly kind: Player["kind"];
  readonly id: PlayerId;
  readonly name: string;
  readonly seat: number;
  readonly avatar?: string;
}

export interface RoleCard {
  readonly id: CardId;
  readonly role: RoleId;
}

export type CenterCards = readonly [RoleCard, RoleCard, RoleCard];

export interface CardLayout {
  readonly players: Readonly<Record<PlayerId, RoleCard>>;
  readonly center: CenterCards;
}

export interface GameSetup {
  readonly gameId: string;
  readonly seed: string;
  readonly players: readonly Player[];
  /** Exactly one role per player, plus exactly three center roles. */
  readonly roles: readonly RoleId[];
}

export type GamePhase = "night" | "discussion" | "voting" | "resolved";

export type NightRole =
  | "werewolf"
  | "minion"
  | "seer"
  | "robber"
  | "troublemaker"
  | "drunk"
  | "insomniac";

export interface NightTurn {
  readonly actorId: PlayerId;
  /** Night roles are always based on the initially dealt card. */
  readonly role: NightRole;
  readonly order: number;
}

/**
 * One publicly announced role in the night ceremony. Ceremony steps are based
 * on the configured deck, not on which cards happened to be dealt to players,
 * so this shape intentionally contains no actor ids or actor count.
 */
export interface NightCeremonyStep {
  readonly id: string;
  readonly role: NightRole;
  readonly order: number;
}

export interface NightState {
  /** Server-only action queue. Never expose this through a player projection. */
  readonly queue: readonly NightTurn[];
  /** Cursor into the server-only action queue. */
  readonly cursor: number;
  readonly completedPlayerIds: readonly PlayerId[];
  /** Public ceremony derived from every distinct wake role in the deck. */
  readonly ceremonySteps: readonly NightCeremonyStep[];
  /** Cursor into ceremonySteps; may point one past the end after dawn. */
  readonly ceremonyCursor: number;
}

export type NightAction =
  | {
      readonly type: "werewolf";
      readonly actorId: PlayerId;
      /** A lone werewolf may inspect one center card, or decline by omitting it. */
      readonly centerIndex?: CenterIndex;
    }
  | { readonly type: "minion"; readonly actorId: PlayerId }
  | {
      readonly type: "seer";
      readonly actorId: PlayerId;
      readonly choice:
        | { readonly kind: "player"; readonly playerId: PlayerId }
        | {
            readonly kind: "center";
            readonly indices: readonly [CenterIndex, CenterIndex];
          };
    }
  | {
      readonly type: "robber";
      readonly actorId: PlayerId;
      /** null means the Robber deliberately declines the swap. */
      readonly targetId: PlayerId | null;
    }
  | {
      readonly type: "troublemaker";
      readonly actorId: PlayerId;
      /** null means the Troublemaker deliberately declines the swap. */
      readonly targetIds: readonly [PlayerId, PlayerId] | null;
    }
  | {
      readonly type: "drunk";
      readonly actorId: PlayerId;
      readonly centerIndex: CenterIndex;
    }
  | { readonly type: "insomniac"; readonly actorId: PlayerId };

export type KnowledgeItem =
  | {
      readonly type: "starting-role";
      readonly cardId: CardId;
      readonly role: RoleId;
    }
  | {
      readonly type: "werewolf-allies";
      readonly playerIds: readonly PlayerId[];
      readonly isLoneWerewolf: boolean;
    }
  | {
      readonly type: "minion-werewolves";
      readonly playerIds: readonly PlayerId[];
    }
  | {
      readonly type: "observed-player-card";
      readonly playerId: PlayerId;
      readonly cardId: CardId;
      readonly role: RoleId;
      readonly during: "seer" | "robber" | "insomniac";
    }
  | {
      readonly type: "observed-center-card";
      readonly centerIndex: CenterIndex;
      readonly cardId: CardId;
      readonly role: RoleId;
      readonly during: "werewolf" | "seer";
    }
  | {
      readonly type: "swap-performed";
      readonly during: "robber" | "troublemaker" | "drunk";
      readonly slots: readonly [CardSlot, CardSlot];
    }
  | {
      readonly type: "action-declined";
      readonly during: "robber" | "troublemaker";
    };

export type CardSlot =
  | { readonly kind: "player"; readonly playerId: PlayerId }
  | { readonly kind: "center"; readonly centerIndex: CenterIndex };

export type DesireLevel = number;

export interface SpeechIntent {
  readonly playerId: PlayerId;
  /** Integer from 0 (silent) through 10 (strongly wants the floor). */
  readonly selfDesire: DesireLevel;
  /** One 0..10 value for every other player. */
  readonly hearFrom: Readonly<Record<PlayerId, DesireLevel>>;
  readonly source: "agent-tool" | "human-signals";
  readonly turnNumber: number;
}

export interface SpeechScore {
  readonly playerId: PlayerId;
  readonly selfComponent: number;
  readonly audienceComponent: number;
  readonly waitingBonus: number;
  readonly repeatPenalty: number;
  readonly total: number;
}

export interface SpeakerSelection {
  readonly playerId: PlayerId;
  readonly turnNumber: number;
  readonly scores: readonly SpeechScore[];
}

export interface DiscussionMessage {
  readonly turnNumber: number;
  readonly speakerId: PlayerId;
  readonly text: string;
}

export interface DiscussionState {
  readonly turnNumber: number;
  readonly activeSpeakerId: PlayerId | null;
  readonly intents: Readonly<Partial<Record<PlayerId, SpeechIntent>>>;
  /** Oldest first. This is bounded by the engine to avoid unbounded scoring state. */
  readonly recentSpeakers: readonly PlayerId[];
  readonly transcript: readonly DiscussionMessage[];
}

export interface VotingState {
  readonly votes: Readonly<Partial<Record<PlayerId, PlayerId>>>;
}

export type ResolutionReason =
  | "werewolf-killed"
  | "werewolves-survived"
  | "no-werewolf-no-death"
  | "minion-killed-without-werewolf"
  | "minion-survived-without-werewolf"
  | "innocent-killed-without-werewolf"
  | "tanner-killed";

export interface HunterElimination {
  readonly hunterId: PlayerId;
  readonly targetId: PlayerId;
}

export interface GameResolution {
  readonly votes: Readonly<Record<PlayerId, PlayerId>>;
  readonly tally: Readonly<Record<PlayerId, number>>;
  /** Players tied for the most votes, before Hunter effects. */
  readonly initiallyEliminatedPlayerIds: readonly PlayerId[];
  /** Includes recursively triggered Hunter targets. */
  readonly eliminatedPlayerIds: readonly PlayerId[];
  readonly hunterEliminations: readonly HunterElimination[];
  readonly rolesAtEnd: Readonly<Record<PlayerId, RoleId>>;
  readonly winningTeams: readonly TeamId[];
  readonly winnerPlayerIds: readonly PlayerId[];
  readonly reasons: readonly ResolutionReason[];
}

export type EventVisibility =
  | { readonly kind: "public" }
  | { readonly kind: "private"; readonly playerIds: readonly PlayerId[] }
  | { readonly kind: "server" };

export interface TypedGameEvent<Type extends string, Data> {
  readonly sequence: number;
  readonly type: Type;
  readonly visibility: EventVisibility;
  readonly data: Data;
}

export type GameEvent =
  | TypedGameEvent<
      "game.dealt",
      { readonly playerIds: readonly PlayerId[]; readonly centerCardCount: 3 }
    >
  | TypedGameEvent<
      "knowledge.gained",
      { readonly playerId: PlayerId; readonly items: readonly KnowledgeItem[] }
    >
  | TypedGameEvent<
      "night.action-completed",
      {
        readonly actorId: PlayerId;
        readonly role: NightRole;
        readonly action: NightAction;
      }
    >
  | TypedGameEvent<
      "night.role-opened",
      {
        readonly stepId: string;
        readonly role: NightRole;
        readonly order: number;
        readonly wakeCall: string;
      }
    >
  | TypedGameEvent<
      "night.role-closed",
      {
        readonly stepId: string;
        readonly role: NightRole;
        readonly order: number;
        readonly closeCall: string;
      }
    >
  | TypedGameEvent<"night.completed", Record<string, never>>
  | TypedGameEvent<
      "discussion.intent-submitted",
      { readonly playerId: PlayerId; readonly turnNumber: number }
    >
  | TypedGameEvent<
      "discussion.speaker-selected",
      { readonly selection: SpeakerSelection }
    >
  | TypedGameEvent<
      "discussion.message",
      { readonly message: DiscussionMessage }
    >
  | TypedGameEvent<"voting.started", Record<string, never>>
  | TypedGameEvent<
      "vote.cast",
      { readonly voterId: PlayerId; readonly targetId: PlayerId }
    >
  | TypedGameEvent<
      "game.resolved",
      { readonly resolution: GameResolution }
    >;

export interface GameState {
  readonly schemaVersion: 1;
  readonly gameId: string;
  /** Incremented once for every accepted state transition. */
  readonly revision: number;
  readonly seed: string;
  readonly phase: GamePhase;
  readonly players: readonly Player[];
  readonly deckRoles: readonly RoleId[];
  /** Immutable deal snapshot; night actions always key off this layout. */
  readonly initialCards: CardLayout;
  /** Mutable-in-the-domain, immutable-in-code card layout after swaps. */
  readonly cards: CardLayout;
  readonly knowledge: Readonly<Record<PlayerId, readonly KnowledgeItem[]>>;
  readonly night: NightState;
  readonly discussion: DiscussionState;
  readonly voting: VotingState;
  readonly resolution: GameResolution | null;
  readonly events: readonly GameEvent[];
}

export interface DomainIssue {
  readonly code:
    | "INVALID_SETUP"
    | "WRONG_PHASE"
    | "UNKNOWN_PLAYER"
    | "NOT_CURRENT_ACTOR"
    | "WRONG_ACTION"
    | "INCOMPLETE_NIGHT_STEP"
    | "INVALID_TARGET"
    | "INVALID_CENTER_CARD"
    | "INVALID_INTENT"
    | "SPEAKER_ACTIVE"
    | "NO_SPEAKER"
    | "DUPLICATE_VOTE"
    | "INCOMPLETE_VOTE";
  readonly message: string;
  readonly path?: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainIssue };

export interface GameTransition {
  readonly state: GameState;
  /** Events appended by this transition only. */
  readonly events: readonly GameEvent[];
}

export interface NightContext {
  readonly actorId: PlayerId;
  readonly role: NightRole;
  readonly instructions: string;
  readonly otherPlayerIds: readonly PlayerId[];
  readonly centerIndices: readonly CenterIndex[];
  /** Present for Werewolves and the Minion before their action is submitted. */
  readonly knownWerewolfPlayerIds?: readonly PlayerId[];
}

export interface SpeechAlgorithmConfig {
  readonly selfWeight: number;
  readonly audienceWeight: number;
  readonly waitingBonusPerTurn: number;
  readonly maximumWaitingBonus: number;
  readonly repeatPenalty: number;
  readonly minimumScore: number;
}

export type JsonSchema = {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly oneOf?: readonly JsonSchema[];
};

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface PublicDiscussionView {
  readonly turnNumber: number;
  readonly activeSpeakerId: PlayerId | null;
  readonly recentSpeakers: readonly PlayerId[];
  readonly transcript: readonly DiscussionMessage[];
}

export type NightCeremonyStepStatus = "upcoming" | "active" | "complete";

/** Player-safe chronological view of one public night ceremony step. */
export interface PlayerNightHistoryEntry {
  readonly id: string;
  readonly role: NightRole;
  readonly order: number;
  readonly status: NightCeremonyStepStatus;
  readonly wakeCall: string;
  readonly closeCall: string;
  /** Whether this viewer's original card entitled them to open their eyes. */
  readonly viewerWasAwake: boolean;
  /** Whether this viewer has completed their own action in this step. */
  readonly didAct: boolean;
  /** Facts learned only by this viewer during this role's ceremony step. */
  readonly privateKnowledge: readonly KnowledgeItem[];
}

export interface GameView {
  readonly schemaVersion: 1;
  readonly gameId: string;
  readonly revision: number;
  readonly phase: GamePhase;
  readonly players: readonly PublicPlayer[];
  readonly ownKnowledge: readonly KnowledgeItem[];
  readonly nightContext: NightContext | null;
  readonly nightHistory: readonly PlayerNightHistoryEntry[];
  readonly discussion: PublicDiscussionView;
  readonly votesCast: number;
  readonly ownVote: PlayerId | null;
  readonly revealedInitialCards: CardLayout | null;
  readonly revealedFinalCards: CardLayout | null;
  readonly resolution: GameResolution | null;
  readonly events: readonly GameEvent[];
}
