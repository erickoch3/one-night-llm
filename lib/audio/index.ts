/**
 * Procedural game audio for One Night.
 *
 * This module is safe to import during SSR. It does not read browser globals or
 * construct an AudioContext until one of its methods is used in the browser,
 * and an AudioContext is only constructed by `unlock` after user activation.
 *
 * Typical setup:
 *
 *   const removeUnlockListener = gameAudio.installGestureUnlock();
 *   gameAudio.play("cardFlip");
 *   // On component/app teardown:
 *   removeUnlockListener();
 *   void gameAudio.dispose();
 */

export const GAME_AUDIO_CUES = [
  "hover",
  "cardFlip",
  "nightFall",
  "reveal",
  "speakerSelection",
  "message",
  "vote",
  "victory",
  "defeat",
] as const;

export type GameAudioCue = (typeof GAME_AUDIO_CUES)[number];

export interface PlayCueOptions {
  /** Per-play gain, from 0 through 1. Defaults to 1. */
  volume?: number;
  /** Playback-rate multiplier, clamped to 0.5 through 2. Defaults to 1. */
  pitch?: number;
  /** Delay before the cue starts, in seconds. */
  delay?: number;
  /** Stereo position, from -1 (left) through 1 (right). */
  pan?: number;
}

export interface GameAudioSnapshot {
  /** Whether this browser exposes Web Audio. */
  readonly supported: boolean;
  /** Whether audio has been unlocked by a user gesture. */
  readonly unlocked: boolean;
  readonly contextState: AudioContextState | "unavailable";
  readonly muted: boolean;
  /** Master volume, from 0 through 1. */
  readonly volume: number;
  /** The user's saved preference for ambient sound. */
  readonly ambienceEnabled: boolean;
  /** True only while the procedural night bed is actually running. */
  readonly ambiencePlaying: boolean;
  /** Effective accessibility mode (system preference or app override). */
  readonly reducedEffects: boolean;
}

export type GameAudioListener = (snapshot: GameAudioSnapshot) => void;

export interface UserGestureLike {
  readonly isTrusted?: boolean;
  readonly nativeEvent?: { readonly isTrusted?: boolean };
}

interface StoredAudioPreferences {
  muted: boolean;
  volume: number;
  ambienceEnabled: boolean;
}

interface AudioGraph {
  context: AudioContext;
  master: GainNode;
  effects: GainNode;
  ambience: GainNode;
  reverb: ConvolverNode;
  reverbGain: GainNode;
  compressor: DynamicsCompressorNode;
}

