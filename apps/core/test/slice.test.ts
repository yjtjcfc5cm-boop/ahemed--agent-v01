import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationTask, ResultData } from "@ahmed/contract";
import type { Core } from "../src/server.js";
import {
  AUTH,
  approval,
  countEvents,
  decide,
  getConversation,
  getTask,
  makeEnv,
  makePdf,
  multipart,
  requestPayload,
  scriptedModel,
  send,
  sendAndWait,
  startCore,
  type Env,
} from "./helpers.js";

const CONV = "conv-1";
const REPORT = { name: "report.txt", content: "Quarterly report: revenue grew 12% and costs fell.", type: "text/plain" };

let env: Env;
let core: Core;

beforeEach(async () => {
  env = makeEnv();
  core = await startCore(env, scriptedModel());
});

afterEach(async () => {
  await core.close().catch(() => {});
  env.cleanup();
});

const ws = (...p: string[]) => path.join(env.wsRoot, ...p);

/** Upload + summarize, then ask to move. Returns the task waiting for approval. */
async function uploadAndRequestMove(file = REPORT) {
  const read = await sendAndWait(core, CONV, "لخص لي هذا الملف", file);
  expect(read.status).toBe("COMPLETED");
  const move = await sendAndWait(core, CONV, "انقل الملف إلى مجلد archive");
  expect(move.status).toBe("WAITING_FOR_APPROVAL");
  return move;
}

