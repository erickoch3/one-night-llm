import OpenAI from "openai";
import type {
  AgentModelRuntime,
  AgentRuntimeTurnRequest,
  AgentRuntimeTurnResult,
} from "../../lib/agents/orchestrator.ts";
import type { AgentToolExecutor } from "../../lib/agents/tooling.ts";
import type { AgentModelConfig } from "../../lib/shared/agent-config.ts";
import { HttpError } from "../http.ts";

type CreateResponse = (
  body: OpenAI.Responses.ResponseCreateParamsNonStreaming,
  options: { signal?: AbortSignal; timeout: number },
) => Promise<OpenAI.Responses.Response>;

export interface OpenAIApiStatus {
  configured: boolean;
  message: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const minimumOutputTokensByEffort = {
  low: 1_024,
  medium: 2_048,
  high: 4_096,
  xhigh: 8_192,
  max: 16_384,
} as const;

export function openAIApiStatus(
  environment: Environment = process.env,
): OpenAIApiStatus {
  const configured = Boolean(environment.OPENAI_API_KEY?.trim());
  return {
    configured,
    message: configured
      ? "The local game service has an OpenAI API key configured."
      : "Enter an OpenAI API key for this game or export OPENAI_API_KEY.",
  };
}

export function resolveOpenAIApiKey(
  suppliedKey: string | undefined,
  environment: Environment = process.env,
): string {
  const apiKey = suppliedKey?.trim() || environment.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError(
      400,
      "Enter an OpenAI API key or export OPENAI_API_KEY before inviting OpenAI agents.",
    );
  }
  return apiKey;
}

/** Runs the same exact-schema game tools through the OpenAI Responses API. */
export class OpenAIAgentRuntime implements AgentModelRuntime {
  private readonly config: AgentModelConfig;
  private readonly createResponse: CreateResponse;

  constructor(
    apiKey: string,
    config: AgentModelConfig,
    createResponse?: CreateResponse,
  ) {
    this.config = config;
    if (createResponse) {
      this.createResponse = createResponse;
      return;
    }

    const client = new OpenAI({ apiKey, maxRetries: 0 });
    this.createResponse = (body, options) =>
      client.responses.create(body, options);
  }

  async runTurn(
    request: AgentRuntimeTurnRequest,
    toolExecutor: AgentToolExecutor,
  ): Promise<AgentRuntimeTurnResult> {
    // Responses counts hidden reasoning against max_output_tokens. The shared
    // request value covers the small visible tool payload, so reserve additional
    // room according to the reasoning level selected in setup.
    const maxOutputTokens = Math.max(
      request.maxOutputTokens,
      minimumOutputTokensByEffort[this.config.reasoningEffort],
    );
    const response = await this.createResponse(
      {
        model: this.config.model,
        instructions: request.instructions,
        input: request.prompt,
        tools: request.responsesTools,
        tool_choice: request.toolChoice,
        parallel_tool_calls: request.allowParallelToolCalls,
        reasoning: { effort: this.config.reasoningEffort },
        max_output_tokens: maxOutputTokens,
        store: false,
      },
      {
        timeout: request.timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    for (const item of response.output) {
      if (item.type === "function_call") {
        await toolExecutor.execute(item);
      }
    }

    return {
      provider: "OpenAI",
      model: response.model || this.config.model,
      text: response.output_text,
    };
  }
}
