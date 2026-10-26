import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import {
  ACCEPTED_REQUEST_VERSIONS,
  CONTRACT_VERSION,
  FINAL_STATUSES,
  type AgentRequest,
  type ApprovalDecision,
  type Attachment,
  type TaskEvent,
} from "@ahmed/contract";
import { Agent, APPROVAL_TTL_MS, type TokenPricing } from "./agent.js";
import { openDb } from "./db.js";
import type { ModelClient } from "./model.js";
import { conversationResponse, errorResponse, taskEvent, taskEventsResponse, taskResponse } from "./responses.js";
import { Store, type Clock } from "./store.js";
import { Workspace } from "./workspace.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface CoreOptions {
  dbFile: string;
  workspaceRoot: string;
  appToken: string;
  model: ModelClient;
  clock?: Clock;
  approvalTtlMs?: number;
  /** v0.2: USD per 1M tokens. Without both values, cost_usd stays null — never guessed. */
  pricing?: TokenPricing;
  logger?: boolean;
}

export interface Core {
  app: FastifyInstance;
  store: Store;
  agent: Agent;
  workspace: Workspace;
  /** Resolves when all background message processing has finished. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function createCore(opts: CoreOptions): Promise<Core> {
  if (!opts.appToken) throw new Error("APP_TOKEN is required");
  const db = openDb(opts.dbFile);
  const store = new Store(db, opts.clock ?? (() => new Date()));
  const workspace = new Workspace(opts.workspaceRoot);
  const agent = new Agent(store, workspace, opts.model, opts.approvalTtlMs ?? APPROVAL_TTL_MS, opts.pricing ?? {});
  agent.recover();

  const inFlight = new Set<Promise<void>>();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

  // ---- auth: every request needs the app token ----
  const expected = sha256(`Bearer ${opts.appToken}`);
  app.addHook("onRequest", async (req, reply) => {
    const given = sha256(req.headers.authorization ?? "");
    if (!timingSafeEqual(given, expected)) {
      return reply.code(401).send(errorResponse("UNAUTHORIZED", "Missing or invalid app token."));
    }
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorResponse("NOT_FOUND", "Route not found.")));
  app.setErrorHandler((err: { statusCode?: number; message: string }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error(err);
    store.audit("ERROR", {}, { route: req.url, message: err.message });
    return reply
      .code(status)
      .send(errorResponse(status === 500 ? "INTERNAL" : "BAD_REQUEST", status === 500 ? "Internal error." : err.message));
  });

  // ---- POST /v1/messages ----
  app.post("/v1/messages", async (req, reply) => {
    // Rejected uploads are audited and logged so a failed send from the phone is never invisible.
    const reject = (status: number, message: string, requestId: string | null = null) => {
      req.log.warn({ status, reason: message }, "message rejected");
      store.audit("REQUEST_REJECTED", {}, { status, reason: message, request_id: requestId, content_type: req.headers["content-type"] ?? null });
      return reply.code(status).send(errorResponse("BAD_REQUEST", message, { request_id: requestId }));
    };
    if (!req.isMultipart()) return reject(400, "Expected multipart/form-data.");

    let payloadRaw: string | undefined;
    let upload: { filename: string; mimetype: string; buffer: Buffer } | undefined;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file" || upload) {
          await part.toBuffer();
          return reject(400, "Only one file, in the field 'file', is allowed.");
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated) return reject(413, "File is larger than 25 MB.");
        upload = { filename: part.filename, mimetype: part.mimetype, buffer };
      } else if (part.fieldname === "payload") {
        payloadRaw = String(part.value);
      }
    }

    const parsed = parseRequest(payloadRaw);
    if (typeof parsed === "string") return reject(400, parsed);
    const request = parsed;
    if (request.input_type === "file" && !upload) {
      return reject(400, "input_type 'file' requires a 'file' part.", request.request_id);
    }

    // Safe retry: the same request_id never creates a second task.
    const existing = store.getTaskByRequestId(request.request_id);
    if (existing) {
      if (existing.conversation_id !== request.conversation_id) {
        return reply.code(409).send(errorResponse("CONFLICT", "request_id already used in another conversation."));
      }
      return reply.code(200).send(taskResponse(store, existing));
    }

    const attachments: Attachment[] = [];
    if (upload) {
      // Prefer the name from the JSON payload: multipart header filenames are not reliably UTF-8.
      const meta = request.attachments[0];
      const name = (typeof meta?.name === "string" && meta.name.trim()) || upload.filename || "upload";
      const rel = storeUpload(workspace, name, upload.buffer);
      attachments.push({
        name,
        mime_type: upload.mimetype || meta?.mime_type,
        size_bytes: upload.buffer.length,
        workspace_path: rel,
      });
    }

    const task = store.tx(() => {
      store.ensureConversation(request.conversation_id);
      const t = store.createTask({
        conversationId: request.conversation_id,
        requestId: request.request_id,
        userMessage: request.message,
        attachments,
      });
      store.addMessage({ conversationId: request.conversation_id, role: "user", content: request.message, attachments, taskId: t.id });
      store.audit("REQUEST_RECEIVED", { taskId: t.id }, {
        request_id: request.request_id,
        conversation_id: request.conversation_id,
        input_type: request.input_type,
        message: request.message,
        attachments,
      });
      return t;
    });

    const job = agent.processTask(task.id).finally(() => inFlight.delete(job));
    inFlight.add(job);
    return reply.code(202).send(taskResponse(store, store.getTask(task.id)!));
  });

  // ---- GET /v1/tasks/:taskId ----
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (req, reply) => {
    agent.expireStale();
    const task = store.getTask(req.params.taskId);
    if (!task) return reply.code(404).send(errorResponse("NOT_FOUND", "Task not found."));
    return taskResponse(store, task);
  });

  // ---- POST /v1/tasks/:taskId/actions/:actionId/decision ----
  app.post<{ Params: { taskId: string; actionId: string } }>(
    "/v1/tasks/:taskId/actions/:actionId/decision",
    async (req, reply) => {
      const { taskId, actionId } = req.params;
      const body = req.body as Partial<ApprovalDecision> | undefined;
      if (!body || body.action_id !== actionId || (body.decision !== "APPROVE" && body.decision !== "REJECT")) {
        return reply
          .code(400)
          .send(errorResponse("BAD_REQUEST", "Body must be {action_id (same as in the URL), decision: APPROVE|REJECT}."));
      }
      const outcome = agent.decide(taskId, actionId, body.decision);
      switch (outcome.kind) {
        case "not_found":
          return reply.code(404).send(errorResponse("NOT_FOUND", "No such action for this task."));
        case "conflict":
          return reply.code(409).send(
            errorResponse("CONFLICT", `A different decision (${outcome.recorded}) was already recorded.`, {
              request_id: outcome.task.request_id,
              task_id: outcome.task.id,
              status: outcome.task.status,
            }),
          );
        case "expired":
          return reply.code(410).send(taskResponse(store, outcome.task));
        case "ok":
          return taskResponse(store, outcome.task);
      }
    },
  );

  // ---- GET /v1/tasks/:taskId/events (v0.2) ----
  // Default: JSON snapshot of the task's event stream (the audit trail for this task).
  // Accept: text/event-stream -> the snapshot, then live events until a final status.
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId/events", async (req, reply) => {
    agent.expireStale();
    const task = store.getTask(req.params.taskId);
    if (!task) return reply.code(404).send(errorResponse("NOT_FOUND", "Task not found."));

    if (!(req.headers.accept ?? "").includes("text/event-stream")) {
      return taskEventsResponse(task.id, store.listAudit(task.id));
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (e: TaskEvent) => reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const row of store.listAudit(task.id)) send(taskEvent(row));
    if (FINAL_STATUSES.includes(task.status)) {
      reply.raw.end();
      return;
    }
    const off = store.onEvent((e) => {
      if (e.task_id !== task.id) return;
      send(e);
      const current = store.getTask(task.id);
      if (current && FINAL_STATUSES.includes(current.status)) {
        off();
        reply.raw.end();
      }
    });
    req.raw.on("close", off);
  });

  // ---- POST /v1/tasks/:taskId/interrupt (v0.2) ----
  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/interrupt", async (req, reply) => {
    const outcome = agent.interrupt(req.params.taskId);
    switch (outcome.kind) {
      case "not_found":
        return reply.code(404).send(errorResponse("NOT_FOUND", "Task not found."));
      case "already_final":
        return reply.code(409).send(
          errorResponse("CONFLICT", "Task is already finished; nothing to interrupt.", {
            request_id: outcome.task.request_id,
            task_id: outcome.task.id,
            status: outcome.task.status,
          }),
        );
      case "locked":
        return reply.code(409).send(
          errorResponse("CONFLICT", "A write is already executing and is never killed mid-write.", {
            request_id: outcome.task.request_id,
            task_id: outcome.task.id,
            status: outcome.task.status,
          }),
        );
      case "ok":
        return taskResponse(store, outcome.task);
    }
  });

  // ---- GET /v1/conversations/:conversationId ----
  app.get<{ Params: { conversationId: string } }>("/v1/conversations/:conversationId", async (req) => {
    agent.expireStale();
    return conversationResponse(store, req.params.conversationId);
  });

  const drain = async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  };

  return {
    app,
    store,
    agent,
    workspace,
    drain,
    close: async () => {
      await drain();
      await app.close();
      db.close();
    },
  };
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function parseRequest(raw: string | undefined): AgentRequest | string {
  if (!raw) return "Missing 'payload' field.";
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "'payload' is not valid JSON.";
  }
  if (p === null || typeof p !== "object") return "'payload' must be an object.";
  if (
    p.contract_version !== CONTRACT_VERSION &&
    !(ACCEPTED_REQUEST_VERSIONS as readonly string[]).includes(String(p.contract_version))
  ) {
    return `contract_version must be "${CONTRACT_VERSION}".`;
  }
  for (const k of ["request_id", "conversation_id"] as const) {
    if (typeof p[k] !== "string" || !(p[k] as string).trim() || (p[k] as string).length > 100) {
      return `'${k}' must be a non-empty string.`;
    }
  }
  if (p.input_type !== "text" && p.input_type !== "file") return "'input_type' must be \"text\" or \"file\".";
  if (typeof p.message !== "string") return "'message' must be a string.";
  if (p.input_type === "text" && !p.message.trim()) return "'message' is required for text input.";
  if (!Array.isArray(p.attachments)) return "'attachments' must be an array.";
  if (p.client_context !== undefined && (typeof p.client_context !== "object" || p.client_context === null)) {
    return "'client_context' must be an object.";
  }
  return {
    contract_version: CONTRACT_VERSION,
    request_id: p.request_id as string,
    conversation_id: p.conversation_id as string,
    input_type: p.input_type,
    message: p.message,
    attachments: (p.attachments as Attachment[]).filter((a) => a && typeof a === "object"),
    client_context: p.client_context as AgentRequest["client_context"],
  };
}

/** Saves an upload to inbox/ with a safe, unique name. Returns the workspace-relative path. */
function storeUpload(ws: Workspace, original: string, data: Buffer): string {
  const base = path.basename(original || "upload").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").trim() || "upload";
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "upload";
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? `${stem}${ext}` : `${stem}-${i}${ext}`;
    const abs = ws.resolve(`inbox/${name}`);
    if (existsSync(abs)) continue;
    writeFileSync(abs, data, { flag: "wx" });
    return ws.relative(abs);
  }
  throw new Error("Could not find a free file name in inbox/.");
}