describe("1. read a file and summarize it", () => {
  it("stores the upload in inbox/, reads it with read_file, and returns the summary", async () => {
    const sent = await send(core, CONV, "لخص لي هذا الملف", REPORT);
    expect(sent.statusCode).toBe(202);
    expect(sent.body.response_type).toBe("TASK_STATUS");
    expect(["RECEIVED", "PROCESSING"]).toContain(sent.body.status);

    await core.drain();
    const res = await getTask(core, sent.body.task_id!);
    expect(res.status).toBe("COMPLETED");
    expect(res.response_type).toBe("RESULT");
    expect(res.message).toContain("SUMMARY: Quarterly report");
    expect((res.data as ResultData).tool).toBe("read_file");
    expect(readFileSync(ws("inbox", "report.txt"), "utf8")).toBe(REPORT.content);

    const statuses = core.store
      .listAudit(res.task_id!)
      .filter((a) => a.event === "STATUS_CHANGED")
      .map((a) => JSON.parse(a.detail!).to);
    expect(statuses).toEqual(["PROCESSING", "COMPLETED"]);
  });

  it("extracts text from a PDF", async () => {
    const res = await sendAndWait(core, CONV, "summarize this", { name: "doc.pdf", content: makePdf("Hello PDF World"), type: "application/pdf" });
    expect(res.status).toBe("COMPLETED");
    expect(res.message).toContain("Hello PDF World");
  });

  it("keeps Arabic file names intact and never overwrites an earlier upload", async () => {
    const file = { name: "تقرير.txt", content: "محتوى", type: "text/plain" };
    await sendAndWait(core, CONV, "لخص لي هذا الملف", file);
    const second = await sendAndWait(core, CONV, "لخص لي هذا الملف", { ...file, content: "ثاني" });
    expect(readFileSync(ws("inbox", "تقرير.txt"), "utf8")).toBe("محتوى");
    expect(readFileSync(ws("inbox", "تقرير-1.txt"), "utf8")).toBe("ثاني");
    expect(second.message).toContain("ثاني");
  });

  it("accepts a file with no text (a several-MB PDF, as the phone sends it)", async () => {
    const pdf = Buffer.concat([makePdf("Big PDF"), Buffer.alloc(3 * 1024 * 1024, 32)]);
    const sent = await send(core, CONV, "", { name: "big.pdf", content: pdf, type: "application/pdf" });
    expect(sent.statusCode).toBe(202);
    expect(sent.body.data).toMatchObject({ attachments: [{ name: "big.pdf", workspace_path: "inbox/big.pdf", size_bytes: pdf.length }] });
    await core.drain();
    expect(readFileSync(ws("inbox", "big.pdf")).length).toBe(pdf.length);
  });

  it("accepts the multipart body exactly as expo/fetch builds it on the phone", async () => {
    // expo/fetch: own boundary, percent-encoded filename, file part may have no Content-Type.
    const boundary = "----ExpoFetchFormBoundaryAbCdEf0123456789";
    const payload = requestPayload(CONV, "", { name: "تقرير.pdf", content: "x", type: "application/pdf" });
    const pdf = makePdf("From iPhone");
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${encodeURIComponent("تقرير.pdf")}"\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await core.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    await core.drain();
    expect(readFileSync(ws("inbox", "تقرير.pdf")).equals(pdf)).toBe(true);
  });

  it("audits rejected uploads instead of failing invisibly", async () => {
    const payload = { ...requestPayload(CONV, ""), input_type: "file" };
    const mp = multipart(payload);
    const res = await core.app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { ...AUTH, "content-type": mp.contentType },
      payload: mp.body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("requires a 'file' part");
    const rejected = core.store.listAudit().filter((a) => a.event === "REQUEST_REJECTED");
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(rejected[0].detail!).request_id).toBe(payload.request_id);
  });

  it("returns a clear ERROR for unsupported file types", async () => {
    const res = await sendAndWait(core, CONV, "summarize this", { name: "photo.png", content: "not really a png", type: "image/png" });
    expect(res.status).toBe("FAILED");
    expect(res.response_type).toBe("ERROR");
    expect(res.error?.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("answers plain messages without tools as MESSAGE", async () => {
    const res = await sendAndWait(core, CONV, "hi");
    expect(res.status).toBe("COMPLETED");
    expect(res.response_type).toBe("MESSAGE");
    expect(res.message).toBe("Hello Ahmed.");
  });

  it("does not create a second task when the same request_id is retried", async () => {
    const first = await send(core, CONV, "hi", undefined, "req-fixed");
    const second = await send(core, CONV, "hi", undefined, "req-fixed");
    expect(second.statusCode).toBe(200);
    expect(second.body.task_id).toBe(first.body.task_id);
    await core.drain();
    expect((await getConversation(core, CONV)).tasks).toHaveLength(1);
  });
});

describe("2. a move request produces APPROVAL_REQUEST", () => {
  it("understands 'the file' from conversation history and asks for approval without moving anything", async () => {
    const move = await uploadAndRequestMove();
    expect(move.response_type).toBe("APPROVAL_REQUEST");
    const a = approval(move);
    expect(a).toMatchObject({
      operation: "move_file",
      tool: "move_file",
      affected_resource: "inbox/report.txt",
      destination: "archive/report.txt",
      risk_level: "write",
    });
    expect(a.action_id).toBeTruthy();
    expect(a.idempotency_key).toBeTruthy();
    expect(a.description).toContain("inbox/report.txt");
    expect(Date.parse(a.expires_at) - env.nowMs).toBe(15 * 60 * 1000);
    // No side effect yet.
    expect(existsSync(ws("inbox", "report.txt"))).toBe(true);
    expect(existsSync(ws("archive"))).toBe(false);
    expect(countEvents(core, "EXECUTION_STARTED")).toBe(0);
  });
});

describe("3. REJECT prevents execution", () => {
  it("rejects with no side effect", async () => {
    const move = await uploadAndRequestMove();
    const res = await decide(core, move.task_id!, approval(move).action_id, "REJECT");
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.response_type).toBe("RESULT");
    expect((res.body.data as ResultData).decision).toBe("REJECT");
    expect(existsSync(ws("inbox", "report.txt"))).toBe(true);
    expect(existsSync(ws("archive"))).toBe(false);
    expect(countEvents(core, "EXECUTION_STARTED")).toBe(0);
    expect(countEvents(core, "EXECUTION_RESERVED")).toBe(0);

    // A later APPROVE for the same action is a conflict and changes nothing.
    const late = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(late.statusCode).toBe(409);
    expect(late.body.error?.code).toBe("CONFLICT");
    expect(existsSync(ws("archive"))).toBe(false);
    expect((await getTask(core, move.task_id!)).status).toBe("REJECTED");
  });
});

describe("4. APPROVE executes exactly once", () => {
  it("moves the file, verifies it on disk, and completes", async () => {
    const move = await uploadAndRequestMove();
    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.response_type).toBe("RESULT");
    expect(res.body.data).toMatchObject({ decision: "APPROVE", verified: true, destination: "archive/report.txt" });
    expect(existsSync(ws("inbox", "report.txt"))).toBe(false);
    expect(readFileSync(ws("archive", "report.txt"), "utf8")).toBe(REPORT.content);
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(1);

    const statuses = core.store
      .listAudit(move.task_id!)
      .filter((a) => a.event === "STATUS_CHANGED")
      .map((a) => JSON.parse(a.detail!).to);
    expect(statuses).toEqual(["PROCESSING", "WAITING_FOR_APPROVAL", "APPROVED", "EXECUTING", "VERIFYING", "COMPLETED"]);
  });
});

