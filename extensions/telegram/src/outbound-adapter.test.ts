import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";
import {
  clearAllSupergroupViolationsForTesting,
  recordSupergroupViolation,
} from "./supergroup-dm-whitelist.js";

describe("telegramOutbound", () => {
  beforeEach(() => {
    pinMessageTelegramMock.mockReset();
    sendMessageTelegramMock.mockReset();
  });

  afterEach(() => {
    clearAllSupergroupViolationsForTesting();
  });

  it("forwards mediaLocalRoots in direct media sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-media" });

    const result = await telegramOutbound.sendMedia!({
      cfg: {} as never,
      to: "12345",
      text: "hello",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "ops",
      replyToId: "900",
      threadId: "12",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
        accountId: "ops",
        replyToMessageId: 900,
        messageThreadId: 12,
        textMode: "html",
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-media" });
  });

  it("sends payload media in sequence and keeps buttons on the first message only", async () => {
    sendMessageTelegramMock
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "12345" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        text: "Approval required",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
        channelData: {
          telegram: {
            quoteText: "quoted",
            buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
          },
        },
      },
      mediaLocalRoots: ["/tmp/media"],
      accountId: "ops",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      1,
      "12345",
      "Approval required",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      2,
      "12345",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
      }),
    );
    expect(
      (sendMessageTelegramMock.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons,
    ).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "tg-2", chatId: "12345" });
  });

  it("prepends a supergroup-DM violation banner to text replies for chats with a recorded violation", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-banner-1" });
    recordSupergroupViolation({
      entry: { chatId: "-1001234567890", userId: "99887766", threadIds: [7] },
      reason: "unauthorized-sender",
      violatorId: "31415",
      violatorThreadId: 7,
      nowMs: 1700000000000,
    });

    await telegramOutbound.sendText!({
      cfg: {} as never,
      to: "telegram:-1001234567890:topic:7",
      text: "hello world",
      accountId: "ops",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const sentText = sendMessageTelegramMock.mock.calls[0]?.[1] as string;
    expect(sentText.startsWith("⚠️")).toBe(true);
    expect(sentText).toContain("non-whitelisted sender");
    expect(sentText).toContain("hello world");
  });

  it("does not prepend a banner when no violation is recorded", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-clean" });

    await telegramOutbound.sendText!({
      cfg: {} as never,
      to: "telegram:-1001234567890:topic:7",
      text: "hello world",
      accountId: "ops",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock.mock.calls[0]?.[1]).toBe("hello world");
  });

  it("prepends a banner to payload sends as well", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-payload-1", chatId: "12345" });
    recordSupergroupViolation({
      entry: { chatId: "-9000", userId: "1" },
      reason: "unauthorized-topic",
      violatorId: "1",
      violatorThreadId: 999,
      nowMs: 0,
    });

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "telegram:-9000",
      text: "",
      payload: { text: "Approval required" },
      accountId: "ops",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const sentText = sendMessageTelegramMock.mock.calls[0]?.[1] as string;
    expect(sentText.startsWith("⚠️")).toBe(true);
    expect(sentText).toContain("unauthorized topic");
    expect(sentText).toContain("Approval required");
  });

  it("passes delivery pin notify requests to Telegram pinning", async () => {
    pinMessageTelegramMock.mockResolvedValueOnce({ ok: true, messageId: "tg-1", chatId: "12345" });

    await telegramOutbound.pinDeliveredMessage?.({
      cfg: {} as never,
      target: { channel: "telegram", to: "12345", accountId: "ops" },
      messageId: "tg-1",
      pin: { enabled: true, notify: true },
    });

    expect(pinMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "tg-1",
      expect.objectContaining({
        accountId: "ops",
        notify: true,
        verbose: false,
      }),
    );
  });
});
