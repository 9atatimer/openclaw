import { afterEach, describe, expect, test } from "vitest";
import {
  clearAllSupergroupViolationsForTesting,
  clearSupergroupViolation,
  evaluateSupergroupDmStatus,
  formatSupergroupViolationBanner,
  getSupergroupViolation,
  loadSupergroupDmWhitelistFromEnv,
  normalizeSupergroupDmWhitelistEntries,
  recordSupergroupViolation,
  type SupergroupDmWhitelistEntry,
} from "./supergroup-dm-whitelist.js";

afterEach(() => {
  clearAllSupergroupViolationsForTesting();
});

const baseEntry: SupergroupDmWhitelistEntry = {
  chatId: "-1001234567890",
  userId: "99887766",
  threadIds: [7, 11],
};

describe("normalizeSupergroupDmWhitelistEntries", () => {
  test("coerces numeric ids and snake_case keys", () => {
    const result = normalizeSupergroupDmWhitelistEntries([
      { chat_id: -1001234567890, user_id: 99887766, thread_ids: [7, "11"] },
      { chatId: "-987", userId: "55" },
    ]);
    expect(result).toEqual([
      { chatId: "-1001234567890", userId: "99887766", threadIds: [7, 11] },
      { chatId: "-987", userId: "55" },
    ]);
  });

  test("drops entries missing required ids", () => {
    expect(
      normalizeSupergroupDmWhitelistEntries([
        { chatId: "-1", userId: "" },
        { chatId: "", userId: "5" },
        { chatId: "-2", userId: "5" },
        "garbage",
        null,
      ]),
    ).toEqual([{ chatId: "-2", userId: "5" }]);
  });
});

describe("loadSupergroupDmWhitelistFromEnv", () => {
  test("parses inline JSON env var", () => {
    const env = {
      OPENCLAW_TELEGRAM_SUPERGROUP_DM_WHITELIST: JSON.stringify([
        { chatId: "-1001234567890", userId: "99887766", threadIds: [7] },
      ]),
    } satisfies NodeJS.ProcessEnv;
    expect(loadSupergroupDmWhitelistFromEnv(env)).toEqual([
      { chatId: "-1001234567890", userId: "99887766", threadIds: [7] },
    ]);
  });

  test("merges inline and file sources, ignores invalid JSON gracefully", () => {
    const env = {
      OPENCLAW_TELEGRAM_SUPERGROUP_DM_WHITELIST: "not-json",
      OPENCLAW_TELEGRAM_SUPERGROUP_DM_WHITELIST_FILE: "/tmp/wl.json",
    } satisfies NodeJS.ProcessEnv;
    const result = loadSupergroupDmWhitelistFromEnv(env, {
      existsSync: ((path: string) => path === "/tmp/wl.json") as never,
      readFileSync: ((path: string) =>
        path === "/tmp/wl.json" ? JSON.stringify([{ chatId: "-1", userId: "5" }]) : "") as never,
    });
    expect(result).toEqual([{ chatId: "-1", userId: "5" }]);
  });

  test("returns empty list when nothing configured", () => {
    expect(loadSupergroupDmWhitelistFromEnv({})).toEqual([]);
  });
});

