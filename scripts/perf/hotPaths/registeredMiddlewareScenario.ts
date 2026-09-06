import { Context } from "grammy";
import { QUIET_MAX_DURATION_MS } from "../../../packages/consts/commands";
import type { MiddlewareFn } from "grammy";
import type { Update } from "grammy/types";
import { registerHandlers } from "../../../packages/app/registerHandlers";
import { observeWedMembers } from "../../../packages/commands/wed/members";
import { readBotChatPermissions } from "../../../packages/libs/chatMember";
import { aiReplyActivityByChat } from "../../../packages/cache/main/auto";
import { wedMemberStates, resetWedMemberStates } from "../../../packages/cache/main/wedMembers";
import { aiChatConfigReadinessCache } from "../../../packages/cache/main/configReadiness";
import { whitelistEntryCache, blocklistEntryCache } from "../../../packages/cache/main/identityStorage";
import { temporaryWhitelistActivityCache } from "../../../packages/cache/main/temporaryWhitelist";
import { getOrCreateChatState } from "../../../packages/infra/storage/stateStore";
import { bot } from "../../../packages/infra/telegram/mainClient";
import { cannedTelegramCalls, installCannedTelegramOutbound } from "../outboundGuard";
import { incomingMessageSpineScenario } from "./messageSpineScenarios";
import { BENCHMARK_BOT_INFO, BENCHMARK_CHAT_ID } from "./fixtures";
import type { Scenario } from "./types";

/** 真实注册链消费普通文本；静默群和已知管理员状态覆盖热缓存命中的完整路径。 */
export function registeredMiddlewareScenario(): Scenario {
  installCannedTelegramOutbound();
  bot.botInfo = BENCHMARK_BOT_INFO;
  registerHandlers(bot);
  const middleware: MiddlewareFn<Context> = bot.middleware();
  const update: Update = { update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture" },
    from: { id: 42, is_bot: false, first_name: "member" }, text: "普通群消息",
  } };
  const ctx: Context = new Context(update, bot.api, bot.botInfo);
  const spine: Scenario = incomingMessageSpineScenario();
  const end = (): Promise<void> => Promise.reject(new Error("Registered message handler did not consume the fixture."));
  return {
    iterations: 20_000,
    prepare: (): void => {
      spine.prepare?.();
      getOrCreateChatState(BENCHMARK_CHAT_ID).quietUntil = Date.now() + QUIET_MAX_DURATION_MS;
      getOrCreateChatState(BENCHMARK_CHAT_ID).botPermissions = readBotChatPermissions({ status: "member", user: BENCHMARK_BOT_INFO });
      whitelistEntryCache.set(42, null);
      blocklistEntryCache.set(42, null);
      temporaryWhitelistActivityCache.set(42, null);
      aiChatConfigReadinessCache.current = { ok: true };
    },
    run: async (iterations: number): Promise<number> => {
      for (let index: number = 0; index < iterations; index++) await middleware(ctx, end);
      if (!wedMemberStates.get(BENCHMARK_CHAT_ID)?.members.has(42)) throw new Error("Registered chain skipped member observation.");
      if (cannedTelegramCalls.get("sendMessage") !== undefined) throw new Error("Quiet message fixture unexpectedly sent a message.");
      if (cannedTelegramCalls.size !== 0) throw new Error(`Warm registered chain unexpectedly attempted outbound work: ${JSON.stringify([...cannedTelegramCalls])}`);
      if (!aiReplyActivityByChat.has(BENCHMARK_CHAT_ID)) throw new Error("Registered chain skipped incoming message activity.");
      return iterations;
    },
    reset: (): void => { spine.reset?.(); resetWedMemberStates(); cannedTelegramCalls.clear(); },
    probes: { ...spine.probes, observeWedMembers },
  };
}
