import type {
  ParticipantId,
  SpeakerLease,
  SpeakerScore,
  SpeechFloorResolution,
  SpeechInterestSnapshot,
} from "./types";

export interface HumanSpeechSignals {
  participantId: ParticipantId;
  otherParticipantIds: readonly ParticipantId[];
  tick: number;
  /** Typing is an attempt to speak, not an immediate floor grant. */
  isTyping: boolean;
  /** The portrait currently under the pointer, when any. */
  hoveredParticipantId?: ParticipantId;
  hoverStrength?: number;
}

/** Converts UI typing/hover state into the same private interest shape as AI calls. */
export function humanSpeechInterest(
  signals: HumanSpeechSignals,
): SpeechInterestSnapshot {
  const uniqueOthers = [...new Set(signals.otherParticipantIds)].filter(
    (id) => id !== signals.participantId,
  );
  if (
    signals.hoveredParticipantId &&
    !uniqueOthers.includes(signals.hoveredParticipantId)
  ) {
    throw new Error("Hovered participant is not an active peer.");
  }
  const hoverStrength = signals.hoverStrength ?? 10;
  assertScore(hoverStrength, "hoverStrength");

  return {
    participantId: signals.participantId,
    desireToSpeak: signals.isTyping ? 10 : 0,
    desireToHear: Object.fromEntries(
      uniqueOthers.map((id) => [
        id,
        !signals.isTyping && id === signals.hoveredParticipantId
          ? hoverStrength
          : 0,
      ]),
    ),
    tick: signals.tick,
  };
}

export interface ResolveSpeechFloorOptions {
  participantIds: readonly ParticipantId[];
  interests: readonly SpeechInterestSnapshot[];
  tick: number;
  now: number;
  /** An unexpired lease is always retained, preventing simultaneous speech. */
  currentLease?: SpeakerLease | null;
  leaseDurationMs?: number;
  lastSpeakerId?: ParticipantId;
  /** Used for a modest anti-starvation bonus. */
  lastSpokenTick?: Readonly<Record<ParticipantId, number>>;
  maxInterestAgeTicks?: number;
  /** Signals below this combined 0-20 amount leave the floor empty. */
  minimumSignal?: number;
  /** Inject for tests; otherwise a stable seed provides replayable selection. */
  random?: () => number;
  randomSeed?: string;
}

/**
 * Selects by weighted lottery rather than a strict maximum. A user typing at
 * desire 10 gets a strong chance to jump ahead, while inbound interest and
 * other players' urgency can still win. Persist the returned lease with an
 * atomic compare-and-set in multi-server deployments.
 */
export function resolveSpeechFloor(
  options: ResolveSpeechFloorOptions,
): SpeechFloorResolution {
  const participantIds = [...options.participantIds];
  assertParticipantIds(participantIds);
  if (!Number.isInteger(options.tick) || options.tick < 0) {
    throw new Error("tick must be a non-negative integer.");
  }
  if (!Number.isFinite(options.now)) throw new Error("now must be finite.");

  const leaseDurationMs = options.leaseDurationMs ?? 12_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be positive.");
  }
  const maxInterestAgeTicks = options.maxInterestAgeTicks ?? 2;
  if (!Number.isInteger(maxInterestAgeTicks) || maxInterestAgeTicks < 0) {
    throw new Error("maxInterestAgeTicks must be a non-negative integer.");
  }
  const minimumSignal = options.minimumSignal ?? 0.5;
  if (!Number.isFinite(minimumSignal) || minimumSignal < 0) {
    throw new Error("minimumSignal must be non-negative.");
  }

  const currentLease = options.currentLease;
  if (
    currentLease &&
    currentLease.expiresAt > options.now &&
    participantIds.includes(currentLease.participantId)
  ) {
    return {
      lease: currentLease,
      scores: scoreParticipants(
        participantIds,
        options,
        maxInterestAgeTicks,
        minimumSignal,
      ),
      reusedExistingLease: true,
    };
  }

  const scores = scoreParticipants(
    participantIds,
    options,
    maxInterestAgeTicks,
    minimumSignal,
  );
  const totalWeight = scores.reduce((sum, score) => sum + score.weight, 0);
  if (totalWeight <= 0) {
    return { lease: null, scores, reusedExistingLease: false };
  }

  const random =
    options.random ??
    seededRandom(
      options.randomSeed ??
        `${options.tick}:${participantIds.join("|")}:${scores
          .map(({ weight }) => weight.toFixed(4))
          .join("|")}`,
    );
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("random must return a finite number in [0, 1).");
  }
  const threshold = sample * totalWeight;
  let cumulative = 0;
  let selected = scores[scores.length - 1];
  for (const score of scores) {
    cumulative += score.weight;
    if (threshold < cumulative) {
      selected = score;
      break;
    }
  }

  const leaseId = stableHash(
    `${options.randomSeed ?? "floor"}:${options.now}:${options.tick}:${selected.participantId}`,
  ).toString(36);
  return {
    lease: {
      participantId: selected.participantId,
      leaseId: `floor_${leaseId}`,
      acquiredAt: options.now,
      expiresAt: options.now + leaseDurationMs,
    },
    scores,
    reusedExistingLease: false,
  };
}

