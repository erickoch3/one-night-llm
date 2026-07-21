import { buildAgentPromptMaterials } from "./prompts";
import {
  CapturingAgentToolExecutor,
  type AgentToolDefinition,
  type AgentToolExecutor,
  type CodexDynamicToolDefinition,
  type ResponsesFunctionToolDefinition,
  toCodexDynamicTool,
  toResponsesFunctionTool,
} from "./tooling";
import {
  createNightActionToolRegistry,
  createSpeakToolRegistry,
  createSpeechInterestToolRegistry,
  createVoteToolRegistry,
  createVoteReadinessToolRegistry,
  type NightToolOptions,
  type SpeakToolOptions,
} from "./tools";
import type {
  AgentDecision,
  AgentDecisionKind,
  AgentTurnContext,
  NightActionDecision,
  SpeakDecision,
  SpeechInterestDecision,
  VoteDecision,
  VoteReadinessDecision,
} from "./types";

export interface AgentRuntimeTurnRequest {
  requestId: string;
  instructions: string;
  prompt: string;
  /** Canonical definitions for a custom adapter. */
  tools: AgentToolDefinition[];
  /** Ready to place in Codex app-server `thread/start.dynamicTools`. */
  codexDynamicTools: CodexDynamicToolDefinition[];
  /** Ready to place in a Responses API `tools` array. */
  responsesTools: ResponsesFunctionToolDefinition[];
  toolChoice: "required";
  allowParallelToolCalls: false;
  webSearch: "disabled";
  maxOutputTokens: number;
  /** End a provider turn that has not produced a valid tool call by this deadline. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentRuntimeTurnResult {
  /** Optional provider label for diagnostics. */
  provider?: string;
  model?: string;
  /**
   * Return calls here when the adapter does not invoke `toolExecutor.execute`
   * itself. A Codex app-server adapter will normally leave this empty because
   * it executes dynamic-tool server requests while the turn is in progress.
   */
  toolCalls?: unknown[];
  /** Ignored as a decision; useful only for adapter diagnostics. */
  text?: string;
}

/**
 * Authentication and provider lifecycle live behind this boundary. The game
 * layer never receives API keys or Codex account tokens.
 */
export interface AgentModelRuntime {
  runTurn(
    request: AgentRuntimeTurnRequest,
    toolExecutor: AgentToolExecutor,
  ): Promise<AgentRuntimeTurnResult>;
}

export interface PrepareAgentTurnOptions {
  signal?: AbortSignal;
  night?: NightToolOptions;
  speech?: SpeakToolOptions;
  maxOutputTokens?: number;
  turnTimeoutMs?: number;
  retryFeedback?: string;
}

export interface PreparedAgentTurn {
  request: AgentRuntimeTurnRequest;
  executor: CapturingAgentToolExecutor;
}

export function prepareAgentTurn(
  context: AgentTurnContext,
  decisionKind: AgentDecisionKind,
  options: PrepareAgentTurnOptions = {},
): PreparedAgentTurn {
  assertPhaseSupportsDecision(context, decisionKind);
  const timeoutMs = options.turnTimeoutMs ?? 180_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) {
    throw new AgentDecisionError(
      "configuration",
      "turnTimeoutMs must be an integer from 1000 to 180000.",
    );
  }
  const registry = registryForDecision(context, decisionKind, options);
  const definitions = registry.definitions();
  if (definitions.length === 0) {
    throw new AgentDecisionError(
      "configuration",
      `No legal tools were registered for ${decisionKind}.`,
    );
  }

  const materials = buildAgentPromptMaterials(context, decisionKind);
  const prompt = options.retryFeedback
    ? `${materials.prompt}\n\nSERVER RETRY NOTE: ${options.retryFeedback}`
    : materials.prompt;
  const requestId = [
    context.gameId,
    context.participant.id,
    context.phase,
    context.discussionRound,
    decisionKind,
  ].join(":");

  return {
    request: {
      requestId,
      instructions: materials.instructions,
      prompt,
      tools: definitions,
      codexDynamicTools: definitions.map(toCodexDynamicTool),
      responsesTools: definitions.map(toResponsesFunctionTool),
      toolChoice: "required",
      allowParallelToolCalls: false,
      webSearch: "disabled",
      maxOutputTokens: options.maxOutputTokens ?? 180,
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    },
    executor: new CapturingAgentToolExecutor(registry),
  };
}

function registryForDecision(
  context: AgentTurnContext,
  decisionKind: AgentDecisionKind,
  options: PrepareAgentTurnOptions,
) {
  switch (decisionKind) {
    case "night_action":
      return createNightActionToolRegistry(
        context.secret.availableNightActions,
        options.night,
      );
    case "speech_interest":
      return createSpeechInterestToolRegistry(
        context.participant.id,
        context.participants,
      ).registry;
    case "speak":
    case "vote_call_announcement":
      return createSpeakToolRegistry(options.speech);
    case "vote_readiness":
      return createVoteReadinessToolRegistry();
    case "vote": {
      const eligible = context.eligibleVoteTargetIds;
      if (!eligible?.length) {
        throw new AgentDecisionError(
          "configuration",
          "Vote turns require at least one explicit eligibleVoteTargetId.",
        );
      }
      return createVoteToolRegistry(eligible);
    }
  }
}

