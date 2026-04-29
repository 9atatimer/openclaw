import { afterEach, describe, expect, test } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import {
  clearAllSupergroupViolationsForTesting,
  getSupergroupViolation,
  setSupergroupDmWhitelistForTesting,
} from "./supergroup-dm-whitelist.js";

const SUPERGROUP_CHAT_ID = -1001234567890;
const WHITELISTED_USER_ID = 99887766;
const WHITELISTED_TOPIC_ID = 7;

const supergroupMessage = (overrides: Record<string, unknown> = {}) => ({
  chat: {
    id: SUPERGROUP_CHAT_ID,
    type: "supergroup",
    title: "Solo HQ",
    is_forum: true,
  },
  message_thread_id: WHITELISTED_TOPIC_ID,
  from: { id: WHITELISTED_USER_ID, first_name: "Solo" },
  ...overrides,
});

afterEach(() => {
  setSupergroupDmWhitelistForTesting(undefined);
  clearAllSupergroupViolationsForTesting();
});

describe("supergroup DM whitelist integration in buildTelegramMessageContext", () => {
  test("treats whitelisted supergroup+topic+user as a DM session", async () => {
    setSupergroupDmWhitelistForTesting([
      {
        chatId: String(SUPERGROUP_CHAT_ID),
        userId: String(WHITELISTED_USER_ID),
        threadIds: [WHITELISTED_TOPIC_ID],
      },
    ]);

    const ctx = await buildTelegramMessageContextForTest({
      message: supergroupMessage(),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.isGroup).toBe(false);
    expect(ctx?.ctxPayload.ChatType).toBe("direct");
    expect(ctx?.ctxPayload.SessionKey).toContain(`${SUPERGROUP_CHAT_ID}:${WHITELISTED_TOPIC_ID}`);
    expect(getSupergroupViolation(SUPERGROUP_CHAT_ID)).toBeUndefined();
  });

  test("non-whitelisted sender in whitelisted supergroup records a violation and stays group-mode", async () => {
    setSupergroupDmWhitelistForTesting([
      {
        chatId: String(SUPERGROUP_CHAT_ID),
        userId: String(WHITELISTED_USER_ID),
        threadIds: [WHITELISTED_TOPIC_ID],
      },
    ]);

    const ctx = await buildTelegramMessageContextForTest({
      message: supergroupMessage({
        from: { id: 31415, first_name: "Mallory" },
      }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.isGroup).toBe(true);
    expect(ctx?.ctxPayload.ChatType).toBe("group");
    const violation = getSupergroupViolation(SUPERGROUP_CHAT_ID);
    expect(violation?.reason).toBe("unauthorized-sender");
    expect(violation?.lastViolatorId).toBe("31415");
  });

  test("whitelisted user in non-whitelisted topic records an unauthorized-topic violation", async () => {
    setSupergroupDmWhitelistForTesting([
      {
        chatId: String(SUPERGROUP_CHAT_ID),
        userId: String(WHITELISTED_USER_ID),
        threadIds: [WHITELISTED_TOPIC_ID],
      },
    ]);

    const ctx = await buildTelegramMessageContextForTest({
      message: supergroupMessage({ message_thread_id: 999 }),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.isGroup).toBe(true);
    const violation = getSupergroupViolation(SUPERGROUP_CHAT_ID);
    expect(violation?.reason).toBe("unauthorized-topic");
    expect(violation?.lastViolatorThreadId).toBe(999);
  });

  test("unconfigured supergroups behave as ordinary groups", async () => {
    setSupergroupDmWhitelistForTesting([]);

    const ctx = await buildTelegramMessageContextForTest({
      message: supergroupMessage(),
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.isGroup).toBe(true);
    expect(ctx?.ctxPayload.ChatType).toBe("group");
    expect(getSupergroupViolation(SUPERGROUP_CHAT_ID)).toBeUndefined();
  });
});
