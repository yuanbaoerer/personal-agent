/**
 * Feishu owner remote-control extension for omp.
 *
 * A local operator explicitly binds ONE live omp session, already opened at the
 * intended workspace, to a privately paired Feishu owner. This extension is the
 * peer/client side only: it never spawns omp, never listens on a socket, and
 * never exposes an HTTP/admin port. It connects to a POSIX Unix-domain socket
 * owned by the Node relay (PairRelay), over NDJSON frames.
 *
 * Setup
 *   /feishu-pair <absolute private socket path>        local approvals
 *   /feishu-pair --mobile <absolute private socket>    phone approvals (opt-in)
 *   /feishu-pair                                      uses exported PA_CODING_SOCKET
 *   /feishu-unpair
 *
 * The socket must be a Unix socket, owned by the operator, mode 0600, inside a
 * parent directory the operator owns and that is not group/world writable.
 *
 * Wire (peer <-> relay), one JSON object per line:
 *   peer -> {type:"hello", workspace}            workspace is a basename only
 *   host -> {type:"offer", code}
 *   host -> {type:"paired"}
 *   host -> {type:"prompt", id, text}
 *   host -> {type:"stop", id}
 *   host -> {type:"decision", id, nonce, allow}
 *   peer -> {type:"progress"|"result"|"error", id, text}
 *   peer -> {type:"approval", id, nonce, text}
 *
 * Security properties enforced here:
 *  - binding requires an explicit local command in a main (non-subagent) idle
 *    session, an owner-only socket, and a local confirmation;
 *  - while bound, local prompt input is blocked (except /feishu-pair and
 *    /feishu-unpair) so local and remote turns cannot mix;
 *  - the remote peer cannot choose a destination: results go only to the
 *    currently active inbox id;
 *  - file/mention expansion is neutralized on remote prompts, and programmatic
 *    prompt dispatch does not expand slash commands or templates;
 *  - privileged operations are gated per call. Mobile approval is opt-in and
 *    one-shot per call with a nonce; unrepresentable, secret-bearing,
 *    network, outside-workspace, control-path and unknown tools require
 *    explicit local terminal confirmation;
 *  - a shell approval is NOT a sandbox: the warning says so;
 *  - disconnect, stop, unpair, session change and shutdown abort work and fail
 *    closed; there is no automatic replay or reconnect.
 *
 * Only final assistant text is relayed (no thinking, tool arguments, raw tool
 * results, or local transcript), bounded and lightly secret-redacted. Progress
 * is a bounded tool name/status line only.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as net from "node:net";
import * as path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
} from "@oh-my-pi/pi-coding-agent";

const STATUS_KEY = "feishu-pair";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 8000;
const MAX_RESULT_CHARS = 7900; // relay limit is 8000
const MAX_PROGRESS_CHARS = 500;
const MAX_APPROVAL_TEXT_CHARS = 1200;
const MAX_APPROVABLE_COMMAND_CHARS = 2000;
const MAX_APPROVABLE_COMMAND_LINES = 40;
const OFFER_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 50_000; // relay expires at 60s; leave a margin
const START_WATCHDOG_MS = 120_000;
const STOP_WATCHDOG_MS = 8_000;
const SOCKET_PATH_MAX_BYTES = 100;

const liveSockets = new Set<net.Socket>();
let exitHookInstalled = false;

function trackSocket(socket: net.Socket): void {
  liveSockets.add(socket);
  socket.once("close", () => liveSockets.delete(socket));
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const tracked of liveSockets) {
      try {
        tracked.destroy();
      } catch {
        // process is exiting
      }
    }
    liveSockets.clear();
  });
}

const CONTROL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const HAS_CONTROL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;
const ZERO_WIDTH = "\u200B";

const SAFE_NO_APPROVAL_TOOLS = new Set(["think", "todo"]);
const DENIED_TOOLS = new Set(["task", "agent", "subagent", "eval"]);
const SILENT_PROGRESS_TOOLS = new Set(["ask", "glob", "grep", "read", "think", "todo"]);

const REMOTE_SYSTEM_NOTE = [
  "This turn was submitted by the bound remote owner over Feishu and its final answer is relayed to that chat, bounded and secret-redacted.",
  "Reply concisely with only the final answer. Never include raw tool output, tool arguments, file dumps, credentials, tokens, private keys, absolute paths outside the workspace, or chain-of-thought.",
  "Do not claim an operation succeeded unless a tool result confirmed it. State failures and skipped approvals plainly.",
  "Stay inside the workspace bound at pairing. Shell commands are not sandboxed; do not imply that they are.",
  "For questions, ask in your final text and wait for the next Feishu message. Prefer literal workspace paths and native read/edit/write tools.",
].join(" ");

interface RemoteTurn {
  id: string;
  injectedAt: number;
  started: boolean;
  stopped: boolean;
  finalText: string;
  lastStopReason: string | undefined;
  hadError: boolean;
  progressedToolCalls: Set<string>;
  startTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
  nonce: string;
  promptId: string;
  generation: number;
  reason?: string;
  done: (value: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PairState {
  socket: net.Socket;
  ctx: ExtensionCommandContext;
  sessionId: string;
  rootReal: string;
  workspace: string;
  mobile: boolean;
  generation: number;
  offered: boolean;
  offerCode: string | undefined;
  paired: boolean;
  closing: boolean;
  active: RemoteTurn | null;
  pending: PendingApproval | null;
  approvalChain: Promise<void>;
  detach: () => void;
  sendPrompt: (text: string) => Promise<void>;
  dialogAbort: AbortController;
  localApprovalAbort: AbortController | undefined;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  offerTimer?: ReturnType<typeof setTimeout>;
  buffer: string;
  lastBlockedInputNotify: number;
}

type InboundFrame =
  | { type: "offer"; code: string }
  | { type: "paired" }
  | { type: "prompt"; id: string; text: string }
  | { type: "stop"; id: string }
  | { type: "decision"; id: string; nonce: string; allow: boolean };

interface AskDecision {
  kind: "ask";
  remote: boolean;
  title: string;
  localMessage: string;
  remoteMessage?: string;
}

type ToolVerdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | AskDecision;

interface PathAssessment {
  outside: boolean;
  credential: boolean;
  control: boolean;
  sensitive: boolean;
  invalid: boolean;
  networkOrInternal: boolean;
  paths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: string): string {
  return value.replace(CONTROL_CHARS, " ").replace(/\r\n?/g, "\n");
}

function oneLine(value: string): string {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

function sliceByUtf16(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let out = "";
  for (const character of value) {
    if (out.length + character.length > maxChars) break;
    out += character;
  }
  return out;
}

function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n\n[truncated]";
  return `${sliceByUtf16(value, Math.max(0, maxChars - marker.length))}${marker}`;
}

function boundOneLine(value: string, maxChars: number): string {
  const line = oneLine(value);
  if (line.length <= maxChars) return line;
  return `${sliceByUtf16(line, Math.max(0, maxChars - 1))}…`;
}

function safeToolName(name: string): string {
  return boundOneLine(name, 40) || "tool";
}

function safeWorkspaceName(value: string): string {
  const cleaned = oneLine(value)
    .replace(/[\u200B<>"'`/\\]/g, "")
    .trim();
  const bounded = sliceByUtf16(cleaned, 64);
  return bounded && bounded !== "." && bounded !== ".." ? bounded : "workspace";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' || first === "'") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePairArgs(args: string): { ok: true; socketPath: string; mobile: boolean } | { ok: false; error: string } {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let mobile = false;
  let socketPath: string | undefined;

  for (const token of tokens) {
    if (token === "--mobile") {
      mobile = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { ok: false, error: "usage: /feishu-pair [--mobile] <absolute socket path> (or set PA_CODING_SOCKET)" };
    }
    if (token.startsWith("--")) {
      return { ok: false, error: `unknown option ${token}` };
    }
    if (socketPath !== undefined) {
      return { ok: false, error: "expected exactly one socket path" };
    }
    socketPath = unquote(token);
  }

  if (socketPath === undefined) {
    const fromEnv = process.env.PA_CODING_SOCKET?.trim();
    if (fromEnv) socketPath = unquote(fromEnv);
  }
  if (!socketPath) {
    return { ok: false, error: "usage: /feishu-pair [--mobile] <absolute socket path> (or set PA_CODING_SOCKET)" };
  }
  return { ok: true, socketPath, mobile };
}

function validateSocketPath(socketPath: string): { ok: true } | { ok: false; reason: string } {
  if (!path.isAbsolute(socketPath)) return { ok: false, reason: "socket path must be absolute" };
  if (socketPath.includes("\u0000")) return { ok: false, reason: "socket path contains a NUL byte" };
  if (Buffer.byteLength(socketPath, "utf8") >= SOCKET_PATH_MAX_BYTES) {
    return { ok: false, reason: `socket path is too long (>= ${SOCKET_PATH_MAX_BYTES} bytes)` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    return { ok: false, reason: "socket not found; start the relay first" };
  }
  if (!stat.isSocket()) return { ok: false, reason: "path is not a Unix socket" };
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return { ok: false, reason: "socket is not owned by the current operator" };
  }
  if ((stat.mode & 0o077) !== 0) {
    return { ok: false, reason: "socket must be owner-only (chmod 600)" };
  }

  const parent = path.dirname(socketPath);
  let parentStat: fs.Stats;
  try {
    const parentLstat = fs.lstatSync(parent);
    if (parentLstat.isSymbolicLink()) return { ok: false, reason: "socket parent must not be a symlink" };
    parentStat = fs.statSync(parent);
  } catch {
    return { ok: false, reason: "socket parent directory is not readable" };
  }
  if (!parentStat.isDirectory()) return { ok: false, reason: "socket parent is not a directory" };
  if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
    return { ok: false, reason: "socket parent directory is not owned by the current operator" };
  }
  if ((parentStat.mode & 0o077) !== 0) {
    return { ok: false, reason: "socket parent directory must be owner-only (chmod 700)" };
  }
  return { ok: true };
}

function realpathOrResolve(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

function resolveWithExistingAncestor(target: string): string {
  // lstat distinguishes an absent leaf (new file) from a dangling link or
  // unreadable ancestor. Never auto-authorize an unresolved symlink target.
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })) {
      return path.join(fs.realpathSync.native(current), ...tail.reverse());
    }
    tail.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw new Error("unresolvable workspace path");
    current = parent;
  }
}

function isWithin(rootReal: string, target: string): boolean {
  const relative = path.relative(rootReal, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith("local://");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function normalizeCandidate(value: string): string {
  let candidate = value.trim();
  if (candidate.startsWith("@")) candidate = candidate.slice(1);
  return expandHome(candidate);
}

function stripHashlineHeader(value: string): string {
  const trimmed = value.trim();
  const match = /^\[(.+?)(?:#[0-9a-fA-F]{4})?\]$/.exec(trimmed);
  return match?.[1] ? match[1] : trimmed;
}

function readPathCandidates(raw: string): string[] {
  const direct = normalizeCandidate(raw);
  try {
    if (fs.existsSync(path.resolve(direct))) return [direct];
  } catch {
    // fall through to selector stripping
  }

  const candidates = [direct];
  let current = direct;
  for (let step = 0; step < 2; step++) {
    const match = /^(.*):(?:raw|\d+(?:[-+]\d*)?|-\d+|\d+-\d+|raw:\d+(?:-\d+)?)$/.exec(current);
    if (!match?.[1]) break;
    current = match[1];
    candidates.push(current);
  }
  return candidates;
}

const CREDENTIAL_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
]);

function isCredentialPath(absolutePath: string): boolean {
  const base = path.basename(absolutePath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (CREDENTIAL_BASENAMES.has(base)) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;

  const segments = absolutePath.split(path.sep).map(segment => segment.toLowerCase());
  if (segments.includes(".ssh") || segments.includes(".aws") || segments.includes(".gnupg")) return true;
  const joined = segments.join("/");
  if (joined.includes("/.config/gcloud/") || joined.endsWith("/.config/gcloud/configurations")) return true;
  if (joined.includes("/.kube/config") || joined.includes("/.docker/config.json")) return true;
  return false;
}

function relativeSegments(rootReal: string, absolutePath: string): string[] {
  const relative = path.relative(rootReal, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
  return relative.split(path.sep).filter(Boolean).map(segment => segment.toLowerCase());
}

function isWriteControlPath(rootReal: string, absolutePath: string): boolean {
  const segments = relativeSegments(rootReal, absolutePath);
  if (segments.length === 0) return false;
  const first = segments[0];
  if (first === ".git" || first === ".omp" || first === ".pi" || first === ".husky") return true;
  if (first === ".github" && segments[1] === "workflows") return true;
  if (first === ".vscode" && ["settings.json", "tasks.json", "launch.json"].includes(segments[1] ?? "")) return true;
  if (first === ".devcontainer") return true;
  if (segments.length === 1 && ["package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lockb"].includes(first)) {
    return true;
  }
  return false;
}

function isReadSensitivePath(rootReal: string, absolutePath: string): boolean {
  const segments = relativeSegments(rootReal, absolutePath);
  if (segments.length === 0) return false;
  const first = segments[0];
  return first === ".git" || first === ".omp" || first === ".pi" || first === ".ssh" || first === ".aws";
}

function assessPaths(rawPaths: string[], cwd: string, rootReal: string, options: { write: boolean }): PathAssessment {
  const assessment: PathAssessment = {
    outside: false,
    credential: false,
    control: false,
    sensitive: false,
    invalid: false,
    networkOrInternal: false,
    paths: [],
  };

  for (const raw of rawPaths) {
    const candidates = options.write ? [raw] : readPathCandidates(raw);
    for (const candidate of candidates) {
      const normalized = normalizeCandidate(candidate);
      if (HAS_CONTROL_CHARS.test(normalized) || /[\r\n\t]/.test(normalized)) {
        assessment.invalid = true;
        continue;
      }
      if (isUrlLike(normalized)) {
        assessment.networkOrInternal = true;
        assessment.paths.push(normalized);
        continue;
      }
      const absolute = path.resolve(cwd, normalized);
      const real = resolveWithExistingAncestor(absolute);
      assessment.paths.push(real);
      if (!isWithin(rootReal, real)) assessment.outside = true;
      if (isCredentialPath(real)) assessment.credential = true;
      if (isReadSensitivePath(rootReal, real)) assessment.sensitive = true;
      if (options.write && isWriteControlPath(rootReal, real)) assessment.control = true;
    }
  }

  return assessment;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return [];
}

// Mobile authorization is intentionally narrower than shell syntax. Never
// classify an arbitrary command as low risk by blacklisting a few binaries.
// Even these commands run project code, hence the per-invocation approval.
function mobileCheck(command: string): boolean {
  if (/[\r\n]/.test(command)) return false;
  if (/^(?:npm (?:test|run (?:test|typecheck|lint|build))|cargo (?:test|check)|go test \.\/\.\.\.)$/.test(command)) return true;
  const match = /^node --test(?: ([a-zA-Z0-9_./ -]+))?$/.exec(command);
  if (!match) return false;
  return !match[1] || match[1].split(" ").every((file) =>
    file.split("/").every((part) => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(part)));
}

function commandPreview(command: string, cwd: string): string {
  return ["Tool: bash", `Workspace cwd: ${cwd}`, "Command:", command].join("\n");
}

function pathPreview(operation: string, paths: string[]): string {
  return [`Tool: ${operation}`, ...paths.map(target => `Target: ${target}`)].join("\n");
}

function commandPolicy(
  input: Record<string, unknown>,
  ctx: ExtensionContext,
  state: PairState,
): ToolVerdict {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command.trim()) return { kind: "deny", reason: "Remote bash call had no command." };
  if (HAS_CONTROL_CHARS.test(command)) {
    return { kind: "deny", reason: "Remote bash command contained control characters." };
  }
  if (command.length > MAX_APPROVABLE_COMMAND_CHARS || command.split(/\r?\n/).length > MAX_APPROVABLE_COMMAND_LINES) {
    return {
      kind: "deny",
      reason: "Command is too large to review safely during remote operation; split it into smaller commands.",
    };
  }
  if (input.async === true || input.name != null || input.notify != null || input.ready != null) {
    return {
      kind: "deny",
      reason: "Background jobs and long-lived services are disabled while a remote owner controls this session.",
    };
  }
  const rawCwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : ctx.cwd;
  const cwd = resolveWithExistingAncestor(path.resolve(ctx.cwd, normalizeCandidate(rawCwd)));
  if (HAS_CONTROL_CHARS.test(cwd) || /[\r\n\t]/.test(cwd)) {
    return { kind: "deny", reason: "Working directory path contained control characters." };
  }
  const remoteEligible = state.mobile && isWithin(state.rootReal, cwd) &&
    !input.pty && mobileCheck(command) && command.length <= 900;

  const controls: string[] = [];
  if (typeof input.timeout === "number") controls.push(`timeout=${input.timeout}`);
  if (input.pty === true) controls.push("pty=true");
  const controlLine = controls.length > 0 ? `Controls: ${controls.join(" ")}` : "Controls: none";
  const warning = "Shell commands run with your local user permissions. This is NOT a sandbox and a chdir does not confine it.";
  const localMessage = [
    commandPreview(command, cwd),
    controlLine,
    "",
    warning,
    "",
    "Allow this exact operation for this call only?",
  ].join("\n");
  const remoteMessage = [
    `Tool: bash`,
    `CWD: ${cwd}`,
    controlLine,
    `Command:`,
    command,
    "",
    warning,
  ].join("\n");

  return {
    kind: "ask",
    remote: remoteEligible && remoteMessage.length <= 1000,
    title: "Remote shell command",
    localMessage,
    remoteMessage,
  };
}

function pathPolicy(
  operation: "read" | "write" | "edit" | "grep" | "glob",
  rawPaths: string[],
  ctx: ExtensionContext,
  state: PairState,
): ToolVerdict {
  if (rawPaths.length === 0) {
    return { kind: "deny", reason: "Use an explicit file path in the paired workspace." };
  }
  for (const raw of rawPaths) {
    // Archive/DB selectors, globs and internal URIs are not literal paths.
    const literal = operation === "read" ? raw.replace(/:\d+(?:-\d+)?$/, "") : raw;
    if (!/^[\p{L}\p{N}_. /-]+$/u.test(literal) || literal.trim() !== literal) {
      return { kind: "deny", reason: "Use a literal workspace path, optionally with a simple read line range." };
    }
  }
  const write = operation === "write" || operation === "edit";
  const assessment = assessPaths(rawPaths, ctx.cwd, state.rootReal, { write });
  if (assessment.invalid) {
    return { kind: "deny", reason: "A target path contained control characters and was blocked." };
  }
  if (assessment.credential) {
    return {
      kind: "deny",
      reason: "Credential-looking paths are blocked during remote operation. Inspect them locally.",
    };
  }
  if (assessment.networkOrInternal) {
    return {
      kind: "ask",
      remote: false,
      title: "Remote network/internal read",
      localMessage: `${pathPreview(operation, assessment.paths)}\n\nNetwork or internal-URL access is not phone-approvable. Allow locally for this call only?`,
    };
  }
  if (assessment.outside || assessment.control || assessment.sensitive) {
    const why = assessment.outside
      ? "target is outside the bound workspace"
      : assessment.control
        ? "target is a control path"
        : "target is a repository/tool/config path that may contain credentials";
    return {
      kind: "ask",
      remote: false,
      title: "Remote file access",
      localMessage: `${pathPreview(operation, assessment.paths)}\n\nReason: ${why}. This is not phone-approvable. Allow locally for this call only?`,
    };
  }
  return { kind: "allow" };
}

function policyForTool(event: ToolCallEvent, ctx: ExtensionContext, state: PairState): ToolVerdict {
  const input: Record<string, unknown> = isRecord(event.input) ? event.input : {};
  const toolName = event.toolName;

  if (DENIED_TOOLS.has(toolName)) {
    return {
      kind: "deny",
      reason: "Subagents and kernel evaluation are disabled while a remote owner controls this session.",
    };
  }
  if (SAFE_NO_APPROVAL_TOOLS.has(toolName)) return { kind: "allow" };
  if (toolName === "bash") {
    return commandPolicy(input, ctx, state);
  }
  if (toolName === "read") {
    const raw = stringArray(input.path);
    if (raw.length === 1 && isUrlLike(normalizeCandidate(raw[0]!))) {
      return {
        kind: "ask",
        remote: false,
        title: "Remote URL/internal read",
        localMessage: `Tool: read\nTarget: ${raw[0]}\n\nNetwork or internal-URL access is not phone-approvable. Allow locally for this call only?`,
      };
    }
    return pathPolicy("read", raw, ctx, state);
  }
  if ((toolName === "grep" || toolName === "glob") && typeof input.path === "string" &&
      input.gitignore !== false && input.hidden !== true && input.path !== ".") {
    return pathPolicy(toolName, [input.path], ctx, state);
  }
  if (toolName === "write") {
    const raw = stringArray(input.path).map(stripHashlineHeader);
    return pathPolicy("write", raw, ctx, state);
  }
  if (toolName === "edit" && typeof input.path === "string" &&
    typeof input.old_string === "string" && typeof input.new_string === "string" && input.edits === undefined) {
    return pathPolicy("edit", [input.path], ctx, state);
  }

  // Everything else (network tools, MCP, browser, task tools, unknown
  // extension tools) has capabilities this peer cannot safely represent.
  const isMcp = toolName.startsWith("mcp__");
  const network = /^(?:web_search|fetch|browser|computer|image_gen|gh_|github_|memory_)/i.test(toolName);
  const category = isMcp ? "MCP tool" : network ? "network/service tool" : "tool with unknown capabilities";
  return {
    kind: "ask",
    remote: false,
    title: "Remote tool needs local consent",
    localMessage: [
      `Tool: ${toolName}`,
      `Category: ${category}`,
      `Arguments: ${JSON.stringify(input)}`,
      "This may execute code with your local user privileges. Allow this exact call?",
    ].join("\n"),
  };
}

function assistantText(message: unknown): string {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n").trim();
}

function redactOutbound(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, "[redacted private key]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[redacted token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted credential]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/g, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted jwt]")
    .replace(/\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s`'"]{6,}/gi, "$1: [redacted]");
}

function neutralizeFileMentions(text: string): string {
  const mention = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;
  const boundary = /[\s([{<"'`]/;
  return text.replace(mention, (match, _double, _single, _bare, offset: number) => {
    const at = typeof offset === "number" ? offset : 0;
    const previous = at > 0 ? text[at - 1] : undefined;
    if (previous !== undefined && !boundary.test(previous)) return match;
    return `@${ZERO_WIDTH}${match.slice(1)}`;
  });
}

function parseInboundFrame(line: string): InboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  if (parsed.type === "offer") {
    if (typeof parsed.code !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(parsed.code)) return null;
    return { type: "offer", code: parsed.code };
  }
  if (parsed.type === "paired") return { type: "paired" };
  if (parsed.type === "prompt") {
    if (typeof parsed.id !== "string" || !isValidId(parsed.id)) return null;
    if (typeof parsed.text !== "string" || parsed.text.length === 0 || parsed.text.length > MAX_PROMPT_CHARS) return null;
    return { type: "prompt", id: parsed.id, text: parsed.text };
  }
  if (parsed.type === "stop") {
    if (typeof parsed.id !== "string" || !isValidId(parsed.id)) return null;
    return { type: "stop", id: parsed.id };
  }
  if (parsed.type === "decision") {
    if (typeof parsed.id !== "string" || !isValidId(parsed.id)) return null;
    if (typeof parsed.nonce !== "string" || !/^[0-9a-fA-F]{16,64}$/.test(parsed.nonce)) return null;
    if (typeof parsed.allow !== "boolean") return null;
    return { type: "decision", id: parsed.id, nonce: parsed.nonce.toLowerCase(), allow: parsed.allow };
  }
  return null;
}

function isValidId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007F]/.test(value);
}

function sendFrame(state: PairState, frame: unknown): boolean {
  if (state.closing) return false;
  const socket = state.socket;
  if (socket.destroyed || !socket.writable) return false;
  try {
    socket.write(`${JSON.stringify(frame)}\n`);
    return true;
  } catch {
    return false;
  }
}

function sendProgress(state: PairState, id: string, text: string): void {
  if (!state.paired || state.active?.id !== id) return;
  sendFrame(state, { type: "progress", id, text: boundOneLine(text, MAX_PROGRESS_CHARS) });
}

function sendResult(state: PairState, id: string, text: string): void {
  if (!state.paired) return;
  sendFrame(state, {
    type: "result",
    id,
    text: boundText(redactOutbound(cleanText(text)), MAX_RESULT_CHARS),
  });
}

function sendError(state: PairState, id: string, text: string): void {
  if (!state.paired) return;
  sendFrame(state, { type: "error", id, text: boundOneLine(text, MAX_RESULT_CHARS) });
}

function setStatus(state: PairState, text: string | undefined): void {
  try {
    state.ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // status is best-effort
  }
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // notification is best-effort
  }
}

function sessionMatches(state: PairState, ctx: ExtensionContext): boolean {
  try {
    return ctx.sessionManager.getSessionId() === state.sessionId;
  } catch {
    return false;
  }
}

function workspaceMatches(state: PairState, ctx: ExtensionContext): boolean {
  let cwd = ctx.cwd;
  try {
    cwd = ctx.sessionManager.getCwd();
  } catch {
    // fall back to the materialized context cwd
  }
  return realpathOrResolve(cwd) === state.rootReal;
}

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) clearTimeout(timer);
}

function settlePending(state: PairState, allow: boolean, reason?: string): void {
  const pending = state.pending;
  if (!pending) return;
  state.pending = null;
  clearTimer(pending.timer);
  pending.reason = reason;
  pending.done(allow);
  if (state.paired) setStatus(state, "Feishu: paired");
}

function withApprovalSlot<T>(state: PairState, run: () => Promise<T>): Promise<T> {
  const previous = state.approvalChain;
  const gate = Promise.withResolvers<void>();
  state.approvalChain = gate.promise;
  return (async () => {
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      gate.resolve();
    }
  })();
}

async function requestRemoteApproval(
  state: PairState,
  verdict: AskDecision,
): Promise<{ allow: boolean; reason?: string }> {
  const active = state.active;
  if (!active || !state.paired) return { allow: false, reason: "No active remote prompt." };
  const promptId = active.id;
  const generation = state.generation;
  const nonce = randomBytes(16).toString("hex");
  const preview = verdict.remoteMessage ?? verdict.localMessage;

  return withApprovalSlot(state, async () => {
    if (
      state.closing ||
      !state.paired ||
      state.active !== active ||
      active.stopped ||
      state.generation !== generation
    ) {
      return { allow: false, reason: "Pairing or the remote turn ended before approval." };
    }
    const decision = Promise.withResolvers<boolean>();
    const pending: PendingApproval = { nonce, promptId, generation, done: decision.resolve };
    state.pending = pending;
    setStatus(state, "Feishu: approval pending");
    pending.timer = setTimeout(() => settlePending(state, false, "Approval timed out."), APPROVAL_TTL_MS);
    if (!sendFrame(state, { type: "approval", id: promptId, nonce, text: preview })) {
      settlePending(state, false, "Pairing connection closed.");
    }
    return { allow: await decision.promise, reason: pending.reason };
  });
}

async function requestLocalApproval(
  ctx: ExtensionContext,
  verdict: AskDecision,
  signal: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  if (verdict.localMessage.length > 6000) {
    notify(ctx, "The operation is too large to review at the terminal; it was not run. Split it into smaller steps.", "warning");
    return false;
  }
  try {
    return await ctx.ui.confirm(verdict.title, `${verdict.localMessage}\n\nThis approval applies to this call only.`, {
      signal,
    });
  } catch {
    return false;
  }
}

function stopActiveTurn(state: PairState, id: string): void {
  const active = state.active;
  if (!active || active.id !== id || active.stopped) return;
  active.stopped = true;
  clearTimer(active.startTimer);
  clearTimer(active.stopTimer);
  settlePending(state, false, "Stopped by the owner before approval.");
  state.localApprovalAbort?.abort();
  setStatus(state, "Feishu: stopping");
  try {
    state.ctx.abort();
  } catch {
    // abort is best-effort
  }
  active.stopTimer = setTimeout(() => {
    if (state.active === active) finishActiveTurn(state, "Stopped by the owner; no final answer was produced.");
  }, STOP_WATCHDOG_MS);
}

function finishActiveTurn(state: PairState, forcedError?: string): void {
  const active = state.active;
  if (!active) return;
  settlePending(state, false, "The remote turn ended before approval.");
  state.active = null;
  clearTimer(active.startTimer);
  clearTimer(active.stopTimer);

  const id = active.id;
  if (!state.paired || state.closing) {
    setStatus(state, state.closing ? undefined : "Feishu: paired");
    return;
  }

  if (forcedError) {
    sendError(state, id, forcedError);
  } else if (active.stopped) {
    sendError(state, id, "Stopped by the owner; no final answer was produced.");
  } else if (active.hadError || active.lastStopReason === "error" || active.lastStopReason === "aborted") {
    sendError(state, id, "The run failed or was interrupted; no successful completion was confirmed.");
  } else if (!active.finalText) {
    sendError(state, id, "The run ended without a final answer.");
  } else {
    sendResult(state, id, active.finalText);
  }
  setStatus(state, "Feishu: paired");
}


function closePairing(state: PairState, reason: string, options: { notifyLocal: boolean; abort: boolean }): void {
  if (state.closing) return;
  state.closing = true;
  state.detach();
  state.paired = false;
  clearTimer(state.handshakeTimer);
  clearTimer(state.offerTimer);
  if (state.active) {
    clearTimer(state.active.startTimer);
    clearTimer(state.active.stopTimer);
  }
  state.active = null;
  settlePending(state, false, `Pairing ended: ${reason}`);
  state.localApprovalAbort?.abort();
  state.dialogAbort.abort();

  if (options.abort) {
    try {
      state.ctx.abort();
    } catch {
      // abort is best-effort
    }
  }

  try {
    state.socket.destroy();
  } catch {
    // socket already gone
  }
  setStatus(state, undefined);
  if (options.notifyLocal) notify(state.ctx, `Feishu pairing ended: ${reason}`, "warning");
}

function hasRunningAsyncJobs(ctx: ExtensionContext): boolean {
  try {
    const snapshot = ctx.getAsyncJobSnapshot();
    return (snapshot?.running.length ?? 0) > 0;
  } catch {
    return true;
  }
}

function beginRemotePrompt(state: PairState, id: string, rawText: string): void {
  if (state.closing || !state.paired) return;
  if (state.active) {
    sendError(state, id, "Previous turn is still stopping or running; this input was not queued.");
    return;
  }
  if (state.pending) {
    sendError(state, id, "A tool approval is still pending; no prompt was started.");
    return;
  }
  if (!workspaceMatches(state, state.ctx) || !sessionMatches(state, state.ctx)) {
    sendError(state, id, "The bound workspace or session changed; pairing was closed.");
    closePairing(state, "session or workspace changed", { notifyLocal: true, abort: true });
    return;
  }
  if (!state.ctx.isIdle() || state.ctx.hasPendingMessages()) {
    sendError(state, id, "The session is busy; no prompt was started. Try again after it is idle.");
    return;
  }
  if (hasRunningAsyncJobs(state.ctx)) {
    sendError(state, id, "Background jobs are still running; no prompt was started. Stop them before submitting.");
    return;
  }

  const body = neutralizeFileMentions(cleanText(rawText)).trim();
  if (!body) {
    sendError(state, id, "The prompt was empty after normalization.");
    return;
  }
  const text = `Remote owner request via Feishu:\n\n${body}`;

  const active: RemoteTurn = {
    id,
    injectedAt: Date.now(),
    started: false,
    stopped: false,
    finalText: "",
    lastStopReason: undefined,
    hadError: false,
    progressedToolCalls: new Set(),
  };
  state.active = active;
  setStatus(state, "Feishu: starting remote turn");
  sendProgress(state, id, "Starting…");
  active.startTimer = setTimeout(() => {
    if (state.active === active && !active.started) {
      sendError(state, id, "The run did not start in time; no final answer was produced.");
      state.active = null;
      try {
        state.ctx.abort();
      } catch {
        // best effort
      }
      setStatus(state, "Feishu: paired");
    }
  }, START_WATCHDOG_MS);

  void (async () => {
    try {
      await state.sendPrompt(text);
    } catch {
      if (state.active === active) {
        state.active = null;
        clearTimer(active.startTimer);
        sendError(state, id, "Could not start the run.");
        setStatus(state, "Feishu: paired");
      }
    }
  })();
}

function handleInbound(state: PairState, line: string): void {
  const frame = parseInboundFrame(line);
  if (!frame) return;

  if (!state.offered) {
    if (frame.type !== "offer") return;
    state.offered = true;
    state.offerCode = frame.code;
    clearTimer(state.handshakeTimer);
    clearTimer(state.offerTimer);
    notify(
      state.ctx,
      `Feishu pairing code: ${frame.code}\nFrom the bound chat, send: /code pair ${frame.code}\nThe code expires in 5 minutes.`,
      "info",
    );
    setStatus(state, "Feishu: awaiting owner pair");
    state.offerTimer = setTimeout(() => {
      if (!state.paired) closePairing(state, "pairing code expired", { notifyLocal: true, abort: false });
    }, OFFER_TTL_MS);
    return;
  }

  if (!state.paired) {
    if (frame.type !== "paired") return;
    state.paired = true;
    state.offerCode = undefined;
    clearTimer(state.handshakeTimer);
    clearTimer(state.offerTimer);
    notify(
      state.ctx,
      "Feishu owner paired. Remote control is exclusive; local prompts are blocked. Use /feishu-unpair to take back control.",
      "info",
    );
    setStatus(state, state.mobile ? "Feishu: paired (mobile approval)" : "Feishu: paired (local approval)");
    return;
  }

  if (frame.type === "prompt") {
    try {
      beginRemotePrompt(state, frame.id, frame.text);
    } catch {
      sendError(state, frame.id, "Could not start the run.");
    }
    return;
  }
  if (frame.type === "stop") {
    stopActiveTurn(state, frame.id);
    return;
  }
  if (frame.type === "decision") {
    const pending = state.pending;
    const active = state.active;
    if (!pending || !active) return;
    if (frame.id !== active.id || frame.id !== pending.promptId) return;
    if (frame.nonce !== pending.nonce) return;
    settlePending(state, frame.allow, frame.allow ? undefined : "Denied by the owner on Feishu.");
  }
}

function readInboundChunk(state: PairState, chunk: string): void {
  if (state.closing) return;
  state.buffer += chunk;
  if (Buffer.byteLength(state.buffer, "utf8") > MAX_BUFFER_BYTES) {
    closePairing(state, "relay sent an oversized frame", { notifyLocal: true, abort: true });
    return;
  }

  for (;;) {
    const newline = state.buffer.indexOf("\n");
    if (newline < 0) break;
    const line = state.buffer.slice(0, newline).replace(/\r$/, "");
    state.buffer = state.buffer.slice(newline + 1);
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      closePairing(state, "relay sent an oversized frame", { notifyLocal: true, abort: true });
      return;
    }
    handleInbound(state, line);
    if (state.closing) return;
  }

  if (Buffer.byteLength(state.buffer, "utf8") > MAX_FRAME_BYTES) {
    closePairing(state, "relay sent an incomplete oversized frame", { notifyLocal: true, abort: true });
  }
}

export default function feishuPairExtension(pi: ExtensionAPI): void {
  let pairing: PairState | null = null;
  let binding = false;
  let generationCounter = 0;

  const current = (): PairState | null => pairing;

  const closeCurrent = (reason: string, notifyLocal: boolean, abort = true): void => {
    const state = pairing;
    if (!state) return;
    pairing = null;
    closePairing(state, reason, { notifyLocal, abort });
  };

  pi.registerCommand("feishu-pair", {
    description:
      "Bind this idle omp session to a Feishu owner over a private Unix socket. Usage: /feishu-pair [--mobile] <absolute socket path>",
    handler: async (args, ctx) => {
      if (ctx.agent.kind !== "main") {
        notify(ctx, "Feishu pairing is only available in the main session, not a subagent.", "error");
        return;
      }
      const trimmed = args.trim();
      if (trimmed === "status") {
        if (!pairing) {
          notify(ctx, "Feishu pairing: not bound.", "info");
          return;
        }
        const state = pairing;
        const phase = state.paired ? (state.active ? "remote turn running" : "paired") : state.offered ? "awaiting owner pair" : "connecting";
        const codeLine = !state.paired && state.offerCode ? `\nCode: ${state.offerCode}` : "";
        notify(
          ctx,
          `Feishu pairing: ${phase}${codeLine}\nWorkspace: ${state.workspace}\nApproval: ${state.mobile ? "mobile (one-shot, opt-in)" : "local terminal"}`,
          "info",
        );
        return;
      }
      if (pairing || binding) {
        notify(ctx, "This session is already bound to Feishu. Run /feishu-unpair first.", "warning");
        return;
      }
      if (!ctx.hasUI) {
        notify(ctx, "Feishu pairing requires an interactive terminal (no UI available).", "error");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages() || hasRunningAsyncJobs(ctx)) {
        notify(ctx, "Feishu pairing requires an idle session with no queued prompts or running background jobs.", "warning");
        return;
      }

      const parsed = parsePairArgs(args);
      if (!parsed.ok) {
        notify(ctx, parsed.error, "error");
        return;
      }
      const validation = validateSocketPath(parsed.socketPath);
      if (!validation.ok) {
        notify(ctx, `Refusing to pair: ${validation.reason}.`, "error");
        return;
      }

      const rootReal = realpathOrResolve(ctx.cwd);
      try {
        if (!fs.statSync(rootReal).isDirectory()) throw new Error("not a directory");
      } catch {
        notify(ctx, "Refusing to pair: the session workspace is not an existing directory.", "error");
        return;
      }
      const workspace = safeWorkspaceName(path.basename(rootReal));

      const warning = parsed.mobile
        ? [
            "Mobile approval is ON.",
            "Listed test/build commands may be approved once in Feishu. Other privileged operations still require this terminal.",
            "A shell is NOT a sandbox: approved commands run with your local user permissions.",
            "Remote prompts can edit files inside this workspace. Local prompt input will be blocked while paired.",
          ].join(" ")
        : [
            "Mobile approval is OFF (local terminal approval).",
            "Shell, network, outside-workspace and unknown-tool operations require confirmation at this terminal.",
            "Remote prompts can edit files inside this workspace. Local prompt input will be blocked while paired.",
          ].join(" ");

      binding = true;
      let confirmed = false;
      try {
        confirmed = await ctx.ui.confirm(
          "Pair Feishu owner?",
          [
            `Workspace: ${rootReal}`,
            `Socket: ${parsed.socketPath}`,
            `Approval: ${parsed.mobile ? "mobile (one-shot, opt-in)" : "local terminal"}`,
            "",
            warning,
            "",
            "Continue?",
          ].join("\n"),
        );
      } catch {
        confirmed = false;
      }
      if (!confirmed) {
        binding = false;
        notify(ctx, "Feishu pairing cancelled.", "info");
        return;
      }

      let socket: net.Socket;
      try {
        socket = net.createConnection({ path: parsed.socketPath });
      } catch {
        binding = false;
        notify(ctx, "Could not create the Unix-socket connection.", "error");
        return;
      }

      const state: PairState = {
        socket,
        ctx,
        sessionId: (() => {
          try {
            return ctx.sessionManager.getSessionId();
          } catch {
            return "";
          }
        })(),
        rootReal,
        workspace,
        mobile: parsed.mobile,
        generation: ++generationCounter,
        offered: false,
        offerCode: undefined,
        paired: false,
        closing: false,
        active: null,
        pending: null,
        approvalChain: Promise.resolve(),
        detach: () => undefined,
        sendPrompt: text => pi.sendUserMessage(text),
        dialogAbort: new AbortController(),
        localApprovalAbort: undefined,
        buffer: "",
        lastBlockedInputNotify: 0,
      };
      state.detach = () => {
        if (pairing === state) pairing = null;
        binding = false;
      };
      pairing = state;
      binding = false;
      trackSocket(socket);
      setStatus(state, "Feishu: connecting");

      socket.setEncoding("utf8");
      state.handshakeTimer = setTimeout(() => {
        if (!state.offered && !state.closing) {
          closePairing(state, "relay connect/offer timeout", { notifyLocal: true, abort: false });
        }
      }, 15_000);

      socket.on("connect", () => {
        if (state.closing) return;
        sendFrame(state, { type: "hello", workspace });
        setStatus(state, "Feishu: awaiting offer");
      });
      socket.on("data", (chunk: string) => readInboundChunk(state, chunk));
      socket.on("error", () => {
        if (!state.closing) closePairing(state, "socket error", { notifyLocal: true, abort: true });
      });
      socket.on("end", () => {
        if (!state.closing) closePairing(state, "relay disconnected", { notifyLocal: true, abort: true });
      });
      socket.on("close", () => {
        if (!state.closing) closePairing(state, "relay closed the connection", { notifyLocal: true, abort: true });
      });

      notify(ctx, `Connecting to the Feishu relay at ${parsed.socketPath}…`, "info");
    },
  });

  pi.registerCommand("feishu-unpair", {
    description: "End the Feishu pairing and abort any remote turn.",
    handler: async (_args, ctx) => {
      if (!pairing) {
        notify(ctx, "Feishu pairing: not bound.", "info");
        return;
      }
      notify(ctx, "Ending Feishu pairing and aborting any remote turn…", "warning");
      closeCurrent("unpaired locally", true, true);
    },
  });

  pi.on("input", (event, ctx) => {
    const state = current();
    if (!state) return;
    if (event.source === "extension") return;
    const text = event.text.trim();
    if (text === "/feishu-pair" || text.startsWith("/feishu-pair ")) return;
    if (text === "/feishu-unpair" || text.startsWith("/feishu-unpair ")) return;
    const now = Date.now();
    if (now - state.lastBlockedInputNotify > 2000) {
      state.lastBlockedInputNotify = now;
      notify(ctx, "Feishu remote control is active; local prompts are blocked. Use /feishu-unpair to take back control.", "warning");
    }
    return { handled: true };
  });

  pi.on("agent_start", (_event, ctx) => {
    const state = current();
    if (!state) return;
    if (!state.paired) {
      notify(ctx, "Unexpected turn while Feishu pairing was starting; pairing closed.", "error");
      closeCurrent("unexpected turn during pairing", true, true);
      return;
    }
    if (!state.active) {
      notify(ctx, "Unexpected local turn while Feishu pairing was active; pairing closed.", "error");
      closeCurrent("unexpected local turn", true, true);
      return;
    }
    if (!state.active.started) {
      state.active.started = true;
      clearTimer(state.active.startTimer);
      setStatus(state, "Feishu: remote turn running");
    }
  });

  pi.on("before_agent_start", (event, _ctx) => {
    const state = current();
    if (!state?.paired || !state.active) return;
    if (event.reason === "prompt" && event.prompt) {
      const actual = event.prompt.replace(/\u200B/g, "").replace(/\s+/g, " ").trim();
      if (!actual.includes("Remote owner request via Feishu:")) {
        sendError(state, state.active.id, "The turn did not match the remote prompt; it was aborted.");
        closeCurrent("remote turn mismatch", true, true);
        return;
      }
    }
    if (event.systemPrompt.some(part => part.includes("bound remote owner over Feishu"))) return;
    return { systemPrompt: [...event.systemPrompt, REMOTE_SYSTEM_NOTE] };
  });

  pi.on("message_end", event => {
    const state = current();
    if (!state?.paired || !state.active) return;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
    if (!state.active.started && timestamp > 0 && timestamp + 1000 < state.active.injectedAt) return;
    const text = assistantText(message);
    if (text) state.active.finalText = text;
    if (typeof message.stopReason === "string") state.active.lastStopReason = message.stopReason;
    if (typeof message.errorMessage === "string" && message.errorMessage) state.active.hadError = true;
  });

  pi.on("turn_end", event => {
    const state = current();
    if (!state?.paired || !state.active) return;
    const message = event.message;
    if (!isRecord(message) || message.role !== "assistant") return;
    const text = assistantText(message);
    state.active.finalText = text;
    if (typeof message.stopReason === "string") state.active.lastStopReason = message.stopReason;
    if (typeof message.errorMessage === "string" && message.errorMessage) state.active.hadError = true;
  });

  pi.on("agent_end", event => {
    const state = current();
    if (!state?.paired || !state.active) return;
    if (!state.active.started) {
      sendError(state, state.active.id, "The run ended before it started; no final answer was produced.");
      clearTimer(state.active.startTimer);
      state.active = null;
      setStatus(state, "Feishu: paired");
      return;
    }
    if (event.willContinue || event.awaitingAsyncWork) return;
    finishActiveTurn(state);
  });

  pi.on("tool_call", async (event, ctx) => {
    const state = current();
    if (!state) return;
    if (!state.paired || !state.active || ctx.agent.kind !== "main") {
      return { block: true, reason: "No active paired owner turn." };
    }
    const turn = state.active;
    if (turn.stopped) return { block: true, reason: "The owner stopped this turn." };
    if (!sessionMatches(state, ctx) || !workspaceMatches(state, ctx)) {
      sendError(state, state.active.id, "The bound workspace or session changed; the tool call was blocked.");
      closeCurrent("session or workspace changed", true, true);
      return { block: true, reason: "The bound workspace or session changed." };
    }

    let verdict: ToolVerdict;
    try {
      verdict = policyForTool(event, ctx, state);
    } catch {
      return { block: true, reason: "Could not verify the operation or its path." };
    }
    if (verdict.kind === "allow") return;
    if (verdict.kind === "deny") return { block: true, reason: verdict.reason };

    let allowed = false;
    let reason = "Approval was not granted; the operation was not run.";
    if (state.mobile && verdict.remote) {
      const decision = await requestRemoteApproval(state, verdict);
      allowed = decision.allow;
      if (!allowed) reason = decision.reason ?? reason;
    } else {
      const controller = new AbortController();
      allowed = await withApprovalSlot(state, async () => {
        const active = state.active;
        if (state.closing || !active || active.stopped) return false;
        state.localApprovalAbort = controller;
        try {
          return await requestLocalApproval(ctx, verdict, controller.signal);
        } finally {
          if (state.localApprovalAbort === controller) state.localApprovalAbort = undefined;
        }
      });
      if (!allowed) reason = "Local approval was denied or no approval UI was available.";
    }

    if (!allowed || state.closing || state.active !== turn || turn.stopped) {
      if (state.active) sendProgress(state, state.active.id, `Tool ${safeToolName(event.toolName)}: denied`);
      return { block: true, reason };
    }
    return;
  });

  pi.on("tool_execution_start", event => {
    const state = current();
    if (!state?.paired || !state.active) return;
    const active = state.active;
    if (active.progressedToolCalls.has(event.toolCallId)) return;
    if (SILENT_PROGRESS_TOOLS.has(event.toolName)) return;
    active.progressedToolCalls.add(event.toolCallId);
    sendProgress(state, active.id, `Running ${safeToolName(event.toolName)}…`);
  });

  pi.on("tool_execution_end", event => {
    const state = current();
    if (!state?.paired || !state.active) return;
    const active = state.active;
    if (!active.progressedToolCalls.delete(event.toolCallId)) return;
    sendProgress(state, active.id, `${safeToolName(event.toolName)} ${event.isError ? "failed" : "finished"}`);
  });

  pi.on("session_before_switch", (_event, ctx) => {
    const state = current();
    if (!state) return;
    notify(ctx, "Unpair Feishu first (/feishu-unpair); switching sessions would end the remote binding.", "warning");
    return { cancel: true };
  });

  pi.on("session_before_branch", (_event, ctx) => {
    const state = current();
    if (!state) return;
    notify(ctx, "Unpair Feishu first (/feishu-unpair); branching would end the remote binding.", "warning");
    return { cancel: true };
  });

  pi.on("session_before_tree", (_event, ctx) => {
    const state = current();
    if (!state) return;
    notify(ctx, "Unpair Feishu first (/feishu-unpair); navigating the session tree would end the remote binding.", "warning");
    return { cancel: true };
  });

  pi.on("session_switch", () => {
    if (current()) closeCurrent("session switched", true, true);
  });
  pi.on("session_branch", () => {
    if (current()) closeCurrent("session branched", true, true);
  });
  pi.on("session_clear", () => {
    if (current()) closeCurrent("session context cleared", true, true);
  });
  pi.on("session_shutdown", () => {
    if (current()) closeCurrent("session shut down", false, true);
  });
}
