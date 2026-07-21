import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

import type { AgentRuntimeTurnRequest } from "../lib/agents/orchestrator.ts";
import type { AgentToolExecutor } from "../lib/agents/tooling.ts";
import { CodexAgentRuntime } from "../server/agent-runtime.ts";
import {
  CodexAppServer,
  type ToolCallRecord,
  type ToolTurnRequest,
  type ToolTurnResult,
} from "../server/codex/client.ts";

interface TestActiveTurn {
  threadId: string;
  turnId: string | null;
  onToolCall: (call: ToolCallRecord) => Promise<string> | string;
  toolCalls: ToolCallRecord[];
  streamedText: string;
  authoritativeText: string;
  resolve: (value: ToolTurnResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

interface TestClientInternals {
  child: ChildProcessWithoutNullStreams | null;
  activeTurns: Map<string, TestActiveTurn>;
  interruptTurn: (threadId: string, turnId: string) => void;
  handleServerRequest: (
    requestId: number | string,
    method: string,
    rawParams: unknown,
    sourceChild: ChildProcessWithoutNullStreams,
  ) => Promise<void>;
}

function fakeChild(writes: string[]) {
  return {
    stdin: {
      writable: true,
      write(value: string) {
        writes.push(value);
        return true;
      },
    },
  } as unknown as ChildProcessWithoutNullStreams;
}

test("the agent runtime forwards explicit model and reasoning settings", async () => {
  let captured: ToolTurnRequest | undefined;
  const runtime = new CodexAgentRuntime(
    {
      async runToolTurn(request) {
        captured = request;
        return {
          text: "",
          toolCalls: [],
          threadId: "thread-config",
          turnId: "turn-config",
        };
      },
    },
    { model: "gpt-5.6-luna", reasoningEffort: "medium" },
  );
  const request: AgentRuntimeTurnRequest = {
    requestId: "request-config",
    instructions: "Use the tool.",
    prompt: "Choose.",
    tools: [],
    codexDynamicTools: [],
    responsesTools: [],
    toolChoice: "required",
    allowParallelToolCalls: false,
    webSearch: "disabled",
    maxOutputTokens: 180,
    timeoutMs: 5_000,
  };
  const executor: AgentToolExecutor = {
    definitions: () => [],
    execute: async () => "accepted",
  };

  const result = await runtime.runTurn(request, executor);

  assert.equal(captured?.model, "gpt-5.6-luna");
  assert.equal(captured?.reasoningEffort, "medium");
  assert.equal(result.model, "gpt-5.6-luna");
});

test("a validated game tool resolves immediately and interrupts unused model work", async () => {
  const client = new CodexAppServer();
  const internals = client as unknown as TestClientInternals;
  const writes: string[] = [];
  const child = fakeChild(writes);
  const interruptions: Array<[string, string]> = [];
  internals.child = child;
  internals.interruptTurn = (threadId, turnId) => {
    interruptions.push([threadId, turnId]);
  };

  let resolveTurn!: (value: ToolTurnResult) => void;
  let rejectTurn!: (reason: Error) => void;
  const completed = new Promise<ToolTurnResult>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  internals.activeTurns.set("thread-1", {
    threadId: "thread-1",
    turnId: "turn-1",
    onToolCall: (call) => {
      assert.equal(call.name, "speak_to_group");
      return "accepted";
    },
    toolCalls: [],
    streamedText: "",
    authoritativeText: "",
    resolve: resolveTurn,
    reject: rejectTurn,
    timer: setTimeout(() => undefined, 60_000),
  });

  await internals.handleServerRequest(
    17,
    "item/tool/call",
    {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "speak_to_group",
      arguments: { text: "I have a claim." },
    },
    child,
  );

  const result = await completed;
  assert.deepEqual(result.toolCalls, [
    {
      callId: "call-1",
      name: "speak_to_group",
      arguments: { text: "I have a claim." },
    },
  ]);
  assert.equal(internals.activeTurns.size, 0);
  assert.deepEqual(interruptions, [["thread-1", "turn-1"]]);
  assert.deepEqual(JSON.parse(writes[0]), {
    id: 17,
    result: {
      success: true,
      contentItems: [{ type: "inputText", text: "accepted" }],
    },
  });
});

test("an invalid game tool stays active so the model can correct it", async () => {
  const client = new CodexAppServer();
  const internals = client as unknown as TestClientInternals;
  const writes: string[] = [];
  const child = fakeChild(writes);
  const timer = setTimeout(() => undefined, 60_000);
  internals.child = child;
  internals.interruptTurn = () => {
    assert.fail("An invalid call must not interrupt the turn.");
  };
  internals.activeTurns.set("thread-2", {
    threadId: "thread-2",
    turnId: "turn-2",
    onToolCall: () => {
      throw new Error("text is too long");
    },
    toolCalls: [],
    streamedText: "",
    authoritativeText: "",
    resolve: () => undefined,
    reject: () => undefined,
    timer,
  });

  await internals.handleServerRequest(
    18,
    "item/tool/call",
    {
      threadId: "thread-2",
      turnId: "turn-2",
      callId: "call-2",
      tool: "speak_to_group",
      arguments: {},
    },
    child,
  );

  assert.equal(internals.activeTurns.has("thread-2"), true);
  assert.equal(JSON.parse(writes[0]).result.success, false);
  clearTimeout(timer);
  internals.activeTurns.delete("thread-2");
});
