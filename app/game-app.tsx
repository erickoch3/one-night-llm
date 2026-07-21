"use client";

import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CircleHelp,
  Copy,
  Crown,
  ExternalLink,
  Eye,
  LoaderCircle,
  MessageCircle,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Shield,
  Skull,
  Sparkles,
  Volume2,
  VolumeX,
  Vote,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { CardSlot, KnowledgeItem, PlayerId, RoleId } from "@/lib/game/types";
import { gameAudio } from "@/lib/audio";
import {
  AGENT_MODELS,
  AGENT_REASONING_EFFORTS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_REASONING_EFFORT,
  type AgentModel,
  type AgentReasoningEffort,
} from "@/lib/shared/agent-config";
import {
  gameApi,
  type CodexAuthStatus,
  type CodexLoginChallenge,
} from "@/lib/client/api";
import type {
  GameMode,
  GameSnapshot,
  HumanNightActionRequest,
  NightHistoryEntryView,
  PublicPlayerView,
} from "@/lib/shared/protocol";

type AppScreen = "landing" | "lobby" | "game";
type RolePack = "classic" | "chaos";

const ROLE_GLYPHS: Record<RoleId, string> = {
  werewolf: "◑",
  villager: "⌂",
  seer: "✦",
  robber: "♠",
  troublemaker: "⇄",
  drunk: "◒",
  insomniac: "☾",
  minion: "♟",
  hunter: "⌖",
  tanner: "◇",
};

const ROLE_NAMES: Record<RoleId, string> = {
  werewolf: "Werewolf",
  villager: "Villager",
  seer: "Seer",
  robber: "Robber",
  troublemaker: "Troublemaker",
  drunk: "Drunk",
  insomniac: "Insomniac",
  minion: "Minion",
  hunter: "Hunter",
  tanner: "Tanner",
};

const PHASES = [
  { id: "night", label: "Night", icon: Moon },
  { id: "discussion", label: "Speak", icon: MessageCircle },
  { id: "voting", label: "Vote", icon: Vote },
  { id: "resolved", label: "Reveal", icon: Eye },
] as const;

const CONVERSATION_DELAYS_MS = {
  typing: 180,
  hover: 350,
  automatic: 700,
} as const;

const AGENT_MODEL_LABELS: Record<AgentModel, string> = {
  "gpt-5.6-luna": "Luna · efficient",
  "gpt-5.6-terra": "Terra · balanced",
  "gpt-5.6-sol": "Sol · most capable",
};

const AGENT_REASONING_LABELS: Record<AgentReasoningEffort, string> = {
  low: "Low · fastest",
  medium: "Medium · balanced",
  high: "High · deeper",
  xhigh: "Extra high",
  max: "Max · slowest",
};