interface AmbientGraph {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

interface ToneOptions {
  start: number;
  duration: number;
  frequency: number;
  endFrequency?: number;
  type?: OscillatorType;
  gain: number;
  attack?: number;
  release?: number;
  pan?: number;
  filterFrequency?: number;
  reverb?: number;
}

interface NoiseOptions {
  start: number;
  duration: number;
  gain: number;
  filterType?: BiquadFilterType;
  filterFrequency?: number;
  filterQ?: number;
  pan?: number;
  reverb?: number;
}

const STORAGE_KEY = "one-night-llm:audio:v1";
const DEFAULT_PREFERENCES: StoredAudioPreferences = {
  muted: false,
  volume: 0.72,
  ambienceEnabled: true,
};

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const EPSILON_GAIN = 0.0001;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getAudioContextConstructor(): typeof AudioContext | undefined {
  if (!isBrowser()) return undefined;

  const audioWindow = window as typeof window & {
    webkitAudioContext?: typeof AudioContext;
  };
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext;
}

function browserHasUserActivation(gesture?: UserGestureLike): boolean {
  if (gesture?.isTrusted || gesture?.nativeEvent?.isTrusted) return true;
  if (typeof navigator === "undefined") return false;

  const userActivation = (
    navigator as Navigator & {
      userActivation?: { readonly isActive: boolean; readonly hasBeenActive: boolean };
    }
  ).userActivation;

  // Older browsers do not expose UserActivation. In those browsers `unlock`
  // remains an explicit gesture-only API and the AudioContext enforces policy.
  return userActivation
    ? userActivation.isActive || userActivation.hasBeenActive
    : true;
}

function readPreferences(): StoredAudioPreferences {
  if (!isBrowser()) return { ...DEFAULT_PREFERENCES };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<StoredAudioPreferences>;

    return {
      muted:
        typeof parsed.muted === "boolean"
          ? parsed.muted
          : DEFAULT_PREFERENCES.muted,
      volume:
        typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
          ? clamp(parsed.volume, 0, 1)
          : DEFAULT_PREFERENCES.volume,
      ambienceEnabled:
        typeof parsed.ambienceEnabled === "boolean"
          ? parsed.ambienceEnabled
          : DEFAULT_PREFERENCES.ambienceEnabled,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function makeSnapshot(
  preferences: StoredAudioPreferences,
  reducedEffects: boolean,
  graph: AudioGraph | null,
  ambiencePlaying: boolean,
): GameAudioSnapshot {
  const contextState = graph?.context.state ?? "unavailable";
  return Object.freeze({
    supported: Boolean(getAudioContextConstructor()),
    unlocked: Boolean(graph && contextState === "running"),
    contextState,
    muted: preferences.muted,
    volume: preferences.volume,
    ambienceEnabled: preferences.ambienceEnabled,
    ambiencePlaying,
    reducedEffects,
  });
}

/**
 * Stateful, lazily initialized Web Audio controller.
 *
 * Use `createGameAudio` for an isolated instance in tests or embedded games;
 * most applications should use the `gameAudio` singleton exported below.
 */
export class GameAudio {
  private preferences: StoredAudioPreferences = { ...DEFAULT_PREFERENCES };
  private preferencesLoaded = false;
  private graph: AudioGraph | null = null;
  private ambientGraph: AmbientGraph | null = null;
  private ambientRequested = false;
  private listeners = new Set<GameAudioListener>();
  private gestureCleanups = new Set<() => void>();
  private mediaQuery: MediaQueryList | null = null;
  private reducedEffectsOverride: boolean | null = null;
  private systemReducedEffects = false;
  private storageListener: ((event: StorageEvent) => void) | null = null;
  private mediaListener: ((event: MediaQueryListEvent) => void) | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private snapshot: GameAudioSnapshot = Object.freeze({
    supported: false,
    unlocked: false,
    contextState: "unavailable",
    muted: DEFAULT_PREFERENCES.muted,
    volume: DEFAULT_PREFERENCES.volume,
    ambienceEnabled: DEFAULT_PREFERENCES.ambienceEnabled,
    ambiencePlaying: false,
    reducedEffects: false,
  });

  /** Current state, suitable for React's `useSyncExternalStore`. */
  getSnapshot = (): GameAudioSnapshot => {
    this.ensureBrowserState();
    return this.snapshot;
  };

  /** Stable SSR snapshot for `useSyncExternalStore`'s third argument. */
  getServerSnapshot = (): GameAudioSnapshot => this.snapshot;

  subscribe = (listener: GameAudioListener): (() => void) => {
    this.ensureBrowserState();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Unlock audio from a pointer/key handler. Returns false when called before
   * user activation, when Web Audio is unavailable, or if initialization fails.
   */
  async unlock(gesture?: UserGestureLike): Promise<boolean> {
    this.ensureBrowserState();
    if (!browserHasUserActivation(gesture)) return false;

    if (!this.graph) {
      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) return false;

      try {
        this.graph = this.createGraph(new AudioContextConstructor());
      } catch {
        this.graph = null;
        this.refreshSnapshot();
        return false;
      }
    }

    const { context } = this.graph;
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        this.refreshSnapshot();
        return false;
      }
    }

    const unlocked = context.state === "running";
    this.refreshSnapshot(true);
    if (unlocked && this.ambientRequested) this.maybeStartAmbience();
    return unlocked;
  }

  /**
   * Installs one-time unlock handlers. Context creation happens inside the
   * resulting trusted pointer/touch/key event, never when this method is called.
   */
  installGestureUnlock(target?: EventTarget): () => void {
    if (!isBrowser()) return () => undefined;

    const eventTarget = target ?? window;
    let removed = false;
    const onGesture = (event: Event): void => {
      void this.unlock(event).then((unlocked) => {
        if (unlocked) cleanup();
      });
    };

    const cleanup = (): void => {
      if (removed) return;
      removed = true;
      eventTarget.removeEventListener("pointerdown", onGesture);
      eventTarget.removeEventListener("touchend", onGesture);
      eventTarget.removeEventListener("keydown", onGesture);
      this.gestureCleanups.delete(cleanup);
    };

    eventTarget.addEventListener("pointerdown", onGesture, { passive: true });
    eventTarget.addEventListener("touchend", onGesture, { passive: true });
    eventTarget.addEventListener("keydown", onGesture);
    this.gestureCleanups.add(cleanup);
    return cleanup;
  }

  /** Play a named procedural cue. It is a no-op until audio is unlocked. */
  play(cue: GameAudioCue, options: PlayCueOptions = {}): boolean {
    this.ensureBrowserState();
    const graph = this.graph;
    if (!graph || graph.context.state === "closed" || this.preferences.muted) {
      return false;
    }

    if (graph.context.state === "suspended") {
      // A backgrounded tab can suspend an already-unlocked context. Resuming is
      // safe here; unlike construction, this does not bypass gesture gating.
      void graph.context.resume();
    }

    const reduced = this.effectiveReducedEffects();
    // Tiny, frequent flourishes disappear in reduced-effects mode. Important
    // state cues remain, but are shorter and quieter below.
    if (reduced && (cue === "hover" || cue === "message")) return false;

    const volume = clamp(options.volume ?? 1, 0, 1) * (reduced ? 0.58 : 1);
    if (volume <= 0) return false;
    const pitch = clamp(options.pitch ?? 1, 0.5, 2);
    const pan = clamp(options.pan ?? 0, -1, 1);
    const start =
      graph.context.currentTime + clamp(options.delay ?? 0, 0, 10) + 0.008;

    switch (cue) {
      case "hover":
        this.playHover(start, volume, pitch, pan);
        break;
      case "cardFlip":
        this.playCardFlip(start, volume, pitch, pan);
        break;
      case "nightFall":
        this.playNightFall(start, volume, pitch, pan, reduced);
        break;
      case "reveal":
        this.playReveal(start, volume, pitch, pan, reduced);
        break;
      case "speakerSelection":
        this.playSpeakerSelection(start, volume, pitch, pan);
        break;
      case "message":
        this.playMessage(start, volume, pitch, pan);
        break;
      case "vote":
        this.playVote(start, volume, pitch, pan);
        break;
      case "victory":
        this.playVictory(start, volume, pitch, pan, reduced);
        break;
      case "defeat":
        this.playDefeat(start, volume, pitch, pan, reduced);
        break;
    }

    return true;
  }

  setMuted(muted: boolean): void {
    this.ensureBrowserState();
    if (this.preferences.muted === muted) return;
    this.preferences = { ...this.preferences, muted };
    this.applyMasterVolume();
    if (muted) this.stopAmbientGraph(0.15);
    else if (this.ambientRequested) this.maybeStartAmbience();
    this.persistAndNotify();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.preferences.muted);
    return this.preferences.muted;
  }

