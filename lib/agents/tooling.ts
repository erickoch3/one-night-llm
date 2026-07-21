import type { AgentDecision } from "./types";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema extends Record<string, unknown> {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: JsonPrimitive[];
  const?: JsonPrimitive;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  oneOf?: JsonSchema[];
}

/** Canonical definition; adapters below produce each provider's wire shape. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface CodexDynamicToolDefinition {
  type: "function";
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ResponsesFunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: false;
}

export function toCodexDynamicTool(
  definition: AgentToolDefinition,
): CodexDynamicToolDefinition {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

export function toResponsesFunctionTool(
  definition: AgentToolDefinition,
): ResponsesFunctionToolDefinition {
  return {
    type: "function",
    name: definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    // Keep this compatible with Codex dynamic tools and Responses-compatible
    // endpoints that do not implement strict structured outputs.
    strict: false,
  };
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

export type ToolValidationCode =
  | "malformed_call"
  | "arguments_too_large"
  | "invalid_json"
  | "invalid_arguments"
  | "unknown_tool"
  | "duplicate_call"
  | "decision_already_captured"
  | "missing_decision";

export class AgentToolValidationError extends Error {
  readonly code: ToolValidationCode;
  readonly path?: string;

  constructor(code: ToolValidationCode, message: string, path?: string) {
    super(message);
    this.name = "AgentToolValidationError";
    this.code = code;
    this.path = path;
  }
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: ToolValidationCode;
        message: string;
        path?: string;
      };
    };

type ToolParser<T extends AgentDecision> = (
  argumentsObject: Record<string, unknown>,
) => T;

interface ToolRegistryEntry<T extends AgentDecision = AgentDecision> {
  definition: AgentToolDefinition;
  parser: ToolParser<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new AgentToolValidationError(
      "malformed_call",
      `${path} must be a string.`,
      path,
    );
  }
  if (value.length === 0 || value.length > maximum) {
    throw new AgentToolValidationError(
      "malformed_call",
      `${path} must contain between 1 and ${maximum} characters.`,
      path,
    );
  }
  return value;
}

/**
 * Accepts the normalized form, an OpenAI function call/output item, or the
 * params object from Codex app-server's `item/tool/call` request.
 */
export function normalizeAgentToolCall(input: unknown): AgentToolCall {
  if (!isRecord(input)) {
    throw new AgentToolValidationError(
      "malformed_call",
      "Tool call must be a JSON object.",
    );
  }

  if (isRecord(input.function)) {
    return {
      id: boundedString(input.id ?? input.call_id, "id", 256),
      name: boundedString(input.function.name, "function.name", 128),
      arguments: normalizeRawArguments(input.function.arguments),
    };
  }

  if (typeof input.name === "string") {
    return {
      id: boundedString(input.id ?? input.call_id, "id", 256),
      name: boundedString(input.name, "name", 128),
      arguments: normalizeRawArguments(input.arguments),
    };
  }

  if (typeof input.tool === "string") {
    return {
      id: boundedString(input.callId ?? input.id, "callId", 256),
      name: boundedString(input.tool, "tool", 128),
      arguments: normalizeRawArguments(input.arguments),
    };
  }

  throw new AgentToolValidationError(
    "malformed_call",
    "Tool call is missing a function or tool name.",
  );
}

function normalizeRawArguments(
  value: unknown,
): string | Record<string, unknown> {
  if (typeof value === "string" || isRecord(value)) return value;
  if (value === undefined || value === null) return "{}";
  throw new AgentToolValidationError(
    "malformed_call",
    "Tool arguments must be a JSON object or an encoded JSON object.",
    "arguments",
  );
}

export interface ParseToolArgumentsOptions {
  maximumBytes?: number;
  /** Tolerate a single markdown JSON fence from less reliable endpoints. */
  allowJsonFence?: boolean;
}

export function parseToolArguments(
  raw: string | Record<string, unknown>,
  options: ParseToolArgumentsOptions = {},
): Record<string, unknown> {
  const maximumBytes = options.maximumBytes ?? 16_384;
  if (isRecord(raw)) {
    let encoded: string;
    try {
      encoded = JSON.stringify(raw);
    } catch {
      throw new AgentToolValidationError(
        "invalid_arguments",
        "Tool arguments must be JSON-serializable.",
      );
    }
    if (utf8ByteLength(encoded) > maximumBytes) {
      throw new AgentToolValidationError(
        "arguments_too_large",
        `Tool arguments exceed the ${maximumBytes}-byte limit.`,
      );
    }
    return raw;
  }

  if (utf8ByteLength(raw) > maximumBytes) {
    throw new AgentToolValidationError(
      "arguments_too_large",
      `Tool arguments exceed the ${maximumBytes}-byte limit.`,
    );
  }

  let source = raw.trim();
  if (options.allowJsonFence !== false) {
    const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) source = fenced[1];
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
    // Some gateways double-encode function arguments. Tolerate one layer.
    if (typeof decoded === "string") decoded = JSON.parse(decoded);
  } catch {
    throw new AgentToolValidationError(
      "invalid_json",
      "Tool arguments are not valid JSON.",
    );
  }

  if (!isRecord(decoded)) {
    throw new AgentToolValidationError(
      "invalid_arguments",
      "Tool arguments must decode to a JSON object.",
    );
  }
  return decoded;
}

