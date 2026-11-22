import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { CredentialBroker } from "../apps/agent/src/actions/credentials.ts";
import { createGithubPlugin } from "../apps/agent/src/plugins/github.ts";
import { FileSkillRuntime } from "../apps/agent/src/plugins/skills.ts";
import { createApp } from "../apps/agent/src/app.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { PiRouterModel } from "../apps/agent/src/coordinator/pi-router.ts";
import { createOpencodeModels, NodePiRuntime } from "../apps/agent/src/runtime/node-pi.ts";
import { noopWake } from "../apps/agent/src/runtime/types.ts";
import { openStore } from "../apps/agent/src/storage/node.ts";
import { CredentialRepository } from "../apps/agent/src/storage/credentials.ts";
import { ProjectRepository } from "../apps/agent/src/storage/projects.ts";

process.loadEnvFile(".env");
const token = process.env.GITHUB_TOKEN;
if (token === undefined || token.trim().length === 0) {
  throw new Error("GITHUB_TOKEN is required for the real review");
}
const config = loadConfig(process.env);
if (config.model.apiKey === undefined) {
  throw new Error("OPENCODE_API_KEY is required for the real review");
}
const ownerOpenId = config.ownerOpenId;
if (ownerOpenId === undefined) {
  throw new Error("OWNER_FEISHU_OPEN_ID is required");
}
const repositoryFullName = process.env.REAL_REVIEW_REPO ?? "yuanbaoerer/personal-agent";
const projectKey = process.env.REAL_REVIEW_PROJECT ?? "personal-agent";

const repoResponse = await fetch(`https://api.github.com/repos/${repositoryFullName}`, {
  headers: {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "personal-agent-verification",
  },
});
if (!repoResponse.ok) {
  throw new Error(`GitHub repo lookup failed: ${repoResponse.status}`);
}
const repo = (await repoResponse.json()) as {
  id?: unknown;
  full_name?: unknown;
  default_branch?: unknown;
};
if (typeof repo.id !== "number" || typeof repo.full_name !== "string") {
  throw new Error("GitHub repo response missing id/full_name");
}

const directory = mkdtempSync(join(tmpdir(), "pa-real-review-"));
const store = openStore(join(directory, "agent.sqlite"));
const bind = store.bindOwner({
  channel: "feishu",
  accountId: config.feishu.accountId ?? config.feishu.appId,
  actorId: ownerOpenId,
  verifiedAt: new Date().toISOString(),
});
const conversation = store.upsertConversation({
  ownerId: bind.id,
  channel: "feishu",
  accountId: config.feishu.accountId ?? config.feishu.appId,
  platformConversationId: "real-review-p2p",
  kind: "p2p",
  createdAt: new Date().toISOString(),
});

const projects = new ProjectRepository(store.db);
const credentials = new CredentialBroker(() => new Date(), new CredentialRepository(store.db));
credentials.register("github:default", {
  token,
  scopes: ["repository.read"],
  ownerId: bind.id,
  account: "yuanbaoerer",
});
const github = {
  token,
  allowedRepos: [repo.full_name],
  credentials,
  resolveProject: (key: string) => projects.findActiveByKey(bind.id, key),
};
const baseRuntime = new NodePiRuntime({
  databasePath: join(directory, "pi.sqlite"),
  model: { provider: config.model.provider, modelId: config.model.modelId },
  models: createOpencodeModels(config.model.apiKey),
});
const runtime = {
  open: (spec: Parameters<typeof baseRuntime.open>[0]) => baseRuntime.open(spec),
  submit: (
    sessionId: string,
    text: string,
    operationId: string,
  ) => baseRuntime.submit(sessionId, text, operationId),
  interrupt: (sessionId: string) => baseRuntime.interrupt(sessionId),
  wait: async (
    sessionId: string,
    operationId: string,
    timeoutMs?: number,
  ) => {
    const answer = await baseRuntime.wait(sessionId, operationId, timeoutMs);
    if (answer.status === "answered") {
      console.error("RAW_ANSWER_START");
      console.error(answer.text.slice(0, 12_000));
      console.error("RAW_ANSWER_END");
    }
    return answer;
  },
};
const app = createApp({
  store,
  runtime,
  wake: noopWake,
  github,
  skills: new FileSkillRuntime({ root: "skills" }),
  builtinPlugins: [createGithubPlugin(github)],
  model: new PiRouterModel(store, runtime),
  budgetLimits: config.budget,
  now: () => new Date(),
});
app.projectService.bind(
  bind.id,
  {
    projectKey,
    repositoryId: repo.id,
    repositoryFullName: repo.full_name,
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
    credentialRef: "github:default",
    allowedPlanPaths: [
      "README.md",
      "docs/21-mvp-functional-ready.md",
      "docs/24-github-project-management.md",
    ],
  },
  "owner",
);
app.preauthorization.grant(bind.id, repo.full_name);

const text =
  "检查 personal-agent 最新实施情况，对照项目规划、源码、PR 和 CI，指出三个主要工程缺口，关联已有 Issue，生成待办修改草稿。只读，不要实际修改 GitHub。";
await app.ingress.accept({
  channel: "feishu",
  accountId: config.feishu.accountId ?? config.feishu.appId,
  platformEventId: `evt_real_review_${Date.now()}`,
  eventType: "im.message.receive_v1",
  chatType: "p2p",
  actorType: "user",
  actorId: ownerOpenId,
  platformConversationId: conversation.platformConversationId,
  text,
  occurredAt: new Date().toISOString(),
});

let task = app.tasks.listByOwner(bind.id)[0];
for (let round = 0; round < 240; round += 1) {
  await app.effectDispatcher.drain(20);
  task = app.tasks.listByOwner(bind.id)[0];
  if (
    task !== undefined &&
    ["succeeded", "needs_review", "failed", "cancelled"].includes(task.status)
  ) {
    break;
  }
  console.error(
    JSON.stringify({
      round,
      task: task?.status,
      actions: app.actions.listByTask(task?.id ?? "").length,
    }),
  );
  await sleep(1_000);
}

const actions = task === undefined ? [] : app.actions.listByTask(task.id);
console.log(
  JSON.stringify(
    {
      database: directory,
      repositoryId: repo.id,
      repositoryFullName: repo.full_name,
      projectKey,
      task: task === undefined
        ? undefined
        : {
            id: task.id,
            status: task.status,
            revision: task.revision,
            mandate: task.mandate,
            criteria: task.completionCriteria,
            verification: task.verification,
            lastError: task.lastError,
          },
      actions: actions.map((action) => ({
        id: action.id,
        tool: action.tool,
        operation: action.args.operation,
        status: action.status,
        commitSha: action.evidence?.commitSha,
        headSha: action.evidence?.headSha,
        stale: action.evidence?.stale,
        source: action.evidence?.source,
        permanentUrl: action.evidence?.permanentUrl,
        error: action.lastError,
      })),
      outbox: store.listRecentOutbox(30).map((row) => ({
        purpose: row.purpose,
        text: row.text.slice(0, 1_500),
      })),
      audits: store.listAuditAfter(0, 200).map((row) => row.event),
    },
    null,
    2,
  ),
);
await baseRuntime.close();
store.close();
