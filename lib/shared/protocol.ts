import type {
  CenterIndex,
  GamePhase,
  KnowledgeItem,
  NightRole,
  PlayerId,
  ResolutionReason,
  RoleId,
  SpeechScore,
  TeamId,
} from "../game/types";
import type { AgentModel, AgentReasoningEffort } from "./agent-config";

export type GameMode = "codex" | "openai" | "rehearsal";

export interface PublicPlayerView {
  id: PlayerId;
  name: string;
  kind: "human" | "agent";
  seat: number;
  avatar: string;
  persona?: string;
  isYou: boolean;
  lastSpokeTurn: number | null;
  hasVoted: boolean;
}

export interface RoleView {
  id: RoleId;
  name: string;
  team: TeamId;
  wakeInstructions: string;
}

export interface NightPromptView {
  actorId: PlayerId;
  role: NightRole;
  instructions: string;
  otherPlayerIds: PlayerId[];
  centerIndices: CenterIndex[];
  knownWerewolfPlayerIds?: PlayerId[];
}

export interface NightHistoryEntryView {
  id: string;
  role: NightRole;
  roleName: string;
  order: number;
  status: "upcoming" | "active" | "complete";
  wakeCall: string;
  closeCall: string;
  /** True only in this viewer's private projection. */
  viewerWasAwake: boolean;
  /** True only when this viewer personally completed the role's action. */
  didAct: boolean;
  /** Knowledge earned by this viewer during this role's step, never another player's. */
  privateKnowledge: KnowledgeItem[];
}

export interface TranscriptEntryView {
  id: string;
  turnNumber: number;
  speakerId: PlayerId | null;
  speakerName: string;
  text: string;
  kind: "speech" | "system";
}

export interface DialogueView {
  turnNumber: number;
  activeSpeakerId: PlayerId | null;
  humanMaySpeak: boolean;
  busy: boolean;
  recentSpeakerIds: PlayerId[];
  transcript: TranscriptEntryView[];
  lastScores: SpeechScore[];
}

export interface CenterCardView {
  index: CenterIndex;
  role: RoleId | null;
}

export interface ResolutionView {
  eliminatedPlayerIds: PlayerId[];
  winnerPlayerIds: PlayerId[];
  winningTeams: TeamId[];
  reasons: ResolutionReason[];
  rolesAtEnd: Record<PlayerId, RoleId>;
  votes: Record<PlayerId, PlayerId>;
  tally: Record<PlayerId, number>;
  playerWon: boolean;
}

export interface GameSnapshot {
  gameId: string;
  revision: number;
  mode: GameMode;
  phase: GamePhase;
  phaseLabel: string;
  viewerId: PlayerId;
  players: PublicPlayerView[];
  ownInitialRole: RoleView;
  ownKnownCurrentRole: RoleView | null;
  ownKnowledge: KnowledgeItem[];
  nightPrompt: NightPromptView | null;
  nightHistory: NightHistoryEntryView[];
  mayAdvanceNight: boolean;
  centerCards: CenterCardView[];
  dialogue: DialogueView;
  votesCast: number;
  ownVote: PlayerId | null;
  resolution: ResolutionView | null;
  degradedAgents: boolean;
  notice: string | null;
}

export interface CreateGameRequest {
  playerName: string;
  agentCount: number;
  mode: GameMode;
  rolePack: "classic" | "chaos";
  agentModel: AgentModel;
  agentReasoningEffort: AgentReasoningEffort;
  /** Used only by the local service to create this room's OpenAI runtime. */
  openaiApiKey?: string;
}

export type HumanNightActionRequest =
  | { type: "werewolf"; centerIndex?: CenterIndex }
  | { type: "minion" }
  | {
      type: "seer";
      choice:
        | { kind: "player"; playerId: PlayerId }
        | { kind: "center"; indices: [CenterIndex, CenterIndex] };
    }
  | { type: "robber"; targetId: PlayerId | null }
  | {
      type: "troublemaker";
      targetIds: [PlayerId, PlayerId] | null;
    }
  | { type: "drunk"; centerIndex: CenterIndex }
  | { type: "insomniac" };

export interface AdvanceDialogueRequest {
  humanWantsToSpeak: boolean;
  hoverTargetId: PlayerId | null;
}
