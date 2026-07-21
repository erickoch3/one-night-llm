import type {
  AdvanceDialogueRequest,
  CreateGameRequest,
  GameSnapshot,
  HumanNightActionRequest,
} from "../shared/protocol";
import type { PlayerId } from "../game/types";

export interface CodexAuthStatus {
  available: boolean;
  signedIn: boolean;
  account: { type: string; email?: string; planType?: string } | null;
  runtime?: { source: string; executable: string; version?: string };
  message: string;
}

export interface CodexLoginChallenge {
  type: "chatgpt" | "chatgptDeviceCode";
  loginId: string;
  authorizationUrl: string;
  userCode?: string;
}

const configuredApiBase =
  process.env.NEXT_PUBLIC_GAME_API_URL?.replace(/\/$/, "") || null;

function apiBase() {
  if (configuredApiBase) return configuredApiBase;
  if (typeof window !== "undefined" && window.location.hostname === "127.0.0.1") {
    return "http://127.0.0.1:4318";
  }
  return "http://localhost:4318";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new Error(
      "The local game service is not running. Start the app with npm run dev.",
    );
  }
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || `Game service returned ${response.status}.`);
  }
  return payload as T;
}

function post<T>(path: string, body?: unknown) {
  return request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const gameApi = {
  authStatus: () => request<CodexAuthStatus>("/api/auth/status"),
  beginLogin: (method: "browser" | "device") =>
    post<CodexLoginChallenge>("/api/auth/login", { method }),
  loginStatus: (loginId: string) =>
    request<
      | { state: "pending"; status: CodexAuthStatus }
      | { state: "complete"; status: CodexAuthStatus }
      | { state: "failed"; message: string }
    >(`/api/auth/login/${encodeURIComponent(loginId)}`),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  createGame: (value: CreateGameRequest) =>
    post<GameSnapshot>("/api/games", value),
  getGame: (gameId: string) =>
    request<GameSnapshot>(`/api/games/${encodeURIComponent(gameId)}`),
  nightAction: (gameId: string, value: HumanNightActionRequest) =>
    post<GameSnapshot>(`/api/games/${encodeURIComponent(gameId)}/night`, value),
  advanceNight: (gameId: string) =>
    post<GameSnapshot>(`/api/games/${encodeURIComponent(gameId)}/night/advance`),
  advanceDialogue: (gameId: string, value: AdvanceDialogueRequest) =>
    post<GameSnapshot>(
      `/api/games/${encodeURIComponent(gameId)}/dialogue/advance`,
      value,
    ),
  speak: (gameId: string, text: string) =>
    post<GameSnapshot>(
      `/api/games/${encodeURIComponent(gameId)}/dialogue/speak`,
      { text },
    ),
  startVote: (gameId: string) =>
    post<GameSnapshot>(`/api/games/${encodeURIComponent(gameId)}/vote/start`),
  castVote: (gameId: string, targetId: PlayerId) =>
    post<GameSnapshot>(`/api/games/${encodeURIComponent(gameId)}/vote/cast`, {
      targetId,
    }),
  leave: (gameId: string) =>
    post<{ ok: true }>(`/api/games/${encodeURIComponent(gameId)}/leave`),
};