  setVolume(volume: number): void {
    this.ensureBrowserState();
    const nextVolume = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
    if (this.preferences.volume === nextVolume) return;
    this.preferences = { ...this.preferences, volume: nextVolume };
    this.applyMasterVolume();
    this.persistAndNotify();
  }

  setAmbienceEnabled(enabled: boolean): void {
    this.ensureBrowserState();
    if (this.preferences.ambienceEnabled === enabled) return;
    this.preferences = { ...this.preferences, ambienceEnabled: enabled };
    if (enabled && this.ambientRequested) this.maybeStartAmbience();
    else this.stopAmbientGraph(0.5);
    this.persistAndNotify();
  }

  /**
   * Overrides the system reduced-motion preference for audio treatment. Pass
   * null to return to automatic behavior. This override is intentionally not
   * persisted so an app-level accessibility setting remains authoritative.
   */
  setReducedEffectsOverride(reduced: boolean | null): void {
    this.ensureBrowserState();
    if (this.reducedEffectsOverride === reduced) return;
    this.reducedEffectsOverride = reduced;
    if (this.effectiveReducedEffects()) this.stopAmbientGraph(0.35);
    else if (this.ambientRequested) this.maybeStartAmbience();
    this.refreshSnapshot(true);
  }

  /**
   * Requests the subtle procedural night bed. The request is remembered until
   * `stopNightAmbience`; it starts after unlock if user settings allow it.
   */
  startNightAmbience(): boolean {
    this.ensureBrowserState();
    this.ambientRequested = true;
    return this.maybeStartAmbience();
  }

  stopNightAmbience(fadeSeconds = 0.8): void {
    this.ambientRequested = false;
    this.stopAmbientGraph(clamp(fadeSeconds, 0, 5));
  }