function assertPhaseSupportsDecision(
  context: AgentTurnContext,
  decisionKind: AgentDecisionKind,
): void {
  const allowed =
    (context.phase === "night" && decisionKind === "night_action") ||
    (context.phase === "discussion" &&
      (decisionKind === "speech_interest" ||
        decisionKind === "speak" ||
        decisionKind === "vote_readiness" ||
        decisionKind === "vote_call_announcement")) ||
    (context.phase === "vote" && decisionKind === "vote");
  if (!allowed) {
    throw new AgentDecisionError(
      "configuration",
      `${decisionKind} is not legal during the ${context.phase} phase.`,
    );
  }
}

export type AgentDecisionErrorCode =
  | "configuration"
  | "runtime"
  | "missing_tool_call"
  | "wrong_decision"
  | "aborted";

export class AgentDecisionError extends Error {
  readonly code: AgentDecisionErrorCode;

  constructor(code: AgentDecisionErrorCode, message: string) {
    super(message);
    this.name = "AgentDecisionError";
    this.code = code;
  }
}

export interface RunAgentDecisionOptions extends PrepareAgentTurnOptions {
  /** Fresh model turns after a no-call/invalid result. Defaults to 2 total. */
  maximumAttempts?: number;
}

export interface AgentDecisionResult<T extends AgentDecision = AgentDecision> {
  decision: T;
  attempts: number;
  provider?: string;
  model?: string;
}

export async function runAgentDecision(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  decisionKind: AgentDecisionKind,
  options: RunAgentDecisionOptions = {},
): Promise<AgentDecisionResult> {
  const maximumAttempts = options.maximumAttempts ?? 2;
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 4) {
    throw new AgentDecisionError(
      "configuration",
      "maximumAttempts must be an integer from 1 to 4.",
    );
  }

  let retryFeedback: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new AgentDecisionError("aborted", "The agent turn was aborted.");
    }
    const prepared = prepareAgentTurn(context, decisionKind, {
      ...options,
      retryFeedback,
    });

    let result: AgentRuntimeTurnResult;
    try {
      result = await runtime.runTurn(prepared.request, prepared.executor);
      if (!prepared.executor.decision() && result.toolCalls?.length) {
        for (const call of result.toolCalls) {
          await prepared.executor.execute(call);
        }
      }
      const decision = prepared.executor.requireDecision();
      if (!decisionMatchesKind(decision, decisionKind)) {
        throw new AgentDecisionError(
          "wrong_decision",
          `The runtime returned ${decision.type} for ${decisionKind}.`,
        );
      }
      return {
        decision,
        attempts: attempt,
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.model ? { model: result.model } : {}),
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw new AgentDecisionError("aborted", "The agent turn was aborted.");
      }
      lastError = error;
      retryFeedback = retryMessage(error, decisionKind);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "unknown error";
  throw new AgentDecisionError(
    "runtime",
    `Agent failed to produce a valid ${decisionKind} after ${maximumAttempts} attempt(s): ${detail}`,
  );
}

function retryMessage(error: unknown, kind: AgentDecisionKind): string {
  const detail = error instanceof Error ? error.message : "No valid tool call was received.";
  return `The previous turn was rejected (${detail.slice(0, 300)}). Call exactly one supplied tool for ${kind}; provide every required argument and no extra arguments.`;
}

function decisionMatchesKind(
  decision: AgentDecision,
  kind: AgentDecisionKind,
): boolean {
  switch (kind) {
    case "night_action":
      return decision.type.startsWith("night_");
    case "speech_interest":
      return decision.type === "speech_interest";
    case "speak":
    case "vote_call_announcement":
      return decision.type === "speak";
    case "vote_readiness":
      return decision.type === "vote_readiness";
    case "vote":
      return decision.type === "vote";
  }
}

export async function runNightAction(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  options?: RunAgentDecisionOptions,
): Promise<AgentDecisionResult<NightActionDecision>> {
  return (await runAgentDecision(
    runtime,
    context,
    "night_action",
    options,
  )) as AgentDecisionResult<NightActionDecision>;
}

export async function collectSpeechInterest(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  options?: RunAgentDecisionOptions,
): Promise<AgentDecisionResult<SpeechInterestDecision>> {
  return (await runAgentDecision(
    runtime,
    context,
    "speech_interest",
    options,
  )) as AgentDecisionResult<SpeechInterestDecision>;
}

export async function takeSpeakingTurn(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  options?: RunAgentDecisionOptions,
): Promise<AgentDecisionResult<SpeakDecision>> {
  return (await runAgentDecision(
    runtime,
    context,
    "speak",
    options,
  )) as AgentDecisionResult<SpeakDecision>;
}

export async function collectVoteReadiness(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  options?: RunAgentDecisionOptions,
): Promise<AgentDecisionResult<VoteReadinessDecision>> {
  return (await runAgentDecision(
    runtime,
    context,
    "vote_readiness",
    options,
  )) as AgentDecisionResult<VoteReadinessDecision>;
}

export async function announceVoteCall(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  options?: RunAgentDecisionOptions,
): Promise<AgentDecisionResult<SpeakDecision>> {
  return (await runAgentDecision(
    runtime,
    context,
    "vote_call_announcement",
    options,
  )) as AgentDecisionResult<SpeakDecision>;
}

export async function collectVote(
  runtime: AgentModelRuntime,
  context: AgentTurnContext,
  options?: RunAgentDecisionOptions,
): Promise<AgentDecisionResult<VoteDecision>> {
  return (await runAgentDecision(
    runtime,
    context,
    "vote",
    options,
  )) as AgentDecisionResult<VoteDecision>;
}
