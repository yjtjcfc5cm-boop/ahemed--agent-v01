import { FINAL_STATUSES, type Attachment, type DecisionValue, type ErrorCode } from "@ahmed/contract";
import { ModelError, type ModelBlock, type ModelClient, type ModelMessage, type ModelUsage } from "./model.js";
import type { ActionRow, Store, TaskRow } from "./store.js";
import { TOOL_REGISTRY, executeMove, getTool, planMove, readFileTool, verifyMove, type MovePlan } from "./tools.js";
import { ToolError, type Workspace } from "./workspace.js";

export const APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_MODEL_STEPS = 6;

/** Tool errors that end the task immediately instead of being handed back to the model. */
const FATAL_TOOL_ERRORS: ErrorCode[] = ["PATH_OUTSIDE_WORKSPACE", "UNSUPPORTED_FILE_TYPE"];

const SYSTEM_PROMPT = `You are AHMED Agent, Ahmed's personal assistant, running on Ahmed's computer.
You work only on files inside a single workspace folder. All paths are relative to the workspace root
(for example inbox/report.pdf). Files Ahmed uploads from his phone are stored in inbox/.

Tools:
- read_file: read a .txt, .md or .pdf file.
- move_file: move a file to another folder in the workspace. The system asks Ahmed to approve every move
  before anything happens, so just call the tool when he asks for a move; do not ask for confirmation yourself.

When Ahmed refers to "the file" or "this file", he means the most recently attached file in the conversation.
To summarize a file, read it first with read_file, then give a clear, concise summary.
Reply in the same language Ahmed writes in. Keep answers short and practical.`;

export type DecisionOutcome =
  | { kind: "ok"; task: TaskRow }
  | { kind: "not_found" }
  | { kind: "conflict"; task: TaskRow; recorded: string }
  | { kind: "expired"; task: TaskRow };

export type InterruptOutcome =
  | { kind: "ok"; task: TaskRow }
  | { kind: "not_found" }
  | { kind: "already_final"; task: TaskRow }
  | { kind: "locked"; task: TaskRow };

/** USD prices per 1M tokens. Without both values no cost is computed — never a guess. */
export interface TokenPricing {
  inputPer1M?: number;
  outputPer1M?: number;
}

/**
 * The Agent Core: owns decisions, state transitions, permissions and audit.
 * Every state change goes through Store.transition (explicit state machine, persisted in SQLite).
 */
