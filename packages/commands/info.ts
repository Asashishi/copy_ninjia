/**
 * `/info`：查询目标的名称（用户为 first_name 与 last_name 拼接，频道或群为 title）、用户名、
 * id 与头像，回执 30 秒后删除。任何人都能用；私聊由 infra/updateGate.ts 的前置网关拦截。
 *
 * 目标可以是回复、@username、用户 id 或频道/群 id，机器人自己与其他 bot 也可以。handler
 * 同步解析目标后交给延迟命令执行器的 interactive 档，接纳后立即返回。资料以本轮现查为准：
 * 用户读本群成员身份，频道或群读 getChat，机器人自己用启动时的自身资料；查不到时退回目标
 * 解析得到的身份，连名称和用户名都没有时回「查不到」。头像复用 readCurrentAvatar；整次查询
 * 受 INFO_TASK_BUDGET_MS 约束，超时按已拿到的资料回复，停机取消时静默收场。
 */

import type { CommandContext, Context } from "grammy";
import type { ChatFullInfo, MessageEntity, User } from "grammy/types";
import { INFO_TASK_BUDGET_MS } from "../consts/info";
import { chatAtmosphere } from "../infra/atmosphere";
import { sendCommandMessage } from "../infra/telegram";
import { logUnlessAborted, runTelegramAction } from "../infra/telegram/actions/core";
import { readChatMemberUser } from "../infra/telegram/actions/membership";
import { readCurrentAvatar } from "../infra/telegram/avatar/read";
import { sendCommandPhoto } from "../infra/telegram/commandPhotos";
import { bot } from "../infra/telegram/mainClient";
import { currentUpdateAbortSignal } from "../infra/updateContext";
import { isTimeoutAbort, signalWithTimeout } from "../libs/abortSignal";
import { forumTopicThreadId } from "../libs/forumTopic";
import { signalArgs } from "../libs/telegramSignalArgs";
import { sanitizeDisplayName } from "../libs/text";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { CachedUser } from "../types/chatState";
import type { InfoLookup, InfoProfile, InfoRequest } from "../types/info";
import type { CurrentAvatarResult } from "../types/telegram";
import { submitDeferredCommand } from "./deferredCommands";
import { resolveCommandTarget } from "./targetResolution";

/** 回执正文与其中 id 的 code 实体。 */
interface InfoMessage {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
}

/** first_name 与 last_name 用一个空格拼接；缺的部分不留空格。 */
function joinName(firstName: string | undefined, lastName: string | undefined): string {
  if (firstName === undefined || firstName.length === 0) return lastName ?? "";
  return lastName === undefined || lastName.length === 0 ? firstName : `${firstName} ${lastName}`;
}

/** 用户资料与头像读取目标。 */
function userLookup(user: User): InfoLookup {
  return { profile: { id: user.id, name: joinName(user.first_name, user.last_name), username: user.username }, avatarTarget: user };
}

/** 现查失败时退回目标解析得到的身份；连名称和用户名都没有时为 undefined。 */
function cachedLookup(target: CachedUser): InfoLookup | undefined {
  const name: string = target.isChannel === true ? target.title ?? "" : joinName(target.first_name, target.last_name);
  if (name.length === 0 && target.username === undefined) return undefined;
  const avatarTarget: User | number | undefined = target.isChannel === true
    ? target.id
    : { id: target.id, is_bot: false, first_name: target.first_name ?? "", username: target.username };
  return { profile: { id: target.id, name, username: target.username }, avatarTarget };
}

/** 频道或群的资料；只有频道能读头像。 */
function chatLookup(chat: ChatFullInfo): InfoLookup {
  const name: string = "title" in chat && chat.title !== undefined ? chat.title : joinName(chat.first_name, chat.last_name);
  return {
    profile: { id: chat.id, name, username: chat.username },
    avatarTarget: chat.type === "channel" ? chat.id : undefined,
  };
}

