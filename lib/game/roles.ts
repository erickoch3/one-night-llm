import type { NightRole, RoleId, TeamId } from "./types.js";

export interface RoleDefinition {
  readonly id: RoleId;
  readonly name: string;
  readonly team: TeamId;
  readonly nightOrder: number | null;
  /** Public moderator copy; null for roles that never wake. */
  readonly wakeCall: string | null;
  /** Public moderator copy; null for roles that never wake. */
  readonly closeCall: string | null;
  readonly wakeInstructions: string;
}

export const ROLE_DEFINITIONS: Readonly<Record<RoleId, RoleDefinition>> = {
  werewolf: {
    id: "werewolf",
    name: "Werewolf",
    team: "werewolf",
    nightOrder: 10,
    wakeCall: "Werewolves, open your eyes and look for the other Werewolves.",
    closeCall: "Werewolves, close your eyes.",
    wakeInstructions:
      "Learn the other original Werewolves. If you are alone, you may inspect one center card.",
  },
  minion: {
    id: "minion",
    name: "Minion",
    team: "werewolf",
    nightOrder: 20,
    wakeCall: "Minion, open your eyes. Werewolves, keep your eyes closed and raise a thumb.",
    closeCall: "Minion, close your eyes. Werewolves, lower your thumbs.",
    wakeInstructions:
      "Learn which players began as Werewolves. They do not learn that you are the Minion.",
  },
  seer: {
    id: "seer",
    name: "Seer",
    team: "village",
    nightOrder: 30,
    wakeCall: "Seer, open your eyes and inspect the village or the center.",
    closeCall: "Seer, close your eyes.",
    wakeInstructions:
      "Inspect either one other player's current card or two different center cards.",
  },
  robber: {
    id: "robber",
    name: "Robber",
    team: "village",
    nightOrder: 40,
    wakeCall: "Robber, open your eyes and choose whether to exchange your card.",
    closeCall: "Robber, close your eyes.",
    wakeInstructions:
      "You may swap your card with another player's card, then inspect the card you received.",
  },
  troublemaker: {
    id: "troublemaker",
    name: "Troublemaker",
    team: "village",
    nightOrder: 50,
    wakeCall: "Troublemaker, open your eyes and choose whether to exchange two other players' cards.",
    closeCall: "Troublemaker, close your eyes.",
    wakeInstructions:
      "You may swap the cards of two other players without looking at either card.",
  },
  drunk: {
    id: "drunk",
    name: "Drunk",
    team: "village",
    nightOrder: 60,
    wakeCall: "Drunk, open your eyes and exchange your card with one card from the center.",
    closeCall: "Drunk, close your eyes.",
    wakeInstructions:
      "Swap your card with one center card without looking at the card you receive.",
  },
  insomniac: {
    id: "insomniac",
    name: "Insomniac",
    team: "village",
    nightOrder: 70,
    wakeCall: "Insomniac, open your eyes and inspect your card.",
    closeCall: "Insomniac, close your eyes.",
    wakeInstructions: "Inspect your card after every other swap has finished.",
  },
  villager: {
    id: "villager",
    name: "Villager",
    team: "village",
    nightOrder: null,
    wakeCall: null,
    closeCall: null,
    wakeInstructions: "You have no night action. Use deduction and discussion to find a Werewolf.",
  },
  hunter: {
    id: "hunter",
    name: "Hunter",
    team: "village",
    nightOrder: null,
    wakeCall: null,
    closeCall: null,
    wakeInstructions: "You have no night action. If you die, the player you voted for also dies.",
  },
  tanner: {
    id: "tanner",
    name: "Tanner",
    team: "tanner",
    nightOrder: null,
    wakeCall: null,
    closeCall: null,
    wakeInstructions: "You have no night action. You win only if you are eliminated.",
  },
};

export const NIGHT_ROLES: readonly NightRole[] = [
  "werewolf",
  "minion",
  "seer",
  "robber",
  "troublemaker",
  "drunk",
  "insomniac",
] as const;

export function isNightRole(role: RoleId): role is NightRole {
  return ROLE_DEFINITIONS[role].nightOrder !== null;
}

export function teamForRole(role: RoleId): TeamId {
  return ROLE_DEFINITIONS[role].team;
}

/**
 * A balanced default deck, sliced to playerCount + 3 cards. All supported roles
 * appear by nine players, while small games keep the most legible action mix.
 */
export function buildRecommendedDeck(playerCount: number): readonly RoleId[] {
  if (!Number.isInteger(playerCount) || playerCount < 3) {
    throw new RangeError("One Night requires at least three total players.");
  }

  const foundation: RoleId[] = [
    "werewolf",
    "werewolf",
    "seer",
    "robber",
    "troublemaker",
    "villager",
    "villager",
    "drunk",
    "insomniac",
    "minion",
    "hunter",
    "tanner",
  ];

  const required = playerCount + 3;
  while (foundation.length < required) {
    // Large custom games stay playable: add mostly villagers and one extra
    // Werewolf per four overflow cards.
    const overflowIndex = foundation.length - 12;
    foundation.push(overflowIndex % 4 === 3 ? "werewolf" : "villager");
  }

  return foundation.slice(0, required);
}
