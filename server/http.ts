import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const PLAYER_SESSION_COOKIE = "one_night_player";

const loopbackWebHosts = new Set(["localhost", "127.0.0.1"]);

function isAllowedBrowserOrigin(origin: string | undefined) {
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      loopbackWebHosts.has(url.hostname) &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function applyCors(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  const originAllowed = isAllowedBrowserOrigin(origin);
  if (origin && originAllowed) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, If-Match");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  return originAllowed;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
) {
  const encoded = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  response.end(encoded);
}

export async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = 256_000,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const source of request) {
    const chunk = Buffer.isBuffer(source) ? source : Buffer.from(source);
    size += chunk.length;
    if (size > maximumBytes) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function parseCookies(request: IncomingMessage) {
  const values: Record<string, string> = {};
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const key = pair.slice(0, index).trim();
    const rawValue = pair.slice(index + 1).trim();
    try {
      values[key] = decodeURIComponent(rawValue);
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return values;
}

export function getOrCreatePlayerSession(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const existing = parseCookies(request)[PLAYER_SESSION_COOKIE];
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const sessionId = randomUUID();
  response.setHeader(
    "Set-Cookie",
    `${PLAYER_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  );
  return sessionId;
}

export function routeSegments(pathname: string) {
  return pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

export function asString(
  value: unknown,
  label: string,
  maximum = 200,
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, `${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) {
    throw new HttpError(
      400,
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return trimmed;
}

export function asInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new HttpError(
      400,
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value as number;
}

export function asOneOf<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}
