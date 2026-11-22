import type {
  ActionRecord,
  AssignmentRecord,
  ExtensionPolicy,
  IssueDraftSnapshot,
  MemoryRecord,
  PlanBudget,
  PlanDiff,
  PlanRecord,
  PlanStepRecord,
  PlanStepSpec,
  PlanView,
  ProjectBinding,
  ScheduleRecord,
  TaskInputRecord,
  TaskRecord,
  TaskStatus,
} from "../domain/types.ts";
import type {
  PluginLifecycleResult,
  PluginView,
} from "../plugins/types.ts";
import type { SkillMetadata } from "../plugins/skills-contract.ts";

export class ClientApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export interface ClientApiOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface TaskDetail {
  task: TaskRecord;
  assignments: AssignmentRecord[];
  actions: ActionRecord[];
  inputs: TaskInputRecord[];
}

export interface ApiEvent {
  cursor: number;
  event: string;
  subjectType?: string;
  subjectId?: string;
  traceId: string;
  occurredAt: string;
}

export interface ClientTokenView {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

/**
 * Small dependency-free TypeScript client for the local /api/v1 surface.
 * The CLI uses this class; a future TUI can reuse it unchanged.
 */
export class ClientApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClientApiOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async health(): Promise<{ ok: boolean; apiVersion: number; ownerId: string }> {
    return this.#request("/health");
  }

  async status(): Promise<Record<string, unknown>> {
    return this.#request("/status");
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return this.#request("/diagnostics");
  }

  async usage(): Promise<Record<string, unknown>> {
    return this.#request("/usage");
  }

  async listPlugins(): Promise<PluginView[]> {
    const result = await this.#request<{ plugins: PluginView[] }>("/plugins");
    return result.plugins;
  }

