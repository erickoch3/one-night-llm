import type {
  AgentModelRuntime,
  AgentRuntimeTurnRequest,
  AgentRuntimeTurnResult,
} from "../lib/agents/orchestrator.ts";
import type { AgentToolExecutor } from "../lib/agents/tooling.ts";
import {
  DEFAULT_AGENT_MODEL_CONFIG,
  type AgentModelConfig,
} from "../lib/shared/agent-config.ts";
import { codexAppServer, type CodexAppServer } from "./codex/client.ts";

/** Bridges the provider-neutral game-agent layer to Codex dynamic tools. */
export class CodexAgentRuntime implements AgentModelRuntime {
  private readonly client: Pick<CodexAppServer, "runToolTurn">;
  private readonly config: AgentModelConfig;

  constructor(
    client: Pick<CodexAppServer, "runToolTurn"> = codexAppServer,
    config: AgentModelConfig = DEFAULT_AGENT_MODEL_CONFIG,
  ) {
    this.client = client;
    this.config = config;
  }

  async runTurn(
    request: AgentRuntimeTurnRequest,
    toolExecutor: AgentToolExecutor,
  ): Promise<AgentRuntimeTurnResult> {
    const result = await this.client.runToolTurn({
      prompt: request.prompt,
      instructions: request.instructions,
      tools: request.codexDynamicTools,
      onToolCall: (call) =>
        toolExecutor.execute({
          id: call.callId,
          name: call.name,
          arguments: call.arguments,
        }),
      timeoutMs: request.timeoutMs,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      provider: "Codex",
      model: this.config.model,
      text: result.text,
    };
  }
}
