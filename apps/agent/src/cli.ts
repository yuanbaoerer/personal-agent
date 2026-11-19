import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { ClientApiClient, ClientApiError } from "./client/sdk.ts";
import type { ActionRecord, ScheduleRecord, TaskRecord } from "./domain/types.ts";
import { runTui } from "./tui.ts";

interface CliIo {
  out(message: string): void;
  err(message: string): void;
}

interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Record<string, string | true>;
}

const HELP = `Personal Agent CLI (PA-18 draft)

Usage:
  pa tui
  pa status [--json]
  pa tasks [--status STATUS] [--limit N] [--json]
  pa task <id> [--json]
  pa create <goal> [--criteria TEXT] [--resources a,b] [--tools a,b]
            [--priority N] [--deadline ISO] [--request-id ID] [--json]
  pa cancel <id> [--json]
  pa revise <id> --revision N [--goal TEXT] [--criteria TEXT]
            [--priority N] [--json]
  pa supplement <id> <text> [--request-id ID] [--json]
  pa approvals [--json]
  pa approve <action-id> --yes [--json]
  pa deny <action-id> --yes [--json]
  pa memory list [--project NAME]
  pa memory save <key> <value> [--project NAME]
  pa memory forget <key> [--project NAME]
  pa reminders list
  pa reminders create <text> --at ISO --timezone ZONE
  pa reminders cancel <id>
  pa events [--after CURSOR] [--limit N] [--follow]
  pa tokens create --name NAME [--scopes read,write,approve]
  pa tokens list
  pa tokens revoke <id>

Environment:
  PA_API_URL    default http://127.0.0.1:8787
  PA_API_TOKEN  device token; falls back to ADMIN_TOKEN for local bootstrap
`;

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals > 2) {
      flags[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command: positionals.shift(), positionals, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagNumber(flags: ParsedArgs["flags"], name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  return value;
}

function listValue(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

function formatTask(task: TaskRecord): string {
  return `${shortId(task.id)}  ${task.status.padEnd(16)} rev ${task.revision}  ${safeText(task.goal)}`;
}

function formatAction(action: ActionRecord): string {
  return [
    `action ${action.id}`,
    `task ${action.taskId} rev ${action.taskRevision} tool ${action.tool}`,
    `args ${safeText(JSON.stringify(action.args))}`,
    `expires ${action.expiresAt}`,
    `nonce ${action.nonce}`,
    `argsHash ${action.argsHash}`,
  ].join("\n");
}

function formatReminder(reminder: ScheduleRecord): string {
  return `${shortId(reminder.id)}  ${reminder.status.padEnd(8)}  ${reminder.dueAt}  ${safeText(reminder.text)}`;
}

function makeClient(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch): ClientApiClient {
  const baseUrl = env.PA_API_URL?.trim() || "http://127.0.0.1:8787";
  const token = env.PA_API_TOKEN?.trim() || env.ADMIN_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error("PA_API_TOKEN or ADMIN_TOKEN is required");
  }
  return new ClientApiClient({ baseUrl, token, fetch: fetchImpl });
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** Testable CLI entry. It never accepts a token on argv. */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = {
    out: (message) => console.log(message),
    err: (message) => console.error(message),
  },
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === undefined || args.command === "help" || args.command === "--help") {
    io.out(HELP);
    return 0;
  }
  const json = args.flags.json === true;

  try {
    const client = makeClient(env, fetchImpl);
    switch (args.command) {
      case "tui": {
        return await runTui(client);
      }
      case "status": {
        const status = await client.status();
        if (json) {
          printJson(io, status);
        } else {
          const diagnostics = status.diagnostics as {
            ownerId?: string;
            tasks?: { status: string; goal?: string }[];
            unknownActions?: unknown[];
            effects?: Record<string, number>;
            confirmations?: { pending?: number };
          };
          const usage = status.usage as { tasks?: Record<string, number> };
          io.out(`API v${String(status.apiVersion)}  owner ${diagnostics.ownerId ?? "?"}`);
          const counts = usage.tasks ?? {};
          io.out(
            `tasks: queued ${counts.queued ?? 0}, running ${counts.running ?? 0}, ` +
              `waiting ${counts.waiting_user ?? 0}, review ${counts.needs_review ?? 0}, ` +
              `failed ${counts.failed ?? 0}, succeeded ${counts.succeeded ?? 0}`,
          );
          io.out(
            `effects: pending ${diagnostics.effects?.pending ?? 0}, ` +
              `running ${diagnostics.effects?.running ?? 0}, failed ${diagnostics.effects?.failed ?? 0}; ` +
              `unknown actions ${diagnostics.unknownActions?.length ?? 0}; ` +
              `pending confirmations ${diagnostics.confirmations?.pending ?? 0}`,
          );
        }
        return 0;
      }
      case "tasks": {
        const status = flagString(args.flags, "status");
        const limit = flagNumber(args.flags, "limit");
        const tasks = await client.listTasks({
          status: status as TaskRecord["status"] | undefined,
          limit,
        });
        if (json) printJson(io, { tasks });
        else if (tasks.length === 0) io.out("No tasks.");
        else for (const task of tasks) io.out(formatTask(task));
        return 0;
      }
      case "task": {
        const id = requirePositional(args, 0, "task id");
        const detail = await client.getTask(id);
        if (json) {
          printJson(io, detail);
          return 0;
        }
        io.out(formatTask(detail.task));
        io.out(`goal: ${detail.task.goal}`);
        io.out(`criteria: ${detail.task.completionCriteria}`);
        if (detail.actions.length > 0) {
          io.out("actions:");
          for (const action of detail.actions) {
            io.out(`- ${shortId(action.id)} ${action.tool} ${action.status}`);
          }
        }
        if (detail.inputs.length > 0) {
          io.out("inputs:");
          for (const input of detail.inputs) io.out(`- #${input.seq} ${input.text}`);
        }
        return 0;
      }
      case "create": {
        const goal = args.positionals.join(" ").trim() || flagString(args.flags, "goal");
        if (goal === undefined || goal.length === 0) throw new Error("goal is required");
        const requestId = flagString(args.flags, "request-id") ?? randomUUID();
        const resources = listValue(flagString(args.flags, "resources"));
        const tools = listValue(flagString(args.flags, "tools"));
        const mandate =
          resources === undefined && tools === undefined
            ? undefined
            : { resources: resources ?? ["chat"], tools: tools ?? [] };
        const task = await client.createTask(
          {
            goal,
            completionCriteria: flagString(args.flags, "criteria") ?? goal,
            mandate,
            priority: flagNumber(args.flags, "priority"),
            deadline: flagString(args.flags, "deadline"),
          },
          requestId,
        );
        if (json) printJson(io, { task });
        else io.out(formatTask(task));
        return 0;
      }
      case "cancel": {
        const id = requirePositional(args, 0, "task id");
        const task = await client.cancelTask(id);
        if (json) printJson(io, { task });
        else io.out(formatTask(task));
        return 0;
      }
      case "revise": {
        const id = requirePositional(args, 0, "task id");
        const expectedRevision = flagNumber(args.flags, "revision");
        if (expectedRevision === undefined) throw new Error("--revision is required");
        const task = await client.reviseTask(id, {
          expectedRevision,
          goal: flagString(args.flags, "goal"),
          completionCriteria: flagString(args.flags, "criteria"),
          priority: flagNumber(args.flags, "priority"),
        });
        if (json) printJson(io, { task });
        else io.out(formatTask(task));
        return 0;
      }
      case "supplement": {
        const id = requirePositional(args, 0, "task id");
        const text = args.positionals.slice(1).join(" ").trim();
        if (text.length === 0) throw new Error("supplement text is required");
        const requestId = flagString(args.flags, "request-id") ?? randomUUID();
        const result = await client.supplementTask(id, text, requestId);
        if (json) printJson(io, result);
        else io.out(`input #${result.input.seq} accepted for ${shortId(result.task.id)}`);
        return 0;
      }
      case "approvals": {
        const approvals = await client.listApprovals();
        if (json) printJson(io, { approvals });
        else if (approvals.length === 0) io.out("No pending approvals.");
        else for (const action of approvals) {
          io.out(formatAction(action));
          io.out("");
        }
        return 0;
      }
      case "approve":
      case "deny": {
        const id = requirePositional(args, 0, "action id");
        const action = await client.getApproval(id);
        if (args.flags.yes !== true) {
          io.out(formatAction(action));
          io.out(`Refusing to ${args.command} without --yes.`);
          return 2;
        }
        const binding = {
          nonce: action.nonce,
          argsHash: action.argsHash,
          taskRevision: action.taskRevision,
        };
        const result =
          args.command === "approve"
            ? await client.approve(id, binding)
            : await client.deny(id, binding);
        if (json) printJson(io, { action: result });
        else io.out(`action ${shortId(result.id)} ${result.status}`);
        return 0;
      }
      case "memory": {
        const sub = requirePositional(args, 0, "memory subcommand");
        const project = flagString(args.flags, "project");
        if (sub === "list") {
          const memories = await client.listMemories(project);
          if (json) printJson(io, { memories });
          else if (memories.length === 0) io.out("No memories.");
          else for (const memory of memories) {
            io.out(`${memory.project ?? "global"}/${memory.key} = ${memory.value}`);
          }
          return 0;
        }
        if (sub === "save") {
          const key = requirePositional(args, 1, "memory key");
          const value = args.positionals.slice(2).join(" ").trim();
          if (value.length === 0) throw new Error("memory value is required");
          const memory = await client.saveMemory({ key, value, project });
          if (json) printJson(io, { memory });
          else io.out(`saved ${memory.project ?? "global"}/${memory.key} v${memory.version}`);
          return 0;
        }
        if (sub === "forget") {
          const key = requirePositional(args, 1, "memory key");
          const memory = await client.forgetMemory(key, project);
          if (json) printJson(io, { memory });
          else io.out(`forgot ${memory.project ?? "global"}/${memory.key}`);
          return 0;
        }
        throw new Error("memory subcommand must be list, save or forget");
      }
      case "reminders": {
        const sub = requirePositional(args, 0, "reminders subcommand");
        if (sub === "list") {
          const reminders = await client.listReminders();
          if (json) printJson(io, { reminders });
          else if (reminders.length === 0) io.out("No reminders.");
          else for (const reminder of reminders) io.out(formatReminder(reminder));
          return 0;
        }
        if (sub === "create") {
          const text = args.positionals.slice(1).join(" ").trim();
          if (text.length === 0) throw new Error("reminder text is required");
          const dueAt = flagString(args.flags, "at");
          if (dueAt === undefined) throw new Error("--at is required");
          const timezone = flagString(args.flags, "timezone") ?? "UTC";
          const reminder = await client.createReminder({ text, dueAt, timezone });
          if (json) printJson(io, { reminder });
          else io.out(formatReminder(reminder));
          return 0;
        }
        if (sub === "cancel") {
          const id = requirePositional(args, 1, "reminder id");
          const reminder = await client.cancelReminder(id);
          if (json) printJson(io, { reminder });
          else io.out(formatReminder(reminder));
          return 0;
        }
        throw new Error("reminders subcommand must be list, create or cancel");
      }
      case "events": {
        const cursor = flagNumber(args.flags, "after") ?? 0;
        const limit = flagNumber(args.flags, "limit");
        if (args.flags.follow === true) {
          const controller = new AbortController();
          const onSignal = () => controller.abort();
          process.once("SIGINT", onSignal);
          try {
            for await (const event of client.streamEvents({
              after: cursor,
              limit,
              signal: controller.signal,
            })) {
              if (json) {
                printJson(io, event);
              } else {
                io.out(
                  `${event.cursor}  ${event.event}  ${event.subjectType ?? "-"} ${shortId(event.subjectId ?? "-")}`,
                );
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          } finally {
            process.off("SIGINT", onSignal);
          }
          return 0;
        }
        const result = await client.events({ after: cursor, limit });
        if (json) printJson(io, result);
        else {
          for (const event of result.events) {
            io.out(`${event.cursor}  ${event.event}  ${event.subjectType ?? "-"} ${shortId(event.subjectId ?? "-")}`);
          }
          io.out(`cursor ${result.nextCursor}`);
        }
        return 0;
      }
      case "tokens": {
        const sub = requirePositional(args, 0, "tokens subcommand");
        if (sub === "list") {
          const tokens = await client.listTokens();
          if (json) printJson(io, { tokens });
          else for (const token of tokens) {
            io.out(`${token.id}  ${token.name}  ${token.scopes.join(",")}  ${token.revokedAt ?? "active"}`);
          }
          return 0;
        }
        if (sub === "create") {
          const name = flagString(args.flags, "name") ?? "cli";
          const scopes = listValue(flagString(args.flags, "scopes"));
          const result = await client.createToken({ name, scopes });
          if (json) printJson(io, result);
          else {
            io.out(`token: ${result.token}`);
            io.out("Store it now; it cannot be displayed again.");
          }
          return 0;
        }
        if (sub === "revoke") {
          const id = requirePositional(args, 1, "token id");
          const revoked = await client.revokeToken(id);
          if (json) printJson(io, { revoked });
          else io.out(revoked ? "revoked" : "not found or already revoked");
          return revoked ? 0 : 1;
        }
        throw new Error("tokens subcommand must be list, create or revoke");
      }
      default:
        throw new Error(`unknown command: ${args.command}`);
    }
  } catch (error) {
    if (error instanceof ClientApiError) {
      io.err(`${error.status} ${error.code}${error.message === error.code ? "" : `: ${error.message}`}`);
    } else {
      io.err(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.(".env");
  } catch {
    // .env is optional; process env still works.
  }
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  await main();
}
