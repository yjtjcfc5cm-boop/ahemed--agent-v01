import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  type AgentResponse,
  type ResultData,
  type TaskEventsResponse,
} from "@ahmed/contract";
import { openDb } from "../src/db.js";
import { FakeModelClient } from "../src/model.js";
import type { Core } from "../src/server.js";
import {
  AUTH,
  approval,
  countEvents,
  decide,
  getTask,
  makeEnv,
  multipart,
  requestPayload,
  send,
  sendAndWait,
  startCore,
  type Env,
} from "./helpers.js";

describe("contract v0.2", () => {
  let env: Env | undefined;
  let core: Core | undefined;

  afterEach(async () => {
    await core?.close();
    env?.cleanup();
    env = undefined;
    core = undefined;
  });

  async function boot(model: FakeModelClient, pricing?: { inputPer1M: number; outputPer1M: number }) {
    env = makeEnv();
    core = await startCore(env, model, pricing ? { pricing } : {});
    return core;
  }

  it("accepts a legacy 0.1 request and answers with the current version", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "hi" })));
    const payload = { ...requestPayload("c1", "hello"), contract_version: "0.1" };
    const mp = multipart(payload);
    const res = await c.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...AUTH, "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as AgentResponse).contract_version).toBe("0.2");
    expect(CONTRACT_VERSION).toBe("0.2");
  });

  it("serves the task event stream as a JSON snapshot", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "hi" })));
    const done = await sendAndWait(c, "c1", "hello");
    const res = await c.app.inject({ method: "GET", url: `/v1/tasks/${done.task_id}/events`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as TaskEventsResponse;
    expect(body.contract_version).toBe("0.2");
    expect(body.task_id).toBe(done.task_id);
    const types = body.events.map((e) => e.type);
    expect(types).toContain("REQUEST_RECEIVED");
    expect(types).toContain("STATUS_CHANGED");
    expect(types).toContain("TASK_COMPLETED");
    const seqs = body.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(body.events.every((e) => e.task_id === done.task_id)).toBe(true);
  });

  it("404s the event stream for an unknown task", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "hi" })));
    const res = await c.app.inject({ method: "GET", url: "/v1/tasks/nope/events", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("streams a finished task's events as SSE and closes", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "hi" })));
    const done = await sendAndWait(c, "c1", "hello");
    const res = await c.app.inject({
      method: "GET",
      url: `/v1/tasks/${done.task_id}/events`,
      headers: { ...AUTH, accept: "text/event-stream" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: TASK_COMPLETED");
    expect(res.body).toContain(`"task_id":"${done.task_id}"`);
  });

  it("streams live events over SSE until the task reaches a final status", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "hi" })));
    const sent = await send(c, "c1", "hello");
    const sse = c.app.inject({
      method: "GET",
      url: `/v1/tasks/${sent.body.task_id}/events`,
      headers: { ...AUTH, accept: "text/event-stream" },
    });
    await c.drain();
    const res = await sse;
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: TASK_COMPLETED");
  });

  it("records tokens and computes cost_usd when pricing is configured", async () => {
    const model = new FakeModelClient((_req, call) =>
      call === 0
        ? {
            text: "Reading.",
            toolCalls: [{ name: "read_file", input: { path: "inbox/note.txt" } }],
            usage: { input_tokens: 1000, output_tokens: 100 },
          }
        : { text: "SUMMARY: hello", usage: { input_tokens: 2000, output_tokens: 200 } },
    );
    const c = await boot(model, { inputPer1M: 1, outputPer1M: 2 });
    const done = await sendAndWait(c, "c1", "summarize please", {
      name: "note.txt",
      content: "hello world",
      type: "text/plain",
    });
    expect(done.response_type).toBe("RESULT");
    const data = done.data as ResultData;
    expect(data.simulated).toBe(false);
    // 3000 in at $1/1M + 300 out at $2/1M = 0.0036
    expect(data.cost_usd).toBeCloseTo(0.0036, 6);
    const row = c.store.getTask(done.task_id!)!;
    expect(row.input_tokens).toBe(3000);
    expect(row.output_tokens).toBe(300);
  });

  it("records tokens but omits cost when pricing is not configured", async () => {
    const model = new FakeModelClient(() => ({ text: "hi", usage: { input_tokens: 10, output_tokens: 5 } }));
    const c = await boot(model);
    const done = await sendAndWait(c, "c1", "hello");
    expect(done.response_type).toBe("MESSAGE");
    const row = c.store.getTask(done.task_id!)!;
    expect(row.input_tokens).toBe(10);
    expect(row.cost_usd).toBeNull();
    const usageEvent = c.store.listAudit(done.task_id!).find((a) => a.event === "MODEL_RESPONDED")!;
    expect(JSON.parse(usageEvent.detail!).usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("attaches the execution plan to approval requests", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "Moving.", toolCalls: [{ name: "move_file", input: { source: "inbox/note.txt", destination_dir: "archive" } }] })));
    const waiting = await sendAndWait(c, "c1", "move it", { name: "note.txt", content: "x", type: "text/plain" });
    expect(waiting.status).toBe("WAITING_FOR_APPROVAL");
    const req = approval(waiting);
    expect(req.plan).toHaveLength(3);
    expect(req.plan![1].tool).toBe("move_file");
    expect(req.plan![1].risk_level).toBe("write");
  });

  it("interrupt rejects a waiting approval, changes nothing on disk, and a late approve conflicts", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "Moving.", toolCalls: [{ name: "move_file", input: { source: "inbox/note.txt", destination_dir: "archive" } }] })));
    const waiting = await sendAndWait(c, "c1", "move it", { name: "note.txt", content: "x", type: "text/plain" });
    const taskId = waiting.task_id!;

    const res = await c.app.inject({ method: "POST", url: `/v1/tasks/${taskId}/interrupt`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentResponse;
    expect(body.status).toBe("REJECTED");
    expect(body.error?.code).toBe("INTERRUPTED");
    expect(existsSync(path.join(env!.wsRoot, "archive", "note.txt"))).toBe(false);
    expect(countEvents(c, "TASK_INTERRUPTED", taskId)).toBe(1);

    const late = await decide(c, taskId, approval(waiting).action_id, "APPROVE");
    expect(late.statusCode).toBe(409);
    expect(existsSync(path.join(env!.wsRoot, "archive", "note.txt"))).toBe(false);

    const again = await c.app.inject({ method: "POST", url: `/v1/tasks/${taskId}/interrupt`, headers: AUTH });
    expect(again.statusCode).toBe(409);
  });

  it("interrupt during processing fails the task between model steps", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = new FakeModelClient(async () => {
      await gate;
      return { text: "late" };
    });
    const c = await boot(model);
    const sent = await send(c, "c1", "hello");
    for (let i = 0; i < 200 && model.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(model.requests.length).toBe(1);

    const res = await c.app.inject({ method: "POST", url: `/v1/tasks/${sent.body.task_id}/interrupt`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    release();
    await c.drain();

    const t = await getTask(c, sent.body.task_id!);
    expect(t.status).toBe("FAILED");
    expect(t.error?.code).toBe("INTERRUPTED");
    expect(countEvents(c, "INTERRUPT_REQUESTED", sent.body.task_id!)).toBe(1);
  });

  it("interrupt on an unknown task is a 404", async () => {
    const c = await boot(new FakeModelClient(() => ({ text: "hi" })));
    const res = await c.app.inject({ method: "POST", url: "/v1/tasks/nope/interrupt", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("migrates a pre-0.2 database in place (token columns added, data kept)", async () => {
    env = makeEnv();
    // A database as v0.1 created it: tasks without the token columns.
    const old = new Database(env.dbFile);
    old.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        request_id TEXT NOT NULL UNIQUE, user_message TEXT NOT NULL, status TEXT NOT NULL,
        used_tool TEXT, result_message TEXT, error_code TEXT, error_message TEXT,
        attachments TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO conversations (id, created_at) VALUES ('old-conv', '2026-10-01T00:00:00.000Z');
      INSERT INTO tasks (id, conversation_id, request_id, user_message, status, created_at, updated_at)
        VALUES ('old-task', 'old-conv', 'old-req', 'hello', 'COMPLETED', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    `);
    old.close();

    const db = openDb(env.dbFile);
    const cols = (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["input_tokens", "output_tokens", "cost_usd"]));
    const row = db.prepare("SELECT * FROM tasks WHERE id = 'old-task'").get() as { status: string; cost_usd: unknown };
    expect(row.status).toBe("COMPLETED");
    expect(row.cost_usd).toBeNull();
    db.close();
  });
});