  /** Stop sources, remove listeners, and close the AudioContext. */
  async dispose(): Promise<void> {
    for (const cleanup of [...this.gestureCleanups]) cleanup();
    this.gestureCleanups.clear();
    this.stopAmbientGraph(0);

    if (isBrowser() && this.storageListener) {
      window.removeEventListener("storage", this.storageListener);
    }
    if (this.mediaQuery && this.mediaListener) {
      this.mediaQuery.removeEventListener("change", this.mediaListener);
    }
    this.storageListener = null;
    this.mediaListener = null;
    this.mediaQuery = null;
    this.listeners.clear();

    const context = this.graph?.context;
    if (this.graph) this.graph.context.onstatechange = null;
    this.graph = null;
    this.noiseBuffer = null;
    this.ambientRequested = false;
    this.preferencesLoaded = false;
    this.preferences = { ...DEFAULT_PREFERENCES };
    this.systemReducedEffects = false;
    this.reducedEffectsOverride = null;
    this.refreshSnapshot();

    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // Some browsers throw while a context is transitioning; all references
        // have already been released, so there is nothing else to clean up.
      }
    }
  }

  private ensureBrowserState(): void {
    if (!isBrowser()) return;
    if (!this.preferencesLoaded) {
      this.preferences = readPreferences();
      this.preferencesLoaded = true;
    }

    if (!this.mediaQuery && typeof window.matchMedia === "function") {
      this.mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
      this.systemReducedEffects = this.mediaQuery.matches;
      this.mediaListener = (event) => {
        this.systemReducedEffects = event.matches;
        if (this.effectiveReducedEffects()) this.stopAmbientGraph(0.35);
        else if (this.ambientRequested) this.maybeStartAmbience();
        this.refreshSnapshot(true);
      };
      this.mediaQuery.addEventListener("change", this.mediaListener);
    }

    if (!this.storageListener) {
      this.storageListener = (event) => {
        if (event.key !== STORAGE_KEY) return;
        this.preferences = readPreferences();
        this.applyMasterVolume();
        if (
          this.preferences.muted ||
          !this.preferences.ambienceEnabled ||
          this.effectiveReducedEffects()
        ) {
          this.stopAmbientGraph(0.25);
        } else if (this.ambientRequested) {
          this.maybeStartAmbience();
        }
        this.refreshSnapshot(true);
      };
      window.addEventListener("storage", this.storageListener);
    }

    this.refreshSnapshot();
  }

  private createGraph(context: AudioContext): AudioGraph {
    const master = context.createGain();
    const effects = context.createGain();
    const ambience = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const reverb = context.createConvolver();
    const reverbGain = context.createGain();

    master.gain.value = this.preferences.muted ? 0 : this.preferences.volume;
    effects.gain.value = 0.82;
    ambience.gain.value = EPSILON_GAIN;
    compressor.threshold.value = -18;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;
    reverb.buffer = this.createImpulseResponse(context, 1.65, 2.6);
    reverbGain.gain.value = 0.22;

    effects.connect(master);
    ambience.connect(master);
    reverb.connect(reverbGain);
    reverbGain.connect(master);
    master.connect(compressor);
    compressor.connect(context.destination);

    const graph = {
      context,
      master,
      effects,
      ambience,
      reverb,
      reverbGain,
      compressor,
    };
    context.onstatechange = () => this.refreshSnapshot(true);
    return graph;
  }

  private createImpulseResponse(
    context: AudioContext,
    seconds: number,
    decay: number,
  ): AudioBuffer {
    const length = Math.floor(context.sampleRate * seconds);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        const envelope = Math.pow(1 - index / length, decay);
        data[index] = (Math.random() * 2 - 1) * envelope;
      }
    }
    return impulse;
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === context.sampleRate) {
      return this.noiseBuffer;
    }

    const length = Math.floor(context.sampleRate * 2);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.82 + white * 0.18;
      data[index] = previous;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  private tone(options: ToneOptions): void {
    const graph = this.graph;
    if (!graph) return;
    const { context } = graph;
    const attack = Math.min(options.attack ?? 0.008, options.duration * 0.4);
    const release = Math.min(options.release ?? 0.12, options.duration * 0.8);
    const stopAt = options.start + options.duration;

    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    let filter: BiquadFilterNode | null = null;

    oscillator.type = options.type ?? "sine";
    oscillator.frequency.setValueAtTime(options.frequency, options.start);
    if (options.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(20, options.endFrequency),
        stopAt,
      );
    }
    envelope.gain.setValueAtTime(EPSILON_GAIN, options.start);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(EPSILON_GAIN, options.gain),
      options.start + attack,
    );
    envelope.gain.setValueAtTime(
      Math.max(EPSILON_GAIN, options.gain),
      Math.max(options.start + attack, stopAt - release),
    );
    envelope.gain.exponentialRampToValueAtTime(EPSILON_GAIN, stopAt);
    panner.pan.value = clamp(options.pan ?? 0, -1, 1);

    oscillator.connect(envelope);
    if (options.filterFrequency) {
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = options.filterFrequency;
      filter.Q.value = 0.6;
      envelope.connect(filter);
      filter.connect(panner);
    } else {
      envelope.connect(panner);
    }
    panner.connect(graph.effects);
    if ((options.reverb ?? 0) > 0) {
      const send = context.createGain();
      send.gain.value = options.reverb ?? 0;
      panner.connect(send);
      send.connect(graph.reverb);
      oscillator.addEventListener(
        "ended",
        () => {
          send.disconnect();
        },
        { once: true },
      );
    }

    oscillator.start(options.start);
    oscillator.stop(stopAt + 0.015);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        envelope.disconnect();
        filter?.disconnect();
        panner.disconnect();
      },
      { once: true },
    );
  }

  private noise(options: NoiseOptions): void {
    const graph = this.graph;
    if (!graph) return;
    const { context } = graph;
    const stopAt = options.start + options.duration;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    const panner = context.createStereoPanner();
    const send = context.createGain();

    source.buffer = this.getNoiseBuffer(context);
    filter.type = options.filterType ?? "bandpass";
    filter.frequency.value = options.filterFrequency ?? 1600;
    filter.Q.value = options.filterQ ?? 0.8;
    envelope.gain.setValueAtTime(Math.max(EPSILON_GAIN, options.gain), options.start);
    envelope.gain.exponentialRampToValueAtTime(EPSILON_GAIN, stopAt);
    panner.pan.value = clamp(options.pan ?? 0, -1, 1);
    send.gain.value = options.reverb ?? 0;

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(panner);
    panner.connect(graph.effects);
    if ((options.reverb ?? 0) > 0) {
      panner.connect(send);
      send.connect(graph.reverb);
    }

    const maximumOffset = Math.max(0, source.buffer.duration - options.duration);
    source.start(options.start, Math.random() * maximumOffset, options.duration);
    source.stop(stopAt + 0.015);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        filter.disconnect();
        envelope.disconnect();
        panner.disconnect();
        send.disconnect();
      },
      { once: true },
    );
  }

  private playHover(start: number, volume: number, pitch: number, pan: number): void {
    this.tone({
      start,
      duration: 0.055,
      frequency: 620 * pitch,
      endFrequency: 770 * pitch,
      type: "sine",
      gain: 0.035 * volume,
      release: 0.04,
      pan,
    });
  }

  private playCardFlip(start: number, volume: number, pitch: number, pan: number): void {
    this.noise({
      start,
      duration: 0.11,
      gain: 0.12 * volume,
      filterType: "bandpass",
      filterFrequency: 1850 * pitch,
      filterQ: 0.7,
      pan,
      reverb: 0.05,
    });
    this.tone({
      start: start + 0.018,
      duration: 0.1,
      frequency: 260 * pitch,
      endFrequency: 630 * pitch,
      type: "triangle",
      gain: 0.065 * volume,
      release: 0.07,
      pan,
      filterFrequency: 2100,
    });
  }

  private playNightFall(
    start: number,
    volume: number,
    pitch: number,
    pan: number,
    reduced: boolean,
  ): void {
    const duration = reduced ? 0.72 : 1.55;
    [330, 220, 146.8].forEach((frequency, index) => {
      this.tone({
        start: start + index * (reduced ? 0.045 : 0.09),
        duration,
        frequency: frequency * pitch,
        endFrequency: frequency * 0.48 * pitch,
        type: index === 2 ? "sine" : "triangle",
        gain: (0.075 - index * 0.012) * volume,
        attack: 0.12,
        release: duration * 0.62,
        pan: pan + (index - 1) * 0.16,
        filterFrequency: 1100,
        reverb: reduced ? 0.08 : 0.32,
      });
    });
    if (!reduced) {
      this.noise({
        start,
        duration: 1.35,
        gain: 0.036 * volume,
        filterType: "lowpass",
        filterFrequency: 480,
        filterQ: 0.4,
        pan,
        reverb: 0.18,
      });
    }
  }

  private playReveal(
    start: number,
    volume: number,
    pitch: number,
    pan: number,
    reduced: boolean,
  ): void {
    const notes = reduced ? [392, 587.33] : [392, 523.25, 659.25, 783.99];
    notes.forEach((frequency, index) => {
      this.tone({
        start: start + index * 0.075,
        duration: reduced ? 0.25 : 0.42,
        frequency: frequency * pitch,
        endFrequency: frequency * 1.015 * pitch,
        type: "sine",
        gain: 0.072 * volume,
        attack: 0.012,
        release: reduced ? 0.17 : 0.3,
        pan: pan + (index % 2 === 0 ? -0.08 : 0.08),
        reverb: reduced ? 0.08 : 0.3,
      });
    });
  }

  private playSpeakerSelection(
    start: number,
    volume: number,
    pitch: number,
    pan: number,
  ): void {
    [440, 659.25].forEach((frequency, index) => {
      this.tone({
        start: start + index * 0.075,
        duration: 0.2,
        frequency: frequency * pitch,
        type: "triangle",
        gain: 0.07 * volume,
        attack: 0.008,
        release: 0.14,
        pan,
        filterFrequency: 2400,
        reverb: 0.12,
      });
    });
  }

  private playMessage(start: number, volume: number, pitch: number, pan: number): void {
    this.tone({
      start,
      duration: 0.15,
      frequency: 740 * pitch,
      endFrequency: 890 * pitch,
      type: "sine",
      gain: 0.04 * volume,
      attack: 0.006,
      release: 0.11,
      pan,
      reverb: 0.06,
    });
  }

  private playVote(start: number, volume: number, pitch: number, pan: number): void {
    this.noise({
      start,
      duration: 0.07,
      gain: 0.13 * volume,
      filterType: "lowpass",
      filterFrequency: 880 * pitch,
      filterQ: 0.5,
      pan,
    });
    this.tone({
      start,
      duration: 0.29,
      frequency: 155 * pitch,
      endFrequency: 82 * pitch,
      type: "triangle",
      gain: 0.12 * volume,
      attack: 0.004,
      release: 0.24,
      pan,
      filterFrequency: 920,
      reverb: 0.12,
    });
  }

  private playVictory(
    start: number,
    volume: number,
    pitch: number,
    pan: number,
    reduced: boolean,
  ): void {
    const notes = reduced
      ? [523.25, 659.25, 783.99]
      : [392, 523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, index) => {
      this.tone({
        start: start + index * 0.1,
        duration: reduced ? 0.33 : 0.72,
        frequency: frequency * pitch,
        type: index % 2 === 0 ? "triangle" : "sine",
        gain: (0.072 - index * 0.004) * volume,
        attack: 0.012,
        release: reduced ? 0.2 : 0.52,
        pan: pan + (index % 2 === 0 ? -0.12 : 0.12),
        filterFrequency: 3300,
        reverb: reduced ? 0.1 : 0.36,
      });
    });
  }

  private playDefeat(
    start: number,
    volume: number,
    pitch: number,
    pan: number,
    reduced: boolean,
  ): void {
    const notes = reduced ? [392, 293.66] : [392, 311.13, 233.08, 155.56];
    notes.forEach((frequency, index) => {
      this.tone({
        start: start + index * (reduced ? 0.13 : 0.18),
        duration: reduced ? 0.38 : 0.8,
        frequency: frequency * pitch,
        endFrequency: frequency * 0.94 * pitch,
        type: "triangle",
        gain: (0.068 - index * 0.007) * volume,
        attack: 0.02,
        release: reduced ? 0.24 : 0.58,
        pan: pan + (index % 2 === 0 ? 0.08 : -0.08),
        filterFrequency: 1300,
        reverb: reduced ? 0.08 : 0.3,
      });
    });
  }

  private maybeStartAmbience(): boolean {
    const graph = this.graph;
    if (
      this.ambientGraph ||
      !graph ||
      graph.context.state !== "running" ||
      this.preferences.muted ||
      !this.preferences.ambienceEnabled ||
      this.effectiveReducedEffects()
    ) {
      this.refreshSnapshot();
      return false;
    }

    const { context } = graph;
    const now = context.currentTime;
    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];

    const noise = context.createBufferSource();
    const noiseFilter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = this.getNoiseBuffer(context);
    noise.loop = true;
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.value = 420;
    noiseFilter.Q.value = 0.35;
    noiseGain.gain.value = 0.022;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(graph.ambience);
    sources.push(noise);
    nodes.push(noiseFilter, noiseGain);

    const drone = context.createOscillator();
    const droneGain = context.createGain();
    drone.type = "sine";
    drone.frequency.value = 54;
    droneGain.gain.value = 0.018;
    drone.connect(droneGain);
    droneGain.connect(graph.ambience);
    sources.push(drone);
    nodes.push(droneGain);

    const overtone = context.createOscillator();
    const overtoneGain = context.createGain();
    overtone.type = "sine";
    overtone.frequency.value = 82.4;
    overtoneGain.gain.value = 0.009;
    overtone.connect(overtoneGain);
    overtoneGain.connect(graph.ambience);
    sources.push(overtone);
    nodes.push(overtoneGain);

    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.type = "sine";
    lfo.frequency.value = 0.075;
    lfoGain.gain.value = 0.007;
    lfo.connect(lfoGain);
    lfoGain.connect(noiseGain.gain);
    sources.push(lfo);
    nodes.push(lfoGain);

    graph.ambience.gain.cancelScheduledValues(now);
    graph.ambience.gain.setValueAtTime(EPSILON_GAIN, now);
    graph.ambience.gain.exponentialRampToValueAtTime(0.72, now + 2.2);
    for (const source of sources) source.start(now);
    this.ambientGraph = { sources, nodes };
    this.refreshSnapshot(true);
    return true;
  }

  private stopAmbientGraph(fadeSeconds: number): void {
    const ambientGraph = this.ambientGraph;
    const graph = this.graph;
    if (!ambientGraph || !graph) return;
    this.ambientGraph = null;

    const now = graph.context.currentTime;
    const stopAt = now + fadeSeconds;
    graph.ambience.gain.cancelScheduledValues(now);
    graph.ambience.gain.setValueAtTime(
      Math.max(EPSILON_GAIN, graph.ambience.gain.value),
      now,
    );
    graph.ambience.gain.exponentialRampToValueAtTime(EPSILON_GAIN, stopAt + 0.01);

    for (const source of ambientGraph.sources) {
      try {
        source.stop(stopAt + 0.02);
      } catch {
        // A source may already have ended during context shutdown.
      }
    }

    const finalSource = ambientGraph.sources.at(-1);
    if (finalSource) {
      finalSource.addEventListener(
        "ended",
        () => {
          for (const source of ambientGraph.sources) source.disconnect();
          for (const node of ambientGraph.nodes) node.disconnect();
        },
        { once: true },
      );
    } else {
      for (const node of ambientGraph.nodes) node.disconnect();
    }
    this.refreshSnapshot(true);
  }

  private applyMasterVolume(): void {
    if (!this.graph) return;
    const { context, master } = this.graph;
    const target = this.preferences.muted ? 0 : this.preferences.volume;
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(target, context.currentTime, 0.025);
  }

  private effectiveReducedEffects(): boolean {
    return this.reducedEffectsOverride ?? this.systemReducedEffects;
  }

  private persistAndNotify(): void {
    if (isBrowser()) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences));
      } catch {
        // Private browsing and locked-down embeds may reject localStorage.
      }
    }
    this.refreshSnapshot(true);
  }

  private refreshSnapshot(notify = false): void {
    const next = makeSnapshot(
      this.preferences,
      this.effectiveReducedEffects(),
      this.graph,
      Boolean(this.ambientGraph),
    );
    const previous = this.snapshot;
    const changed =
      previous.supported !== next.supported ||
      previous.unlocked !== next.unlocked ||
      previous.contextState !== next.contextState ||
      previous.muted !== next.muted ||
      previous.volume !== next.volume ||
      previous.ambienceEnabled !== next.ambienceEnabled ||
      previous.ambiencePlaying !== next.ambiencePlaying ||
      previous.reducedEffects !== next.reducedEffects;
    if (!changed) return;
    this.snapshot = next;
    if (notify) {
      for (const listener of this.listeners) listener(this.snapshot);
    }
  }
}

export function createGameAudio(): GameAudio {
  return new GameAudio();
}

/** Shared controller for the application's single game soundscape. */
export const gameAudio = createGameAudio();
