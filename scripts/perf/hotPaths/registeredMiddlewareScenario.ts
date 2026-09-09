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
import {
  BENCHMARK_BOT_ADMIN_MEMBER,
  BENCHMARK_BOT_INFO,
  BENCHMARK_CHAT_ID,
  BENCHMARK_SENDER_ID,
} from "./fixtures";
import type { Scenario } from "./types";

/**
 * 真实注册链消费普通文本；静默群和已知管理员状态覆盖热缓存命中的完整路径。
 *
 * **权限位必须是 administrator**：受管群的常态就是本机器人已经是管理员（入群守卫、
 * gag、刷屏禁言、广告处置全都以此为前提）。给成员身份的话
 * `handleAntiRaidMessageIngress` 在 `cachedBotAdminStatus` 那道闸就返回，
 * `ingestAdminChatMessage` 与 `ingestAdmittedMessage` 整段——黑名单频道门禁、广告候选、
 * 刷屏候选、待验证镜像的空表前置判定——一次都不会执行，而那一段是每条群消息都要走的。
 *
 * 管理员身份下这条路径仍然同步、零副作用：`sender_chat` 缺席让黑名单门禁第一行返回
 * false；`isAdDetectEnabled` 与 `isFloodControlEnabled` 都保持缺省关闭，两个候选都是
 * `undefined`（因此也不碰 `ensureBotChatPermissions` 与任何跨线程投递）；待验证镜像为
 * 空表，键都不拼。改 fixture 前必须重新验证这几条。
 */
export function registeredMiddlewareScenario(): Scenario {
  installCannedTelegramOutbound();
  bot.botInfo = BENCHMARK_BOT_INFO;
  registerHandlers(bot);
  const middleware: MiddlewareFn<Context> = bot.middleware();
  const update: Update = { update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture" },
    from: { id: BENCHMARK_SENDER_ID, is_bot: false, first_name: "member" }, text: "普通群消息",
  } };
  const ctx: Context = new Context(update, bot.api, bot.botInfo);
  const spine: Scenario = incomingMessageSpineScenario();
  const end = (): Promise<void> => Promise.reject(new Error("Registered message handler did not consume the fixture."));
  return {
    iterations: 20_000,
    prepare: (): void => {
      spine.prepare?.();
      getOrCreateChatState(BENCHMARK_CHAT_ID).quietUntil = Date.now() + QUIET_MAX_DURATION_MS;
      getOrCreateChatState(BENCHMARK_CHAT_ID).botPermissions =
        readBotChatPermissions(BENCHMARK_BOT_ADMIN_MEMBER);
      whitelistEntryCache.set(BENCHMARK_SENDER_ID, null);
      blocklistEntryCache.set(BENCHMARK_SENDER_ID, null);
      temporaryWhitelistActivityCache.set(BENCHMARK_SENDER_ID, null);
      aiChatConfigReadinessCache.current = { ok: true };
    },
    run: async (iterations: number): Promise<number> => {
      for (let index: number = 0; index < iterations; index++) await middleware(ctx, end);
      if (!wedMemberStates.get(BENCHMARK_CHAT_ID)?.members.has(BENCHMARK_SENDER_ID)) throw new Error("Registered chain skipped member observation.");
      if (cannedTelegramCalls.get("sendMessage") !== undefined) throw new Error("Quiet message fixture unexpectedly sent a message.");
      if (cannedTelegramCalls.size !== 0) throw new Error(`Warm registered chain unexpectedly attempted outbound work: ${JSON.stringify([...cannedTelegramCalls])}`);
      if (!aiReplyActivityByChat.has(BENCHMARK_CHAT_ID)) throw new Error("Registered chain skipped incoming message activity.");
      return iterations;
    },
    reset: (): void => { spine.reset?.(); resetWedMemberStates(); cannedTelegramCalls.clear(); },
    probes: { ...spine.probes, observeWedMembers },
  };
}