describe("5. repeated approvals never execute twice", () => {
  it("returns the current state for a repeated APPROVE", async () => {
    const move = await uploadAndRequestMove();
    const id = approval(move).action_id;
    const first = await decide(core, move.task_id!, id, "APPROVE");
    const second = await decide(core, move.task_id!, id, "APPROVE");
    expect(first.body.status).toBe("COMPLETED");
    expect(second.statusCode).toBe(200);
    expect(second.body.status).toBe("COMPLETED");
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(1);
    expect(countEvents(core, "DECISION_RECORDED", move.task_id!)).toBe(1);
  });

  it("executes once when two approvals arrive at the same time", async () => {
    const move = await uploadAndRequestMove();
    const id = approval(move).action_id;
    const results = await Promise.all([
      decide(core, move.task_id!, id, "APPROVE"),
      decide(core, move.task_id!, id, "APPROVE"),
      decide(core, move.task_id!, id, "APPROVE"),
    ]);
    for (const r of results) expect(r.statusCode).toBe(200);
    expect((await getTask(core, move.task_id!)).status).toBe("COMPLETED");
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(1);
    expect(countEvents(core, "EXECUTION_RESERVED", move.task_id!)).toBe(1);
  });

  it("the UNIQUE idempotency_key blocks a second reservation at the database level", async () => {
    const move = await uploadAndRequestMove();
    await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    const action = core.store.getAction(approval(move).action_id)!;
    expect(() => core.store.insertExecution(action)).toThrow(/UNIQUE/);
  });

  it("an expired approval becomes REJECTED and never executes", async () => {
    const move = await uploadAndRequestMove();
    env.nowMs += 16 * 60 * 1000;
    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(res.statusCode).toBe(410);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.error?.code).toBe("APPROVAL_EXPIRED");
    expect(existsSync(ws("inbox", "report.txt"))).toBe(true);
    expect(existsSync(ws("archive"))).toBe(false);
    expect(countEvents(core, "EXECUTION_STARTED")).toBe(0);
  });

  it("expiry is also applied when the app polls the task", async () => {
    const move = await uploadAndRequestMove();
    env.nowMs += 15 * 60 * 1000 + 1;
    const polled = await getTask(core, move.task_id!);
    expect(polled.status).toBe("REJECTED");
    expect(polled.error?.code).toBe("APPROVAL_EXPIRED");
  });

  it.each(["APPROVE", "REJECT"] as const)("expires at the exact deadline before a %s decision", async (decision) => {
    const move = await uploadAndRequestMove();
    env.nowMs = Date.parse(approval(move).expires_at);

    const res = await decide(core, move.task_id!, approval(move).action_id, decision);
    expect(res.statusCode).toBe(410);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.error?.code).toBe("APPROVAL_EXPIRED");
    expect(readFileSync(ws("inbox", "report.txt"), "utf8")).toBe(REPORT.content);
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(0);
  });

  it.each(["APPROVE", "REJECT"] as const)("persists the same timestamp used to accept a %s decision", async (decision) => {
    const move = await uploadAndRequestMove();
    const beforeExpiry = Date.parse(approval(move).expires_at) - 1;
    let clockReads = 0;
    Object.defineProperty(env, "nowMs", {
      configurable: true,
      get: () => clockReads++ === 0 ? beforeExpiry : beforeExpiry + 1,
    });

    const res = await decide(core, move.task_id!, approval(move).action_id, decision);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe(decision === "APPROVE" ? "COMPLETED" : "REJECTED");
    const action = core.store.getAction(approval(move).action_id)!;
    expect(Date.parse(action.decided_at!)).toBe(beforeExpiry);
    expect(Date.parse(action.decided_at!)).toBeLessThan(Date.parse(action.expires_at));
  });
});

