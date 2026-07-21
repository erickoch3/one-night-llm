import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeTurnRequest } from "../lib/agents/orchestrator.ts";
import {
  normalizeAgentToolCall,
  type AgentToolExecutor,
} from "../lib/agents/tooling.ts";
import {
  OpenAIAgentRuntime,
  openAIApiStatus,
  resolveOpenAIApiKey,
} from "../server/openai/runtime.ts";

test("the OpenAI runtime sends exact tool settings through Responses", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  const handledCalls: unknown[] = [];
  const runtime = new OpenAIAgentRuntime(
    "test-secret-api-key",
    { model: "gpt-5.6-terra", reasoningEffort: "high" },
    async (body, options) => {
      capturedBody = body as unknown as Record<string, unknown>;
      capturedOptions = options;
      return {
        model: "gpt-5.6-terra-2026-07-01",
        output_text: "",
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "cast_vote",
            arguments: '{"targetId":"agent-2"}',
          },
        ],
      } as never;
    },
  );
  const request: AgentRuntimeTurnRequest = {
    requestId: "request-openai",
    instructions: "Call exactly one game tool.",
    prompt: "Choose a player.",
    tools: [],
    codexDynamicTools: [],
    responsesTools: [
      {
        type: "function",
        name: "cast_vote",
        description: "Cast one vote.",
        parameters: {
          type: "object",
          properties: { targetId: { type: "string" } },
          required: ["targetId"],
          additionalProperties: false,
        },
        strict: false,
      },
    ],
    toolChoice: "required",
    allowParallelToolCalls: false,
    webSearch: "disabled",
    maxOutputTokens: 180,
    timeoutMs: 5_000,
  };
  const executor: AgentToolExecutor = {
    definitions: () => [],
    execute: async (call) => {
      handledCalls.push(call);
      return "accepted";
    },
  };

  const result = await runtime.runTurn(request, executor);

  assert.deepEqual(capturedBody, {
    model: "gpt-5.6-terra",
    instructions: request.instructions,
    input: request.prompt,
    tools: request.responsesTools,
    tool_choice: "required",
    parallel_tool_calls: false,
    reasoning: { effort: "high" },
    max_output_tokens: 4_096,
    store: false,
  });
  assert.deepEqual(capturedOptions, { timeout: 5_000 });
  assert.equal(handledCalls.length, 1);
  assert.deepEqual(normalizeAgentToolCall(handledCalls[0]), {
    id: "call-1",
    name: "cast_vote",
    arguments: '{"targetId":"agent-2"}',
  });
  assert.equal(JSON.stringify(capturedBody).includes("test-secret-api-key"), false);
  assert.equal(result.provider, "OpenAI");
  assert.equal(result.model, "gpt-5.6-terra-2026-07-01");
});

test("OpenAI API keys prefer a per-game key and fall back to the environment", () => {
  const environment = { OPENAI_API_KEY: "  environment-key  " };

  assert.equal(resolveOpenAIApiKey("  per-game-key  ", environment), "per-game-key");
  assert.equal(resolveOpenAIApiKey(undefined, environment), "environment-key");
  assert.deepEqual(openAIApiStatus(environment), {
    configured: true,
    message: "The local game service has an OpenAI API key configured.",
  });
  assert.throws(
    () => resolveOpenAIApiKey(undefined, {}),
    /Enter an OpenAI API key or export OPENAI_API_KEY/,
  );
});
