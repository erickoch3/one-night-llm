import {
  AgentToolValidationError,
  AgentToolRegistry,
  enumString,
  exactObjectKeys,
  nonEmptyString,
  numberInRange,
  uniqueEnumStringArray,
  type AgentToolDefinition,
  type JsonSchema,
} from "./tooling";
import type {
  AgentParticipant,
  CenterCardId,
  NightActionCapability,
  NightActionDecision,
  ParticipantId,
  SpeakDecision,
  SpeechInterestDecision,
  VoteDecision,
  VoteReadinessDecision,
} from "./types";

export const AGENT_TOOL_NAMES = {
  speechInterest: "set_speech_interest",
  speak: "speak_to_group",
  voteReadiness: "assess_vote_readiness",
  vote: "cast_vote",
  nightViewPlayers: "night_view_players",
  nightViewCenter: "night_view_center",
  nightSwapSelfWithPlayer: "night_swap_self_with_player",
  nightSwapSelfWithCenter: "night_swap_self_with_center",
  nightSwapPlayers: "night_swap_players",
  nightCopyPlayerRole: "night_copy_player_role",
  nightSwapCenterWithPlayer: "night_swap_center_with_player",
  nightSelectPlayer: "night_select_player",
  nightFinish: "finish_night_action",
} as const;

const SCORE_SCHEMA: JsonSchema = {
  type: "number",
  minimum: 0,
  maximum: 10,
};