/**
 * Instance-scoped and immutable-from-the-model registry. Construct a fresh
 * registry for each decision so an agent never receives out-of-phase tools.
 */
export class AgentToolRegistry {
  readonly #entries = new Map<string, ToolRegistryEntry>();

  register<T extends AgentDecision>(
    definition: AgentToolDefinition,
    parser: ToolParser<T>,
  ): this {
    if (this.#entries.has(definition.name)) {
      throw new Error(`Tool ${definition.name} is already registered.`);
    }
    this.#entries.set(definition.name, { definition, parser });
    return this;
  }

  definitions(): AgentToolDefinition[] {
    return [...this.#entries.values()]
      .map(({ definition }) => definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  safeParse(callInput: unknown): ParseResult<AgentDecision> {
    try {
      return { ok: true, value: this.parse(callInput) };
    } catch (error) {
      if (error instanceof AgentToolValidationError) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.path ? { path: error.path } : {}),
          },
        };
      }
      throw error;
    }
  }

  parse(callInput: unknown): AgentDecision {
    const call = normalizeAgentToolCall(callInput);
    const entry = this.#entries.get(call.name);
    if (!entry) {
      throw new AgentToolValidationError(
        "unknown_tool",
        `The tool ${call.name} is not available for this turn.`,
      );
    }
    const argumentsObject = parseToolArguments(call.arguments);
    return entry.parser(argumentsObject);
  }
}

export interface AgentToolExecutor {
  definitions(): AgentToolDefinition[];
  execute(call: unknown): Promise<string>;
}

/**
 * A no-side-effect executor for Codex-style dynamic tool calls. It captures one
 * validated intent; the game engine applies that intent exactly once later.
 */
export class CapturingAgentToolExecutor implements AgentToolExecutor {
  readonly #registry: AgentToolRegistry;
  readonly #seenCallIds = new Set<string>();
  #decision: AgentDecision | undefined;

  constructor(registry: AgentToolRegistry) {
    this.#registry = registry;
  }

  definitions(): AgentToolDefinition[] {
    return this.#registry.definitions();
  }

  async execute(callInput: unknown): Promise<string> {
    const call = normalizeAgentToolCall(callInput);
    if (!this.#seenCallIds.add(call.id)) {
      throw new AgentToolValidationError(
        "duplicate_call",
        `Tool call ${call.id} was already handled.`,
      );
    }
    if (this.#decision) {
      throw new AgentToolValidationError(
        "decision_already_captured",
        "This turn already recorded a decision.",
      );
    }

    this.#decision = this.#registry.parse(call);
    return JSON.stringify({
      ok: true,
      accepted: true,
      decisionType: this.#decision.type,
      instruction: "The game recorded this decision. End the turn now.",
    });
  }

  decision(): AgentDecision | undefined {
    return this.#decision;
  }

  requireDecision(): AgentDecision {
    if (!this.#decision) {
      throw new AgentToolValidationError(
        "missing_decision",
        "The model turn ended without a valid game decision.",
      );
    }
    return this.#decision;
  }
}

export function exactObjectKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new AgentToolValidationError(
        "invalid_arguments",
        `Unexpected argument ${key}.`,
        key,
      );
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new AgentToolValidationError(
        "invalid_arguments",
        `Missing required argument ${key}.`,
        key,
      );
    }
  }
}

export function numberInRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new AgentToolValidationError(
      "invalid_arguments",
      `${path} must be a finite number from ${minimum} to ${maximum}.`,
      path,
    );
  }
  return value;
}

export function nonEmptyString(
  value: unknown,
  path: string,
  maximumCharacters: number,
): string {
  if (typeof value !== "string") {
    throw new AgentToolValidationError(
      "invalid_arguments",
      `${path} must be a string.`,
      path,
    );
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > maximumCharacters) {
    throw new AgentToolValidationError(
      "invalid_arguments",
      `${path} must contain 1-${maximumCharacters} characters.`,
      path,
    );
  }
  return normalized;
}

export function enumString<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AgentToolValidationError(
      "invalid_arguments",
      `${path} must be one of the currently allowed identifiers.`,
      path,
    );
  }
  return value as T;
}

export function uniqueEnumStringArray<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
  minimumItems: number,
  maximumItems: number,
): T[] {
  if (
    !Array.isArray(value) ||
    value.length < minimumItems ||
    value.length > maximumItems
  ) {
    throw new AgentToolValidationError(
      "invalid_arguments",
      `${path} must contain ${minimumItems}-${maximumItems} identifiers.`,
      path,
    );
  }
  const parsed = value.map((item, index) =>
    enumString(item, `${path}[${index}]`, allowed),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new AgentToolValidationError(
      "invalid_arguments",
      `${path} cannot contain the same identifier twice.`,
      path,
    );
  }
  return parsed;
}
