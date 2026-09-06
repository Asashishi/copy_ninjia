/**
 * 各热点场景共用的基准夹具：固定的群 id、时间戳起点与一份最小消息。
 *
 * 单独成文件是因为它们跨场景组共用（scenarios.ts、messageSpineScenarios.ts、
 * floodScenarios.ts、transcriptScenarios.ts），而各组按领域分文件之后，
 * 谁都不该为了拿一个常量去 import 另一组场景。
 */

import type { Message, UserFromGetMe } from "grammy/types";

/** 基准群聊 id；仅用于进程内 Map，不产生任何 Telegram 或磁盘副作用。 */
export const BENCHMARK_CHAT_ID: number = -100_000_000_000_001;
/**
 * 所有时间戳场景的起点，取 2026-01-01T00:00:00Z 的毫秒值。
 *
 * 必须用生产量级，不能用 1_000_000 这类小整数。`Date.now()` 的毫秒值约 1.75e12，
 * 早已超出 int32；生产窗口喂进来的全是 `Date.now()`，基准必须使用相同数量级，
 * 才能维持一致的数值表示和 JIT 输入形态。
 *
 * 固定值让各次运行可复现，并避免同一热函数在预热与正式循环之间切换数值表示。
 */
export const BENCHMARK_EPOCH_MS: number = 1_767_225_600_000;

export function messageFixture(username?: string): Message {
  return {
    message_id: 1,
    date: 1,
    chat: {
      id: BENCHMARK_CHAT_ID,
      type: "supergroup",
      title: "Performance fixture",
    },
    from: {
      id: 42,
      is_bot: false,
      first_name: "Stable",
      last_name: "Sender",
      username,
    },
  };
}

/** 注册链与成员观察共用的罐头机器人身份。 */
export const BENCHMARK_BOT_INFO: Readonly<UserFromGetMe> = {
  id: 1, is_bot: true, first_name: "perf", username: "perf_bot",
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: true,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
