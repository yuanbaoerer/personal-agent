import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import path from "node:path";

import type { InboxRecord, ReplyDraft } from "../domain/types.ts";
import type { Store } from "../storage/store.ts";

/**
 * Node-only private control plane for a real omp session.
 *
 * The host never spawns a shell or omp: a peer opened by the user at one
 * workspace connects over a private POSIX Unix socket, is paired by the
 * bound Feishu owner with a short-lived code, and then relays chat turns.
 * The peer chooses neither owner nor destination; the host always uses the
 * conversation captured at pairing time.
 *
 * Wire (NDJSON, one bounded frame per line):
 *   peer -> host: hello{workspace} | progress|result|error{id,text}
 *                 | approval{id,nonce,text}
 *   host -> peer: offer{code} | paired | prompt{id,text} | stop{id}
 *                 | decision{id,nonce,allow}
 */

const PAIR_META_KEY = "coding:pair";
const INBOX_META_PREFIX = "coding:inbox:";
const TRACE_PREFIX = "coding:inbox:";
const BUSINESS_PREFIX = "coding:inbox:";

const MAX_SOCKET_PATH_BYTES = 100;
const MAX_FRAME_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const OFFER_TTL_MS = 5 * 60_000;
const OFFER_MAX_ATTEMPTS = 5;
const APPROVAL_TTL_MS = 60_000;
const MAX_PROMPT_CHARS = 8_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_PROGRESS_CHARS = 500;
const MAX_APPROVAL_PREVIEW_CHARS = 1_200;
const MAX_PROGRESS_PER_TURN = 20;
const MAX_IGNORED_TURNS = 16;
const MAX_WORKSPACE_CHARS = 64;
const CODE_LENGTH = 10;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface PersistedPair {
  version: 1;
  ownerId: string;
  channel: string;
  accountId: string;
  platformConversationId: string;
  conversationId: string;
  workspace: string;
  pairedAt: string;
}

interface PendingApproval {
  nonce: string;
  createdAt: number;
}

interface ActiveTurn {
  inboxId: string;
  progressSeq: number;
  pendingApproval?: PendingApproval;
}

interface Offer {
  code: string;
  workspace: string;
  expiresAt: number;
  attempts: number;
  timer: NodeJS.Timeout;
}

type ClientState = "idle" | "awaiting_hello" | "offered" | "paired";

interface DeliveryTarget {
  ownerId: string;
  channel: string;
  accountId: string;
  /** Platform conversation id, as required by the outbox. */
  conversationId: string;
}

export interface CodingRelayOptions {
  /** Test seam; production uses the wall clock. */
  now?: () => Date;
}

interface RawPairState {
  version?: unknown;
  ownerId?: unknown;
  channel?: unknown;
  accountId?: unknown;
  platformConversationId?: unknown;
  conversationId?: unknown;
  workspace?: unknown;
  pairedAt?: unknown;
}

interface PeerMessage {
  type: string;
  workspace?: unknown;
  id?: unknown;
  nonce?: unknown;
  text?: unknown;
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** Single-line text for progress: no control characters, no newlines. */
function cleanInline(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  return clip(normalized, maxChars);
}

/** Final text may keep paragraphs, but never terminal control sequences. */
function cleanMultiline(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g,
      " ",
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(normalized, maxChars);
}

/**
 * Accept only a display basename. Never keep the peer's full path, owner
 * address, or any other hello field.
 */
function sanitizeWorkspace(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) {
    return undefined;
  }
  const base = trimmed.split(/[\\/]+/).filter((part) => part.length > 0).at(-1);
  if (base === undefined) {
    return undefined;
  }
  const cleaned = base
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return undefined;
  }
  if (!/^[^\u0000-\u001f\u007f<>"'`/\\]+$/u.test(cleaned)) {
    return undefined;
  }
  return clip(cleaned, MAX_WORKSPACE_CHARS);
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  }
  return code;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const NONCE_PATTERN = /^[A-Fa-f0-9]{16,64}$/;

function parsePairState(raw: string | undefined): PersistedPair | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  let parsed: RawPairState;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    parsed = value as RawPairState;
  } catch {
    return undefined;
  }
  if (parsed.version !== 1) {
    return undefined;
  }
  const fields = [
    "ownerId",
    "channel",
    "accountId",
    "platformConversationId",
    "conversationId",
    "workspace",
    "pairedAt",
  ] as const;
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
  }
  if (parsed.channel !== "feishu") {
    return undefined;
  }
  return {
    version: 1,
    ownerId: parsed.ownerId as string,
    channel: "feishu",
    accountId: parsed.accountId as string,
    platformConversationId: parsed.platformConversationId as string,
    conversationId: parsed.conversationId as string,
    workspace: parsed.workspace as string,
    pairedAt: parsed.pairedAt as string,
  };
}

function pairTarget(pair: PersistedPair): DeliveryTarget {
  return {
    ownerId: pair.ownerId,
    channel: pair.channel,
    accountId: pair.accountId,
    conversationId: pair.platformConversationId,
  };
}