describe("evaluateSupergroupDmStatus", () => {
  test("off when chat type is direct", () => {
    expect(
      evaluateSupergroupDmStatus({
        chatType: "private",
        chatId: "-1001234567890",
        senderId: "99887766",
        messageThreadId: 7,
        whitelist: [baseEntry],
      }),
    ).toEqual({ kind: "off" });
  });

  test("off when chat is not whitelisted", () => {
    expect(
      evaluateSupergroupDmStatus({
        chatType: "supergroup",
        chatId: "-9999",
        senderId: "99887766",
        messageThreadId: 7,
        whitelist: [baseEntry],
      }),
    ).toEqual({ kind: "off" });
  });

  test("active when chat + topic + sender all match", () => {
    const status = evaluateSupergroupDmStatus({
      chatType: "supergroup",
      chatId: "-1001234567890",
      senderId: "99887766",
      messageThreadId: 7,
      whitelist: [baseEntry],
    });
    expect(status.kind).toBe("active");
    if (status.kind === "active") {
      expect(status.entry.userId).toBe("99887766");
    }
  });

  test("active for any topic when entry omits threadIds", () => {
    const open: SupergroupDmWhitelistEntry = { chatId: "-1", userId: "5" };
    const status = evaluateSupergroupDmStatus({
      chatType: "supergroup",
      chatId: "-1",
      senderId: "5",
      messageThreadId: 42,
      whitelist: [open],
    });
    expect(status.kind).toBe("active");
  });

  test("violation when sender does not match", () => {
    const status = evaluateSupergroupDmStatus({
      chatType: "supergroup",
      chatId: "-1001234567890",
      senderId: "31415",
      messageThreadId: 7,
      whitelist: [baseEntry],
    });
    expect(status).toMatchObject({
      kind: "violation",
      reason: "unauthorized-sender",
      violatorId: "31415",
      violatorThreadId: 7,
    });
  });

  test("violation when topic is outside the entry's threadIds", () => {
    const status = evaluateSupergroupDmStatus({
      chatType: "supergroup",
      chatId: "-1001234567890",
      senderId: "99887766",
      messageThreadId: 999,
      whitelist: [baseEntry],
    });
    expect(status).toMatchObject({
      kind: "violation",
      reason: "unauthorized-topic",
      violatorId: "99887766",
      violatorThreadId: 999,
    });
  });

  test("multiple chat entries: pick the matching user", () => {
    const wl: SupergroupDmWhitelistEntry[] = [
      { chatId: "-1", userId: "111", threadIds: [1] },
      { chatId: "-1", userId: "222", threadIds: [2] },
    ];
    const status = evaluateSupergroupDmStatus({
      chatType: "supergroup",
      chatId: "-1",
      senderId: "222",
      messageThreadId: 2,
      whitelist: wl,
    });
    expect(status.kind).toBe("active");
    if (status.kind === "active") {
      expect(status.entry.userId).toBe("222");
    }
  });
});

describe("violation tracker", () => {
  test("record/get/clear lifecycle", () => {
    expect(getSupergroupViolation(baseEntry.chatId)).toBeUndefined();
    const record = recordSupergroupViolation({
      entry: baseEntry,
      reason: "unauthorized-sender",
      violatorId: "31415",
      violatorThreadId: 7,
      nowMs: 1700000000000,
    });
    expect(record).toEqual({
      chatId: baseEntry.chatId,
      whitelistedUserId: baseEntry.userId,
      reason: "unauthorized-sender",
      lastViolatorId: "31415",
      lastViolatorThreadId: 7,
      detectedAtMs: 1700000000000,
    });
    expect(getSupergroupViolation(baseEntry.chatId)).toEqual(record);
    clearSupergroupViolation(baseEntry.chatId);
    expect(getSupergroupViolation(baseEntry.chatId)).toBeUndefined();
  });

  test("subsequent record overwrites latest violator", () => {
    recordSupergroupViolation({
      entry: baseEntry,
      reason: "unauthorized-sender",
      violatorId: "111",
      nowMs: 1,
    });
    recordSupergroupViolation({
      entry: baseEntry,
      reason: "unauthorized-topic",
      violatorId: "222",
      violatorThreadId: 4,
      nowMs: 2,
    });
    expect(getSupergroupViolation(baseEntry.chatId)).toMatchObject({
      reason: "unauthorized-topic",
      lastViolatorId: "222",
      lastViolatorThreadId: 4,
      detectedAtMs: 2,
    });
  });
});

describe("formatSupergroupViolationBanner", () => {
  test("includes violator id and topic for sender violations", () => {
    const banner = formatSupergroupViolationBanner({
      chatId: "-1",
      whitelistedUserId: "99",
      reason: "unauthorized-sender",
      lastViolatorId: "31415",
      lastViolatorThreadId: 7,
      detectedAtMs: 0,
    });
    expect(banner).toContain("non-whitelisted sender");
    expect(banner).toContain("sender 31415");
    expect(banner).toContain("topic 7");
    expect(banner).toContain("group permissions enforced");
  });

  test("indicates unauthorized topic without including the whitelisted user id", () => {
    const banner = formatSupergroupViolationBanner({
      chatId: "-1",
      whitelistedUserId: "99",
      reason: "unauthorized-topic",
      lastViolatorId: "99",
      lastViolatorThreadId: 999,
      detectedAtMs: 0,
    });
    expect(banner).toContain("unauthorized topic");
    expect(banner).not.toContain("sender 99");
    expect(banner).toContain("topic 999");
  });
});