/** 本轮现查资料；查不到时退回缓存身份。 */
async function lookUp(request: InfoRequest, signal: AbortSignal): Promise<InfoLookup | undefined> {
  if (request.selfUser !== undefined) return userLookup(request.selfUser);
  const target: CachedUser = request.target;
  if (target.id > 0) {
    const user: User | undefined = await readChatMemberUser({ chatId: request.chatId, userId: target.id, signal });
    return user === undefined ? cachedLookup(target) : userLookup(user);
  }
  const chat: ChatFullInfo | undefined = await runTelegramAction({
    action: `read chat ${target.id} for /info`,
    execute: (requestSignal?: AbortSignal): Promise<ChatFullInfo> => bot.api.getChat(target.id, ...signalArgs(requestSignal)),
    map: (value: ChatFullInfo): ChatFullInfo => value,
    fallback: undefined,
    signal,
    shouldLogError: logUnlessAborted,
  });
  return chat === undefined ? cachedLookup(target) : chatLookup(chat);
}

/**
 * 回执正文：名称与用户名是用户可控片段，经 sanitizeDisplayName 中和命令与双向控制字符；
 * id 用 code 实体标出，偏移按 UTF-16 计。没有头像时多一行「头像：无」。
 */
export function buildInfoMessage(profile: InfoProfile, texts: AtmosphereTexts["INFO_TEXTS"], hasAvatar: boolean): InfoMessage {
  const name: string = sanitizeDisplayName(profile.name) || texts.noUsername;
  const username: string = profile.username === undefined ? texts.noUsername : `@${profile.username}`;
  const head: string = `${texts.nameLabel}${name}\n${texts.usernameLabel}${username}\n${texts.idLabel}`;
  const id: string = String(profile.id);
  const text: string = hasAvatar ? `${head}${id}` : `${head}${id}\n${texts.noAvatar}`;
  return { text, entities: [{ type: "code", offset: head.length, length: id.length }] };
}

/** 出队后查资料与头像并回执。 */
export async function deliverInfo(request: InfoRequest): Promise<void> {
  const texts: AtmosphereTexts["INFO_TEXTS"] = chatAtmosphere(request.chatId).INFO_TEXTS;
  const signal: AbortSignal = signalWithTimeout(currentUpdateAbortSignal(), INFO_TASK_BUDGET_MS);
  const lookup: InfoLookup | undefined = await lookUp(request, signal);
  if (signal.aborted && !isTimeoutAbort(signal)) return;
  if (lookup === undefined) {
    await sendCommandMessage({ chatId: request.chatId, text: texts.notFound, replyToMessageId: request.messageId });
    return;
  }
  const avatar: CurrentAvatarResult | undefined = lookup.avatarTarget === undefined || signal.aborted
    ? undefined
    : await readCurrentAvatar(lookup.avatarTarget, signal);
  if (signal.aborted && !isTimeoutAbort(signal)) return;
  if (avatar?.status === "ok") {
    const message: InfoMessage = buildInfoMessage(lookup.profile, texts, true);
    const sent: number | undefined = await sendCommandPhoto({
      chatId: request.chatId,
      photo: avatar.photo,
      caption: message.text,
      captionEntities: message.entities,
      replyToMessageId: request.messageId,
      messageThreadId: request.messageThreadId,
    });
    if (sent !== undefined) return;
  }
  // 没有头像，或带图发送失败：退回纯文字回执，注明没有头像。
  const message: InfoMessage = buildInfoMessage(lookup.profile, texts, false);
  await sendCommandMessage({
    chatId: request.chatId,
    text: message.text,
    entities: message.entities,
    replyToMessageId: request.messageId,
    messageThreadId: request.messageThreadId,
  });
}

/** 处理 `/info`：解析目标后交给延迟命令执行器，满额时回「稍后再试」。 */
export async function handleInfoCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const atmosphere: AtmosphereTexts = chatAtmosphere(chatId);
  const target: CachedUser | undefined = await resolveCommandTarget({
    chatId,
    message: ctx.msg,
    botUserId: ctx.me.id,
    rawArgument: ctx.match,
    messages: atmosphere.INFO_TARGET_TEXTS,
    acceptUserId: true,
    acceptChatId: true,
    allowSelfTarget: true,
  });
  if (target === undefined) return;
  const request: InfoRequest = {
    chatId,
    messageId,
    messageThreadId: forumTopicThreadId(ctx.msg),
    target,
    selfUser: target.id === ctx.me.id ? ctx.me : undefined,
  };
  const accepted: boolean = submitDeferredCommand(
    "interactive",
    (): Promise<void> => deliverInfo(request),
    "Unexpected error while processing /info:"
  );
  if (!accepted) await sendCommandMessage({ chatId, text: atmosphere.INFO_TEXTS.busy, replyToMessageId: messageId });
}