function eventTarget(event: InboxRecord): DeliveryTarget | undefined {
  if (
    event.ownerId === undefined ||
    event.platformConversationId.length === 0
  ) {
    return undefined;
  }
  return {
    ownerId: event.ownerId,
    channel: event.channel,
    accountId: event.accountId,
    conversationId: event.platformConversationId,
  };
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

function assertPrivateParent(socketPath: string): void {
  const parent = path.dirname(socketPath);
  const stat = lstatOrUndefined(parent);
  if (stat === undefined) {
    throw new Error("coding socket directory does not exist");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("coding socket parent must be a real directory");
  }
  const uid = currentUid();
  if (uid === undefined) {
    throw new Error("coding relay requires a POSIX host");
  }
  if (stat.uid !== uid) {
    throw new Error("coding socket directory must be owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("coding socket directory must be private (mode 0700)");
  }
}

async function probeSocket(socketPath: string): Promise<"alive" | "stale" | "unknown"> {
  const { promise, resolve } = Promise.withResolvers<"alive" | "stale" | "unknown">();
  const socket = createConnection(socketPath);
  let settled = false;
  const finish = (result: "alive" | "stale" | "unknown"): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(result);
  };
  const timer = setTimeout(() => finish("unknown"), 500);
  timer.unref?.();
  socket.once("connect", () => finish("alive"));
  socket.once("error", (error: NodeJS.ErrnoException) =>
    finish(error.code === "ECONNREFUSED" ? "stale" : "unknown"),
  );
  return promise;
}

/**
 * Refuse to clobber an existing path. A socket that is verified to be a
 * dead socket owned by this user may be replaced; anything else is an error.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  const stat = lstatOrUndefined(socketPath);
  if (stat === undefined) {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new Error("refusing to use a symlinked coding socket path");
  }
  if (!stat.isSocket()) {
    throw new Error("refusing to replace a non-socket coding socket path");
  }
  const uid = currentUid();
  if (uid === undefined || stat.uid !== uid) {
    throw new Error("refusing to replace a coding socket owned by another user");
  }
  const probe = await probeSocket(socketPath);
  if (probe === "alive") {
    throw new Error("coding socket is already in use");
  }
  if (probe !== "stale") {
    throw new Error("cannot verify that the existing coding socket is stale");
  }
  unlinkSync(socketPath);
}

export class CodingRelay {
  readonly #store: Store;
  readonly #now: () => Date;

  #pair: PersistedPair | undefined;
  #pairCorrupt = false;
  #server: Server | undefined;
  #client: Socket | undefined;
  #clientState: ClientState = "idle";
  #buffer = "";
  #offer: Offer | undefined;
  #turn: ActiveTurn | undefined;
  /** Nonces already offered are burned for the host process lifetime. */
  #usedNonces = new Set<string>();
  #usedNonceOrder: string[] = [];
  #ignoredTurns = new Set<string>();
  #ignoredOrder: string[] = [];
  #socketPath: string | undefined;
  #socketIdentity: { dev: number; ino: number } | undefined;
  #listening = false;
  #closed = false;

  constructor(store: Store, options: CodingRelayOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    const raw = this.#store.metaGet(PAIR_META_KEY);
    this.#pair = parsePairState(raw);
    this.#pairCorrupt =
      this.#pair === undefined && raw !== undefined && raw !== "";
  }

  /** Bind a private Unix-domain socket. The parent must already be 0700. */
  async listen(absoluteSocketPath: string): Promise<void> {
    if (this.#closed) {
      throw new Error("coding relay is closed");
    }
    if (this.#server !== undefined) {
      throw new Error("coding relay is already listening");
    }
    if (!path.isAbsolute(absoluteSocketPath)) {
      throw new Error("coding socket path must be absolute");
    }
    if (Buffer.byteLength(absoluteSocketPath, "utf8") > MAX_SOCKET_PATH_BYTES) {
      throw new Error("coding socket path is too long");
    }
    assertPrivateParent(absoluteSocketPath);
    await clearStaleSocket(absoluteSocketPath);

    const server = createServer({ allowHalfOpen: false }, (socket) =>
      this.#onConnection(socket),
    );
    // Node's own queue is kept small; #onConnection also enforces one peer.
    server.maxConnections = 8;

    const { promise: listening, resolve, reject } =
      Promise.withResolvers<void>();
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(absoluteSocketPath);
    } catch (error: unknown) {
      server.off("error", onError);
      server.off("listening", onListening);
      try {
        server.close();
      } catch {
        // Nothing to clean up.
      }
      throw error;
    }
    await listening.catch((error: unknown) => {
      try {
        server.close();
      } catch {
        // Nothing to clean up.
      }
      throw error;
    });

    // Later accept errors must not crash the host process.
    server.on("error", () => undefined);

    let identity: { dev: number; ino: number } | undefined;
    try {
      const stat = lstatSync(absoluteSocketPath);
      const uid = currentUid();
      if (
        stat.isSymbolicLink() ||
        !stat.isSocket() ||
        uid === undefined ||
        stat.uid !== uid
      ) {
        throw new Error("coding socket failed its post-listen ownership check");
      }
      identity = { dev: stat.dev, ino: stat.ino };
      chmodSync(absoluteSocketPath, 0o600);
    } catch (error: unknown) {
      try {
        server.close();
      } catch {
        // Nothing to clean up.
      }
      try {
        const current = lstatSync(absoluteSocketPath);
        if (
          identity !== undefined &&
          current.isSocket() &&
          !current.isSymbolicLink() &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        ) {
          unlinkSync(absoluteSocketPath);
        }
      } catch {
        // Only remove our own socket name.
      }
      throw error;
    }
    this.#socketIdentity = identity;

    this.#server = server;
    this.#socketPath = absoluteSocketPath;
    this.#listening = true;
  }

  /** Idempotent and safe during shutdown or partial startup. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#listening = false;
    this.#clearOffer();

    const client = this.#client;
    this.#client = undefined;
    this.#clientState = "idle";
    this.#buffer = "";
    this.#turn = undefined;
    if (client !== undefined) {
      try {
        client.destroy();
      } catch {
        // A dead socket needs no cleanup.
      }
    }

    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      try {
        server.close();
      } catch {
        // Already closed.
      }
    }

    const socketPath = this.#socketPath;
    const identity = this.#socketIdentity;
    this.#socketPath = undefined;
    this.#socketIdentity = undefined;
    if (socketPath !== undefined && identity !== undefined) {
      try {
        const stat = lstatSync(socketPath);
        const uid = currentUid();
        if (
          stat.isSocket() &&
          !stat.isSymbolicLink() &&
          stat.dev === identity.dev &&
          stat.ino === identity.ino &&
          (uid === undefined || stat.uid === uid)
        ) {
          unlinkSync(socketPath);
        }
      } catch {
        // Never fail shutdown over socket cleanup.
      }
    }
  }

  /**
   * Router entry point. Only explicitly eligible owner P2P messages are
   * consumed; anything else returns undefined so core routing continues.
   * Consumed events always return []: replies are written as durable Outbox
   * rows so they carry the coding trace marker and survive delivery delays.
   */
  handle(event: InboxRecord): ReplyDraft[] | undefined {
    if (!this.#eligible(event)) {
      return undefined;
    }

    const text = event.text?.trim() ?? "";
    if (/^\/code(?:\s|$)/.test(text)) {
      return this.#handleCode(event, text);
    }
    // Other slash commands remain core commands, even in a paired
    // conversation. Only plain text can become a coding prompt.
    if (text.startsWith("/")) {
      return undefined;
    }

    const pair = this.#pair;
    if (pair === undefined && this.#store.metaGet(`${INBOX_META_PREFIX}${event.id}`) !== undefined) {
      // Recovery can race /code leave. A consumed coding input must not fall
      // through to the general Router after its terminal is gone.
      return [];
    }
    if (pair === undefined) {
      if (this.#pairCorrupt) {
        if (this.#consume(event.id, "prompt:corrupt")) {
          this.#replyToEvent(
            event,
            "failure",
            "配对状态无法读取，本条消息未转发。请发送 /code leave 清除后重新配对。",
            "corrupt",
          );
        }
        return [];
      }
      return undefined;
    }
    if (!this.#inPairedScope(event, pair)) {
      return undefined;
    }
    return this.#handlePairedText(event, text, pair);
  }

  #eligible(event: InboxRecord): boolean {
    if (
      event.status !== "accepted" ||
      event.channel !== "feishu" ||
      event.actorType !== "user" ||
      event.chatType !== "p2p" ||
      event.ownerId === undefined ||
      event.conversationId === undefined ||
      event.platformConversationId.length === 0
    ) {
      return false;
    }
    // Defend the ingress decision: the sender must still be a live bound
    // owner for this account, and the internal conversation must point at
    // the same owner and platform address.
    const owner = this.#store.findOwner(
      event.channel,
      event.accountId,
      event.actorId,
    );
    if (owner === undefined || owner.id !== event.ownerId) {
      return false;
    }
    const conversation = this.#store.getConversation(event.conversationId);
    if (conversation === undefined) {
      return false;
    }
    return (
      conversation.ownerId === event.ownerId &&
      conversation.channel === event.channel &&
      conversation.accountId === event.accountId &&
      conversation.platformConversationId === event.platformConversationId &&
      conversation.kind === "p2p"
    );
  }

  #samePairedConversation(event: InboxRecord, pair: PersistedPair): boolean {
    return (
      event.ownerId === pair.ownerId &&
      event.channel === pair.channel &&
      event.accountId === pair.accountId &&
      event.conversationId === pair.conversationId &&
      event.platformConversationId === pair.platformConversationId
    );
  }

  /**
   * Plain chat is gated by the durable platform address, not only the local
   * conversation row id: a rebuilt row must still fail closed (never reach
   * the general model) while a pairing exists.
   */
  #inPairedScope(event: InboxRecord, pair: PersistedPair): boolean {
    return (
      event.ownerId === pair.ownerId &&
      event.channel === pair.channel &&
      event.accountId === pair.accountId &&
      event.platformConversationId === pair.platformConversationId
    );
  }

  /**
   * Persist the dedupe marker before any side effect. A crash after this
   * point is an unknown outcome, never an automatic re-execution.
   */
  #consume(inboxId: string, kind: string): boolean {
    const key = `${INBOX_META_PREFIX}${inboxId}`;
    if (this.#store.metaGet(key) !== undefined) {
      return false;
    }
    this.#store.metaSet(key, kind);
    return true;
  }

  #enqueue(
    target: DeliveryTarget,
    purpose: "status" | "result" | "failure" | "approval",
    text: string,
    businessKey: string,
    inboxId: string,
  ): void {
    const at = this.#now().toISOString();
    this.#store.enqueueOutbox({
      businessKey,
      ownerId: target.ownerId,
      channel: target.channel,
      accountId: target.accountId,
      conversationId: target.conversationId,
      purpose,
      text,
      createdAt: at,
      traceId: `${TRACE_PREFIX}${inboxId}`,
    });
  }

  #replyToEvent(
    event: InboxRecord,
    purpose: "status" | "failure",
    text: string,
    suffix: string,
  ): void {
    const target = eventTarget(event);
    if (target === undefined) {
      return;
    }
    this.#enqueue(
      target,
      purpose,
      text,
      `${BUSINESS_PREFIX}${event.id}:${suffix}`,
      event.id,
    );
  }

  #handleCode(event: InboxRecord, text: string): ReplyDraft[] {
    const match = /^\/code(?:\s+([\s\S]*))?$/.exec(text);
    const args = match?.[1]?.trim() ?? "";
    const tokens = args.length === 0 ? [] : args.split(/\s+/);
    const sub = (tokens[0] ?? "help").toLowerCase();

    if (!this.#consume(event.id, `code:${sub}`)) {
      // A recovered inbox is already reflected by a durable reply or has
      // an unknown side effect; never repeat a decision.
      return [];
    }

    if (args.length === 0 || sub === "help") {
      this.#replyToEvent(
        event,
        "status",
        [
          "/code 用法：",
          "/code pair <配对码> 绑定本机 omp 工作区",
          "/code status 查看配对与当前轮次",
          "/code stop 停止当前轮次",
          "/code leave 解除配对",
          "/code allow <审批号> 允许一次工具调用",
          "/code deny <审批号> 拒绝一次工具调用",
          "其他 / 命令仍由主 Agent 处理。",
        ].join("\n"),
        "help",
      );
      return [];
    }

    if (
      this.#pair !== undefined &&
      event.ownerId !== this.#pair.ownerId
    ) {
      this.#replyToEvent(
        event,
        "failure",
        "当前 omp 配对属于其他主人，操作被拒绝。",
        "owner-scope",
      );
      return [];
    }

    if (this.#pair !== undefined && !this.#samePairedConversation(event, this.#pair) &&
      (sub === "status" || sub === "leave" || sub === "pair")) {
      this.#replyToEvent(event, "failure", "请在原配对私聊中操作。", "conversation-scope");
      return [];
    }
    if (tokens.length > (["pair", "allow", "deny"].includes(sub) ? 2 : 1)) {
      this.#replyToEvent(event, "failure", "每次只接受一条完整的 /code 指令。", "usage");
      return [];
    }
    if (sub === "status") {
      this.#replyToEvent(event, "status", this.#statusText(), "status");
      return [];
    }

    if (sub === "pair") {
      this.#pairCommand(event, tokens[1] ?? "");
      return [];
    }

    if (sub === "stop") {
      this.#stopCommand(event);
      return [];
    }

    if (sub === "leave") {
      this.#leaveCommand(event);
      return [];
    }

    if (sub === "allow" || sub === "deny") {
      this.#decisionCommand(event, sub === "allow", tokens[1] ?? "");
      return [];
    }

    this.#replyToEvent(
      event,
      "failure",
      "无法识别的 /code 子命令。发送 /code 查看用法。",
      "usage",
    );
    return [];
  }

  #statusText(): string {
    if (this.#pairCorrupt) {
      return "omp 配对：配对状态无法读取。请发送 /code leave 清除后重新配对。";
    }
    const pair = this.#pair;
    const lines: string[] = [];
    if (!this.#listening) {
      lines.push("omp 配对：本宿主未启用编码套接字（PA_CODING_SOCKET 未设置）。");
      if (pair !== undefined) {
        lines.push(
          `已记录的配对工作区：「${pair.workspace}」（当前不可用；/code leave 可清除）。`,
        );
      }
    } else if (this.#clientState === "paired" && pair !== undefined) {
      lines.push("omp 配对：已连接", `工作区：「${pair.workspace}」`);
      if (this.#turn !== undefined) {
        lines.push("当前轮次：运行中");
        const approval = this.#turn.pendingApproval;
        if (approval !== undefined) {
          const remaining = Math.max(
            0,
            Math.ceil(
              (approval.createdAt + APPROVAL_TTL_MS - this.#now().getTime()) /
                1000,
            ),
          );
          lines.push(
            `待审批：${approval.nonce.toLowerCase()}（约 ${remaining} 秒内有效）`,
          );
        }
      } else {
        lines.push("当前轮次：空闲");
      }
    } else if (this.#clientState === "offered" && this.#offer !== undefined) {
      lines.push(
        "omp 配对：等待主人确认",
        `工作区：「${this.#offer.workspace}」`,
        "在 omp 终端查看配对码后发送 /code pair <配对码>。",
      );
    } else if (pair !== undefined) {
      lines.push(
        "omp 配对：已断开",
        `工作区：「${pair.workspace}」`,
        "普通消息不会转发。请在 omp 重新连接并用 /code pair 配对，或发送 /code leave 解除。",
      );
    } else if (this.#clientState === "idle") {
      lines.push("omp 配对：未配对。", "当前没有 omp 连接。");
    } else {
      lines.push("omp 配对：未配对。");
    }
    return lines.join("\n");
  }

  #pairCommand(event: InboxRecord, rawCode: string): void {
    if (!this.#listening) {
      this.#replyToEvent(
        event,
        "failure",
        "此宿主未启用 omp 配对（PA_CODING_SOCKET 未设置）。",
        "pair-disabled",
      );
      return;
    }
    if (this.#clientState === "paired" && this.#client !== undefined) {
      const workspace = this.#pair?.workspace ?? "未知";
      this.#replyToEvent(
        event,
        "status",
        `当前已配对工作区「${workspace}」。如需更换，请先发送 /code leave。`,
        "pair-busy",
      );
      return;
    }
    const offer = this.#offer;
    const socket = this.#client;
    if (
      this.#clientState !== "offered" ||
      offer === undefined ||
      socket === undefined
    ) {
      this.#replyToEvent(
        event,
        "failure",
        "当前没有等待配对的 omp 会话。请先在 omp 中打开工作区并连接。",
        "pair-none",
      );
      return;
    }
    if (rawCode.length === 0) {
      this.#replyToEvent(event, "failure", "用法：/code pair <配对码>", "pair-usage");
      return;
    }
    if (this.#now().getTime() >= offer.expiresAt) {
      this.#replyToEvent(
        event,
        "failure",
        "配对码已过期。请在 omp 中重新连接以获取新配对码。",
        "pair-expired",
      );
      this.#invalidateOffer(true);
      return;
    }
    if (offer.attempts >= OFFER_MAX_ATTEMPTS) {
      this.#replyToEvent(
        event,
        "failure",
        "配对尝试次数过多。请在 omp 中重新连接以获取新配对码。",
        "pair-blocked",
      );
      this.#invalidateOffer(true);
      return;
    }

    const normalized = rawCode.replace(/[\s-]+/g, "").toUpperCase();
    if (!sameSecret(normalized, offer.code)) {
      offer.attempts += 1;
      if (offer.attempts >= OFFER_MAX_ATTEMPTS) {
        this.#replyToEvent(
          event,
          "failure",
          "配对码不正确，已达尝试上限。请在 omp 中重新连接。",
          "pair-attempts",
        );
        this.#invalidateOffer(true);
      } else {
        this.#replyToEvent(
          event,
          "failure",
          "配对码不正确。配对码显示在 omp 终端，注意区分大小写。",
          "pair-wrong",
        );
      }
      return;
    }

    const workspace = offer.workspace;
    if (!this.#send({ type: "paired" })) {
      this.#replyToEvent(
        event,
        "failure",
        "与 omp 的连接已断开，配对未完成。",
        "pair-disconnected",
      );
      this.#invalidateOffer(true);
      return;
    }

    const ownerId = event.ownerId;
    const conversationId = event.conversationId;
    if (ownerId === undefined || conversationId === undefined) {
      this.#replyToEvent(event, "failure", "配对失败：活动范围不完整。", "pair-scope");
      this.#invalidateOffer(true);
      return;
    }

    const pair: PersistedPair = {
      version: 1,
      ownerId,
      channel: event.channel,
      accountId: event.accountId,
      platformConversationId: event.platformConversationId,
      conversationId,
      workspace,
      pairedAt: event.occurredAt ?? event.receivedAt,
    };
    this.#store.metaSet(PAIR_META_KEY, JSON.stringify(pair));
    this.#pair = pair;
    this.#pairCorrupt = false;
    this.#ignoredTurns.clear();
    this.#ignoredOrder = [];
    this.#clearOffer();
    this.#clientState = "paired";
    this.#turn = undefined;
    this.#replyToEvent(
      event,
      "status",
      [
        `已配对工作区「${workspace}」。`,
        "直接发送普通消息即可交给 omp；/code stop 停止当前轮次，/code leave 解除。",
      ].join("\n"),
      "pair-ok",
    );
  }

  #stopCommand(event: InboxRecord): void {
    const pair = this.#pair;
    if (pair === undefined) {
      this.#replyToEvent(event, "failure", "当前未配对。", "stop-unpaired");
      return;
    }
    if (!this.#samePairedConversation(event, pair)) {
      this.#replyToEvent(
        event,
        "failure",
        "停止只能在已配对的主人对一对话中执行。",
        "stop-scope",
      );
      return;
    }
    if (
      this.#clientState !== "paired" ||
      this.#client === undefined ||
      this.#turn === undefined
    ) {
      this.#replyToEvent(
        event,
        "status",
        "当前没有运行中的编码轮次。",
        "stop-idle",
      );
      return;
    }

    const id = this.#turn.inboxId;
    this.#turn = undefined;
    this.#rememberIgnored(id);
    if (!this.#send({ type: "stop", id })) {
      this.#replyToEvent(
        event,
        "failure",
        "与 omp 的连接已断开，停止请求未送达；本轮状态未知。",
        "stop-unsent",
      );
      return;
    }
    this.#replyToEvent(
      event,
      "status",
      "已请求停止本轮；未完成的工具审批已失效。",
      "stop-ok",
    );
  }

  #leaveCommand(event: InboxRecord): void {
    const pair = this.#pair;
    const hadClient = this.#client !== undefined;
    if (pair === undefined && !hadClient && !this.#pairCorrupt) {
      this.#replyToEvent(event, "status", "当前未配对。", "leave-none");
      return;
    }

    this.#forgetPair();
    this.#turn = undefined;
    this.#clearOffer();
    this.#clientState = "idle";
    this.#buffer = "";
    const client = this.#client;
    this.#client = undefined;
    if (client !== undefined) {
      try {
        client.destroy();
      } catch {
        // Already gone.
      }
    }
    this.#replyToEvent(
      event,
      "status",
      "已解除配对，omp 连接已断开。普通消息恢复由主 Agent 处理。",
      "leave-ok",
    );
  }

  #decisionCommand(event: InboxRecord, allow: boolean, rawNonce: string): void {
    const pair = this.#pair;
    if (pair === undefined) {
      this.#replyToEvent(event, "failure", "当前未配对。", "decision-unpaired");
      return;
    }
    if (!this.#samePairedConversation(event, pair)) {
      this.#replyToEvent(
        event,
        "failure",
        "审批只能在与 omp 配对的主人对一对话中提交。",
        "decision-scope",
      );
      return;
    }
    if (
      this.#clientState !== "paired" ||
      this.#client === undefined ||
      this.#turn === undefined
    ) {
      this.#replyToEvent(
        event,
        "failure",
        "当前没有运行中的轮次，审批已失效。",
        "decision-idle",
      );
      return;
    }
    const nonce = rawNonce.trim();
    if (!NONCE_PATTERN.test(nonce)) {
      this.#replyToEvent(
        event,
        "failure",
        "用法：/code allow <审批号> 或 /code deny <审批号>",
        "decision-usage",
      );
      return;
    }
    const turn = this.#turn;
    const approval = turn.pendingApproval;
    if (approval === undefined) {
      this.#replyToEvent(
        event,
        "failure",
        "当前没有待审批的工具调用（可能已处理、已停止或已断开）。",
        "decision-none",
      );
      return;
    }
    if (approval.nonce.toLowerCase() !== nonce.toLowerCase()) {
      this.#replyToEvent(
        event,
        "failure",
        "审批号不匹配。",
        "decision-mismatch",
      );
      return;
    }
    if (this.#now().getTime() >= approval.createdAt + APPROVAL_TTL_MS) {
      turn.pendingApproval = undefined;
      this.#replyToEvent(
        event,
        "failure",
        "审批已超时（60 秒），未发送决定。",
        "decision-expired",
      );
      return;
    }
    // Consume before writing: a duplicate or late decision can never
    // authorize another call, even if the socket write fails.
    turn.pendingApproval = undefined;
    const id = turn.inboxId;
    if (
      !this.#send({
        type: "decision",
        id,
        nonce: approval.nonce,
        allow,
      })
    ) {
      this.#replyToEvent(
        event,
        "failure",
        "与 omp 的连接已断开，审批决定未送达。",
        "decision-unsent",
      );
      return;
    }
    this.#replyToEvent(
      event,
      "status",
      allow
        ? "已提交允许决定；仅这一次工具调用有效。"
        : "已提交拒绝决定。",
      `decision-${allow ? "allow" : "deny"}`,
    );
  }

  #handlePairedText(
    event: InboxRecord,
    text: string,
    pair: PersistedPair,
  ): ReplyDraft[] {
    const marker = this.#store.metaGet(`${INBOX_META_PREFIX}${event.id}`);
    if (marker !== undefined) {
      // The marker survives a host crash. A forwarded prompt may or may not
      // have reached omp; report the uncertainty instead of re-executing it.
      // A durable final row means the outcome is already known.
      const finalKey = `${BUSINESS_PREFIX}${event.id}`;
      const finalized =
        this.#store.getOutboxByBusinessKey(`${finalKey}:result`) !== undefined ||
        this.#store.getOutboxByBusinessKey(`${finalKey}:error`) !== undefined;
      if (marker === "prompt" && !finalized) {
        this.#replyToEvent(
          event,
          "failure",
          "这条消息此前已转发给 omp；宿主重启后无法确认本轮结果，不会自动重试。请重新发送以开始新一轮。",
          "unknown",
        );
      }
      return [];
    }
    if ((event.occurredAt ?? event.receivedAt) < pair.pairedAt) {
      if (this.#consume(event.id, "prompt:older-than-pair")) {
        this.#replyToEvent(event, "failure", "这条消息早于当前配对，未交给此工作区。", "stale");
      }
      return [];
    }

    if (
      this.#clientState !== "paired" ||
      this.#client === undefined
    ) {
      if (!this.#consume(event.id, "prompt:offline")) {
        return [];
      }
      const detail =
        this.#clientState === "offered"
          ? `工作区「${pair.workspace}」的 omp 会话正在等待重新配对，本条消息未转发。请发送 /code pair <配对码>。`
          : `工作区「${pair.workspace}」的 omp 连接已断开，本条消息未转发。请在 omp 重新连接并配对，或发送 /code leave 结束配对。`;
      this.#replyToEvent(event, "failure", detail, "offline");
      return [];
    }

    if (text.length === 0) {
      if (!this.#consume(event.id, "prompt:empty")) {
        return [];
      }
      this.#replyToEvent(
        event,
        "status",
        "请发送要交给 omp 的工作内容。",
        "empty",
      );
      return [];
    }
    if (text.length > MAX_PROMPT_CHARS) {
      if (!this.#consume(event.id, "prompt:too-long")) {
        return [];
      }
      this.#replyToEvent(
        event,
        "failure",
        `消息过长（上限 ${MAX_PROMPT_CHARS} 字符），未转发。`,
        "too-long",
      );
      return [];
    }
    if (this.#turn !== undefined) {
      if (!this.#consume(event.id, "prompt:busy")) {
        return [];
      }
      this.#replyToEvent(
        event,
        "status",
        "上一轮仍在运行。请等待结果，或发送 /code stop 停止后再发送。",
        "busy",
      );
      return [];
    }

    if (!this.#consume(event.id, "prompt")) {
      return [];
    }

    if (!this.#send({ type: "prompt", id: event.id, text })) {
      this.#replyToEvent(
        event,
        "failure",
        "与 omp 的连接已断开，本条消息未转发。",
        "unsent",
      );
      return [];
    }
    this.#turn = {
      inboxId: event.id,
      progressSeq: 0,
    };
    return [];
  }

  #forgetPair(): void {
    this.#pair = undefined;
    this.#pairCorrupt = false;
    try {
      this.#store.db.run(`DELETE FROM pa_meta WHERE key = ?`, PAIR_META_KEY);
    } catch {
      // A failed delete must not leave a pairing that a restart would
      // resurrect; an empty value is treated as absent by the parser.
      try {
        this.#store.metaSet(PAIR_META_KEY, "");
      } catch {
        // The database is unavailable; the in-memory state is still cleared.
      }
    }
  }

  #rememberNonce(nonce: string): boolean {
    const lower = nonce.toLowerCase();
    if (this.#usedNonces.has(lower)) {
      return false;
    }
    this.#usedNonces.add(lower);
    this.#usedNonceOrder.push(lower);
    while (this.#usedNonceOrder.length > 64) {
      const removed = this.#usedNonceOrder.shift();
      if (removed !== undefined) {
        this.#usedNonces.delete(removed);
      }
    }
    return true;
  }

  #rememberIgnored(inboxId: string): void {
    if (this.#ignoredTurns.has(inboxId)) {
      return;
    }
    this.#ignoredTurns.add(inboxId);
    this.#ignoredOrder.push(inboxId);
    while (this.#ignoredOrder.length > MAX_IGNORED_TURNS) {
      const removed = this.#ignoredOrder.shift();
      if (removed !== undefined) {
        this.#ignoredTurns.delete(removed);
      }
    }
  }

  #onConnection(socket: Socket): void {
    if (this.#closed || this.#client !== undefined) {
      socket.destroy();
      return;
    }
    this.#client = socket;
    this.#clientState = "awaiting_hello";
    this.#buffer = "";
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => {
      if (socket === this.#client && this.#clientState === "awaiting_hello") {
        socket.destroy();
      }
    });
    socket.on("data", (chunk: Buffer | string) => {
      this.#onData(
        socket,
        typeof chunk === "string" ? chunk : chunk.toString("utf8"),
      );
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      this.#onClientClose(socket);
    });
  }

  #onData(socket: Socket, chunk: string): void {
    if (socket !== this.#client) {
      return;
    }
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > MAX_FRAME_BYTES) {
          socket.destroy();
        }
        return;
      }
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) {
        continue;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line) as unknown;
      } catch {
        socket.destroy();
        return;
      }
      try {
        this.#onFrame(frame);
      } catch {
        // A malformed or unpersistable peer frame fails closed.
        socket.destroy();
        return;
      }
      if (socket !== this.#client) {
        return;
      }
    }
  }

  #onFrame(frame: unknown): void {
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      this.#destroyClient();
      return;
    }
    const message = frame as PeerMessage;
    if (typeof message.type !== "string") {
      this.#destroyClient();
      return;
    }
    if (this.#clientState === "awaiting_hello") {
      if (message.type !== "hello") {
        this.#destroyClient();
        return;
      }
      const workspace = sanitizeWorkspace(message.workspace);
      if (workspace === undefined) {
        this.#destroyClient();
        return;
      }
      const socket = this.#client;
      if (socket === undefined) {
        return;
      }
      socket.setTimeout(0);
      this.#clientState = "offered";
      const timer = setTimeout(() => {
        if (this.#clientState === "offered" && this.#offer !== undefined) {
          this.#invalidateOffer(true);
        }
      }, OFFER_TTL_MS);
      timer.unref?.();
      const offer: Offer = {
        code: generateCode(),
        workspace,
        expiresAt: this.#now().getTime() + OFFER_TTL_MS,
        attempts: 0,
        timer,
      };
      this.#offer = offer;
      if (!this.#send({ type: "offer", code: offer.code })) {
        this.#invalidateOffer(true);
      }
      return;
    }
    if (this.#clientState !== "paired") {
      // Until /code pair succeeds, peer frames carry no authority.
      return;
    }
    switch (message.type) {
      case "progress":
        this.#onProgress(message);
        return;
      case "result":
        this.#onFinal(message, "result");
        return;
      case "error":
        this.#onFinal(message, "failure");
        return;
      case "approval":
        this.#onApproval(message);
        return;
      default:
        // Unknown frames are ignored; the wire is versioned by message type.
        return;
    }
  }

  #onProgress(message: PeerMessage): void {
    const turn = this.#turn;
    const pair = this.#pair;
    if (turn === undefined || pair === undefined) {
      return;
    }
    if (message.id !== turn.inboxId) {
      return;
    }
    if (turn.progressSeq >= MAX_PROGRESS_PER_TURN) {
      return;
    }
    const text = cleanInline(message.text, MAX_PROGRESS_CHARS);
    if (text.length === 0) {
      return;
    }
    turn.progressSeq += 1;
    this.#enqueue(
      pairTarget(pair),
      "status",
      text,
      `${BUSINESS_PREFIX}${turn.inboxId}:progress:${turn.progressSeq}`,
      turn.inboxId,
    );
  }

  #onFinal(message: PeerMessage, purpose: "result" | "failure"): void {
    const turn = this.#turn;
    const pair = this.#pair;
    if (turn === undefined || pair === undefined) {
      return;
    }
    if (message.id !== turn.inboxId || this.#ignoredTurns.has(turn.inboxId)) {
      return;
    }
    if (typeof message.text !== "string") {
      return;
    }
    // Peer text is untrusted display data. It is clipped and de-controlled
    // here, never parsed as a command or interpreted as authorization.
    const cleaned = cleanMultiline(message.text, MAX_RESULT_CHARS);
    const text =
      cleaned.length > 0
        ? cleaned
        : purpose === "result"
          ? "（omp 已结束本轮，但没有返回文本结果。）"
          : "（omp 报告错误，但没有返回详情。）";
    this.#turn = undefined;
    this.#enqueue(
      pairTarget(pair),
      purpose,
      text,
      `${BUSINESS_PREFIX}${turn.inboxId}:${purpose === "result" ? "result" : "error"}`,
      turn.inboxId,
    );
  }

  #onApproval(message: PeerMessage): void {
    const turn = this.#turn;
    const pair = this.#pair;
    if (turn === undefined || pair === undefined) {
      return;
    }
    if (message.id !== turn.inboxId || this.#ignoredTurns.has(turn.inboxId)) {
      return;
    }
    if (turn.pendingApproval !== undefined) {
      if (
        this.#now().getTime() >=
        turn.pendingApproval.createdAt + APPROVAL_TTL_MS
      ) {
        turn.pendingApproval = undefined;
      } else {
        return;
      }
    }
    if (typeof message.nonce !== "string" || !NONCE_PATTERN.test(message.nonce)) {
      return;
    }
    const preview = cleanMultiline(
      message.text,
      MAX_APPROVAL_PREVIEW_CHARS + 1,
    );
    if (preview.length === 0 || preview.length > MAX_APPROVAL_PREVIEW_CHARS) {
      // A truncated approval could hide arguments. The peer must fall back
      // to local consent for anything it cannot render safely and briefly.
      return;
    }
    if (!this.#rememberNonce(message.nonce)) {
      return;
    }
    const nonce = message.nonce;
    turn.pendingApproval = {
      nonce,
      createdAt: this.#now().getTime(),
    };
    const lower = nonce.toLowerCase();
    this.#enqueue(
      pairTarget(pair),
      "approval",
      [
        "omp 请求执行工具：",
        preview,
        "",
        `审批号：${lower}`,
        `允许：/code allow ${lower}`,
        `拒绝：/code deny ${lower}`,
        "60 秒内有效；仅这一次工具调用有效。",
      ].join("\n"),
      `${BUSINESS_PREFIX}${turn.inboxId}:approval:${lower}`,
      turn.inboxId,
    );
  }

  #onClientClose(socket: Socket): void {
    if (socket !== this.#client) {
      return;
    }
    const wasPaired = this.#clientState === "paired";
    const turn = this.#turn;
    const pair = this.#pair;
    this.#client = undefined;
    this.#clientState = "idle";
    this.#buffer = "";
    this.#turn = undefined;
    this.#clearOffer();
    if (
      !this.#closed &&
      wasPaired &&
      turn !== undefined &&
      pair !== undefined
    ) {
      try {
        this.#enqueue(
          pairTarget(pair),
          "failure",
          "与 omp 的连接已断开；本轮结果未知，不会自动重试。",
          `${BUSINESS_PREFIX}${turn.inboxId}:disconnect`,
          turn.inboxId,
        );
      } catch {
        // Shutdown or a failing database must not crash the close handler.
      }
    }
  }

  #destroyClient(): void {
    const socket = this.#client;
    if (socket === undefined) {
      return;
    }
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
  }

  #send(frame: Record<string, unknown>): boolean {
    const socket = this.#client;
    if (socket === undefined || socket.destroyed || !socket.writable) {
      return false;
    }
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      return false;
    }
    try {
      socket.write(line);
      return true;
    } catch {
      return false;
    }
  }

  #clearOffer(): void {
    if (this.#offer !== undefined) {
      clearTimeout(this.#offer.timer);
      this.#offer = undefined;
    }
  }

  #invalidateOffer(closeClient: boolean): void {
    this.#clearOffer();
    if (closeClient) {
      this.#destroyClient();
    }
  }
}