  async getPlugin(id: string): Promise<PluginView> {
    const result = await this.#request<{ plugin: PluginView }>(
      `/plugins/${encodeURIComponent(id)}`,
    );
    return result.plugin;
  }

  async enablePlugin(id: string): Promise<PluginLifecycleResult> {
    return this.#request(`/plugins/${encodeURIComponent(id)}/enable`, {
      method: "POST",
    });
  }

  async disablePlugin(id: string): Promise<PluginLifecycleResult> {
    return this.#request(`/plugins/${encodeURIComponent(id)}/disable`, {
      method: "POST",
    });
  }

  async listSkills(): Promise<{ available: boolean; skills: SkillMetadata[] }> {
    return this.#request("/skills");
  }

  async listProjects(status?: "active" | "revoked"): Promise<ProjectBinding[]> {
    const result = await this.#request<{ projects: ProjectBinding[] }>("/projects", {
      query: { status },
    });
    return result.projects;
  }

  async getProject(id: string): Promise<ProjectBinding> {
    const result = await this.#request<{ project: ProjectBinding }>(
      `/projects/${encodeURIComponent(id)}`,
    );
    return result.project;
  }

  async bindProject(input: {
    projectKey: string;
    repositoryId: number;
    repositoryFullName: string;
    defaultBranch?: string;
    credentialRef?: string;
    allowedPlanPaths?: string[];
  }): Promise<{ project: ProjectBinding; created: boolean }> {
    return this.#request("/projects", { method: "POST", body: input });
  }

  async unbindProject(id: string): Promise<{
    project: ProjectBinding;
    changed: boolean;
  }> {
    return this.#request(`/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async listDrafts(options: {
    status?: IssueDraftSnapshot["status"];
    project?: string;
  } = {}): Promise<IssueDraftSnapshot[]> {
    const result = await this.#request<{ drafts: IssueDraftSnapshot[] }>("/drafts", {
      query: { status: options.status, project: options.project },
    });
    return result.drafts;
  }

  async getDraft(id: string): Promise<IssueDraftSnapshot> {
    const result = await this.#request<{ draft: IssueDraftSnapshot }>(
      `/drafts/${encodeURIComponent(id)}`,
    );
    return result.draft;
  }

  async rejectDraft(id: string): Promise<IssueDraftSnapshot> {
    const result = await this.#request<{ draft: IssueDraftSnapshot }>(
      `/drafts/${encodeURIComponent(id)}/reject`,
      { method: "POST" },
    );
    return result.draft;
  }

  async listPlans(options: {
    parentTaskId?: string;
    status?: PlanRecord["status"];
    limit?: number;
  } = {}): Promise<PlanRecord[]> {
    const result = await this.#request<{ plans: PlanRecord[] }>("/plans", {
      query: {
        task: options.parentTaskId,
        status: options.status,
        limit: options.limit,
      },
    });
    return result.plans;
  }

  async getPlan(id: string): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}`);
  }

  async createPlan(
    parentTaskId: string,
    input: { steps: PlanStepSpec[]; budget?: Partial<PlanBudget> },
  ): Promise<PlanView> {
    return this.#request("/plans", {
      method: "POST",
      body: { parentTaskId, ...input },
    });
  }

  async revisePlan(
    id: string,
    input: { steps: PlanStepSpec[]; budget?: Partial<PlanBudget> },
  ): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}/revise`, {
      method: "POST",
      body: input,
    });
  }

  async replanPlan(
    id: string,
    input: {
      steps: PlanStepSpec[];
      budget?: Partial<PlanBudget>;
      stopOpenSteps?: boolean;
    },
  ): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}/replan`, {
      method: "POST",
      body: input,
    });
  }

  async activatePlan(id: string): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}/activate`, {
      method: "POST",
    });
  }

  async pausePlan(id: string): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}/pause`, {
      method: "POST",
    });
  }

  async resumePlan(id: string): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}/resume`, {
      method: "POST",
    });
  }

  async cancelPlan(id: string): Promise<PlanView> {
    return this.#request(`/plans/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
  }

  async planDiff(
    id: string,
    options: { from?: number; to?: number } = {},
  ): Promise<PlanDiff> {
    const result = await this.#request<{ diff: PlanDiff }>(
      `/plans/${encodeURIComponent(id)}/diff`,
      { query: { from: options.from, to: options.to } },
    );
    return result.diff;
  }

  async listTasks(options: { status?: TaskStatus; limit?: number } = {}): Promise<TaskRecord[]> {
    const result = await this.#request<{ tasks: TaskRecord[] }>("/tasks", {
      query: { status: options.status, limit: options.limit },
    });
    return result.tasks;
  }

  async getTask(id: string): Promise<TaskDetail> {
    return this.#request(`/tasks/${encodeURIComponent(id)}`);
  }

  async createTask(input: {
    goal: string;
    completionCriteria: string;
    mandate?: TaskRecord["mandate"];
    extensionPolicy?: ExtensionPolicy;
    priority?: number;
    deadline?: string;
  }, idempotencyKey: string): Promise<TaskRecord> {
    const result = await this.#request<{ task: TaskRecord }>("/tasks", {
      method: "POST",
      body: input,
      idempotencyKey,
    });
    return result.task;
  }

  async cancelTask(id: string): Promise<TaskRecord> {
    const result = await this.#request<{ task: TaskRecord }>(
      `/tasks/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
    );
    return result.task;
  }

  async reviseTask(
    id: string,
    changes: {
      expectedRevision: number;
      goal?: string;
      completionCriteria?: string;
      mandate?: TaskRecord["mandate"];
      priority?: number;
    },
  ): Promise<TaskRecord> {
    const result = await this.#request<{ task: TaskRecord }>(
      `/tasks/${encodeURIComponent(id)}/revise`,
      { method: "POST", body: changes },
    );
    return result.task;
  }

  async supplementTask(id: string, text: string, idempotencyKey: string): Promise<{
    input: TaskInputRecord;
    task: TaskRecord;
  }> {
    return this.#request(`/tasks/${encodeURIComponent(id)}/supplement`, {
      method: "POST",
      body: { text },
      idempotencyKey,
    });
  }

  async listApprovals(): Promise<ActionRecord[]> {
    const result = await this.#request<{ approvals: ActionRecord[] }>("/approvals");
    return result.approvals;
  }

  async getApproval(id: string): Promise<ActionRecord> {
    const result = await this.#request<{ approval: ActionRecord }>(
      `/approvals/${encodeURIComponent(id)}`,
    );
    return result.approval;
  }

  async approve(
    id: string,
    binding: { nonce: string; argsHash: string; taskRevision: number },
  ): Promise<ActionRecord> {
    const result = await this.#request<{ action: ActionRecord }>(
      `/approvals/${encodeURIComponent(id)}/approve`,
      { method: "POST", body: binding },
    );
    return result.action;
  }

  async deny(
    id: string,
    binding: { nonce: string; argsHash: string; taskRevision: number },
  ): Promise<ActionRecord> {
    const result = await this.#request<{ action: ActionRecord }>(
      `/approvals/${encodeURIComponent(id)}/deny`,
      { method: "POST", body: binding },
    );
    return result.action;
  }

  async listMemories(project?: string): Promise<MemoryRecord[]> {
    const result = await this.#request<{ memories: MemoryRecord[] }>("/memories", {
      query: { project },
    });
    return result.memories;
  }

  async saveMemory(input: {
    key: string;
    value: string;
    project?: string;
  }): Promise<MemoryRecord> {
    const result = await this.#request<{ memory: MemoryRecord }>("/memories", {
      method: "POST",
      body: input,
    });
    return result.memory;
  }

  async forgetMemory(key: string, project?: string): Promise<MemoryRecord> {
    const result = await this.#request<{ memory: MemoryRecord }>(
      `/memories/${encodeURIComponent(key)}`,
      { method: "DELETE", query: { project } },
    );
    return result.memory;
  }

  async listReminders(): Promise<ScheduleRecord[]> {
    const result = await this.#request<{ reminders: ScheduleRecord[] }>("/reminders");
    return result.reminders;
  }

  async createReminder(input: {
    text: string;
    dueAt: string;
    timezone: string;
  }): Promise<ScheduleRecord> {
    const result = await this.#request<{ reminder: ScheduleRecord }>("/reminders", {
      method: "POST",
      body: input,
    });
    return result.reminder;
  }

  async updateReminder(
    id: string,
    changes: { text?: string; dueAt?: string; timezone?: string },
  ): Promise<ScheduleRecord> {
    const result = await this.#request<{ reminder: ScheduleRecord }>(
      `/reminders/${encodeURIComponent(id)}`,
      { method: "PATCH", body: changes },
    );
    return result.reminder;
  }

  async cancelReminder(id: string): Promise<ScheduleRecord> {
    const result = await this.#request<{ reminder: ScheduleRecord }>(
      `/reminders/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return result.reminder;
  }

  async events(options: { after?: number; limit?: number } = {}): Promise<{
    events: ApiEvent[];
    nextCursor: number;
  }> {
    return this.#request("/events", {
      query: { after: options.after, limit: options.limit },
    });
  }

  /**
   * Consume the SSE event stream. The caller owns the AbortSignal and should
   * pass the last cursor as `after` when reconnecting.
   */
  async *streamEvents(options: {
    after?: number;
    limit?: number;
    signal?: AbortSignal;
  } = {}): AsyncGenerator<ApiEvent, void, void> {
    const url = new URL(`${this.#baseUrl}/api/v1/events/stream`);
    if (options.after !== undefined) url.searchParams.set("after", String(options.after));
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
    const response = await this.#fetch(url, {
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "text/event-stream",
      },
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      let payload: { error?: unknown; message?: unknown } | undefined;
      try {
        payload = JSON.parse(text) as { error?: unknown; message?: unknown };
      } catch {
        payload = undefined;
      }
      throw new ClientApiError(
        response.status,
        typeof payload?.error === "string" ? payload.error : `http_${response.status}`,
        typeof payload?.message === "string" ? payload.message : undefined,
      );
    }
    if (response.body === null) {
      throw new ClientApiError(response.status, "empty_response");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n");
          if (data.length === 0) continue;
          const event = JSON.parse(data) as unknown;
          if (
            typeof event === "object" &&
            event !== null &&
            "cursor" in event &&
            typeof event.cursor === "number" &&
            "event" in event &&
            typeof event.event === "string"
          ) {
            yield event as ApiEvent;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async createToken(input: { name: string; scopes?: string[]; ttlDays?: number }): Promise<{
    token: string;
    record: ClientTokenView;
  }> {
    return this.#request("/tokens", { method: "POST", body: input });
  }

  async listTokens(): Promise<ClientTokenView[]> {
    const result = await this.#request<{ tokens: ClientTokenView[] }>("/tokens");
    return result.tokens;
  }

  async revokeToken(id: string): Promise<boolean> {
    const result = await this.#request<{ revoked: boolean }>(
      `/tokens/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return result.revoked;
  }

  async #request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.#baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await response.text();
    let payload: unknown = undefined;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const error = payload as { error?: unknown; message?: unknown } | undefined;
      throw new ClientApiError(
        response.status,
        typeof error?.error === "string" ? error.error : `http_${response.status}`,
        typeof error?.message === "string" ? error.message : undefined,
      );
    }
    if (payload === undefined) {
      throw new ClientApiError(response.status, "empty_response");
    }
    return payload as T;
  }
}
