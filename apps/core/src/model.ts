import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

// Provider-neutral shapes. The rest of the Core only talks to ModelClient.

export type ModelBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ModelBlock[];
  /** Provider-native assistant content, replayed verbatim inside the same task loop. */
  raw?: unknown;
}

export interface ModelToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDef[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ModelTurn {
  text: string;
  toolCalls: ModelToolCall[];
  /** The assistant message to append to the history before sending tool results back. */
  assistant: ModelMessage;
  /** Token usage for this turn, when the provider reports it (v0.2 cost accounting). */
  usage?: ModelUsage;
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelTurn>;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

// ---------- Anthropic ----------

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(req: ModelRequest): Promise<ModelTurn> {
    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: req.system,
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool.InputSchema,
        })),
        messages: req.messages.map(toParam),
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new ModelError(`Model API error (${err.status ?? "network"}): ${err.message}`);
      }
      throw err;
    }
    if (res.stop_reason === "refusal") throw new ModelError("The model declined this request.");

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolCalls = res.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    if (res.stop_reason === "max_tokens" && toolCalls.length === 0) {
      throw new ModelError("The model response was cut off (max_tokens).");
    }
    return {
      text,
      toolCalls,
      assistant: {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((c) => ({ type: "tool_use" as const, ...c })),
        ],
        raw: res.content,
      },
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    };
  }
}

function toParam(m: ModelMessage): Anthropic.MessageParam {
  if (m.role === "assistant" && m.raw !== undefined) {
    return { role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] };
  }
  return { role: m.role, content: m.content as string | Anthropic.ContentBlockParam[] };
}

// ---------- Fake (tests) ----------

export interface FakeTurn {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  usage?: ModelUsage;
}

/** Deterministic model for tests: a handler decides each turn and every request is recorded. */
export class FakeModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly handler: (req: ModelRequest, call: number) => FakeTurn | Promise<FakeTurn>) {}

  async complete(req: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(req));
    const turn = await this.handler(req, this.requests.length - 1);
    const toolCalls = (turn.toolCalls ?? []).map((c) => ({ id: `toolu_${randomUUID()}`, ...c }));
    const text = turn.text ?? "";
    return {
      text,
      toolCalls,
      assistant: {
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((c) => ({ type: "tool_use" as const, ...c })),
        ],
      },
      usage: turn.usage,
    };
  }
}
