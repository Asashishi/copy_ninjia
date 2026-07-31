import type { MessageEntity } from "@grammyjs/types";
import type { CommandContext, Context } from "grammy";
import type { CachedUser } from "../types/chatState";
import type {
  SetWhitelistPermissionResult,
  WhitelistPermissionKey,
} from "../types/whitelist";
import {
  WHITELIST_PERMISSION_ALL_COMMAND,
  WHITELIST_PERMISSION_HELP,
  WHITELIST_PERMISSION_HELP_COMMAND,
  WHITELIST_PERMISSION_KEYS,
} from "../consts/whitelist";
import {
  enableAllWhitelistPermissions,
  isWhitelisted,
  setWhitelistPermission,
} from "../config/whitelist";
import { sendMessage } from "../infra/telegram";
import { formatTargetLabel, formatUserLabel } from "../users/userLabel";
import { isSuperAdminActor, resolveCommandActor } from "./commandActor";
import { resolveCommandTarget } from "./targetResolution";

/** /permission 的固定用法；支持回复目标，或显式给用户/频道 ID 与 @username。 */
const PERMISSION_USAGE_TEXT: string =
  `笨蛋，用法是 /permission <用户id|频道id|@username> <权限键> <true|false>；` +
  `回复白名单身份时可以省略目标，只写 /permission <权限键> <true|false>；` +
  `全部权限打开用 /permission <用户id|频道id|@username> all，回复目标时只写 /permission all；` +
  `查看权限说明用 /permission help♡`;

interface PermissionHelpMessage {
  text: string;
  entities: readonly MessageEntity[];
}

/** 把权限键与说明渲染为可复制的 JSON 代码块，实体偏移按 UTF-16 code unit 计算。 */
function formatPermissionHelpMessage(): PermissionHelpMessage {
  const prefix: string = "可用权限如下；true 表示授予，false 表示收回：\n";
  const permissionJson: string = JSON.stringify(WHITELIST_PERMISSION_HELP, null, 2);
  const suffix: string = [
    "",
    "设置已有白名单身份：",
    "/permission <用户id|频道id|@username> <权限键> <true|false>",
    "回复目标时可省略身份：/permission <权限键> <true|false>",
    "",
    "把已有白名单身份的全部权限设为 true：",
    "/permission <用户id|频道id|@username> all",
    "回复目标时可省略身份：/permission all",
  ].join("\n");
  return {
    text: `${prefix}${permissionJson}\n${suffix}`,
    entities: [
      {
        type: "pre",
        offset: prefix.length,
        length: permissionJson.length,
        language: "json",
      },
    ],
  };
}

/** 大小写不敏感地还原为配置中的规范权限键。 */
export function parseWhitelistPermissionKey(
  raw: string
): WhitelistPermissionKey | undefined {
  const normalized: string = raw.toLowerCase();
  return WHITELIST_PERMISSION_KEYS.find(
    (key: WhitelistPermissionKey): boolean => key.toLowerCase() === normalized
  );
}

/** 只接受字面量 true/false，避免 1、yes 等形态日后出现多套口径。 */
export function parsePermissionBoolean(raw: string): boolean | undefined {
  const normalized: string = raw.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

/**
 * 处理 /permission：仅超级管理员可修改已经存在的白名单条目。
 *
 * 新增/删除成员由同样仅限超级管理员的 /white 负责；本命令只修改已有身份的
 * 单项或全部权限，避免误发一条带陌生 ID 的消息就扩大整个白名单安全边界。
 */
export async function handlePermissionCommand(
  ctx: CommandContext<Context>
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  if (!isSuperAdminActor(ctx)) {
    const actor: CachedUser | undefined = resolveCommandActor(ctx);
    await sendMessage({
      chatId,
      text: `就 ${actor ? formatUserLabel(actor) : "哪个杂鱼"} 也想改本天才的权限配置？哪来的资格呀，笨蛋♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  const tokens: string[] = ctx.match.trim()
    .split(/\s+/)
    .filter((token: string): boolean => token.length > 0);
  if (
    tokens.length === 1 &&
    tokens[0]?.toLowerCase() === WHITELIST_PERMISSION_HELP_COMMAND
  ) {
    const helpMessage: PermissionHelpMessage = formatPermissionHelpMessage();
    await sendMessage({
      chatId,
      text: helpMessage.text,
      entities: helpMessage.entities,
      replyToMessageId: messageId,
    });
    return;
  }
  const isEnableAll: boolean =
    tokens.at(-1)?.toLowerCase() === WHITELIST_PERMISSION_ALL_COMMAND;
  if (!isEnableAll && tokens.length < 2) {
    await sendMessage({
      chatId,
      text: PERMISSION_USAGE_TEXT,
      replyToMessageId: messageId,
    });
    return;
  }

  let key: WhitelistPermissionKey | undefined;
  let value: boolean | undefined;
  if (!isEnableAll) {
    const rawValue: string = tokens.at(-1)!;
    const rawKey: string = tokens.at(-2)!;
    key = parseWhitelistPermissionKey(rawKey);
    value = parsePermissionBoolean(rawValue);
    if (key === undefined || value === undefined) {
      await sendMessage({
        chatId,
        text: `${PERMISSION_USAGE_TEXT}\n可用权限键：${WHITELIST_PERMISSION_KEYS.join(", ")}`,
        replyToMessageId: messageId,
      });
      return;
    }
  }

  const targetArgument: string = tokens
    .slice(0, isEnableAll ? -1 : -2)
    .join(" ");
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: targetArgument,
    acceptUserId: true,
    acceptChatId: true,
    messages: {
      missingTarget: `笨蛋，要回复一个白名单身份，或者把用户/频道 id 写在 /permission 后面呀♡`,
      invalidUsername: (rawArgument: string): string =>
        `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户/频道 id♡`,
      unknownUsername: (rawUsername: string): string =>
        `笨蛋，@${rawUsername} 还没被本天才记住；回复 TA 的消息或直接给 id 吧♡`,
      conflictingTarget: (rawArgument: string): string =>
        `笨蛋，你回复了一个身份、又写了 ${rawArgument}，本天才不会猜要改谁的权限♡`,
      selfTarget: `笨蛋，本天才自己的权限不归白名单配置管呀♡`,
    },
  });
  if (target === undefined) return;
  if (!isWhitelisted(target.id)) {
    await sendMessage({
      chatId,
      text: `${formatTargetLabel(target)} 还不在白名单里；先用 /white 把 TA 加进去再改权限呀，笨蛋♡`,
      replyToMessageId: messageId,
    });
    return;
  }

  if (isEnableAll) {
    const result: SetWhitelistPermissionResult =
      await enableAllWhitelistPermissions(target.id);
    const replyText: string = result.changed
      ? `哼，${formatTargetLabel(target)} 的权限已经被本天才全部打开啦，可别拿去乱来哦♡`
      : `笨蛋，${formatTargetLabel(target)} 的权限本来就是全开的，还想让本天才开几次呀♡`;
    await sendMessage({
      chatId,
      text: replyText,
      replyToMessageId: messageId,
    });
    return;
  }
  if (key === undefined || value === undefined) {
    throw new Error("Permission mutation reached execution without a parsed key and value");
  }

  const result: SetWhitelistPermissionResult = await setWhitelistPermission({
    id: target.id,
    key,
    value,
  });
  const stateText: string = result.changed ? "已设为" : "原本就是";
  await sendMessage({
    chatId,
    text: `哼，${formatTargetLabel(target)} 的 ${key} ${stateText} ${String(value)} 啦♡`,
    replyToMessageId: messageId,
  });
}
