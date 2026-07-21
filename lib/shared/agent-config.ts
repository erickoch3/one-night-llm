export const AGENT_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

export type AgentModel = (typeof AGENT_MODELS)[number];

export const AGENT_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export interface AgentModelConfig {
  model: AgentModel;
  reasoningEffort: AgentReasoningEffort;
}

export const DEFAULT_AGENT_MODEL: AgentModel = "gpt-5.6-luna";
export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium";

export const DEFAULT_AGENT_MODEL_CONFIG: AgentModelConfig = {
  model: DEFAULT_AGENT_MODEL,
  reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
};

export function isAgentModel(value: unknown): value is AgentModel {
  return AGENT_MODELS.includes(value as AgentModel);
}

export function isAgentReasoningEffort(
  value: unknown,
): value is AgentReasoningEffort {
  return AGENT_REASONING_EFFORTS.includes(value as AgentReasoningEffort);
}
