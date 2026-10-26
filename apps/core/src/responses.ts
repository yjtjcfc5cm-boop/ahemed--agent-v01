import {
  CONTRACT_VERSION,
  type AgentError,
  type AgentResponse,
  type ApprovalRequest,
  type Attachment,
  type ConversationResponse,
  type ErrorCode,
  type PlanStep,
  type ResultData,
  type TaskEvent,
  type TaskEventsResponse,
} from "@ahmed/contract";
import type { ActionRow, AuditRow, Store, TaskRow } from "./store.js";

export function errorResponse(code: ErrorCode, message: string, extra: Partial<AgentResponse> = {}): AgentResponse {
  return {
    contract_version: CONTRACT_VERSION,
    request_id: null,
    response_type: "ERROR",
    task_id: null,
    status: null,
    message,
    data: null,
    error: { code, message },
    ...extra,
  };
}

/** v0.2: the plan an approval unlocks — the real v0.1 write pipeline, in order. */
function planFor(a: ActionRow): PlanStep[] {
  return [
    { n: 1, label: "Ahmed approves this change", tool: a.tool, risk_level: a.risk_level },
    { n: 2, label: `Core executes ${a.operation} inside the workspace`, tool: a.tool, risk_level: a.risk_level },
    { n: 3, label: "Core verifies the result on disk and reports what really happened" },
  ];
}

export function approvalData(a: ActionRow): ApprovalRequest {
  return {
    action_id: a.id,
    idempotency_key: a.idempotency_key,
    operation: a.operation,
    description: a.description,
    tool: a.tool,
    affected_resource: a.affected_resource,
    destination: a.destination,
    risk_level: a.risk_level,
    expires_at: a.expires_at,
    plan: planFor(a),
  };
}

function resultData(task: TaskRow, a: ActionRow | undefined): ResultData | null {
  // v0.2: simulated is always explicit. No simulated execution path exists today, so false.
  const honesty = { simulated: false as const, ...(task.cost_usd !== null ? { cost_usd: task.cost_usd } : {}) };
  if (a) {
    return {
      action_id: a.id,
      tool: a.tool,
      affected_resource: a.affected_resource,
      destination: a.destination ?? undefined,
      decision: a.decision ?? undefined,
      verified: a.verified === null ? undefined : a.verified === 1,
      ...honesty,
    };
  }
  return task.used_tool ? { tool: task.used_tool, ...honesty } : null;
}

/** Builds the contract response for a task purely from what is stored in SQLite. */
export function taskResponse(store: Store, task: TaskRow): AgentResponse {
  const action = store.getActionByTask(task.id);
  const error: AgentError | null = task.error_code
    ? { code: task.error_code, message: task.error_message ?? task.error_code }
    : null;
  const base = {
    contract_version: CONTRACT_VERSION,
    request_id: task.request_id,
    task_id: task.id,
    status: task.status,
    message: task.result_message,
    error,
  };
  switch (task.status) {
    case "WAITING_FOR_APPROVAL":
      return { ...base, response_type: "APPROVAL_REQUEST", data: approvalData(action!) };
    case "COMPLETED":
      return task.used_tool
        ? { ...base, response_type: "RESULT", data: resultData(task, action) }
        : { ...base, response_type: "MESSAGE", data: null };
    case "REJECTED":
      return { ...base, response_type: "RESULT", data: resultData(task, action) };
    case "FAILED":
      return { ...base, response_type: "ERROR", data: resultData(task, action) };
    default: {
      const attachments = JSON.parse(task.attachments) as Attachment[];
      return { ...base, response_type: "TASK_STATUS", data: attachments.length ? { attachments } : null };
    }
  }
}

// ---------- v0.2: task event stream ----------

export function taskEvent(a: AuditRow): TaskEvent {
  return {
    seq: a.id,
    ts: a.ts,
    type: a.event,
    task_id: a.task_id,
    action_id: a.action_id,
    detail: a.detail ? JSON.parse(a.detail) : null,
  };
}

export function taskEventsResponse(taskId: string, rows: AuditRow[]): TaskEventsResponse {
  return { contract_version: CONTRACT_VERSION, task_id: taskId, events: rows.map(taskEvent) };
}

export function conversationResponse(store: Store, conversationId: string): ConversationResponse {
  return {
    contract_version: CONTRACT_VERSION,
    conversation_id: conversationId,
    messages: store.listMessages(conversationId).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      attachments: JSON.parse(m.attachments) as Attachment[],
      task_id: m.task_id,
      created_at: m.created_at,
    })),
    tasks: store.listTasks(conversationId).map((t) => ({
      task_id: t.id,
      user_message: t.user_message,
      created_at: t.created_at,
      updated_at: t.updated_at,
      response: taskResponse(store, t),
    })),
  };
}
