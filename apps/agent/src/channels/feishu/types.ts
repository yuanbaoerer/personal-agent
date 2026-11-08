import type { InboundEnvelope } from "../../domain/types.ts";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  apiBase?: string;
  timeoutMs?: number;
  accountId?: string;
}

export interface FeishuRawRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export type FeishuParseResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "event"; event: InboundEnvelope }
  | { kind: "ignored"; reason: string };
