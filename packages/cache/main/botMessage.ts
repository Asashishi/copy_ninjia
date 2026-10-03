/** owner: main。Bot-to-Bot 发言限流记录。 */

import type { BotMessageActivity } from "../../types/botMessage";

/**
 * 收到其他机器人发来的 message 时填充，命中时续期；timeout 回调或到期后的首次命中清除记录。
 * 容量固定为 512 个身份，满载拒绝新身份，不淘汰现有记录。记录不跨线程、不落盘；
 * Worker 重建不影响计数，进程重启从空表开始。
 */
export const botMessageActivity: Map<number, BotMessageActivity> = new Map();
