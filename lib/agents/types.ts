/**
 * Provider-neutral contracts for an LLM-backed One Night player.
 *
 * The game engine should build one AgentTurnContext per player. In particular,
 * never put the authoritative deck or another player's private facts in this
 * object: everything here is serialized into that player's model prompt.
 */

export type ParticipantId = string;
export type RoleId = string;
export type CenterCardId = string;

export type ParticipantKind = "human" | "llm";
export type AgentPhase = "night" | "discussion" | "vote" | "complete";

export interface AgentParticipant {
  id: ParticipantId;
  displayName: string;
  kind: ParticipantKind;
  seat: number;
  /** Optional public personality tagline; it must not contain secret state. */
  persona?: string;
  /** Trusted out-of-game voice direction, supplied only for the acting agent. */
  voiceProfile?: string;
}

export type TranscriptEntryKind =
  | "speech"
  | "system"
  | "vote_reveal"
  | "elimination";

export interface PublicTranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  /** Absent for system-authored entries. */
  speakerId?: ParticipantId;
  text: string;
  discussionRound: number;
  /** A monotonic game sequence number, not a client-provided timestamp. */
  sequence: number;
}

export type SecretNightFact =
  | {
      kind: "role_seen";
      participantId: ParticipantId;
      roleId: RoleId;
    }
  | {
      kind: "center_role_seen";
      centerCardId: CenterCardId;
      roleId: RoleId;
    }
  | {
      kind: "teammates_seen";
      participantIds: ParticipantId[];
      team: string;
    }
  | {
      kind: "card_moved";
      from: ParticipantId | CenterCardId;
      to: ParticipantId | CenterCardId;
      /** Include only when this player is entitled to know the card identity. */
      roleId?: RoleId;
    }
  | {
      kind: "copied_role";
      participantId: ParticipantId;
      roleId: RoleId;
    }
  | {
      kind: "private_note";
      /** Server-authored role information. Never copy transcript text here. */
      text: string;
    };

export type AgentNightHistoryStatus = "upcoming" | "active" | "complete";

/**
 * One canonical narrated role step, projected for a single viewer.
 *
 * The wake/close calls and progress are safe for every player. The final three
 * fields are viewer-private and must never be copied into public prompt data.
 */
export interface AgentNightHistoryEntry {
  id: string;
  roleId: RoleId;
  order: number;
  status: AgentNightHistoryStatus;
  wakeCall: string;
  closeCall: string;
  viewerWasAwake: boolean;
  didAct: boolean;
  privateFacts: SecretNightFact[];
}

export interface SecretRoleContext {
  /** The card dealt to this player before night actions. */
  originalRoleId: RoleId;
  /** Rules text for the original or copied role, supplied by the game engine. */
  roleRules: string;
  /** Known current role only when this role is allowed to inspect it. */
  knownCurrentRoleId?: RoleId;
  nightFacts: SecretNightFact[];
  availableNightActions: NightActionCapability[];
}

interface ParticipantTargetCapability {
  allowedParticipantIds: ParticipantId[];
}

interface CenterTargetCapability {
  allowedCenterCardIds: CenterCardId[];
}

/**
 * Capabilities are authoritative permissions for one night turn. Register only
 * the capability(s) currently legal at that step of a multi-step role action.
 */
export type NightActionCapability =
  | ({
      kind: "view_players";
      minTargets: number;
      maxTargets: number;
    } & ParticipantTargetCapability)
  | ({
      kind: "view_center";
      minTargets: number;
      maxTargets: number;
    } & CenterTargetCapability)
  | ({ kind: "swap_self_with_player" } & ParticipantTargetCapability)
  | ({ kind: "swap_self_with_center" } & CenterTargetCapability)
  | ({ kind: "swap_players" } & ParticipantTargetCapability)
  | ({ kind: "copy_player_role" } & ParticipantTargetCapability)
  | ({
      kind: "swap_center_with_player";
    } & ParticipantTargetCapability & CenterTargetCapability)
  | ({
      kind: "select_player";
      /** A stable engine-owned identifier such as `shield` or `apprentice`. */
      actionId: string;
      prompt: string;
    } & ParticipantTargetCapability);

export type NightActionDecision =
  | { type: "night_view_players"; targetParticipantIds: ParticipantId[] }
  | { type: "night_view_center"; centerCardIds: CenterCardId[] }
  | { type: "night_swap_self_with_player"; targetParticipantId: ParticipantId }
  | { type: "night_swap_self_with_center"; centerCardId: CenterCardId }
  | {
      type: "night_swap_players";
      firstParticipantId: ParticipantId;
      secondParticipantId: ParticipantId;
    }
  | { type: "night_copy_player_role"; targetParticipantId: ParticipantId }
  | {
      type: "night_swap_center_with_player";
      centerCardId: CenterCardId;
      targetParticipantId: ParticipantId;
    }
  | {
      type: "night_select_player";
      actionId: string;
      targetParticipantId: ParticipantId;
    }
  | { type: "night_finish" };

export interface SpeechInterestDecision {
  type: "speech_interest";
  participantId: ParticipantId;
  desireToSpeak: number;
  /** Contains exactly one 0-10 value for every other active participant. */
  desireToHear: Record<ParticipantId, number>;
}

export interface SpeakDecision {
  type: "speak";
  text: string;
}

export interface VoteReadinessDecision {
  type: "vote_readiness";
  /** Private preference about ending discussion; never a final elimination vote. */
  readyToVote: boolean;
}

export interface VoteDecision {
  type: "vote";
  targetParticipantId: ParticipantId;
}

export type AgentDecision =
  | NightActionDecision
  | SpeechInterestDecision
  | SpeakDecision
  | VoteReadinessDecision
  | VoteDecision;

export interface AgentTurnContext {
  gameId: string;
  participant: AgentParticipant;
  participants: AgentParticipant[];
  phase: AgentPhase;
  discussionRound: number;
  publicTranscript: PublicTranscriptEntry[];
  /** Ordered public narration plus this viewer's private experience of it. */
  nightHistory: AgentNightHistoryEntry[];
  secret: SecretRoleContext;
  /** Engine-authored public summary, for example time remaining. */
  publicSituation?: string;
  /** Legal vote targets for this player during the vote phase. */
  eligibleVoteTargetIds?: ParticipantId[];
}

export type AgentDecisionKind =
  | "night_action"
  | "speech_interest"
  | "speak"
  | "vote_readiness"
  | "vote_call_announcement"
  | "vote";

export interface SpeechInterestSnapshot {
  participantId: ParticipantId;
  desireToSpeak: number;
  desireToHear: Record<ParticipantId, number>;
  /** Monotonic discussion tick at which this interest was collected. */
  tick: number;
}

export interface SpeakerLease {
  participantId: ParticipantId;
  leaseId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface SpeakerScore {
  participantId: ParticipantId;
  selfDesire: number;
  inboundHearDesire: number;
  recencyMultiplier: number;
  waitingMultiplier: number;
  weight: number;
}

export interface SpeechFloorResolution {
  lease: SpeakerLease | null;
  scores: SpeakerScore[];
  reusedExistingLease: boolean;
}