export function GameApp() {
  const [screen, setScreen] = useState<AppScreen>("landing");
  const [auth, setAuth] = useState<CodexAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginChallenge, setLoginChallenge] =
    useState<CodexLoginChallenge | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [playerName, setPlayerName] = useState("Player");
  const [agentCount, setAgentCount] = useState(4);
  const [rolePack, setRolePack] = useState<RolePack>("classic");
  const [mode, setMode] = useState<GameMode>("codex");
  const [agentModel, setAgentModel] = useState<AgentModel>(DEFAULT_AGENT_MODEL);
  const [agentReasoningEffort, setAgentReasoningEffort] =
    useState<AgentReasoningEffort>(DEFAULT_AGENT_REASONING_EFFORT);
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const actionGenerationRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [roleOverlay, setRoleOverlay] = useState(false);
  const [roleFlipped, setRoleFlipped] = useState(false);
  const [message, setMessage] = useState("");
  const [hoverTargetId, setHoverTargetId] = useState<PlayerId | null>(null);
  const [voteTargetId, setVoteTargetId] = useState<PlayerId | null>(null);
  const [autoFlow, setAutoFlow] = useState(true);
  const [rulesOpen, setRulesOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const previousPhaseRef = useRef<GameSnapshot["phase"] | null>(null);
  const audio = useSyncExternalStore(
    gameAudio.subscribe,
    gameAudio.getSnapshot,
    gameAudio.getServerSnapshot,
  );

  useEffect(() => gameAudio.installGestureUnlock(), []);

  useEffect(() => {
    let active = true;
    gameApi
      .authStatus()
      .then((status) => {
        if (active) setAuth(status);
      })
      .catch((reason) => {
        if (active) {
          setAuth({
            available: false,
            signedIn: false,
            account: null,
            message: reason instanceof Error ? reason.message : "Codex is unavailable.",
          });
        }
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!loginChallenge) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const status = await gameApi.loginStatus(loginChallenge.loginId);
        if (cancelled || status.state === "pending") return;
        if (status.state === "failed") throw new Error(status.message);
        setAuth(status.status);
        setLoginChallenge(null);
        setLoginPending(false);
        setMode("codex");
        gameAudio.play("reveal");
      } catch (reason) {
        if (!cancelled) {
          setLoginPending(false);
          setError(reason instanceof Error ? reason.message : "Sign-in failed.");
        }
      }
    }, 1_400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loginChallenge]);

  useEffect(() => {
    if (!game) return;
    if (game.phase === "night" || roleOverlay) gameAudio.startNightAmbience();
    else gameAudio.stopNightAmbience();
    const previous = previousPhaseRef.current;
    if (previous && previous !== game.phase) {
      if (game.phase === "voting") gameAudio.play("vote");
      if (game.phase === "resolved") {
        gameAudio.play(game.resolution?.playerWon ? "victory" : "defeat");
      }
    }
    previousPhaseRef.current = game.phase;
  }, [game, roleOverlay]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [game?.dialogue.transcript.length]);

  const runGameAction = useCallback(
    async (operation: () => Promise<GameSnapshot>) => {
      if (pendingRef.current) return null;
      const generation = actionGenerationRef.current;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        const beforeCount = game?.dialogue.transcript.length ?? 0;
        const next = await operation();
        if (generation !== actionGenerationRef.current) return null;
        setGame(next);
        if (next.dialogue.transcript.length > beforeCount) {
          gameAudio.play("message");
        }
        return next;
      } catch (reason) {
        if (generation === actionGenerationRef.current) {
          setError(reason instanceof Error ? reason.message : "The village lost the thread.");
        }
        return null;
      } finally {
        if (generation === actionGenerationRef.current) {
          pendingRef.current = false;
          setPending(false);
        }
      }
    },
    [game],
  );

  const advanceConversation = useCallback(
    (humanWantsToSpeak: boolean) => {
      if (!game || game.phase !== "discussion") return;
      void runGameAction(() =>
        gameApi.advanceDialogue(game.gameId, {
          humanWantsToSpeak,
          hoverTargetId,
        }),
      );
    },
    [game, hoverTargetId, runGameAction],
  );

  useEffect(() => {
    if (
      !game ||
      game.phase !== "discussion" ||
      game.dialogue.humanMaySpeak ||
      pending ||
      roleOverlay
    ) {
      return;
    }
    const typing = message.trim().length > 0;
    if (!typing && !autoFlow && !hoverTargetId) return;
    const delay = typing
      ? CONVERSATION_DELAYS_MS.typing
      : hoverTargetId
        ? CONVERSATION_DELAYS_MS.hover
        : CONVERSATION_DELAYS_MS.automatic;
    const timer = window.setTimeout(
      () => advanceConversation(typing),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [
    advanceConversation,
    autoFlow,
    game,
    hoverTargetId,
    message,
    pending,
    roleOverlay,
  ]);

  async function startLogin(method: "browser" | "device") {
    setLoginPending(true);
    setError(null);
    try {
      const challenge = await gameApi.beginLogin(method);
      setLoginChallenge(challenge);
      window.open(
        challenge.authorizationUrl,
        "one-night-codex-login",
        "popup,width=720,height=780,noopener,noreferrer",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start sign-in.");
      setLoginPending(false);
    }
  }

  async function startGame(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current) return;
    const generation = actionGenerationRef.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const next = await gameApi.createGame({
        playerName: playerName.trim() || "Player",
        agentCount,
        mode,
        rolePack,
        agentModel,
        agentReasoningEffort,
      });
      if (generation !== actionGenerationRef.current) {
        await gameApi.leave(next.gameId).catch(() => undefined);
        return;
      }
      setGame(next);
      setScreen("game");
      setRoleOverlay(true);
      setRoleFlipped(false);
      setMessage("");
      setVoteTargetId(null);
      previousPhaseRef.current = next.phase;
      gameAudio.play("nightFall");
    } catch (reason) {
      if (generation === actionGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : "Could not gather the village.");
      }
    } finally {
      if (generation === actionGenerationRef.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  function returnToLanding() {
    actionGenerationRef.current += 1;
    pendingRef.current = false;
    setPending(false);
    setError(null);
    setScreen("landing");
  }

  async function leaveGame() {
    const departingGame = game;
    actionGenerationRef.current += 1;
    pendingRef.current = false;
    setPending(false);
    if (departingGame) {
      await gameApi.leave(departingGame.gameId).catch(() => undefined);
    }
    setGame(null);
    setScreen("lobby");
    setRoleOverlay(false);
    setRoleFlipped(false);
    setMessage("");
    setVoteTargetId(null);
    gameAudio.stopNightAmbience();
  }

  function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!game || !game.dialogue.humanMaySpeak || !message.trim()) return;
    const text = message.trim();
    setMessage("");
    void runGameAction(() => gameApi.speak(game.gameId, text));
  }

  const shellClass = `app-shell screen-${screen} ${game?.phase ? `phase-${game.phase}` : ""}`;

  return (
    <main className={shellClass}>
      <div className="atmosphere" aria-hidden="true">
        <span className="star star-one" />
        <span className="star star-two" />
        <span className="star star-three" />
        <span className="mist mist-one" />
        <span className="mist mist-two" />
      </div>

      <GlobalBar
        screen={screen}
        auth={auth}
        authLoading={authLoading}
        muted={audio.muted}
        onToggleSound={() => gameAudio.toggleMuted()}
        onBack={screen === "game" ? leaveGame : returnToLanding}
      />

      {screen === "landing" && (
        <Landing
          onEnter={() => {
            gameAudio.play("reveal");
            setScreen("lobby");
          }}
          onRules={() => setRulesOpen(true)}
        />
      )}

      {screen === "lobby" && (
        <Lobby
          playerName={playerName}
          onPlayerName={setPlayerName}
          agentCount={agentCount}
          onAgentCount={setAgentCount}
          rolePack={rolePack}
          onRolePack={setRolePack}
          mode={mode}
          onMode={setMode}
          agentModel={agentModel}
          onAgentModel={setAgentModel}
          agentReasoningEffort={agentReasoningEffort}
          onAgentReasoningEffort={setAgentReasoningEffort}
          auth={auth}
          authLoading={authLoading}
          pending={pending}
          loginPending={loginPending}
          onLogin={startLogin}
          onSubmit={startGame}
        />
      )}

      {screen === "game" && game && (
        <GameBoard
          game={game}
          pending={pending}
          message={message}
          onMessage={setMessage}
          hoverTargetId={hoverTargetId}
          onHoverTarget={(id) => {
            setHoverTargetId(id);
            if (id) gameAudio.play("hover", { volume: 0.35 });
          }}
          voteTargetId={voteTargetId}
          onVoteTarget={setVoteTargetId}
          autoFlow={autoFlow}
          onAutoFlow={setAutoFlow}
          onAdvance={() => advanceConversation(message.trim().length > 0)}
          onSubmitMessage={submitMessage}
          onStartVote={() =>
            void runGameAction(() => gameApi.startVote(game.gameId))
          }
          onCastVote={() => {
            if (!voteTargetId) return;
            gameAudio.play("vote");
            void runGameAction(() => gameApi.castVote(game.gameId, voteTargetId));
          }}
          transcriptRef={transcriptRef}
          onPlayAgain={leaveGame}
        />
      )}

      {roleOverlay && game && (
        <RoleReveal
          game={game}
          flipped={roleFlipped}
          pending={pending}
          onFlip={() => {
            setRoleFlipped(true);
            gameAudio.play("cardFlip");
          }}
          onNightAction={(action) =>
            void runGameAction(() => gameApi.nightAction(game.gameId, action))
          }
          onAdvanceNight={() =>
            void runGameAction(() => gameApi.advanceNight(game.gameId))
          }
          onClose={() => {
            setRoleOverlay(false);
            gameAudio.play("reveal");
          }}
        />
      )}

      {loginChallenge && (
        <LoginModal
          challenge={loginChallenge}
          pending={loginPending}
          onDeviceFallback={() => void startLogin("device")}
          onClose={() => {
            setLoginChallenge(null);
            setLoginPending(false);
          }}
        />
      )}

      {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      {pending && screen === "game" && (
        <div className="thinking-ribbon" aria-live="polite">
          <span className="thinking-orb" />
          {game?.phase === "night"
            ? "The night is moving…"
            : game?.phase === "voting"
              ? "The village is casting its ballots…"
              : "The village is deciding who gets the floor…"}
        </div>
      )}
    </main>
  );
}

function GlobalBar({
  screen,
  auth,
  authLoading,
  muted,
  onToggleSound,
  onBack,
}: {
  screen: AppScreen;
  auth: CodexAuthStatus | null;
  authLoading: boolean;
  muted: boolean;
  onToggleSound: () => void;
  onBack: () => void;
}) {
  return (
    <header className="global-bar">
      <button
        className="wordmark"
        onClick={screen === "landing" ? undefined : onBack}
        aria-label={screen === "landing" ? "One Night home" : "Go back"}
      >
        {screen !== "landing" && <ArrowLeft size={15} />}
        <Moon size={18} fill="currentColor" />
        <span>ONE NIGHT</span>
      </button>
      <div className="global-actions">
        <span
          className={`connection-pill ${auth?.signedIn ? "is-connected" : ""}`}
          title={auth?.message}
        >
          <i />
          {authLoading
            ? "Finding Codex"
            : auth?.signedIn
              ? "Codex awake"
              : "Local village"}
        </span>
        <button
          className="icon-button"
          onClick={onToggleSound}
          aria-label={muted ? "Turn sound on" : "Mute sound"}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
    </header>
  );
}

function Landing({ onEnter, onRules }: { onEnter: () => void; onRules: () => void }) {
  return (
    <section className="landing-view">
      <div className="hero-moon" aria-hidden="true">
        <div className="moon-face" />
        <div className="moon-halo" />
      </div>
      <div className="hero-copy">
        <p className="eyebrow">A village of human &amp; machine voices</p>
        <h1>
          Trust no one
          <span>before dawn.</span>
        </h1>
        <p className="hero-lede">
          One night. Hidden roles. A living conversation where every player decides
          when to speak—and whether they want to hear from you.
        </p>
        <div className="hero-actions">
          <button className="primary-button large" onClick={onEnter}>
            Gather the village <ArrowRight size={18} />
          </button>
          <button className="text-button" onClick={onRules}>
            <CircleHelp size={16} /> How the night unfolds
          </button>
        </div>
      </div>
      <div className="landing-steps" aria-label="Game phases">
        <article>
          <span>01</span>
          <Moon size={19} />
          <div><strong>Wake in secret</strong><small>Learn, inspect, or move a card.</small></div>
        </article>
        <article>
          <span>02</span>
          <MessageCircle size={19} />
          <div><strong>Fight for the floor</strong><small>Conversation finds its own rhythm.</small></div>
        </article>
        <article>
          <span>03</span>
          <Vote size={19} />
          <div><strong>Choose together</strong><small>One vote decides the village.</small></div>
        </article>
      </div>
      <p className="landing-footnote">Local-first · Powered by your Codex login · No API key</p>
    </section>
  );
}

function Lobby({
  playerName,
  onPlayerName,
  agentCount,
  onAgentCount,
  rolePack,
  onRolePack,
  mode,
  onMode,
  agentModel,
  onAgentModel,
  agentReasoningEffort,
  onAgentReasoningEffort,
  auth,
  authLoading,
  pending,
  loginPending,
  onLogin,
  onSubmit,
}: {
  playerName: string;
  onPlayerName: (value: string) => void;
  agentCount: number;
  onAgentCount: (value: number) => void;
  rolePack: RolePack;
  onRolePack: (value: RolePack) => void;
  mode: GameMode;
  onMode: (value: GameMode) => void;
  agentModel: AgentModel;
  onAgentModel: (value: AgentModel) => void;
  agentReasoningEffort: AgentReasoningEffort;
  onAgentReasoningEffort: (value: AgentReasoningEffort) => void;
  auth: CodexAuthStatus | null;
  authLoading: boolean;
  pending: boolean;
  loginPending: boolean;
  onLogin: (method: "browser" | "device") => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const previewPlayers = [
    "YOU",
    ...Array.from({ length: agentCount }, (_, index) => `A${index + 1}`),
  ];
  const canStart = mode === "rehearsal" || Boolean(auth?.signedIn);
  return (
    <section className="lobby-view">
      <div className="lobby-heading">
        <p className="eyebrow">Prepare the table</p>
        <h1>Who gathers tonight?</h1>
        <p>Begin with one human. The table is structured for more when you are ready.</p>
      </div>
      <div className="lobby-grid">
        <form className="setup-card" onSubmit={onSubmit}>
          <div className="form-section">
            <div className="section-label"><span>1</span><div><strong>Your seat</strong><small>The name the village will know.</small></div></div>
            <label className="field-label" htmlFor="player-name">Player name</label>
            <input
              id="player-name"
              className="text-input"
              value={playerName}
              maxLength={40}
              onChange={(event) => onPlayerName(event.target.value)}
              placeholder="Your name"
            />
          </div>

          <div className="form-section">
            <div className="section-label"><span>2</span><div><strong>Village size</strong><small>You plus {agentCount} independent agents.</small></div></div>
            <div className="stepper-row">
              <button type="button" onClick={() => onAgentCount(Math.max(2, agentCount - 1))} aria-label="Remove an agent">−</button>
              <div><b>{agentCount + 1}</b><small>players</small></div>
              <button type="button" onClick={() => onAgentCount(Math.min(6, agentCount + 1))} aria-label="Add an agent">+</button>
            </div>
          </div>

          <div className="form-section">
            <div className="section-label"><span>3</span><div><strong>Role deck</strong><small>Three extra cards always wait in the center.</small></div></div>
            <div className="choice-grid role-pack-grid">
              <button
                type="button"
                className={rolePack === "classic" ? "selected" : ""}
                onClick={() => onRolePack("classic")}
              >
                <Shield size={18} /><strong>Classic</strong><small>Clean deductions, iconic swaps.</small>
                {rolePack === "classic" && <Check size={15} />}
              </button>
              <button
                type="button"
                className={rolePack === "chaos" ? "selected" : ""}
                onClick={() => onRolePack("chaos")}
              >
                <Sparkles size={18} /><strong>Wild night</strong><small>Minion, Tanner, Hunter &amp; more.</small>
                {rolePack === "chaos" && <Check size={15} />}
              </button>
            </div>
          </div>

          <div className="form-section backend-section">
            <div className="section-label"><span>4</span><div><strong>Players’ minds</strong><small>Codex is the primary game engine.</small></div></div>
            <button
              type="button"
              className={`backend-choice ${mode === "codex" ? "selected" : ""}`}
              onClick={() => onMode("codex")}
            >
              <span className="backend-icon"><Bot size={19} /></span>
              <span><strong>Codex agents <em>Recommended</em></strong><small>{authLoading ? "Checking your local runtime…" : auth?.signedIn ? auth.message : "Sign in with ChatGPT—no API key needed."}</small></span>
              {auth?.signedIn ? <Check size={18} /> : mode === "codex" ? <i /> : null}
            </button>
            {mode === "codex" && (
              <div className="agent-config-panel" aria-label="Codex agent settings">
                <div className="agent-config-heading">
                  <strong>Model settings</strong>
                  <small>Applied to every agent decision in this game.</small>
                </div>
                <div className="agent-config-grid">
                  <label>
                    <span>Model</span>
                    <select
                      value={agentModel}
                      disabled={pending}
                      onChange={(event) => onAgentModel(event.target.value as AgentModel)}
                    >
                      {AGENT_MODELS.map((value) => (
                        <option key={value} value={value}>
                          {AGENT_MODEL_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Reasoning</span>
                    <select
                      value={agentReasoningEffort}
                      disabled={pending}
                      onChange={(event) =>
                        onAgentReasoningEffort(
                          event.target.value as AgentReasoningEffort,
                        )
                      }
                    >
                      {AGENT_REASONING_EFFORTS.map((value) => (
                        <option key={value} value={value}>
                          {AGENT_REASONING_LABELS[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            )}
            {mode === "codex" && !auth?.signedIn && (
              <div className="connect-row">
                <button
                  type="button"
                  className="connect-button"
                  disabled={loginPending || authLoading}
                  onClick={() => onLogin("browser")}
                >
                  {loginPending ? <LoaderCircle className="spin" size={16} /> : <ExternalLink size={15} />}
                  Sign in with ChatGPT
                </button>
                <button type="button" className="device-link" onClick={() => onLogin("device")}>Use a device code</button>
              </div>
            )}
            <button
              type="button"
              className={`backend-choice compact ${mode === "rehearsal" ? "selected" : ""}`}
              onClick={() => onMode("rehearsal")}
            >
              <span className="backend-icon"><RefreshCw size={17} /></span>
              <span><strong>Rehearsal agents</strong><small>Fast deterministic understudies; no sign-in.</small></span>
              {mode === "rehearsal" && <Check size={17} />}
            </button>
          </div>

          <button className="primary-button start-game-button" disabled={!canStart || pending}>
            {pending ? <><LoaderCircle className="spin" size={18} /> The village falls asleep…</> : <>Deal the roles <ArrowRight size={18} /></>}
          </button>
        </form>

        <aside className="table-preview">
          <div className="preview-orbit" style={{ "--preview-count": previewPlayers.length } as CSSProperties}>
            <div className="preview-moon"><Moon size={31} fill="currentColor" /><span>{previewPlayers.length}</span><small>souls</small></div>
            {previewPlayers.map((avatar, index) => (
              <span
                key={avatar}
                className={`preview-avatar ${index === 0 ? "you" : ""}`}
                style={{ "--preview-angle": `${(360 / previewPlayers.length) * index}deg` } as CSSProperties}
              >{avatar}</span>
            ))}
          </div>
          <div className="preview-copy">
            <p className="eyebrow">Tonight’s table</p>
            <h2>Every table sounds different.</h2>
            <p>Each agent gets a random everyday personality and backstory for the whole match. It shapes how they talk, never what they know about the game.</p>
            <dl>
              <div><dt>{agentCount + 4}</dt><dd>cards dealt</dd></div>
              <div><dt>3</dt><dd>in the center</dd></div>
              <div><dt>1</dt><dd>voice at a time</dd></div>
            </dl>
          </div>
        </aside>
      </div>
    </section>
  );
}

function GameBoard({
  game,
  pending,
  message,
  onMessage,
  hoverTargetId,
  onHoverTarget,
  voteTargetId,
  onVoteTarget,
  autoFlow,
  onAutoFlow,
  onAdvance,
  onSubmitMessage,
  onStartVote,
  onCastVote,
  transcriptRef,
  onPlayAgain,
}: {
  game: GameSnapshot;
  pending: boolean;
  message: string;
  onMessage: (value: string) => void;
  hoverTargetId: PlayerId | null;
  onHoverTarget: (value: PlayerId | null) => void;
  voteTargetId: PlayerId | null;
  onVoteTarget: (value: PlayerId | null) => void;
  autoFlow: boolean;
  onAutoFlow: (value: boolean) => void;
  onAdvance: () => void;
  onSubmitMessage: (event: FormEvent) => void;
  onStartVote: () => void;
  onCastVote: () => void;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  onPlayAgain: () => void;
}) {
  const hovered = game.players.find((player) => player.id === hoverTargetId);
  return (
    <section className="game-view">
      <PhaseRail phase={game.phase} />
      <div className="game-grid">
        <RolePanel game={game} />
        <VillageTable
          game={game}
          hoverTargetId={hoverTargetId}
          voteTargetId={voteTargetId}
          onHoverTarget={onHoverTarget}
          onPlayerClick={(id) => {
            if (game.phase === "voting") onVoteTarget(id === voteTargetId ? null : id);
          }}
        />
        <DialoguePanel
          game={game}
          pending={pending}
          message={message}
          onMessage={onMessage}
          voteTargetId={voteTargetId}
          onVoteTarget={onVoteTarget}
          autoFlow={autoFlow}
          onAutoFlow={onAutoFlow}
          onAdvance={onAdvance}
          onSubmitMessage={onSubmitMessage}
          onStartVote={onStartVote}
          onCastVote={onCastVote}
          transcriptRef={transcriptRef}
          onPlayAgain={onPlayAgain}
        />
      </div>
      {game.phase === "discussion" && hovered && !hovered.isYou && (
        <div className="listen-intent" role="status">
          <span className="listen-waves"><i /><i /><i /></span>
          You want to hear from <strong>{hovered.name}</strong>
        </div>
      )}
      {game.notice && <div className="degraded-note">{game.notice}</div>}
    </section>
  );
}

function PhaseRail({ phase }: { phase: GameSnapshot["phase"] }) {
  const activeIndex = PHASES.findIndex((item) => item.id === phase);
  return (
    <nav className="phase-rail" aria-label="Game progress">
      {PHASES.map((item, index) => {
        const Icon = item.icon;
        return (
          <div key={item.id} className={`${index === activeIndex ? "active" : ""} ${index < activeIndex ? "complete" : ""}`}>
            <span>{index < activeIndex ? <Check size={13} /> : <Icon size={14} />}</span>
            <small>{item.label}</small>
          </div>
        );
      })}
    </nav>
  );
}

function RolePanel({ game }: { game: GameSnapshot }) {
  const role = game.ownInitialRole;
  return (
    <aside className="role-panel panel">
      <div className="panel-kicker"><Eye size={14} /> Your secret</div>
      <div className={`mini-role-card team-${role.team}`}>
        <span className="role-corner">{ROLE_GLYPHS[role.id]}</span>
        <div className="role-sigil">{ROLE_GLYPHS[role.id]}</div>
        <small>You began as</small>
        <h2>{role.name}</h2>
        <p>{role.wakeInstructions}</p>
        <span className="team-tag">{role.team === "werewolf" ? "Werewolf team" : role.team === "tanner" ? "Your own side" : "Village team"}</span>
      </div>
      {game.ownKnownCurrentRole && (
        <div className="current-role-note">
          <RefreshCw size={15} />
          <span>Your known final card is <strong>{game.ownKnownCurrentRole.name}</strong>.</span>
        </div>
      )}
      <NightHistory game={game} variant="compact" />
      {game.phase === "discussion" && (
        <div className="discussion-meter">
          <div><strong>Discussion</strong><span>{game.dialogue.turnNumber} statements</span></div>
          <p>The table decides when it is ready to vote.</p>
        </div>
      )}
    </aside>
  );
}

function NightHistory({
  game,
  variant,
}: {
  game: GameSnapshot;
  variant: "compact" | "full";
}) {
  const history = [...game.nightHistory].sort(
    (left, right) => left.order - right.order,
  );

  return (
    <section
      className={`night-history night-history-${variant}`}
      aria-label="Night history in role order"
    >
      <div className="intel-heading">
        <strong>{variant === "full" ? "What happened tonight" : "Night history"}</strong>
        <span>{history.filter((entry) => entry.status === "complete").length}</span>
      </div>
      {history.length ? (
        <ol>
          {history.map((entry, index) => {
            const viewerHasPersonalStep =
              entry.status !== "complete" && entry.role === game.ownInitialRole.id;
            const personalDetails = entry.privateKnowledge.map((knowledge, detailIndex) => (
              <li key={`${entry.id}-knowledge-${detailIndex}`}>
                {describeNightKnowledge(knowledge, game)}
              </li>
            ));
            const statusLabel =
              entry.status === "active"
                ? "Now"
                : entry.status === "complete"
                  ? "Complete"
                  : "Upcoming";

            return (
              <li
                key={entry.id}
                className={`${entry.status} ${entry.viewerWasAwake || viewerHasPersonalStep ? "viewer-awake" : "viewer-asleep"}`}
                aria-current={entry.status === "active" ? "step" : undefined}
              >
                <span className="night-history-marker" aria-hidden="true">
                  {entry.status === "complete" ? <Check size={11} /> : index + 1}
                </span>
                <div>
                  <header>
                    <strong>{entry.roleName}</strong>
                    <small>{statusLabel}</small>
                  </header>
                  {variant === "full" && <p className="night-history-call">{entry.wakeCall}</p>}
                  <p className="night-history-visibility">
                    {nightVisibilityCopy(entry, game.ownInitialRole.id)}
                  </p>
                  {personalDetails.length > 0 && (
                    <ul className="night-private-knowledge">{personalDetails}</ul>
                  )}
                  {variant === "full" && entry.status === "complete" && (
                    <p className="night-history-close">{entry.closeCall}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="empty-intel">No role was called during the night.</p>
      )}
    </section>
  );
}

function nightVisibilityCopy(entry: NightHistoryEntryView, ownInitialRole: RoleId) {
  if (entry.status === "upcoming" && entry.role === ownInitialRole) {
    return "You will open your eyes for this step.";
  }
  if (entry.status === "active" && entry.role === ownInitialRole) {
    return "Your eyes are open now. This is your private step.";
  }
  if (!entry.viewerWasAwake) {
    return entry.status === "upcoming"
      ? "Your eyes will stay closed; this step is private to whoever wakes."
      : "Your eyes were closed; whatever happened in this step stayed hidden.";
  }
  if (entry.status === "active") return "Your eyes are open now. This is your private step.";
  return entry.didAct
    ? "You were awake and completed your private step."
    : "You were awake for this step.";
}

function VillageTable({
  game,
  hoverTargetId,
  voteTargetId,
  onHoverTarget,
  onPlayerClick,
}: {
  game: GameSnapshot;
  hoverTargetId: PlayerId | null;
  voteTargetId: PlayerId | null;
  onHoverTarget: (value: PlayerId | null) => void;
  onPlayerClick: (value: PlayerId) => void;
}) {
  const activePlayer = game.players.find((player) => player.id === game.dialogue.activeSpeakerId);
  return (
    <section className="village-stage" aria-label="Village table">
      <div className={`table-orbit ${game.phase === "night" ? "sleeping" : ""}`} style={{ "--player-count": game.players.length } as CSSProperties}>
        <div className="table-surface">
          <div className="table-runes" aria-hidden="true" />
          <div className="center-cards" aria-label="Center cards">
            {game.centerCards.map((card) => (
              <div className={`center-card ${card.role ? "revealed" : ""}`} key={card.index}>
                <span>{card.role ? ROLE_GLYPHS[card.role] : "✦"}</span>
                <small>{card.role ? ROLE_NAMES[card.role] : `CENTER ${card.index + 1}`}</small>
              </div>
            ))}
          </div>
          <div className="table-status">
            <span className="status-moon"><Moon size={18} fill="currentColor" /></span>
            <small>{game.phaseLabel}</small>
            <strong>{tableStatus(game, activePlayer)}</strong>
          </div>
        </div>
        {game.players.map((player, index) => {
          const isActive = game.dialogue.activeSpeakerId === player.id;
          const isRecent = game.dialogue.recentSpeakerIds.at(-1) === player.id;
          const selected = hoverTargetId === player.id || voteTargetId === player.id;
          return (
            <button
              key={player.id}
              className={`player-seat ${player.isYou ? "is-you" : ""} ${isActive ? "is-speaking" : ""} ${isRecent ? "just-spoke" : ""} ${selected ? "is-selected" : ""}`}
              style={{ "--seat-angle": `${(360 / game.players.length) * index}deg` } as CSSProperties}
              onMouseEnter={() => !player.isYou && onHoverTarget(player.id)}
              onMouseLeave={() => onHoverTarget(null)}
              onFocus={() => !player.isYou && onHoverTarget(player.id)}
              onBlur={() => onHoverTarget(null)}
              onClick={() => !player.isYou && onPlayerClick(player.id)}
              aria-label={`${player.name}${isActive ? ", speaking" : ""}${game.phase === "voting" ? ", choose as vote" : ""}`}
            >
              <span className="seat-unrotate">
                <span className="avatar-ring">
                  <span className="avatar-core">{player.avatar}</span>
                  {isActive && <span className="voice-rings"><i /><i /><i /></span>}
                  {player.hasVoted && <span className="voted-mark"><Check size={10} /></span>}
                </span>
                <span className="player-label"><strong>{player.name}</strong><small>{player.isYou ? "you" : isActive ? "speaking" : player.kind === "agent" ? "agent" : "human"}</small></span>
              </span>
            </button>
          );
        })}
      </div>
      {game.phase === "voting" && <p className="table-instruction">Select a portrait or use the ballot to cast your secret vote.</p>}
    </section>
  );
}

function DialoguePanel({
  game,
  pending,
  message,
  onMessage,
  voteTargetId,
  onVoteTarget,
  autoFlow,
  onAutoFlow,
  onAdvance,
  onSubmitMessage,
  onStartVote,
  onCastVote,
  transcriptRef,
  onPlayAgain,
}: {
  game: GameSnapshot;
  pending: boolean;
  message: string;
  onMessage: (value: string) => void;
  voteTargetId: PlayerId | null;
  onVoteTarget: (value: PlayerId | null) => void;
  autoFlow: boolean;
  onAutoFlow: (value: boolean) => void;
  onAdvance: () => void;
  onSubmitMessage: (event: FormEvent) => void;
  onStartVote: () => void;
  onCastVote: () => void;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  onPlayAgain: () => void;
}) {
  if (game.phase === "night") {
    return (
      <aside className="dialogue-panel panel night-panel">
        <Moon size={31} fill="currentColor" />
        <p className="eyebrow">The village sleeps</p>
        <h2>A role is moving in the dark.</h2>
        <p>Only the current player receives their private action. No conversation can begin before every card is still.</p>
        <div className="night-pulse"><i /><i /><i /></div>
      </aside>
    );
  }
  if (game.phase === "voting") {
    return (
      <aside className="dialogue-panel panel ballot-panel">
        <div className="panel-kicker"><Vote size={14} /> The final ballot</div>
        <h2>Who should the village eliminate?</h2>
        <p>Your vote remains secret until every agent has chosen.</p>
        <div className="ballot-list">
          {game.players.filter((player) => !player.isYou).map((player) => (
            <button key={player.id} className={voteTargetId === player.id ? "selected" : ""} onClick={() => onVoteTarget(player.id)}>
              <span>{player.avatar}</span><div><strong>{player.name}</strong><small>{player.persona || "Village resident"}</small></div>{voteTargetId === player.id && <Check size={16} />}
            </button>
          ))}
        </div>
        <button className="danger-button" disabled={!voteTargetId || pending} onClick={onCastVote}>
          {pending ? <LoaderCircle className="spin" size={17} /> : <Skull size={17} />}
          Cast the final vote
        </button>
      </aside>
    );
  }
  if (game.phase === "resolved" && game.resolution) {
    const eliminated = game.players.filter((player) => game.resolution?.eliminatedPlayerIds.includes(player.id));
    return (
      <aside className={`dialogue-panel panel result-panel ${game.resolution.playerWon ? "victory" : "defeat"}`}>
        <div className="result-icon">{game.resolution.playerWon ? <Crown size={31} /> : <Skull size={31} />}</div>
        <p className="eyebrow">The reckoning</p>
        <h2>{game.resolution.playerWon ? "You survived the story." : "The village chose poorly."}</h2>
        <p>{resolutionCopy(game)}</p>
        <div className="eliminated-list"><small>Eliminated</small><strong>{eliminated.length ? eliminated.map((player) => player.name).join(" & ") : "Nobody"}</strong></div>
        <div className="role-reveal-list">
          {game.players.map((player) => (
            <div key={player.id} className={game.resolution?.winnerPlayerIds.includes(player.id) ? "winner" : ""}>
              <span>{player.avatar}</span><strong>{player.name}</strong><small>{ROLE_NAMES[game.resolution!.rolesAtEnd[player.id]]}</small>
            </div>
          ))}
        </div>
        <button className="primary-button" onClick={onPlayAgain}>Play another night <RefreshCw size={16} /></button>
      </aside>
    );
  }
  return (
    <aside className="dialogue-panel conversation-panel panel">
      <div className="dialogue-header">
        <div><div className="panel-kicker"><MessageCircle size={14} /> Village square</div><h2>The conversation</h2></div>
        <button className={`flow-toggle ${autoFlow ? "active" : ""}`} onClick={() => onAutoFlow(!autoFlow)} title={autoFlow ? "Pause automatic flow" : "Resume automatic flow"}>
          {autoFlow ? <Pause size={13} /> : <Play size={13} />} {autoFlow ? "Flowing" : "Paused"}
        </button>
      </div>
      <div
        className="transcript"
        ref={transcriptRef}
        aria-label="Village conversation transcript"
        aria-live="polite"
        tabIndex={0}
      >
        {game.dialogue.transcript.map((entry) => (
          <article key={entry.id} className={entry.kind === "system" ? "system-message" : entry.speakerId === game.viewerId ? "human-message" : ""}>
            {entry.kind === "system" ? (
              <><span><Moon size={13} /></span><p>{entry.text}</p></>
            ) : (
              <><header><strong>{entry.speakerName}</strong><small>#{entry.turnNumber + 1}</small></header><p>{entry.text}</p></>
            )}
          </article>
        ))}
        {pending && <article className="typing-message"><span /><span /><span /><small>The room weighs its words</small></article>}
      </div>
      <form className={`composer ${game.dialogue.humanMaySpeak ? "has-floor" : ""}`} onSubmit={onSubmitMessage}>
        {game.dialogue.humanMaySpeak && <div className="floor-granted"><Sparkles size={13} /> The floor is yours</div>}
        <textarea
          value={message}
          onChange={(event) => onMessage(event.target.value)}
          placeholder={game.dialogue.humanMaySpeak ? "Say it to the village…" : "Type to ask for the floor…"}
          maxLength={500}
          rows={3}
          aria-label="Your message"
        />
        <div className="composer-footer">
          <span>{message.length}/500</span>
          {game.dialogue.humanMaySpeak ? (
            <button className="send-button" disabled={!message.trim() || pending}>Speak <ArrowRight size={15} /></button>
          ) : (
            <button type="button" className="listen-button" disabled={pending} onClick={onAdvance}>
              <Play size={13} /> {message.trim() ? "Ask for the floor" : "Let someone speak"}
            </button>
          )}
        </div>
      </form>
      {game.dialogue.turnNumber >= 3 && !game.dialogue.humanMaySpeak && (
        <button className="call-vote-button" onClick={onStartVote} disabled={pending}><Vote size={14} /> Call the vote</button>
      )}
    </aside>
  );
}

function RoleReveal({
  game,
  flipped,
  pending,
  onFlip,
  onNightAction,
  onAdvanceNight,
  onClose,
}: {
  game: GameSnapshot;
  flipped: boolean;
  pending: boolean;
  onFlip: () => void;
  onNightAction: (action: HumanNightActionRequest) => void;
  onAdvanceNight: () => void;
  onClose: () => void;
}) {
  const history = [...game.nightHistory].sort(
    (left, right) => left.order - right.order,
  );
  const activeStep = history.find((entry) => entry.status === "active") ?? null;
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [showRoleCard, setShowRoleCard] = useState(true);
  const closingStep = pendingCloseId
    ? history.find(
        (entry) => entry.id === pendingCloseId && entry.status === "complete",
      ) ?? null
    : null;
  const nightComplete =
    game.phase !== "night" && history.every((entry) => entry.status === "complete");
  const activePosition = activeStep
    ? history.findIndex((entry) => entry.id === activeStep.id) + 1
    : 0;
  const viewerOwnsActiveRole = activeStep?.role === game.ownInitialRole.id;
  const title = !flipped
    ? "Your card for tonight"
    : closingStep
      ? closingStep.closeCall
      : nightComplete
        ? "Remember what you know"
        : activeStep
          ? `${activeStep.roleName} wakes`
          : "The night continues";

  const submitNightAction = (action: HumanNightActionRequest) => {
    if (activeStep) setPendingCloseId(activeStep.id);
    onNightAction(action);
  };

  const advanceNight = () => {
    if (activeStep) setPendingCloseId(activeStep.id);
    onAdvanceNight();
  };

  return (
    <div className="modal-backdrop role-reveal-backdrop" role="dialog" aria-modal="true" aria-labelledby="role-reveal-title">
      <div className={`role-reveal-modal ${flipped ? "ceremony-active" : ""}`}>
        <p className="eyebrow">
          {!flipped
            ? "Keep this to yourself"
            : nightComplete
              ? "Dawn approaches"
              : "The night, in order"}
        </p>
        <h2 id="role-reveal-title">{title}</h2>

        {(!flipped || (showRoleCard && !closingStep && !nightComplete)) && (
          <div className={`flip-card ${flipped ? "is-flipped" : ""}`}>
            <div className="flip-card-inner">
              <button
                className="role-card-back"
                onClick={onFlip}
                aria-label="Reveal your role"
                aria-hidden={flipped}
                disabled={flipped}
              >
                <Moon size={46} fill="currentColor" />
                <span>ONE NIGHT</span><small>Tap to reveal</small>
              </button>
              <div
                className={`role-card-front team-${game.ownInitialRole.team}`}
                aria-hidden={!flipped}
              >
                <span className="large-sigil">{ROLE_GLYPHS[game.ownInitialRole.id]}</span>
                <p>You are the</p><h3>{game.ownInitialRole.name}</h3>
                <small>{game.ownInitialRole.wakeInstructions}</small>
                <em>{game.ownInitialRole.team === "werewolf" ? "Protect the pack" : game.ownInitialRole.team === "tanner" ? "Get yourself eliminated" : "Find the wolves"}</em>
              </div>
            </div>
          </div>
        )}

        {!flipped ? (
          <button className="primary-button reveal-button" onClick={onFlip}><Eye size={16} /> Reveal my role</button>
        ) : closingStep ? (
          <section className="night-ceremony closing-call" aria-live="polite">
            <div className="ceremony-role-mark" aria-hidden="true">
              {ROLE_GLYPHS[closingStep.role]}
            </div>
            {closingStep.privateKnowledge.length > 0 && (
              <div className="ceremony-private-memory">
                <strong>What your open eyes revealed</strong>
                <ul>
                  {closingStep.privateKnowledge.map((knowledge, index) => (
                    <li key={`${closingStep.id}-closing-knowledge-${index}`}>
                      {describeNightKnowledge(knowledge, game)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p>{closingStep.closeCall}</p>
            <small>
              {closingStep.viewerWasAwake
                ? "Keep only what your own open eyes revealed."
                : "Your eyes stayed closed; no private detail was revealed to you."}
            </small>
            <button
              type="button"
              className="primary-button ceremony-button"
              onClick={() => {
                setPendingCloseId(null);
                setShowRoleCard(false);
              }}
            >
              {nightComplete ? "Review the night" : "Next role"} <ArrowRight size={15} />
            </button>
          </section>
        ) : nightComplete ? (
          <div className="night-recap">
            <p className="night-recap-lede">
              Everyone heard the same roles called in this order. Details appear only
              where your own eyes were open.
            </p>
            <NightHistory game={game} variant="full" />
            <button type="button" className="primary-button wake-village-button" onClick={onClose}>
              Everyone, wake up <ArrowRight size={16} />
            </button>
          </div>
        ) : activeStep ? (
          <section className="night-ceremony" aria-live="polite" aria-label={`Night step ${activePosition} of ${history.length}: ${activeStep.roleName}`}>
            <div className="ceremony-progress">
              <span>Night order</span>
              <strong>{activePosition} <i>/</i> {history.length}</strong>
            </div>
            <div className="ceremony-progress-track" aria-hidden="true">
              <i style={{ width: `${history.length ? (activePosition / history.length) * 100 : 0}%` }} />
            </div>
            <div className="ceremony-role-mark" aria-hidden="true">
              {ROLE_GLYPHS[activeStep.role]}
            </div>
            <h3>{activeStep.wakeCall}</h3>
            <p className={`ceremony-visibility ${viewerOwnsActiveRole ? "is-awake" : "is-asleep"}`}>
              {viewerOwnsActiveRole
                ? "Your eyes are open. Only the information below is yours to remember."
                : `Your eyes remain closed. Whatever the ${activeStep.roleName} may do is hidden from you.`}
            </p>
            {game.nightPrompt ? (
              <NightActionPanel
                key={activeStep.id}
                game={game}
                pending={pending}
                onSubmit={submitNightAction}
              />
            ) : (
              <button
                type="button"
                className="primary-button ceremony-button"
                disabled={!game.mayAdvanceNight || pending}
                onClick={advanceNight}
              >
                {pending ? (
                  <><LoaderCircle className="spin" size={16} /> The role is moving…</>
                ) : (
                  <>Continue the night <ArrowRight size={15} /></>
                )}
              </button>
            )}
            <p className="ceremony-next-call">Then: {activeStep.closeCall}</p>
          </section>
        ) : (
          <section className="night-ceremony" aria-live="polite">
            <LoaderCircle className="spin" size={24} />
            <p>The narrator is preparing the next role.</p>
            {game.mayAdvanceNight && (
              <button type="button" className="primary-button ceremony-button" disabled={pending} onClick={onAdvanceNight}>
                Continue the night <ArrowRight size={15} />
              </button>
            )}
          </section>
        )}
        <p className="privacy-note"><Shield size={13} /> Other players receive only their own private card and clues.</p>
      </div>
    </div>
  );
}

function NightActionPanel({
  game,
  pending,
  onSubmit,
}: {
  game: GameSnapshot;
  pending: boolean;
  onSubmit: (action: HumanNightActionRequest) => void;
}) {
  const prompt = game.nightPrompt!;
  const [mode, setMode] = useState<"player" | "center">("player");
  const [players, setPlayers] = useState<PlayerId[]>([]);
  const [centers, setCenters] = useState<Array<0 | 1 | 2>>([]);
  const isLoneWerewolf =
    prompt.role === "werewolf" &&
    (prompt.knownWerewolfPlayerIds?.length ?? 0) === 0;
  const candidates = game.players.filter((player) => prompt.otherPlayerIds.includes(player.id));
  const knownWerewolfNames = (prompt.knownWerewolfPlayerIds ?? []).map(
    (id) => game.players.find((player) => player.id === id)?.name ?? id,
  );
  const togglePlayer = (id: PlayerId, maximum: number) =>
    setPlayers((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current.slice(-(maximum - 1)), id],
    );
  const toggleCenter = (index: 0 | 1 | 2, maximum: number) =>
    setCenters((current) =>
      current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current.slice(-(maximum - 1)), index],
    );

  const action = useMemo<HumanNightActionRequest | null>(() => {
    switch (prompt.role) {
      case "werewolf":
        return { type: "werewolf", ...(centers[0] !== undefined ? { centerIndex: centers[0] } : {}) };
      case "minion":
        return { type: "minion" };
      case "seer":
        return mode === "player"
          ? players[0]
            ? { type: "seer", choice: { kind: "player", playerId: players[0] } }
            : null
          : centers.length === 2
            ? { type: "seer", choice: { kind: "center", indices: [centers[0], centers[1]] } }
            : null;
      case "robber":
        return players[0] ? { type: "robber", targetId: players[0] } : null;
      case "troublemaker":
        return players.length === 2 ? { type: "troublemaker", targetIds: [players[0], players[1]] } : null;
      case "drunk":
        return centers[0] !== undefined ? { type: "drunk", centerIndex: centers[0] } : null;
      case "insomniac":
        return { type: "insomniac" };
    }
  }, [centers, mode, players, prompt.role]);
  const declineAction: HumanNightActionRequest | null =
    prompt.role === "robber"
      ? { type: "robber", targetId: null }
      : prompt.role === "troublemaker"
        ? { type: "troublemaker", targetIds: null }
        : null;

  return (
    <div className="night-action-panel">
      <div className="wake-banner"><Moon size={14} fill="currentColor" /><span>{prompt.instructions}</span></div>
      {prompt.role === "werewolf" && prompt.knownWerewolfPlayerIds !== undefined && (
        <p className="pack-note">
          {knownWerewolfNames.length ? (
            <>The other original Werewolf{knownWerewolfNames.length > 1 ? "s are" : " is"} <strong>{knownWerewolfNames.join(", ")}</strong>.</>
          ) : (
            <>You see no other Werewolf; you are the lone original Werewolf.</>
          )}
        </p>
      )}
      {prompt.role === "minion" && prompt.knownWerewolfPlayerIds !== undefined && (
        <p className="pack-note">
          {knownWerewolfNames.length ? (
            <>The original Werewolf{knownWerewolfNames.length > 1 ? "s are" : " is"} <strong>{knownWerewolfNames.join(", ")}</strong>.</>
          ) : (
            <>No player began as a Werewolf.</>
          )}
        </p>
      )}
      {prompt.role === "seer" && (
        <div className="night-mode-tabs"><button className={mode === "player" ? "active" : ""} onClick={() => { setMode("player"); setCenters([]); }}>One player</button><button className={mode === "center" ? "active" : ""} onClick={() => { setMode("center"); setPlayers([]); }}>Two center cards</button></div>
      )}
      {(prompt.role === "seer" || prompt.role === "robber" || prompt.role === "troublemaker") && mode === "player" && (
        <div className="night-targets player-targets">
          {candidates.map((player) => (
            <button key={player.id} className={players.includes(player.id) ? "selected" : ""} onClick={() => togglePlayer(player.id, prompt.role === "troublemaker" ? 2 : 1)}>
              <span>{player.avatar}</span><small>{player.name}</small>{players.includes(player.id) && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
      {(prompt.role === "drunk" || isLoneWerewolf || (prompt.role === "seer" && mode === "center")) && (
        <div className="night-targets center-targets">
          {prompt.centerIndices.map((index) => (
            <button key={index} className={centers.includes(index) ? "selected" : ""} onClick={() => toggleCenter(index, prompt.role === "seer" ? 2 : 1)}><span>✦</span><small>Center {index + 1}</small></button>
          ))}
        </div>
      )}
      <button className="primary-button night-action-button" disabled={!action || pending} onClick={() => action && onSubmit(action)}>
        {pending ? <><LoaderCircle className="spin" size={16} /> The night moves…</> : <>{nightActionLabel(prompt.role)} <ArrowRight size={15} /></>}
      </button>
      {declineAction && !players.length && (
        <button
          className="text-button night-decline-button"
          disabled={pending}
          onClick={() => onSubmit(declineAction)}
        >
          Keep the cards where they are
        </button>
      )}
    </div>
  );
}

function LoginModal({
  challenge,
  pending,
  onDeviceFallback,
  onClose,
}: {
  challenge: CodexLoginChallenge;
  pending: boolean;
  onDeviceFallback: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="login-title">
      <div className="simple-modal login-modal">
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        <div className="modal-icon"><Bot size={25} /></div>
        <p className="eyebrow">Codex players</p>
        <h2 id="login-title">Finish signing in with ChatGPT</h2>
        <p>The local Codex runtime opened a secure browser flow. This login powers the game’s agents; the game keeps a separate local player session for you.</p>
        {challenge.userCode && (
          <button className="device-code" onClick={() => void navigator.clipboard.writeText(challenge.userCode!)}>
            <span>{challenge.userCode}</span><Copy size={15} />
          </button>
        )}
        <a className="primary-button" href={challenge.authorizationUrl} target="_blank" rel="noreferrer">Open sign-in page <ExternalLink size={15} /></a>
        {challenge.type === "chatgpt" && <button className="text-button" onClick={onDeviceFallback}>Browser callback not working? Use a device code</button>}
        <div className="waiting-line">{pending && <LoaderCircle className="spin" size={14} />} Waiting for Codex to confirm your account…</div>
      </div>
    </div>
  );
}

function RulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rules-title">
      <div className="simple-modal rules-modal">
        <button className="modal-close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        <p className="eyebrow">How to play</p><h2 id="rules-title">One night, then one decision.</h2>
        <ol>
          <li><span>1</span><div><strong>Receive a secret role</strong><p>Every player gets one card; three remain face-down in the center.</p></div></li>
          <li><span>2</span><div><strong>Act during the night</strong><p>Roles wake in order. Some inspect cards; others swap them. Your starting card determines your action, but your final card determines your team.</p></div></li>
          <li><span>3</span><div><strong>Talk without turns</strong><p>Everyone privately rates how much they want to speak and hear from others. The game grants one floor at a time. Typing makes your desire to speak a 10; hovering a portrait asks to hear from them.</p></div></li>
          <li><span>4</span><div><strong>Vote once</strong><p>The village eliminates the top-voted player or tied players. The Village wants a Werewolf; the Werewolves want to survive; the Tanner wants to die.</p></div></li>
        </ol>
        <button className="primary-button" onClick={onClose}>I’m ready <ArrowRight size={15} /></button>
      </div>
    </div>
  );
}

function tableStatus(game: GameSnapshot, active?: PublicPlayerView) {
  if (game.phase === "night") return game.nightPrompt ? "Your eyes open" : "Cards move in silence";
  if (game.phase === "discussion") {
    if (game.dialogue.humanMaySpeak) return "The floor is yours";
    if (active) return `${active.name} has the floor`;
    return "Listening for the next voice";
  }
  if (game.phase === "voting") return "Choose one name";
  return "Every card is revealed";
}

function nightActionLabel(role: GameSnapshot["nightPrompt"] extends infer T ? T extends { role: infer R } ? R : never : never) {
  switch (role) {
    case "werewolf": return "Finish the Werewolf’s watch";
    case "minion": return "Remember the pack";
    case "seer": return "See these cards";
    case "robber": return "Make the swap";
    case "troublemaker": return "Switch their cards";
    case "drunk": return "Take the center card";
    case "insomniac": return "Check your final card";
    default: return "Complete the action";
  }
}

function describeNightKnowledge(item: KnowledgeItem, game: GameSnapshot) {
  const playerName = (id: PlayerId) =>
    game.players.find((player) => player.id === id)?.name ?? id;
  const slotName = (slot: CardSlot) =>
    slot.kind === "player"
      ? slot.playerId === game.viewerId
        ? "your card"
        : `${playerName(slot.playerId)}’s card`
      : `center card ${slot.centerIndex + 1}`;

  switch (item.type) {
    case "starting-role": return `You began as the ${ROLE_NAMES[item.role]}.`;
    case "werewolf-allies": return item.playerIds.length ? `Your original pack: ${item.playerIds.map(playerName).join(", ")}.` : "You were the lone original Werewolf.";
    case "minion-werewolves": return item.playerIds.length ? `The original Werewolves: ${item.playerIds.map(playerName).join(", ")}.` : "No player began as a Werewolf.";
    case "observed-player-card": {
      if (item.playerId === game.viewerId && item.during === "robber") {
        return `After your swap, your new card was the ${ROLE_NAMES[item.role]}.`;
      }
      if (item.playerId === game.viewerId && item.during === "insomniac") {
        return `At the end of the night, your card was the ${ROLE_NAMES[item.role]}.`;
      }
      return `You saw ${playerName(item.playerId)}’s card: ${ROLE_NAMES[item.role]}.`;
    }
    case "observed-center-card":
      return `You saw center card ${item.centerIndex + 1}: ${ROLE_NAMES[item.role]}.`;
    case "swap-performed": {
      const [first, second] = item.slots;
      if (item.during === "troublemaker") {
        return `You swapped ${slotName(first)} with ${slotName(second)} without seeing either role.`;
      }
      if (item.during === "drunk") {
        const center = first.kind === "center" ? first : second;
        return `You swapped your card with ${slotName(center)} without seeing what you received.`;
      }
      const other = first.kind === "player" && first.playerId !== game.viewerId ? first : second;
      return `You swapped your card with ${slotName(other)}.`;
    }
    case "action-declined":
      return `You chose not to make your optional ${ROLE_NAMES[item.during]} swap.`;
  }
}

function resolutionCopy(game: GameSnapshot) {
  const resolution = game.resolution!;
  if (resolution.reasons.includes("tanner-killed")) return "The Tanner found exactly the ending they wanted.";
  if (resolution.winningTeams.includes("werewolf")) return "The wolf-aligned players kept the village looking in the wrong direction.";
  if (resolution.winningTeams.includes("village")) return "The village found the threat—or correctly chose peace when no wolf was among them.";
  return "No faction achieved the ending it needed.";
}