describe("6. restarting the Core", () => {
  async function restart() {
    await core.close();
    core = await startCore(env, scriptedModel());
  }

  it("keeps a waiting approval and can approve it after restart", async () => {
    const move = await uploadAndRequestMove();
    await restart();
    const polled = await getTask(core, move.task_id!);
    expect(polled.status).toBe("WAITING_FOR_APPROVAL");
    expect(approval(polled).action_id).toBe(approval(move).action_id);
    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(res.body.status).toBe("COMPLETED");
    expect(existsSync(ws("archive", "report.txt"))).toBe(true);
  });

  /** Puts the task in EXECUTING exactly like a crash right after the reservation. */
  function simulateCrashInExecuting(taskId: string, actionId: string) {
    const s = core.store;
    s.tx(() => {
      s.recordDecision(actionId, "APPROVE");
      s.transition(taskId, "APPROVED");
      s.insertExecution(s.getAction(actionId)!);
      s.transition(taskId, "EXECUTING");
    });
  }

  it("a task stuck in EXECUTING whose move never happened is verified as FAILED, not re-executed", async () => {
    const move = await uploadAndRequestMove();
    simulateCrashInExecuting(move.task_id!, approval(move).action_id);
    await restart();

    const res = await getTask(core, move.task_id!);
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("EXECUTION_FAILED");
    expect(existsSync(ws("inbox", "report.txt"))).toBe(true);
    expect(existsSync(ws("archive", "report.txt"))).toBe(false);
    expect(countEvents(core, "EXECUTION_STARTED")).toBe(0);
    expect(countEvents(core, "RECOVERY", move.task_id!)).toBe(1);

    // Approving again does not run it either.
    const again = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(again.body.status).toBe("FAILED");
    expect(existsSync(ws("archive", "report.txt"))).toBe(false);
  });

  it("a task stuck in EXECUTING whose move did happen is verified as COMPLETED, not re-executed", async () => {
    const move = await uploadAndRequestMove();
    simulateCrashInExecuting(move.task_id!, approval(move).action_id);
    mkdirSync(ws("archive"));
    renameSync(ws("inbox", "report.txt"), ws("archive", "report.txt"));
    await restart();

    const res = await getTask(core, move.task_id!);
    expect(res.status).toBe("COMPLETED");
    expect((res.data as ResultData).verified).toBe(true);
    expect(countEvents(core, "EXECUTION_STARTED")).toBe(0);
  });

  it.each(["EXECUTING", "VERIFYING"] as const)("does not verify an unrelated destination after restarting from %s", async (status) => {
    const move = await uploadAndRequestMove();
    simulateCrashInExecuting(move.task_id!, approval(move).action_id);
    if (status === "VERIFYING") core.store.transition(move.task_id!, "VERIFYING");
    renameSync(ws("inbox", "report.txt"), ws("inbox", "renamed.txt"));
    mkdirSync(ws("archive"));
    const unrelated = "X".repeat(REPORT.content.length);
    writeFileSync(ws("archive", "report.txt"), unrelated);

    await restart();

    const res = await getTask(core, move.task_id!);
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("EXECUTION_FAILED");
    expect((res.data as ResultData).verified).toBe(false);
    expect(readFileSync(ws("inbox", "renamed.txt"), "utf8")).toBe(REPORT.content);
    expect(readFileSync(ws("archive", "report.txt"), "utf8")).toBe(unrelated);
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(0);
  });

  it("does not claim verified recovery for a legacy action with no content fingerprint", async () => {
    const move = await uploadAndRequestMove();
    const action = core.store.getAction(approval(move).action_id)!;
    const legacyPlan = JSON.parse(action.input);
    delete legacyPlan.source_sha256;
    core.store.db.prepare("UPDATE actions SET input = ? WHERE id = ?").run(JSON.stringify(legacyPlan), action.id);
    simulateCrashInExecuting(move.task_id!, action.id);
    mkdirSync(ws("archive"));
    renameSync(ws("inbox", "report.txt"), ws("archive", "report.txt"));

    await restart();

    const res = await getTask(core, move.task_id!);
    expect(res.status).toBe("FAILED");
    expect((res.data as ResultData).verified).toBe(false);
    expect(readFileSync(ws("archive", "report.txt"), "utf8")).toBe(REPORT.content);
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(0);
  });

  it.each(["EXECUTING", "VERIFYING"] as const)("preserves a recorded execution failure when recovering from %s", async (status) => {
    const move = await uploadAndRequestMove();
    const actionId = approval(move).action_id;
    simulateCrashInExecuting(move.task_id!, actionId);
    renameSync(ws("inbox", "report.txt"), ws("inbox", "renamed.txt"));
    mkdirSync(ws("archive"));
    writeFileSync(ws("archive", "report.txt"), REPORT.content);
    core.store.audit("EXECUTION_ERROR", { taskId: move.task_id!, actionId }, { message: "Source file no longer exists." });
    if (status === "VERIFYING") core.store.transition(move.task_id!, "VERIFYING");

    await restart();

    const res = await getTask(core, move.task_id!);
    expect(res.status).toBe("FAILED");
    expect((res.data as ResultData).verified).toBe(false);
    expect(readFileSync(ws("inbox", "renamed.txt"), "utf8")).toBe(REPORT.content);
    expect(readFileSync(ws("archive", "report.txt"), "utf8")).toBe(REPORT.content);
    expect(countEvents(core, "EXECUTION_STARTED", move.task_id!)).toBe(0);
  });

  it("a task interrupted while PROCESSING fails clearly instead of hanging", async () => {
    const t = core.store.tx(() => {
      core.store.ensureConversation(CONV);
      const task = core.store.createTask({ conversationId: CONV, requestId: "r-stuck", userMessage: "hi", attachments: [] });
      core.store.transition(task.id, "PROCESSING");
      return task;
    });
    await restart();
    const res = await getTask(core, t.id);
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("INTERRUPTED");
  });
});

