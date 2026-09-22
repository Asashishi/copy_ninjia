import { CHAT_ID_ARG_PATTERN, USER_ID_ARG_PATTERN } from "../consts/commands";

/**
 * Telegram 群与频道 ID 的共享领域判定。私聊用户 ID 为正数，群、超级群与
 * 频道 ID 为负数；持久化的群级状态不得把两者混用。
 */
export function isTelegramGroupChatId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value < 0;
}

/**
 * 把字符串解析成 Telegram 用户 id（规范十进制正安全整数）；不合法时返回 undefined。
 *
 * 正则之外还要过一次安全整数：`99999999999999999999` 完全匹配「十进制正整数」，
 * 而 `Number` 之后已经不是那个数了，拿它去封人封的是另一个 id。
 *
 * 命令参数（commands/targetResolution.ts）、callback_data（antiRaid/updateIngress.ts
 * 的入群验证按钮、commands/wed.ts 的 `/wed` 按钮）与 gag 的 inline 查询、隐藏
 * 校验链接共用这一道判定：裸 `Number()` 加 `Number.isSafeInteger` 会放过 `"1e3"`、
 * `"0x10"`、`" 12"`、`"12.0"`、`"+5"` 这些非规范写法，而本 bot 生成的载荷只可能是
 * 规范十进制，多认的那几种写法全部来自外部构造。同一理由见 libs/verificationKey.ts
 * 的往返比对。
 */
export function parseUserIdArgument(argument: string): number | undefined {
  if (!USER_ID_ARG_PATTERN.test(argument)) return undefined;
  const userId: number = Number(argument);
  return Number.isSafeInteger(userId) ? userId : undefined;
}

/**
 * 把字符串解析成 Telegram 会话 id（频道/群的规范十进制负安全整数）；不合法时返回
 * undefined。安全整数那道闸的理由同 parseUserIdArgument，只是方向朝负。
 *
 * commands/send.ts 拿解析结果去开持久代发会话，裸 `Number()` 会放过
 * `-100123456789.0`、`0x2d` 这类非规范写法。
 */
export function parseChatIdArgument(argument: string): number | undefined {
  if (!CHAT_ID_ARG_PATTERN.test(argument)) return undefined;
  const chatId: number = Number(argument);
  return Number.isSafeInteger(chatId) ? chatId : undefined;
}
