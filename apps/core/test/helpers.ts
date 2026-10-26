import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTRACT_VERSION, type AgentResponse, type ApprovalRequest, type ConversationResponse } from "@ahmed/contract";
import { FakeModelClient, type FakeTurn, type ModelBlock, type ModelRequest } from "../src/model.js";
import { createCore, type Core, type CoreOptions } from "../src/server.js";

export const TOKEN = "test-app-token";
export const AUTH = { authorization: `Bearer ${TOKEN}` };

export interface Env {
  dir: string;
  dbFile: string;
  wsRoot: string;
  nowMs: number;
  clock: () => Date;
  cleanup(): void;
}

export function makeEnv(): Env {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ahmed-core-test-"));
  const env: Env = {
    dir,
    dbFile: path.join(dir, "core.db"),
    wsRoot: path.join(dir, "workspace"),
    nowMs: Date.parse("2026-10-02T10:00:00.000Z"),
    clock: () => new Date(env.nowMs),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
  return env;
}

export function startCore(env: Env, model: FakeModelClient, extra: Partial<CoreOptions> = {}): Promise<Core> {
  return createCore({ dbFile: env.dbFile, workspaceRoot: env.wsRoot, appToken: TOKEN, model, clock: env.clock, ...extra });
}

// ---------- scripted fake model ----------

function lastUserText(req: ModelRequest): string {
  const last = req.messages[req.messages.length - 1];
  return typeof last.content === "string" ? last.content : "";
}

function allText(req: ModelRequest): string {
  return req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

function latestAttachment(req: ModelRequest): string | undefined {
  const matches = [...allText(req).matchAll(/workspace path: (\S+)\]/g)];
  return matches.at(-1)?.[1];
}

/**
 * Behaves like a minimal real agent:
 *  - "summarize"/"لخص"  -> read_file on the latest attachment, then summarizes the tool result
 *  - "move"/"انقل"      -> move_file latest attachment to archive/
 *  - anything else       -> plain answer
 * `overrides` lets a test force a specific tool call.
 */
export function scriptedModel(override?: (req: ModelRequest) => FakeTurn | undefined): FakeModelClient {
  return new FakeModelClient((req) => {
    const last = req.messages[req.messages.length - 1];
    if (Array.isArray(last.content)) {
      const result = (last.content as ModelBlock[]).find((b) => b.type === "tool_result");
      if (result && result.type === "tool_result") {
        return { text: result.is_error ? `Tool failed: ${result.content}` : `SUMMARY: ${result.content.slice(0, 60)}` };
      }
    }
    const forced = override?.(req);
    if (forced) return forced;
    const text = lastUserText(req);
    if (/summari[sz]e|لخص/i.test(text)) {
      return { text: "Reading the file.", toolCalls: [{ name: "read_file", input: { path: latestAttachment(req) } }] };
    }
    if (/move|انقل/i.test(text)) {
      return { toolCalls: [{ name: "move_file", input: { source: latestAttachment(req), destination_dir: "archive" } }] };
    }
    return { text: "Hello Ahmed." };
  });
}

// ---------- HTTP helpers ----------

export interface UploadFile {
  name: string;
  content: Buffer | string;
  type?: string;
}

export function multipart(payload: unknown, file?: UploadFile) {
  const boundary = `----ahmedtest${randomUUID()}`;
  const chunks: Buffer[] = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`),
  ];
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type ?? "application/octet-stream"}\r\n\r\n`,
      ),
      Buffer.from(file.content),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function requestPayload(conversationId: string, message: string, file?: UploadFile, requestId: string = randomUUID()) {
  return {
    contract_version: CONTRACT_VERSION,
    request_id: requestId,
    conversation_id: conversationId,
    input_type: file ? "file" : "text",
    message,
    attachments: file ? [{ name: file.name, mime_type: file.type, size_bytes: Buffer.byteLength(file.content) }] : [],
    client_context: { platform: "test" },
  };
}

export async function send(core: Core, conversationId: string, message: string, file?: UploadFile, requestId?: string) {
  const mp = multipart(requestPayload(conversationId, message, file, requestId), file);
  const res = await core.app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: { ...AUTH, "content-type": mp.contentType },
    payload: mp.body,
  });
  return { statusCode: res.statusCode, body: res.json() as AgentResponse };
}

/** Sends a message and waits until the Core finished processing it. */
export async function sendAndWait(core: Core, conversationId: string, message: string, file?: UploadFile) {
  const sent = await send(core, conversationId, message, file);
  await core.drain();
  return getTask(core, sent.body.task_id!);
}

export async function getTask(core: Core, taskId: string): Promise<AgentResponse> {
  const res = await core.app.inject({ method: "GET", url: `/v1/tasks/${taskId}`, headers: AUTH });
  return res.json() as AgentResponse;
}

export async function decide(core: Core, taskId: string, actionId: string, decision: "APPROVE" | "REJECT") {
  const res = await core.app.inject({
    method: "POST",
    url: `/v1/tasks/${taskId}/actions/${actionId}/decision`,
    headers: AUTH,
    payload: { action_id: actionId, decision },
  });
  return { statusCode: res.statusCode, body: res.json() as AgentResponse };
}

export async function getConversation(core: Core, conversationId: string): Promise<ConversationResponse> {
  const res = await core.app.inject({ method: "GET", url: `/v1/conversations/${conversationId}`, headers: AUTH });
  return res.json() as ConversationResponse;
}

export function approval(res: AgentResponse): ApprovalRequest {
  return res.data as ApprovalRequest;
}

export function countEvents(core: Core, event: string, taskId?: string): number {
  return core.store.listAudit(taskId).filter((a) => a.event === event).length;
}

/** A tiny but valid single-page PDF containing `text`. */
export function makePdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