export class Agent {
  /** Tasks Ahmed asked to stop while a model call is in flight; honored between steps. */
  private readonly interruptionRequested = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly ws: Workspace,
    private readonly model: ModelClient,
    private readonly approvalTtlMs: number = APPROVAL_TTL_MS,
    private readonly pricing: TokenPricing = {},
  ) {}

  private costOf(usage: { in: number; out: number } | null): number | null {
    if (!usage || this.pricing.inputPer1M === undefined || this.pricing.outputPer1M === undefined) return null;
    const usd = (usage.in / 1e6) * this.pricing.inputPer1M + (usage.out / 1e6) * this.pricing.outputPer1M;
    return Math.round(usd * 1e6) / 1e6;
  }

  // ================= processing a new message =================

  async processTask(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.status !== "RECEIVED") return;
    this.store.transition(taskId, "PROCESSING");
    try {
      await this.runModelLoop(task);
    } catch (err) {
      const code: ErrorCode = err instanceof ModelError ? "MODEL_ERROR" : "INTERNAL";
      this.store.audit("ERROR", { taskId }, { code, message: (err as Error).message });
      this.failIfProcessing(taskId, code, (err as Error).message);
    }
  }

  private async runModelLoop(task: TaskRow): Promise<void> {
    const messages = this.history(task);
    const tools = Object.values(TOOL_REGISTRY).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    let usedTool: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    const usage = (): { in: number; out: number } | null => (sawUsage ? { in: inputTokens, out: outputTokens } : null);

    for (let step = 0; step < MAX_MODEL_STEPS; step++) {
      const turn = await this.model.complete({ system: SYSTEM_PROMPT, messages, tools });
      if (turn.usage) {
        sawUsage = true;
        inputTokens += turn.usage.input_tokens;
        outputTokens += turn.usage.output_tokens;
      }
      this.store.audit("MODEL_RESPONDED", { taskId: task.id }, {
        tool_calls: turn.toolCalls.map((c) => c.name),
        ...(turn.usage ? { usage: turn.usage } : {}),
      });

      // An interrupt lands here, between steps — never in the middle of a write.
      if (this.interruptionRequested.delete(task.id)) {
        this.fail(task.id, "INTERRUPTED", "Interrupted by Ahmed.", usage());
        return;
      }

      if (turn.toolCalls.length === 0) {
        this.complete(task, turn.text || "(no answer)", usedTool, usage());
        return;
      }

      messages.push(turn.assistant);
      const results: ModelBlock[] = [];
      for (const call of turn.toolCalls) {
        this.store.audit("TOOL_CALLED", { taskId: task.id }, { tool: call.name, input: call.input });
        const spec = getTool(call.name);
        try {
          if (!spec) throw new ToolError("TOOL_ERROR", `Unknown tool "${call.name}".`);
          if (spec.risk === "write") {
            // The registry says this changes something: never run it here, ask Ahmed first.
            const plan = planMove(this.ws, call.input);
            this.requestApproval(task, spec.name, plan, turn.text, usage());
            return;
          }
          const out = await readFileTool(this.ws, call.input);
          usedTool = spec.name;
          this.store.audit("TOOL_RESULT", { taskId: task.id }, { tool: spec.name, path: out.path, chars: out.content.length });
          results.push({ type: "tool_result", tool_use_id: call.id, content: out.content });
        } catch (err) {
          if (!(err instanceof ToolError)) throw err;
          this.store.audit("TOOL_ERROR", { taskId: task.id }, { tool: call.name, code: err.code, message: err.message });
          if (FATAL_TOOL_ERRORS.includes(err.code)) {
            this.fail(task.id, err.code, err.message);
            return;
          }
          results.push({ type: "tool_result", tool_use_id: call.id, content: err.message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    this.fail(task.id, "MODEL_ERROR", "The agent did not finish within the step limit.", usage());
  }

  /** Conversation history up to and including this task's user message. */
  private history(task: TaskRow): ModelMessage[] {
    const rows = this.store.listMessages(task.conversation_id);
    const end = rows.findIndex((m) => m.task_id === task.id && m.role === "user");
    const out: ModelMessage[] = [];
    for (const m of end >= 0 ? rows.slice(0, end + 1) : rows) {
      let text = m.content;
      if (m.role === "user") {
        const files = (JSON.parse(m.attachments) as Attachment[]).filter((a) => a.workspace_path);
        const note = files.map((a) => `[Attached file "${a.name}" stored at workspace path: ${a.workspace_path}]`).join("\n");
        text = [text || (files.length ? "(Ahmed uploaded a file.)" : ""), note].filter(Boolean).join("\n");
      }
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.role === m.role) last.content = `${last.content as string}\n\n${text}`;
      else out.push({ role: m.role, content: text });
    }
    while (out.length && out[0].role !== "user") out.shift();
    return out;
  }

  private complete(task: TaskRow, text: string, usedTool: string | null, usage: { in: number; out: number } | null): void {
    this.store.tx(() => {
      this.store.transition(task.id, "COMPLETED", {
        result_message: text,
        used_tool: usedTool,
        ...(usage ? { input_tokens: usage.in, output_tokens: usage.out, cost_usd: this.costOf(usage) } : {}),
      });
      this.store.addMessage({ conversationId: task.conversation_id, role: "assistant", content: text, taskId: task.id });
      this.store.audit("TASK_COMPLETED", { taskId: task.id }, {
        used_tool: usedTool,
        ...(usage ? { usage, cost_usd: this.costOf(usage) } : {}),
      });
    });
  }

  private requestApproval(
    task: TaskRow,
    tool: string,
    plan: MovePlan,
    modelText: string,
    usage: { in: number; out: number } | null,
  ): void {
    const description = `Move file ${plan.source} to folder ${plan.destination_dir} (new path: ${plan.target}).`;
    const expiresAt = new Date(this.store.clock().getTime() + this.approvalTtlMs).toISOString();
    this.store.tx(() => {
      const action = this.store.createAction({
        task_id: task.id,
        tool,
        operation: tool,
        description,
        risk_level: TOOL_REGISTRY[tool].risk,
        affected_resource: plan.source,
        destination: plan.target,
        input: JSON.stringify(plan),
        expires_at: expiresAt,
      });
      this.store.transition(task.id, "WAITING_FOR_APPROVAL", {
        used_tool: tool,
        result_message: description,
        ...(usage ? { input_tokens: usage.in, output_tokens: usage.out, cost_usd: this.costOf(usage) } : {}),
      });
      this.store.audit("APPROVAL_REQUESTED", { taskId: task.id, actionId: action.id }, {
        idempotency_key: action.idempotency_key,
        plan,
        expires_at: expiresAt,
      });
      this.store.addMessage({
        conversationId: task.conversation_id,
        role: "assistant",
        content: [modelText, `Waiting for your approval: ${description}`].filter(Boolean).join("\n"),
        taskId: task.id,
      });
    });
  }

  private fail(taskId: string, code: ErrorCode, message: string, usage: { in: number; out: number } | null = null): void {
    this.store.tx(() => {
      const task = this.store.transition(taskId, "FAILED", {
        error_code: code,
        error_message: message,
        ...(usage ? { input_tokens: usage.in, output_tokens: usage.out, cost_usd: this.costOf(usage) } : {}),
      });
      this.store.addMessage({ conversationId: task.conversation_id, role: "assistant", content: `Error: ${message}`, taskId });
      this.store.audit("TASK_FAILED", { taskId }, { code, message });
    });
  }

  private failIfProcessing(taskId: string, code: ErrorCode, message: string): void {
    const task = this.store.getTask(taskId);
    if (task && (task.status === "PROCESSING" || task.status === "RECEIVED")) this.fail(taskId, code, message);
  }

  // ================= approval decisions =================

  decide(taskId: string, actionId: string, decision: DecisionValue): DecisionOutcome {
    const action = this.store.getAction(actionId);
    if (!action || action.task_id !== taskId) return { kind: "not_found" };

    // Validate and persist one acceptance time, even if the clock crosses expiry during the transaction.
    const decidedAt = this.store.now();
    if (action.decision === null && this.isExpired(action, Date.parse(decidedAt))) this.expire(action);
    const current = this.store.getAction(actionId)!;
    const task = () => this.store.getTask(taskId)!;

    if (current.decision !== null) {
      if (current.decision === "EXPIRED") return { kind: "expired", task: task() };
      if (current.decision === decision) {
        this.store.audit("DECISION_REPEATED", { taskId, actionId }, { decision });
        return { kind: "ok", task: task() };
      }
      this.store.audit("DECISION_CONFLICT", { taskId, actionId }, { recorded: current.decision, received: decision });
      return { kind: "conflict", task: task(), recorded: current.decision };
    }

    if (decision === "REJECT") {
      this.store.tx(() => {
        if (!this.store.recordDecision(actionId, "REJECT", decidedAt)) throw new Error("decision race");
        this.store.audit("DECISION_RECORDED", { taskId, actionId }, { decision });
        this.store.transition(taskId, "REJECTED", { result_message: "Rejected. Nothing was changed." });
        this.store.addMessage({
          conversationId: task().conversation_id,
          role: "assistant",
          content: `Rejected: ${current.description} Nothing was changed.`,
          taskId,
        });
        this.store.audit("TASK_REJECTED", { taskId, actionId });
      });
      return { kind: "ok", task: task() };
    }

    // APPROVE: record the decision and reserve the execution in ONE transaction.
    // The UNIQUE idempotency_key in `executions` plus the compare-and-set on the task status
    // guarantee that only one request can ever reach executeAction for this action.
    this.store.tx(() => {
      if (!this.store.recordDecision(actionId, "APPROVE", decidedAt)) throw new Error("decision race");
      this.store.audit("DECISION_RECORDED", { taskId, actionId }, { decision });
      this.store.transition(taskId, "APPROVED");
      this.store.insertExecution(current);
      this.store.transition(taskId, "EXECUTING");
      this.store.audit("EXECUTION_RESERVED", { taskId, actionId }, { idempotency_key: current.idempotency_key });
    });
    this.executeAction(actionId);
    return { kind: "ok", task: task() };
  }

  private isExpired(action: ActionRow, now = this.store.clock().getTime()): boolean {
    return now >= Date.parse(action.expires_at);
  }

  private expire(action: ActionRow): void {
    this.store.tx(() => {
      if (!this.store.recordDecision(action.id, "EXPIRED")) return;
      const message = "The approval request expired after 15 minutes. Nothing was changed.";
      const task = this.store.transition(action.task_id, "REJECTED", {
        result_message: message,
        error_code: "APPROVAL_EXPIRED",
        error_message: message,
      });
      this.store.addMessage({ conversationId: task.conversation_id, role: "assistant", content: message, taskId: task.id });
      this.store.audit("APPROVAL_EXPIRED", { taskId: action.task_id, actionId: action.id });
    });
  }

  /** Rejects every pending approval whose time is up. Called on startup and before reads. */
  expireStale(): void {
    for (const action of this.store.listPendingActions()) {
      if (this.isExpired(action)) this.expire(action);
    }
  }

  // ================= execution & verification =================

  private executeAction(actionId: string): void {
    const action = this.store.getAction(actionId)!;
    const task = this.store.getTask(action.task_id)!;
    const execution = this.store.getExecution(action.idempotency_key);
    // A write runs only with a valid, unexpired approval matching task_id, action_id and idempotency_key.
    const valid =
      task.status === "EXECUTING" &&
      action.decision === "APPROVE" &&
      action.decided_at !== null &&
      Date.parse(action.decided_at) < Date.parse(action.expires_at) &&
      execution !== undefined &&
      execution.action_id === action.id &&
      execution.task_id === task.id;
    if (!valid) throw new Error(`Refusing to execute action ${actionId}: no valid approval/reservation.`);

    const plan = JSON.parse(action.input) as MovePlan;
    this.store.audit("EXECUTION_STARTED", { taskId: task.id, actionId }, { tool: action.tool, plan });
    let execError: string | null = null;
    try {
      executeMove(this.ws, plan);
      this.store.audit("EXECUTION_FINISHED", { taskId: task.id, actionId });
    } catch (err) {
      execError = (err as Error).message;
      this.store.audit("EXECUTION_ERROR", { taskId: task.id, actionId }, { message: execError });
    }
    this.store.transition(task.id, "VERIFYING");
    this.verify(action, execError);
  }

  /** Looks at the real disk and decides COMPLETED or FAILED. Never re-executes. */
  private verify(action: ActionRow, execError: string | null): void {
    const plan = JSON.parse(action.input) as MovePlan;
    // Read the durable result so a restart cannot turn a known failed execution into success.
    const executionFailed = this.store.listAudit(action.task_id).some(
      (event) => event.action_id === action.id && event.event === "EXECUTION_ERROR",
    );
    let verified = false;
    try {
      verified = !executionFailed && verifyMove(this.ws, plan);
    } catch {
      verified = false;
    }
    this.store.tx(() => {
      this.store.setVerified(action.id, verified);
      this.store.audit("VERIFICATION", { taskId: action.task_id, actionId: action.id }, { verified, target: plan.target });
      const task = this.store.getTask(action.task_id)!;
      if (verified) {
        const message = `Done: moved ${plan.source} to ${plan.target}. Verified on disk.`;
        this.store.transition(task.id, "COMPLETED", { result_message: message });
        this.store.addMessage({ conversationId: task.conversation_id, role: "assistant", content: message, taskId: task.id });
        this.store.audit("TASK_COMPLETED", { taskId: task.id, actionId: action.id }, { verified });
      } else {
        const message = `Move verification failed: ${execError ?? "could not confirm the approved file at the destination."}`;
        this.store.transition(task.id, "FAILED", { error_code: "EXECUTION_FAILED", error_message: message });
        this.store.addMessage({ conversationId: task.conversation_id, role: "assistant", content: `Error: ${message}`, taskId: task.id });
        this.store.audit("TASK_FAILED", { taskId: task.id, actionId: action.id }, { code: "EXECUTION_FAILED", message });
      }
    });
  }

  // ================= interruption (v0.2) =================

  /**
   * Ahmed can stop a task. Honored where stopping is safe by construction:
   *  - RECEIVED/PROCESSING: the model loop sees the flag between steps and fails INTERRUPTED.
   *  - WAITING_FOR_APPROVAL: the pending action is closed and the task ends REJECTED, nothing executed.
   *  - APPROVED/EXECUTING/VERIFYING: a write is in flight; it is never killed mid-write (same rule
   *    as restart recovery) — reported "locked" so the caller can say so honestly.
   */
  interrupt(taskId: string): InterruptOutcome {
    const task = this.store.getTask(taskId);
    if (!task) return { kind: "not_found" };
    if (FINAL_STATUSES.includes(task.status)) return { kind: "already_final", task };

    if (task.status === "APPROVED" || task.status === "EXECUTING" || task.status === "VERIFYING") {
      this.store.audit("INTERRUPT_IGNORED", { taskId }, { status: task.status });
      return { kind: "locked", task };
    }

    if (task.status === "WAITING_FOR_APPROVAL") {
      const action = this.store.getActionByTask(taskId);
      this.store.tx(() => {
        if (action && action.decision === null) this.store.recordDecision(action.id, "REJECT");
        this.store.audit("TASK_INTERRUPTED", { taskId, actionId: action?.id }, { at: task.status });
        const t = this.store.transition(taskId, "REJECTED", {
          result_message: "Interrupted while waiting for approval. Nothing was changed.",
          error_code: "INTERRUPTED",
          error_message: "Interrupted by Ahmed before any execution.",
        });
        this.store.addMessage({
          conversationId: t.conversation_id,
          role: "assistant",
          content: "Interrupted. Nothing was changed.",
          taskId,
        });
      });
      return { kind: "ok", task: this.store.getTask(taskId)! };
    }

    // RECEIVED or PROCESSING
    this.store.audit("INTERRUPT_REQUESTED", { taskId }, { at: task.status });
    if (task.status === "RECEIVED") {
      this.fail(taskId, "INTERRUPTED", "Interrupted before processing started.");
    } else {
      this.interruptionRequested.add(taskId);
    }
    return { kind: "ok", task: this.store.getTask(taskId)! };
  }

  // ================= startup recovery =================

  /**
   * Runs once when the Core starts. Tasks stuck in EXECUTING are moved to VERIFYING and checked
   * against the disk; they are never executed again.
   */
  recover(): void {
    for (const task of this.store.listTasksByStatus("EXECUTING")) {
      const action = this.store.getActionByTask(task.id);
      if (!action) {
        this.store.audit("RECOVERY", { taskId: task.id }, { found: "EXECUTING", rerun: false, reason: "missing_action" });
        this.fail(task.id, "INTERRUPTED", "The Core restarted while this task was executing. Please send it again.");
        continue;
      }
      this.store.audit("RECOVERY", { taskId: task.id, actionId: action.id }, { found: "EXECUTING", rerun: false });
      this.store.transition(task.id, "VERIFYING");
      this.verify(action, "execution was interrupted by a Core restart and is not retried automatically.");
    }
    for (const task of this.store.listTasksByStatus("VERIFYING")) {
      const action = this.store.getActionByTask(task.id);
      if (!action) {
        this.store.audit("RECOVERY", { taskId: task.id }, { found: "VERIFYING", rerun: false, reason: "missing_action" });
        this.fail(task.id, "INTERRUPTED", "The Core restarted while this task was verifying. Please send it again.");
        continue;
      }
      this.store.audit("RECOVERY", { taskId: task.id, actionId: action.id }, { found: "VERIFYING", rerun: false });
      this.verify(action, "execution was interrupted by a Core restart and is not retried automatically.");
    }
    for (const status of ["RECEIVED", "PROCESSING"] as const) {
      for (const task of this.store.listTasksByStatus(status)) {
        this.store.audit("RECOVERY", { taskId: task.id }, { found: status });
        this.fail(task.id, "INTERRUPTED", "The Core restarted while this message was being processed. Please send it again.");
      }
    }
    this.expireStale();
  }
}