function scoreParticipants(
  participantIds: readonly ParticipantId[],
  options: ResolveSpeechFloorOptions,
  maxInterestAgeTicks: number,
  minimumSignal: number,
): SpeakerScore[] {
  const participantSet = new Set(participantIds);
  const snapshots = new Map<ParticipantId, SpeechInterestSnapshot>();
  for (const interest of options.interests) {
    if (!participantSet.has(interest.participantId)) continue;
    assertScore(interest.desireToSpeak, "desireToSpeak");
    if (!Number.isInteger(interest.tick) || interest.tick < 0) {
      throw new Error("Interest tick must be a non-negative integer.");
    }
    for (const score of Object.values(interest.desireToHear)) {
      assertScore(score, "desireToHear");
    }
    const existing = snapshots.get(interest.participantId);
    if (!existing || existing.tick < interest.tick) {
      snapshots.set(interest.participantId, interest);
    }
  }

  const freshSnapshots = [...snapshots.values()].filter(({ tick }) => {
    const age = options.tick - tick;
    return age >= 0 && age <= maxInterestAgeTicks;
  });
  return participantIds.map((participantId) => {
    const own = freshSnapshots.find(
      (snapshot) => snapshot.participantId === participantId,
    );
    const selfDesire = own?.desireToSpeak ?? 0;
    const listeners = freshSnapshots.filter(
      (snapshot) => snapshot.participantId !== participantId,
    );
    const inboundHearDesire = listeners.length
      ? listeners.reduce(
          (sum, snapshot) =>
            sum +
            (Object.hasOwn(snapshot.desireToHear, participantId)
              ? (snapshot.desireToHear[participantId] ?? 0)
              : 0),
          0,
        ) / listeners.length
      : 0;
    const signal = selfDesire + inboundHearDesire;

    const recencyMultiplier =
      options.lastSpeakerId === participantId ? 0.22 : 1;
    const lastSpoken =
      options.lastSpokenTick &&
      Object.hasOwn(options.lastSpokenTick, participantId)
        ? options.lastSpokenTick[participantId]
        : undefined;
    const waitedTicks =
      lastSpoken === undefined
        ? Math.min(options.tick + 1, 8)
        : Math.max(0, Math.min(options.tick - lastSpoken, 8));
    const waitingMultiplier = 1 + waitedTicks * 0.06;

    // Squaring urgency makes typing (10) consequential. Inbound demand gets
    // enough weight to beat it sometimes, avoiding a guaranteed interruption.
    const rawWeight =
      signal < minimumSignal
        ? 0
        : 1 + selfDesire ** 2 * 1.4 + inboundHearDesire ** 2;
    const weight = rawWeight * recencyMultiplier * waitingMultiplier;
    return {
      participantId,
      selfDesire,
      inboundHearDesire,
      recencyMultiplier,
      waitingMultiplier,
      weight,
    };
  });
}

function assertScore(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error(`${label} must be a finite number from 0 to 10.`);
  }
}

function assertParticipantIds(ids: readonly string[]): void {
  if (ids.length === 0) throw new Error("At least one participant is required.");
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error("Participant IDs must be non-empty and unique.");
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function seededRandom(seed: string): () => number {
  let state = stableHash(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