describe("7. GET /v1/conversations restores state", () => {
  it("returns messages oldest-first and tasks newest-first with correct statuses", async () => {
    const move = await uploadAndRequestMove();
    const conv = await getConversation(core, CONV);
    expect(conv.conversation_id).toBe(CONV);
    expect(conv.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(conv.messages[0].attachments[0]).toMatchObject({ name: "report.txt", workspace_path: "inbox/report.txt" });
    expect(conv.tasks.map((t: ConversationTask) => t.response.status)).toEqual(["WAITING_FOR_APPROVAL", "COMPLETED"]);
    expect(conv.tasks[0].response.response_type).toBe("APPROVAL_REQUEST");
    expect(approval(conv.tasks[0].response).action_id).toBe(approval(move).action_id);

    await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    const after = await getConversation(core, CONV);
    expect(after.tasks[0].response.status).toBe("COMPLETED");
    expect(after.messages.at(-1)?.content).toContain("Verified on disk");
  });

  it("returns an empty conversation for an unknown id", async () => {
    const conv = await getConversation(core, "never-used");
    expect(conv.messages).toEqual([]);
    expect(conv.tasks).toEqual([]);
  });
});

describe("8. audit log", () => {
  it("records request, tool call, approval request, decision, execution, verification and result", async () => {
    const move = await uploadAndRequestMove();
    await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    const events = core.store.listAudit(move.task_id!).map((a) => a.event);
    for (const e of [
      "REQUEST_RECEIVED",
      "TOOL_CALLED",
      "APPROVAL_REQUESTED",
      "DECISION_RECORDED",
      "EXECUTION_RESERVED",
      "EXECUTION_STARTED",
      "EXECUTION_FINISHED",
      "VERIFICATION",
      "TASK_COMPLETED",
    ]) {
      expect(events).toContain(e);
    }
    const decision = core.store.listAudit(move.task_id!).find((a) => a.event === "DECISION_RECORDED")!;
    expect(decision.action_id).toBe(approval(move).action_id);
    expect(decision.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is append-only", async () => {
    await sendAndWait(core, CONV, "hi");
    expect(() => core.store.db.prepare("UPDATE audit_log SET event = 'X'").run()).toThrow(/append-only/);
    expect(() => core.store.db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
  });
});

describe("9. execution failure is reported as FAILED", () => {
  it("fails clearly when the destination already has a file with the same name, and overwrites nothing", async () => {
    const move = await uploadAndRequestMove();
    mkdirSync(ws("archive"));
    writeFileSync(ws("archive", "report.txt"), "ORIGINAL ARCHIVE COPY");

    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(res.body.status).toBe("FAILED");
    expect(res.body.response_type).toBe("ERROR");
    expect(res.body.error?.code).toBe("EXECUTION_FAILED");
    expect((res.body.data as ResultData).verified).toBe(false);
    expect(readFileSync(ws("archive", "report.txt"), "utf8")).toBe("ORIGINAL ARCHIVE COPY");
    expect(readFileSync(ws("inbox", "report.txt"), "utf8")).toBe(REPORT.content);
    expect(countEvents(core, "EXECUTION_ERROR", move.task_id!)).toBe(1);
  });

  it("fails clearly when the source disappeared before approval", async () => {
    const move = await uploadAndRequestMove();
    renameSync(ws("inbox", "report.txt"), ws("inbox", "renamed.txt"));
    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");
    expect(res.body.status).toBe("FAILED");
    expect(res.body.error?.code).toBe("EXECUTION_FAILED");
    expect(existsSync(ws("archive", "report.txt"))).toBe(false);
  });

  it.each([REPORT.content, "UNRELATED FILE"])("does not report success after execution failed, even if a destination exists (%s)", async (targetContent) => {
    const move = await uploadAndRequestMove();
    renameSync(ws("inbox", "report.txt"), ws("inbox", "renamed.txt"));
    mkdirSync(ws("archive"));
    writeFileSync(ws("archive", "report.txt"), targetContent);

    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");

    expect(res.body.status).toBe("FAILED");
    expect(res.body.error?.code).toBe("EXECUTION_FAILED");
    expect((res.body.data as ResultData).verified).toBe(false);
    expect(readFileSync(ws("archive", "report.txt"), "utf8")).toBe(targetContent);
    expect(readFileSync(ws("inbox", "renamed.txt"), "utf8")).toBe(REPORT.content);
    expect(countEvents(core, "EXECUTION_ERROR", move.task_id!)).toBe(1);
    expect(countEvents(core, "TASK_COMPLETED", move.task_id!)).toBe(0);
  });

  it("refuses to move content changed since the approval was requested", async () => {
    const move = await uploadAndRequestMove();
    const changed = "X".repeat(REPORT.content.length);
    writeFileSync(ws("inbox", "report.txt"), changed);

    const res = await decide(core, move.task_id!, approval(move).action_id, "APPROVE");

    expect(res.body.status).toBe("FAILED");
    expect(res.body.error?.code).toBe("EXECUTION_FAILED");
    expect((res.body.data as ResultData).verified).toBe(false);
    expect(readFileSync(ws("inbox", "report.txt"), "utf8")).toBe(changed);
    expect(existsSync(ws("archive"))).toBe(false);
  });

  it("refuses legacy approvals without a content fingerprint before changing files", async () => {
    const move = await uploadAndRequestMove();
    const action = core.store.getAction(approval(move).action_id)!;
    const legacyPlan = JSON.parse(action.input);
    delete legacyPlan.source_sha256;
    core.store.db.prepare("UPDATE actions SET input = ? WHERE id = ?").run(JSON.stringify(legacyPlan), action.id);

    const res = await decide(core, move.task_id!, action.id, "APPROVE");

    expect(res.body.status).toBe("FAILED");
    expect(res.body.error?.message).toContain("Send the move request again");
    expect(readFileSync(ws("inbox", "report.txt"), "utf8")).toBe(REPORT.content);
    expect(existsSync(ws("archive"))).toBe(false);
  });
});

describe("10. security: workspace boundary and app token", () => {
  async function withModel(override: Parameters<typeof scriptedModel>[0]) {
    await core.close();
    core = await startCore(env, scriptedModel(override));
  }

  it("rejects read_file outside the workspace ('..', absolute path)", async () => {
    writeFileSync(path.join(env.dir, "secret.txt"), "TOP SECRET");
    for (const p of ["../secret.txt", path.join(env.dir, "secret.txt"), "inbox/../../secret.txt"]) {
      await withModel(() => ({ toolCalls: [{ name: "read_file", input: { path: p } }] }));
      const res = await sendAndWait(core, CONV, "read it");
      expect(res.status).toBe("FAILED");
      expect(res.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
      expect(JSON.stringify(core.store.listAudit())).not.toContain("TOP SECRET");
    }
  });

  it("rejects a link inside the workspace that points outside", async () => {
    const outside = path.join(env.dir, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    // A directory junction needs no admin rights on Windows; on other OSes it is a normal symlink.
    symlinkSync(outside, ws("escape"), "junction");
    await withModel(() => ({ toolCalls: [{ name: "read_file", input: { path: "escape/secret.txt" } }] }));
    const res = await sendAndWait(core, CONV, "read it");
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects a path whose parent directory is a link to outside, even when the final file does not exist", async () => {
    const outside = path.join(env.dir, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    symlinkSync(outside, ws("escape"), "junction");
    await withModel(() => ({ toolCalls: [{ name: "read_file", input: { path: "escape/ghost.txt" } }] }));
    const res = await sendAndWait(core, CONV, "read it");
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects move_file to a destination outside the workspace without asking for approval", async () => {
    await sendAndWait(core, CONV, "لخص لي هذا الملف", REPORT);
    await withModel(() => ({ toolCalls: [{ name: "move_file", input: { source: "inbox/report.txt", destination_dir: "../outside" } }] }));
    const res = await sendAndWait(core, CONV, "move it out");
    expect(res.status).toBe("FAILED");
    expect(res.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(core.store.getActionByTask(res.task_id!)).toBeUndefined();
    expect(existsSync(path.join(env.dir, "outside"))).toBe(false);
  });

  it("rejects tools that are not in the registry", async () => {
    await withModel((req) =>
      req.messages.length === 1 ? { toolCalls: [{ name: "delete_file", input: { path: "inbox/x" } }] } : undefined,
    );
    const res = await sendAndWait(core, CONV, "delete everything");
    expect(core.store.listAudit(res.task_id!).some((a) => a.event === "TOOL_ERROR" && a.detail?.includes("Unknown tool"))).toBe(true);
    expect(countEvents(core, "APPROVAL_REQUESTED")).toBe(0);
  });

  it("rejects every endpoint without a valid token", async () => {
    const mp = multipart(requestPayload(CONV, "hi"));
    const calls = [
      { method: "POST" as const, url: "/v1/messages", headers: { "content-type": mp.contentType }, payload: mp.body },
      { method: "GET" as const, url: "/v1/tasks/x" },
      { method: "POST" as const, url: "/v1/tasks/x/actions/y/decision", payload: { action_id: "y", decision: "APPROVE" } },
      { method: "GET" as const, url: `/v1/conversations/${CONV}` },
    ];
    for (const call of calls) {
      for (const authorization of [undefined, "Bearer wrong-token", "test-app-token"]) {
        const res = await core.app.inject({
          ...call,
          headers: { ...(call.headers ?? {}), ...(authorization ? { authorization } : {}) },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe("UNAUTHORIZED");
      }
    }
    expect(core.store.listAudit().some((a) => a.event === "REQUEST_RECEIVED")).toBe(false);
    // Sanity: the right token works.
    expect((await core.app.inject({ method: "GET", url: "/v1/tasks/x", headers: AUTH })).statusCode).toBe(404);
  });
});
