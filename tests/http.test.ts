import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, applyCors, asOneOf } from "../server/http.ts";

function responseHeaders() {
  const headers = new Map<string, string | number | readonly string[]>();
  const response = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name, value);
      return response;
    },
  } as unknown as ServerResponse;
  return { headers, response };
}

test("local CORS boundary accepts CLI traffic and loopback web origins on any port", () => {
  for (const origin of [
    undefined,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:4173",
  ]) {
    const { headers, response } = responseHeaders();
    const request = { headers: { origin } } as IncomingMessage;
    assert.equal(applyCors(request, response), true);
    if (origin) assert.equal(headers.get("Access-Control-Allow-Origin"), origin);
  }
});

test("local CORS boundary rejects non-loopback and malformed browser origins", () => {
  for (const origin of [
    "https://attacker.example",
    "http://localhost.attacker.example:3001",
    "http://127.0.0.2:3001",
    "https://localhost:3001",
    "http://localhost:3001/path",
    "http://evil@localhost:3001",
    "null",
    "not-an-origin",
  ]) {
    const { headers, response } = responseHeaders();
    const request = { headers: { origin } } as IncomingMessage;

    assert.equal(applyCors(request, response), false);
    assert.equal(headers.has("Access-Control-Allow-Origin"), false);
  }
});

test("enumerated request settings reject missing and unsupported values", () => {
  const values = ["gpt-5.6-luna", "gpt-5.6-terra"] as const;
  assert.equal(asOneOf("gpt-5.6-luna", "Agent model", values), "gpt-5.6-luna");

  for (const value of [undefined, null, "gpt-5.6", "gpt-5.6-Luna"]) {
    assert.throws(
      () => asOneOf(value, "Agent model", values),
      (error) =>
        error instanceof HttpError &&
        error.status === 400 &&
        /Agent model must be one of/.test(error.message),
    );
  }
});
