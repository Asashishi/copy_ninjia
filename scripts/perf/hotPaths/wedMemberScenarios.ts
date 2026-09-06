import { Context } from "grammy";
import type { Update, User } from "grammy/types";
import { resetWedMemberStates, wedMemberStates } from "../../../packages/cache/main/wedMembers";
import { WED_MEMBER_LIMIT } from "../../../packages/consts/wed";
import { STATE_MANAGED_CHAT_LIMIT } from "../../../packages/consts/storage";
import { observeWedMembers } from "../../../packages/commands/wed/members";
import { getOrCreateChatState } from "../../../packages/infra/storage/stateStore";
import { bot } from "../../../packages/infra/telegram/mainClient";
import { BENCHMARK_BOT_INFO, BENCHMARK_CHAT_ID } from "./fixtures";
import type { Scenario } from "./types";

/** 成员观察实际入口；增长、已有键命中和满容量拒收分别测量。 */
export function wedMemberScenario(mode: "hit" | "growth" | "churn"): Scenario {
  const user: User = { id: 1, is_bot: false, first_name: "member" };
  const update: Update = { update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: BENCHMARK_CHAT_ID, type: "supergroup", title: "Performance fixture" },
    from: user, text: "普通群消息",
  } };
  const ctx: Context = new Context(update, bot.api, BENCHMARK_BOT_INFO);
  let nextId: number = WED_MEMBER_LIMIT + 1;
  return {
    iterations: mode === "growth" ? WED_MEMBER_LIMIT : 500_000,
    resetBeforeSample: mode === "growth",
    prepare: (): void => {
      getOrCreateChatState(BENCHMARK_CHAT_ID).isInitEnabled = true;
      if (mode !== "growth") {
        for (let id: number = 1; id <= WED_MEMBER_LIMIT; id++) {
          user.id = id;
          observeWedMembers(ctx);
        }
      }
    },
    run: (iterations: number): number => {
      const previousSize: number = wedMemberStates.get(BENCHMARK_CHAT_ID)?.members.size ?? 0;
      const previousRevision: number = wedMemberStates.get(BENCHMARK_CHAT_ID)?.revision ?? 0;
      for (let index: number = 0; index < iterations; index++) {
        user.id = mode === "hit" ? 1 + (index % WED_MEMBER_LIMIT) : nextId++;
        observeWedMembers(ctx);
      }
      const size: number = wedMemberStates.get(BENCHMARK_CHAT_ID)?.members.size ?? 0;
      const expectedSize: number = mode === "growth" ? Math.min(previousSize + iterations, WED_MEMBER_LIMIT) : WED_MEMBER_LIMIT;
      if (size !== expectedSize) throw new Error("Wed member observer did not consume the fixture.");
      if ((wedMemberStates.get(BENCHMARK_CHAT_ID)?.revision ?? 0) - previousRevision !== size - previousSize) {
        throw new Error("Wed member observer marked unchanged members dirty.");
      }
      return size;
    },
    reset: (): void => { resetWedMemberStates(); nextId = WED_MEMBER_LIMIT + 1; },
    probes: { observeWedMembers },
  };
}

/** 按生产群容量轮换实际上下文，覆盖跨群观察和各群成员缓存命中。 */
export function wedMemberChatSwitchScenario(): Scenario {
  const contexts: Context[] = [];
  for (let index: number = 0; index < STATE_MANAGED_CHAT_LIMIT; index++) {
    const update: Update = { update_id: index + 1, message: {
      message_id: 1, date: 1,
      chat: { id: BENCHMARK_CHAT_ID - index, type: "supergroup", title: "Performance fixture" },
      from: { id: index + 1, is_bot: false, first_name: "member" }, text: "普通群消息",
    } };
    contexts.push(new Context(update, bot.api, BENCHMARK_BOT_INFO));
  }
  return {
    iterations: 500_000,
    prepare: (): void => {
      for (const ctx of contexts) {
        getOrCreateChatState(ctx.chat!.id).isInitEnabled = true;
        observeWedMembers(ctx);
      }
    },
    run: (iterations: number): number => {
      for (let index: number = 0; index < iterations; index++) observeWedMembers(contexts[index % contexts.length]!);
      if (wedMemberStates.size !== STATE_MANAGED_CHAT_LIMIT) throw new Error("Wed observer omitted a managed chat.");
      for (const ctx of contexts) {
        if (wedMemberStates.get(ctx.chat!.id)?.members.size !== 1) throw new Error("Wed observer mixed members across chats.");
      }
      return iterations;
    },
    reset: (): void => { resetWedMemberStates(); },
    probes: { observeWedMembers },
  };
}
