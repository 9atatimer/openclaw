import { existsSync, readFileSync } from "node:fs";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

export type SupergroupDmWhitelistEntry = {
  chatId: string;
  threadIds?: readonly number[];
  userId: string;
};

export type SupergroupDmStatus =
  | { kind: "off" }
  | { kind: "active"; entry: SupergroupDmWhitelistEntry }
  | {
      kind: "violation";
      entry: SupergroupDmWhitelistEntry;
      reason: "unauthorized-sender" | "unauthorized-topic";
      violatorId?: string;
      violatorThreadId?: number;
    };

export type SupergroupViolationRecord = {
  chatId: string;
  whitelistedUserId: string;
  reason: "unauthorized-sender" | "unauthorized-topic";
  lastViolatorId?: string;
  lastViolatorThreadId?: number;
  detectedAtMs: number;
};

const ENV_VAR = "OPENCLAW_TELEGRAM_SUPERGROUP_DM_WHITELIST";
const FILE_ENV_VAR = "OPENCLAW_TELEGRAM_SUPERGROUP_DM_WHITELIST_FILE";

function normalizeId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function normalizeThreadIds(value: unknown): readonly number[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids: number[] = [];
  for (const raw of value) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      ids.push(Math.trunc(raw));
      continue;
    }
    if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
      ids.push(Number.parseInt(raw.trim(), 10));
    }
  }
  return ids.length > 0 ? Object.freeze(ids) : undefined;
}

export function normalizeSupergroupDmWhitelistEntries(
  input: unknown,
): SupergroupDmWhitelistEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const entries: SupergroupDmWhitelistEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const chatId = normalizeId(record.chatId ?? record.chat_id);
    const userId = normalizeId(record.userId ?? record.user_id);
    if (!chatId || !userId) {
      continue;
    }
    const threadIds = normalizeThreadIds(record.threadIds ?? record.thread_ids);
    entries.push(threadIds ? { chatId, userId, threadIds } : { chatId, userId });
  }
  return entries;
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source);
  } catch (err) {
    logVerbose(`telegram supergroup DM whitelist: failed to parse ${label}: ${String(err)}`);
    return undefined;
  }
}

export function loadSupergroupDmWhitelistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  io: { existsSync?: typeof existsSync; readFileSync?: typeof readFileSync } = {},
): SupergroupDmWhitelistEntry[] {
  const inline = env[ENV_VAR];
  const filePath = env[FILE_ENV_VAR];
  const exists = io.existsSync ?? existsSync;
  const read = io.readFileSync ?? readFileSync;
  const merged: SupergroupDmWhitelistEntry[] = [];
  if (inline && inline.trim().length > 0) {
    const parsed = parseJson(inline, ENV_VAR);
    merged.push(...normalizeSupergroupDmWhitelistEntries(parsed));
  }
  if (filePath && filePath.trim().length > 0 && exists(filePath)) {
    try {
      const body = read(filePath, "utf8");
      const parsed = parseJson(body, filePath);
      merged.push(...normalizeSupergroupDmWhitelistEntries(parsed));
    } catch (err) {
      logVerbose(`telegram supergroup DM whitelist: failed to read ${filePath}: ${String(err)}`);
    }
  }
  return merged;
}

let cachedWhitelist: SupergroupDmWhitelistEntry[] | undefined;

export function getSupergroupDmWhitelist(): readonly SupergroupDmWhitelistEntry[] {
  cachedWhitelist ??= loadSupergroupDmWhitelistFromEnv();
  return cachedWhitelist;
}

export function setSupergroupDmWhitelistForTesting(
  entries: readonly SupergroupDmWhitelistEntry[] | undefined,
): void {
  cachedWhitelist = entries ? [...entries] : undefined;
}

export function evaluateSupergroupDmStatus(params: {
  chatType: string | undefined;
  chatId: string | number;
  messageThreadId?: number;
  senderId?: string;
  whitelist: readonly SupergroupDmWhitelistEntry[];
}): SupergroupDmStatus {
  if (params.chatType !== "supergroup" && params.chatType !== "group") {
    return { kind: "off" };
  }
  const chatIdStr = String(params.chatId);
  const candidates = params.whitelist.filter((entry) => entry.chatId === chatIdStr);
  if (candidates.length === 0) {
    return { kind: "off" };
  }
  const senderIdStr = params.senderId && params.senderId.length > 0 ? params.senderId : undefined;
  const senderEntries = candidates.filter((entry) => entry.userId === senderIdStr);
  if (senderEntries.length === 0) {
    return {
      kind: "violation",
      entry: candidates[0],
      reason: "unauthorized-sender",
      violatorId: senderIdStr,
      violatorThreadId: params.messageThreadId,
    };
  }
  const topicMatch = senderEntries.find((entry) => {
    if (!entry.threadIds || entry.threadIds.length === 0) {
      return true;
    }
    return params.messageThreadId != null && entry.threadIds.includes(params.messageThreadId);
  });
  if (!topicMatch) {
    return {
      kind: "violation",
      entry: senderEntries[0],
      reason: "unauthorized-topic",
      violatorId: senderIdStr,
      violatorThreadId: params.messageThreadId,
    };
  }
  return { kind: "active", entry: topicMatch };
}

const violationStore = new Map<string, SupergroupViolationRecord>();

export function recordSupergroupViolation(params: {
  entry: SupergroupDmWhitelistEntry;
  reason: SupergroupViolationRecord["reason"];
  violatorId?: string;
  violatorThreadId?: number;
  nowMs?: number;
}): SupergroupViolationRecord {
  const record: SupergroupViolationRecord = {
    chatId: params.entry.chatId,
    whitelistedUserId: params.entry.userId,
    reason: params.reason,
    lastViolatorId: params.violatorId,
    lastViolatorThreadId: params.violatorThreadId,
    detectedAtMs: params.nowMs ?? Date.now(),
  };
  violationStore.set(record.chatId, record);
  return record;
}

export function getSupergroupViolation(
  chatId: string | number,
): SupergroupViolationRecord | undefined {
  return violationStore.get(String(chatId));
}

export function clearSupergroupViolation(chatId: string | number): void {
  violationStore.delete(String(chatId));
}

export function clearAllSupergroupViolationsForTesting(): void {
  violationStore.clear();
}

export function formatSupergroupViolationBanner(record: SupergroupViolationRecord): string {
  const head =
    record.reason === "unauthorized-topic"
      ? "DM-whitelist violation: unauthorized topic"
      : "DM-whitelist violation: non-whitelisted sender";
  const details: string[] = [];
  if (record.lastViolatorId && record.lastViolatorId !== record.whitelistedUserId) {
    details.push(`sender ${record.lastViolatorId}`);
  }
  if (record.lastViolatorThreadId != null) {
    details.push(`topic ${record.lastViolatorThreadId}`);
  }
  details.push("group permissions enforced");
  return `⚠️ ${head} — ${details.join(" · ")}`;
}
