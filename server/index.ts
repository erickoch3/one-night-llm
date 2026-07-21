import { createServer } from "node:http";
import type {
  AdvanceDialogueRequest,
  CreateGameRequest,
  HumanNightActionRequest,
} from "../lib/shared/protocol.ts";
import {
  AGENT_MODELS,
  AGENT_REASONING_EFFORTS,
} from "../lib/shared/agent-config.ts";
import { codexAppServer } from "./codex/client.ts";
import { openAIApiStatus } from "./openai/runtime.ts";
import {
  advanceDialogue,
  advanceNightCeremony,
  createGameRoom,
  getGameRoom,
  removeGameRoom,
  startVoting,
  submitHumanNightAction,
  submitHumanSpeech,
  submitHumanVote,
} from "./game-service.ts";
import {
  HttpError,
  applyCors,
  asInteger,
  asOneOf,
  asString,
  getOrCreatePlayerSession,
  readJsonBody,
  routeSegments,
  sendJson,
} from "./http.ts";

const port = Number(process.env.ONE_NIGHT_API_PORT || 4318);
const host = "127.0.0.1";
const gameModes = ["codex", "openai", "rehearsal"] as const;

const server = createServer(async (request, response) => {
  const originAllowed = applyCors(request, response);
  if (!originAllowed) {
    sendJson(response, 403, { error: "This local service does not accept that browser origin." });
    return;
  }
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || host}`);
    const segments = routeSegments(url.pathname);
    if (request.method === "GET" && url.pathname === "/api/health") {
      const auth = await codexAppServer.accountStatus();
      sendJson(response, 200, {
        ok: true,
        service: "one-night-local",
        codex: {
          available: auth.available,
          signedIn: auth.signedIn,
          version: auth.runtime?.version,
        },
        openai: openAIApiStatus(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/auth/status") {
      sendJson(response, 200, await codexAppServer.accountStatus());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      const method = body.method === "device" ? "device" : "browser";
      sendJson(response, 200, await codexAppServer.beginLogin(method));
      return;
    }
    if (
      request.method === "GET" &&
      segments.length === 4 &&
      segments[0] === "api" &&
      segments[1] === "auth" &&
      segments[2] === "login"
    ) {
      sendJson(response, 200, await codexAppServer.loginStatus(segments[3]));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      await codexAppServer.logout();
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/openai/status") {
      sendJson(response, 200, openAIApiStatus());
      return;
    }

    if (segments[0] === "api" && segments[1] === "games") {
      const sessionId = getOrCreatePlayerSession(request, response);
      if (request.method === "POST" && segments.length === 2) {
        const body = await readJsonBody(request);
        const mode = asOneOf(body.mode, "Agent connection", gameModes);
        const rolePack = body.rolePack === "chaos" ? "chaos" : "classic";
        const createRequest: CreateGameRequest = {
          playerName: asString(body.playerName, "Player name", 40),
          agentCount: asInteger(body.agentCount, "Agent count", 2, 6),
          mode,
          rolePack,
          agentModel: asOneOf(body.agentModel, "Agent model", AGENT_MODELS),
          agentReasoningEffort: asOneOf(
            body.agentReasoningEffort,
            "Agent reasoning effort",
            AGENT_REASONING_EFFORTS,
          ),
          ...(mode === "openai" && body.openaiApiKey !== undefined
            ? {
                openaiApiKey: asString(
                  body.openaiApiKey,
                  "OpenAI API key",
                  512,
                ),
              }
            : {}),
        };
        sendJson(response, 201, await createGameRoom(sessionId, createRequest));
        return;
      }

      const gameId = segments[2];
      if (!gameId) throw new HttpError(404, "Game route not found.");
      if (request.method === "GET" && segments.length === 3) {
        sendJson(response, 200, getGameRoom(gameId, sessionId));
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "night" &&
        segments[4] === "advance" &&
        segments.length === 5
      ) {
        sendJson(
          response,
          200,
          await advanceNightCeremony(gameId, sessionId),
        );
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "night" &&
        segments.length === 4
      ) {
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          await submitHumanNightAction(
            gameId,
            sessionId,
            validateNightRequest(body),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "dialogue" &&
        segments[4] === "advance"
      ) {
        const body = await readJsonBody(request);
        const dialogueRequest: AdvanceDialogueRequest = {
          humanWantsToSpeak: body.humanWantsToSpeak === true,
          hoverTargetId:
            body.hoverTargetId === null || body.hoverTargetId === undefined
              ? null
              : asString(body.hoverTargetId, "Hover target", 64),
        };
        sendJson(
          response,
          200,
          await advanceDialogue(gameId, sessionId, dialogueRequest),
        );
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "dialogue" &&
        segments[4] === "speak"
      ) {
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          await submitHumanSpeech(
            gameId,
            sessionId,
            asString(body.text, "Statement", 500),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "vote" &&
        segments[4] === "start"
      ) {
        sendJson(response, 200, await startVoting(gameId, sessionId));
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "vote" &&
        segments[4] === "cast"
      ) {
        const body = await readJsonBody(request);
        sendJson(
          response,
          200,
          await submitHumanVote(
            gameId,
            sessionId,
            asString(body.targetId, "Vote target", 64),
          ),
        );
        return;
      }
      if (
        request.method === "POST" &&
        segments[3] === "leave" &&
        segments.length === 4
      ) {
        removeGameRoom(gameId, sessionId);
        sendJson(response, 200, { ok: true });
        return;
      }
    }

    throw new HttpError(404, "Route not found.");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof Error && status < 500
        ? error.message
        : "The local village service hit an unexpected problem.";
    if (status >= 500) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[server] ${detail.slice(0, 1_000)}`);
    }
    sendJson(response, status, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`  ➜  Game service: http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    codexAppServer.stop();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

function validateNightRequest(
  body: Record<string, unknown>,
): HumanNightActionRequest {
  const type = asString(body.type, "Night action type", 32);
  switch (type) {
    case "werewolf":
      return {
        type,
        ...(body.centerIndex === undefined
          ? {}
          : { centerIndex: asCenterIndex(body.centerIndex) }),
      };
    case "minion":
    case "insomniac":
      return { type };
    case "seer": {
      const choice = body.choice;
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        throw new HttpError(400, "Seer choice is required.");
      }
      const value = choice as Record<string, unknown>;
      if (value.kind === "player") {
        return {
          type,
          choice: {
            kind: "player",
            playerId: asString(value.playerId, "Player target", 64),
          },
        };
      }
      if (value.kind === "center" && Array.isArray(value.indices)) {
        if (value.indices.length !== 2) {
          throw new HttpError(400, "Choose exactly two center cards.");
        }
        return {
          type,
          choice: {
            kind: "center",
            indices: [asCenterIndex(value.indices[0]), asCenterIndex(value.indices[1])],
          },
        };
      }
      throw new HttpError(400, "Choose one player or two center cards.");
    }
    case "robber":
      return {
        type,
        targetId:
          body.targetId === null
            ? null
            : asString(body.targetId, "Robber target", 64),
      };
    case "troublemaker":
      if (body.targetIds === null) return { type, targetIds: null };
      if (!Array.isArray(body.targetIds) || body.targetIds.length !== 2) {
        throw new HttpError(400, "Choose exactly two players to swap.");
      }
      return {
        type,
        targetIds: [
          asString(body.targetIds[0], "First swap target", 64),
          asString(body.targetIds[1], "Second swap target", 64),
        ],
      };
    case "drunk":
      return { type, centerIndex: asCenterIndex(body.centerIndex) };
    default:
      throw new HttpError(400, "Unknown night action.");
  }
}

function asCenterIndex(value: unknown): 0 | 1 | 2 {
  const index = asInteger(value, "Center card", 0, 2);
  return index as 0 | 1 | 2;
}

function shutdown() {
  codexAppServer.stop();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