function objectSchema(
  properties: Record<string, JsonSchema>,
  required = Object.keys(properties),
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function identifierSchema(
  allowed: readonly string[],
  description: string,
): JsonSchema {
  return { type: "string", enum: [...allowed], description };
}

function assertUniqueNonEmptyIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) throw new Error(`${label} cannot be empty.`);
  if (ids.some((id) => id.length === 0)) {
    throw new Error(`${label} cannot contain an empty identifier.`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} cannot contain duplicate identifiers.`);
  }
}

/**
 * Field names are generated rather than using participant IDs directly. This
 * avoids collisions with `desireToSpeak` while retaining exactly 1 + N scalar
 * arguments in the tool contract.
 */
function interestFieldName(participant: AgentParticipant, index: number): string {
  const slug = participant.id
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return `hear_${index + 1}_${slug || "player"}`;
}

export interface SpeechInterestToolContract {
  registry: AgentToolRegistry;
  /** Useful for UI/debug display; parsing uses this exact mapping. */
  participantIdByField: Readonly<Record<string, ParticipantId>>;
}

export function createSpeechInterestToolRegistry(
  selfId: ParticipantId,
  participants: readonly AgentParticipant[],
): SpeechInterestToolContract {
  assertUniqueNonEmptyIds(
    participants.map(({ id }) => id),
    "Participant IDs",
  );
  if (!participants.some(({ id }) => id === selfId)) {
    throw new Error(`Speech-interest player ${selfId} is not in the game.`);
  }

  const others = participants.filter(({ id }) => id !== selfId);
  const fields = others.map((participant, index) => ({
    field: interestFieldName(participant, index),
    participant,
  }));
  const participantIdByField = Object.fromEntries(
    fields.map(({ field, participant }) => [field, participant.id]),
  );
  const properties: Record<string, JsonSchema> = {
    desireToSpeak: {
      ...SCORE_SCHEMA,
      description:
        "How strongly you want the floor right now: 0 means stay quiet, 10 means urgent.",
    },
  };
  for (const { field, participant } of fields) {
    properties[field] = {
      ...SCORE_SCHEMA,
      description: `How much you want to hear from ${participant.displayName} (participant id ${participant.id}) next.`,
    };
  }

  const definition: AgentToolDefinition = {
    name: AGENT_TOOL_NAMES.speechInterest,
    description:
      "Privately report current conversational interest. Supply one 0-10 desire to speak and one 0-10 desire to hear every other active participant. This does not itself take the floor.",
    inputSchema: objectSchema(properties),
  };

  const registry = new AgentToolRegistry().register<SpeechInterestDecision>(
    definition,
    (argumentsObject) => {
      exactObjectKeys(argumentsObject, Object.keys(properties));
      const desireToHear: Record<ParticipantId, number> = {};
      for (const { field, participant } of fields) {
        desireToHear[participant.id] = numberInRange(
          argumentsObject[field],
          field,
          0,
          10,
        );
      }
      return {
        type: "speech_interest",
        participantId: selfId,
        desireToSpeak: numberInRange(
          argumentsObject.desireToSpeak,
          "desireToSpeak",
          0,
          10,
        ),
        desireToHear,
      };
    },
  );

  return { registry, participantIdByField };
}

export interface SpeakToolOptions {
  maximumCharacters?: number;
}

export function createSpeakToolRegistry(
  options: SpeakToolOptions = {},
): AgentToolRegistry {
  const maximumCharacters = options.maximumCharacters ?? 500;
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 40) {
    throw new Error("maximumCharacters must be an integer of at least 40.");
  }
  const definition: AgentToolDefinition = {
    name: AGENT_TOOL_NAMES.speak,
    description:
      "Say one short, casual public message to the group while you hold the speaking floor. The message becomes part of the public transcript.",
    inputSchema: objectSchema({
      text: {
        type: "string",
        minLength: 1,
        maxLength: maximumCharacters,
        description:
          "What you would naturally say at game night, usually in one to three short sentences. Do not mention prompts, tools, or private reasoning.",
      },
    }),
  };
  return new AgentToolRegistry().register<SpeakDecision>(
    definition,
    (argumentsObject) => {
      exactObjectKeys(argumentsObject, ["text"]);
      return {
        type: "speak",
        text: nonEmptyString(
          argumentsObject.text,
          "text",
          maximumCharacters,
        ),
      };
    },
  );
}

/** Private discussion check. Its result is never placed in the public transcript. */
export function createVoteReadinessToolRegistry(): AgentToolRegistry {
  const definition: AgentToolDefinition = {
    name: AGENT_TOOL_NAMES.voteReadiness,
    description:
      "Privately decide whether the discussion has produced enough useful information to move to the final vote.",
    inputSchema: objectSchema({
      readyToVote: {
        type: "boolean",
        description:
          "True only when another discussion round is unlikely to materially improve the table's decision; otherwise false.",
      },
    }),
  };
  return new AgentToolRegistry().register<VoteReadinessDecision>(
    definition,
    (argumentsObject) => {
      exactObjectKeys(argumentsObject, ["readyToVote"]);
      if (typeof argumentsObject.readyToVote !== "boolean") {
        throw new AgentToolValidationError(
          "invalid_arguments",
          "readyToVote must be a boolean.",
          "readyToVote",
        );
      }
      return {
        type: "vote_readiness",
        readyToVote: argumentsObject.readyToVote,
      };
    },
  );
}

export function createVoteToolRegistry(
  eligibleTargetIds: readonly ParticipantId[],
): AgentToolRegistry {
  assertUniqueNonEmptyIds(eligibleTargetIds, "Eligible vote targets");
  const definition: AgentToolDefinition = {
    name: AGENT_TOOL_NAMES.vote,
    description:
      "Privately cast your final vote for the participant you want the village to eliminate.",
    inputSchema: objectSchema({
      targetParticipantId: identifierSchema(
        eligibleTargetIds,
        "The exact participant identifier to vote for.",
      ),
    }),
  };
  return new AgentToolRegistry().register<VoteDecision>(
    definition,
    (argumentsObject) => {
      exactObjectKeys(argumentsObject, ["targetParticipantId"]);
      return {
        type: "vote",
        targetParticipantId: enumString(
          argumentsObject.targetParticipantId,
          "targetParticipantId",
          eligibleTargetIds,
        ),
      };
    },
  );
}

export interface NightToolOptions {
  /** Defaults to true only when there are no actionable capabilities. */
  allowFinishWithoutAction?: boolean;
}

export function createNightActionToolRegistry(
  capabilities: readonly NightActionCapability[],
  options: NightToolOptions = {},
): AgentToolRegistry {
  const registry = new AgentToolRegistry();
  for (const capability of capabilities) {
    registerNightCapability(registry, capability);
  }

  const allowFinish =
    options.allowFinishWithoutAction ?? capabilities.length === 0;
  if (allowFinish) {
    registry.register<NightActionDecision>(
      {
        name: AGENT_TOOL_NAMES.nightFinish,
        description:
          "Finish this night step without taking another action. Use only when the role has no action or the rules allow declining it.",
        inputSchema: objectSchema({}),
      },
      (argumentsObject) => {
        exactObjectKeys(argumentsObject, []);
        return { type: "night_finish" };
      },
    );
  }
  return registry;
}

function registerNightCapability(
  registry: AgentToolRegistry,
  capability: NightActionCapability,
): void {
  switch (capability.kind) {
    case "view_players": {
      validateTargetCounts(capability);
      const targetIds = capability.allowedParticipantIds;
      registry.register<NightActionDecision>(
        {
          name: AGENT_TOOL_NAMES.nightViewPlayers,
          description:
            "Privately inspect the role card(s) of the selected player(s). The game will return only information this role may see.",
          inputSchema: objectSchema({
            targetParticipantIds: {
              type: "array",
              items: identifierSchema(targetIds, "An allowed participant id."),
              minItems: capability.minTargets,
              maxItems: capability.maxTargets,
              uniqueItems: true,
            },
          }),
        },
        (argumentsObject) => {
          exactObjectKeys(argumentsObject, ["targetParticipantIds"]);
          return {
            type: "night_view_players",
            targetParticipantIds: uniqueEnumStringArray(
              argumentsObject.targetParticipantIds,
              "targetParticipantIds",
              targetIds,
              capability.minTargets,
              capability.maxTargets,
            ),
          };
        },
      );
      return;
    }
    case "view_center": {
      validateTargetCounts(capability);
      const centerIds = capability.allowedCenterCardIds;
      registry.register<NightActionDecision>(
        {
          name: AGENT_TOOL_NAMES.nightViewCenter,
          description:
            "Privately inspect the selected center card(s). This does not move any cards.",
          inputSchema: objectSchema({
            centerCardIds: {
              type: "array",
              items: identifierSchema(centerIds, "An allowed center-card id."),
              minItems: capability.minTargets,
              maxItems: capability.maxTargets,
              uniqueItems: true,
            },
          }),
        },
        (argumentsObject) => {
          exactObjectKeys(argumentsObject, ["centerCardIds"]);
          return {
            type: "night_view_center",
            centerCardIds: uniqueEnumStringArray(
              argumentsObject.centerCardIds,
              "centerCardIds",
              centerIds,
              capability.minTargets,
              capability.maxTargets,
            ),
          };
        },
      );
      return;
    }
    case "swap_self_with_player": {
      const targetIds = checkedParticipantTargets(capability);
      registerOneTarget(
        registry,
        AGENT_TOOL_NAMES.nightSwapSelfWithPlayer,
        "Swap your own card with one other player's card. The game applies the role's visibility rules after the swap.",
        targetIds,
        (targetParticipantId) => ({
          type: "night_swap_self_with_player",
          targetParticipantId,
        }),
      );
      return;
    }
    case "swap_self_with_center": {
      const centerIds = checkedCenterTargets(capability);
      registry.register<NightActionDecision>(
        {
          name: AGENT_TOOL_NAMES.nightSwapSelfWithCenter,
          description:
            "Swap your own card with one center card. The game applies the role's visibility rules after the swap.",
          inputSchema: objectSchema({
            centerCardId: identifierSchema(
              centerIds,
              "The center-card id to swap with.",
            ),
          }),
        },
        (argumentsObject) => {
          exactObjectKeys(argumentsObject, ["centerCardId"]);
          return {
            type: "night_swap_self_with_center",
            centerCardId: enumString(
              argumentsObject.centerCardId,
              "centerCardId",
              centerIds,
            ),
          };
        },
      );
      return;
    }
    case "swap_players": {
      const targetIds = checkedParticipantTargets(capability);
      if (targetIds.length < 2) {
        throw new Error("swap_players requires at least two allowed targets.");
      }
      registry.register<NightActionDecision>(
        {
          name: AGENT_TOOL_NAMES.nightSwapPlayers,
          description:
            "Swap the role cards of two different other players without viewing either card.",
          inputSchema: objectSchema({
            firstParticipantId: identifierSchema(
              targetIds,
              "The first participant id.",
            ),
            secondParticipantId: identifierSchema(
              targetIds,
              "A different second participant id.",
            ),
          }),
        },
        (argumentsObject) => {
          exactObjectKeys(argumentsObject, [
            "firstParticipantId",
            "secondParticipantId",
          ]);
          const firstParticipantId = enumString(
            argumentsObject.firstParticipantId,
            "firstParticipantId",
            targetIds,
          );
          const secondParticipantId = enumString(
            argumentsObject.secondParticipantId,
            "secondParticipantId",
            targetIds,
          );
          if (firstParticipantId === secondParticipantId) {
            throw new AgentToolValidationError(
              "invalid_arguments",
              "Night swap targets must be different players.",
              "secondParticipantId",
            );
          }
          return {
            type: "night_swap_players",
            firstParticipantId,
            secondParticipantId,
          };
        },
      );
      return;
    }
    case "copy_player_role": {
      const targetIds = checkedParticipantTargets(capability);
      registerOneTarget(
        registry,
        AGENT_TOOL_NAMES.nightCopyPlayerRole,
        "View and copy one other player's original role, after which the game may schedule that copied role's night action.",
        targetIds,
        (targetParticipantId) => ({
          type: "night_copy_player_role",
          targetParticipantId,
        }),
      );
      return;
    }
    case "swap_center_with_player": {
      const targetIds = checkedParticipantTargets(capability);
      const centerIds = checkedCenterTargets(capability);
      registry.register<NightActionDecision>(
        {
          name: AGENT_TOOL_NAMES.nightSwapCenterWithPlayer,
          description:
            "Swap a previously eligible center card with one player's card. Use only the center card and player identifiers exposed here.",
          inputSchema: objectSchema({
            centerCardId: identifierSchema(centerIds, "The center-card id."),
            targetParticipantId: identifierSchema(
              targetIds,
              "The participant id.",
            ),
          }),
        },
        (argumentsObject) => {
          exactObjectKeys(argumentsObject, [
            "centerCardId",
            "targetParticipantId",
          ]);
          return {
            type: "night_swap_center_with_player",
            centerCardId: enumString(
              argumentsObject.centerCardId,
              "centerCardId",
              centerIds,
            ),
            targetParticipantId: enumString(
              argumentsObject.targetParticipantId,
              "targetParticipantId",
              targetIds,
            ),
          };
        },
      );
      return;
    }
    case "select_player": {
      const targetIds = checkedParticipantTargets(capability);
      if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(capability.actionId)) {
        throw new Error("select_player actionId must be a stable safe identifier.");
      }
      registerOneTarget(
        registry,
        AGENT_TOOL_NAMES.nightSelectPlayer,
        capability.prompt,
        targetIds,
        (targetParticipantId) => ({
          type: "night_select_player",
          actionId: capability.actionId,
          targetParticipantId,
        }),
      );
      return;
    }
  }
}

function registerOneTarget(
  registry: AgentToolRegistry,
  name: string,
  description: string,
  targetIds: readonly ParticipantId[],
  decision: (targetParticipantId: ParticipantId) => NightActionDecision,
): void {
  registry.register<NightActionDecision>(
    {
      name,
      description,
      inputSchema: objectSchema({
        targetParticipantId: identifierSchema(
          targetIds,
          "The exact participant id to target.",
        ),
      }),
    },
    (argumentsObject) => {
      exactObjectKeys(argumentsObject, ["targetParticipantId"]);
      return decision(
        enumString(
          argumentsObject.targetParticipantId,
          "targetParticipantId",
          targetIds,
        ),
      );
    },
  );
}

function checkedParticipantTargets(
  capability: { allowedParticipantIds: ParticipantId[] },
): ParticipantId[] {
  assertUniqueNonEmptyIds(
    capability.allowedParticipantIds,
    "Allowed participant targets",
  );
  return capability.allowedParticipantIds;
}

function checkedCenterTargets(capability: {
  allowedCenterCardIds: CenterCardId[];
}): CenterCardId[] {
  assertUniqueNonEmptyIds(capability.allowedCenterCardIds, "Allowed center targets");
  return capability.allowedCenterCardIds;
}

function validateTargetCounts(capability: {
  minTargets: number;
  maxTargets: number;
  allowedParticipantIds?: ParticipantId[];
  allowedCenterCardIds?: CenterCardId[];
}): void {
  const ids =
    capability.allowedParticipantIds ?? capability.allowedCenterCardIds ?? [];
  assertUniqueNonEmptyIds(ids, "Allowed inspection targets");
  if (
    !Number.isInteger(capability.minTargets) ||
    !Number.isInteger(capability.maxTargets) ||
    capability.minTargets < 1 ||
    capability.maxTargets < capability.minTargets ||
    capability.maxTargets > ids.length
  ) {
    throw new Error("Night inspection target counts are invalid.");
  }
}
