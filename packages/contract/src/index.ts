// Mirrors V0_CONTRACT.md field-for-field. Change both together.

export const CONTRACT_VERSION = "0.2" as const;
export type ContractVersion = typeof CONTRACT_VERSION;

/**
 * Request versions the Core still accepts. v0.1 clients keep working unchanged;
 * every response carries the Core's own CONTRACT_VERSION ("0.2").
 */
export const ACCEPTED_REQUEST_VERSIONS = ["0.1", "0.2"] as const;

export type InputType = "text" | "file";

export interface Attachment {
  name: string;
  mime_type?: string;
  size_bytes?: number;
  /** Set by the Core only: path relative to WORKSPACE_ROOT. */
  workspace_path?: string;
}

export interface ClientContext {
  platform?: string;
  app_version?: string;
  locale?: string;
}

export interface AgentRequest {
  contract_version: ContractVersion;
  request_id: string;
  conversation_id: string;
  input_type: InputType;
  message: string;
  attachments: Attachment[];
  client_context?: ClientContext;
}

export const TASK_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "REJECTED",
  "EXECUTING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses after which nothing else will happen to the task. */
export const FINAL_STATUSES: readonly TaskStatus[] = ["COMPLETED", "FAILED", "REJECTED"];

export type ResponseType = "MESSAGE" | "TASK_STATUS" | "APPROVAL_REQUEST" | "RESULT" | "ERROR";

export type RiskLevel = "read" | "write";

export type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "APPROVAL_EXPIRED"
  | "UNSUPPORTED_FILE_TYPE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "TOOL_ERROR"
  | "EXECUTION_FAILED"
  | "MODEL_ERROR"
  | "INTERRUPTED"
  | "INTERNAL";

export interface AgentError {
  code: ErrorCode;
  message: string;
}

/** One ordered step of what will happen if an approval is granted (v0.2). */
export interface PlanStep {
  n: number;
  label: string;
  tool?: string;
  risk_level?: RiskLevel;
}

export interface ApprovalRequest {
  action_id: string;
  idempotency_key: string;
  operation: string;
  description: string;
  tool: string;
  affected_resource: string;
  destination: string | null;
  risk_level: RiskLevel;
  expires_at: string;
  /** v0.2: the plan this approval unlocks, in execution order. */
  plan?: PlanStep[];
}

export type DecisionValue = "APPROVE" | "REJECT";

export interface ResultData {
  action_id?: string;
  tool?: string;
  affected_resource?: string;
  destination?: string;
  decision?: DecisionValue | "EXPIRED";
  verified?: boolean;
  /**
   * v0.2 — honesty flag. false: the reported change really happened (verified by the Core).
   * true: preview/simulation only. No simulated execution paths exist yet; any future one
   * MUST set this to true. The UI renders REAL on false and DEMO on true.
   */
  simulated?: boolean;
  /** v0.2: USD cost of model tokens for this task; present only when pricing is configured. */
  cost_usd?: number;
}

export interface TaskStatusData {
  attachments?: Attachment[];
}

export type ResponseData = ApprovalRequest | ResultData | TaskStatusData;

export interface AgentResponse {
  contract_version: ContractVersion;
  request_id: string | null;
  response_type: ResponseType;
  task_id: string | null;
  status: TaskStatus | null;
  message: string | null;
  data: ResponseData | null;
  error: AgentError | null;
}

export interface ApprovalDecision {
  action_id: string;
  decision: DecisionValue;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: Attachment[];
  task_id: string | null;
  created_at: string;
}

export interface ConversationTask {
  task_id: string;
  user_message: string;
  created_at: string;
  updated_at: string;
  response: AgentResponse;
}

export interface ConversationResponse {
  contract_version: ContractVersion;
  conversation_id: string;
  messages: ConversationMessage[];
  tasks: ConversationTask[];
}

// ---------- v0.2: task event stream ----------

/**
 * One entry of a task's event stream. The stream is the task-scoped view of the
 * append-only audit trail — the same rows, exposed live. `type` is the audit event
 * name (e.g. STATUS_CHANGED, MODEL_RESPONDED, TOOL_CALLED, APPROVAL_REQUESTED,
 * DECISION_RECORDED, EXECUTION_STARTED, EXECUTION_FINISHED, EXECUTION_ERROR,
 * VERIFICATION, TASK_COMPLETED, TASK_FAILED, TASK_INTERRUPTED, INTERRUPT_IGNORED).
 */
export interface TaskEvent {
  seq: number;
  ts: string;
  type: string;
  task_id: string | null;
  action_id: string | null;
  detail: unknown;
}

export interface TaskEventsResponse {
  contract_version: ContractVersion;
  task_id: string;
  events: TaskEvent[];
}
