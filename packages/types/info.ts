import type { User } from "grammy/types";
import type { CachedUser } from "./chatState";

/** 一次 `/info` 出队后要用到的会话坐标与目标（commands/info.ts）。 */
export interface InfoRequest {
  readonly chatId: number;
  /** 触发命令的消息；回执回复它。 */
  readonly messageId: number | undefined;
  /** 论坛群里触发消息所在话题；General 与非论坛群为 undefined。 */
  readonly messageThreadId: number | undefined;
  /** 目标解析得到的身份；资料以本轮现查为准，查不到时退回这份。 */
  readonly target: CachedUser;
  /** 目标就是机器人自己时为启动时拿到的自身资料，不再现查；否则为 undefined。 */
  readonly selfUser: User | undefined;
}

/** `/info` 回执展示的资料；名称与用户名尚未清洗，id 原样展示。 */
export interface InfoProfile {
  readonly id: number;
  /** 用户为 first_name 与 last_name 拼接，频道或群为 title；都没有时为空串。 */
  readonly name: string;
  /** 不带 `@`；没有公开用户名时为 undefined。 */
  readonly username: string | undefined;
}

/** 现查得到的资料与头像读取目标：用户传 User，频道传 id，群身份没有可读的头像。 */
export interface InfoLookup {
  readonly profile: InfoProfile;
  readonly avatarTarget: User | number | undefined;
}
