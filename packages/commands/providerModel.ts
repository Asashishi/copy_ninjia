import type { CommandContext, Context } from "grammy";
import { hasGeminiChatCredentials, hasOpenAiChatCredentials } from "../aiChat/credentials";
import { PROVIDER_MODEL_ALIASES, PROVIDER_MODEL_LABELS } from "../consts/commands";
import { persistAuthoritativeState } from "../infra/storage/stateStore";
import { sendCommandMessage } from "../infra/telegram";
import { formatUserLabel } from "../users/userLabel";
import { isSuperAdminActor, resolveCommandActor } from "./commandActor";
import type { AiProviderName } from "../types/aiChat/provider";
import type { CachedUser } from "../types/chatState";
import type { ProviderModelCommandTexts } from "../types/commands";

/**
 * `/image_model` 与 `/chat_model` 的共同实现。
 *
 * 两条命令切的是 AiChatProvider 契约互不重叠的两半（生图 / 回复+纯文本+视觉），
 * 但「谁能切、什么参数算数、切之前要满足什么、按什么次序落盘和推送」完全一致。
 * 这几条里有三条是安全相关的——仅超管且不可经 `/permission` 授权出去、两把 key
 * 都在才允许切、落盘必须先于推送与回执——各留一份复制品迟早会只改一边，而
 * 漂移的那一边不会有任何症状，直到某次切换悄悄绕过了门禁。
 *
 * 差异全部收在 ProviderModelCommand 描述符里：文案、读写哪一项状态、推给
 * Worker 的哪条镜像消息、落盘上下文名。
 */

/** 一条模型切换命令的全部差异项。 */
export interface ProviderModelCommand {
  /** 本条命令的回执文案表。 */
  readonly texts: Readonly<ProviderModelCommandTexts>;
  /** 传给 persistAuthoritativeState 的上下文名，用于落盘诊断。 */
  readonly persistContext: string;
  /**
   * 当前显式选定值；undefined 表示从没设过。
   *
   * 命名与 app/featurePreflight.ts 的 ModelPrerequisite.selected 一致，也刻意
   * 避开 `current`——那个名字在本仓专指 `{ current: T }` 可变 holder，而这里是
   * 一个只读取的读取器（见 scripts/checkProjectConventions.ts 的模块级缓存检查）。
   */
  readonly selected: () => AiProviderName | undefined;
  /** 写入内存权威值；落盘由本模块统一负责。 */
  readonly select: (provider: AiProviderName) => void;
  /** 把新值推给 AI Worker 的只读镜像。 */
  readonly publish: (provider: AiProviderName) => void;
}

/**
 * 处理一条 `<命令> gpt|gemini`：切换该项用哪家供应商，所有群共用同一份选择。
 *
 * 权限仅超级管理员，且**不可经 `/permission` 授权出去**——口径同 `/init`，因此走
 * commandActor.ts 的 isSuperAdminActor（不是 superAdminToggle.ts 的 isSuperAdmin，
 * 那条是 `/send` 专用的 ctx.from 本人判定）。
 *
 * 前置门禁是两把 key 都在：只有一家可用时切换没有意义，还会让人以为切成功了。
 * 缺哪把点名哪把——一把要改 .env 的哪一行，说清楚才改得对。这道门禁也是启动闸
 * （app/featurePreflight.ts）成立的前提：它保证落盘的选定值在写下的那一刻是可
 * 兑现的。
 */
export async function handleProviderModelCommand(
  ctx: CommandContext<Context>,
  command: ProviderModelCommand
): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const actor: CachedUser | undefined = resolveCommandActor(ctx);
  if (!actor || !isSuperAdminActor(ctx)) {
    await sendCommandMessage({
      chatId,
      text: command.texts.rejection(actor ? formatUserLabel(actor) : "哪个杂鱼"),
      replyToMessageId: messageId,
    });
    return;
  }

  // 必须走 Object.hasOwn 而不是直接下标：别名表是对象字面量，下标会走原型链，于是
  // `__proto__`、`toString`、`constructor` 这些继承键都能取到非 undefined 的值，
  // 原样通过下面那道「不认识就报用法」的门禁，被当成 AiProviderName 写进权威状态
  // 并推给 Worker——落盘时 JSON.stringify 静默丢弃函数值（自检照样通过、文件记成
  // 「无覆盖」而内存已污染），structuredClone 则直接拒绝，把 AI 闲聊 Worker 判成
  // 永久不可用。命令参数是任意用户输入，这里是它唯一的收口。
  const alias: string = ctx.match.trim().toLowerCase();
  const provider: AiProviderName | undefined = Object.hasOwn(PROVIDER_MODEL_ALIASES, alias)
    ? PROVIDER_MODEL_ALIASES[alias]
    : undefined;
  if (provider === undefined) {
    await sendCommandMessage({ chatId, text: command.texts.usage, replyToMessageId: messageId });
    return;
  }
  // 两把都要在：切换的前提是「另一家也真的能用」，而不是「这一家能用」。
  if (!hasGeminiChatCredentials()) {
    await sendCommandMessage({ chatId, text: command.texts.missingGeminiKey, replyToMessageId: messageId });
    return;
  }
  if (!hasOpenAiChatCredentials()) {
    await sendCommandMessage({ chatId, text: command.texts.missingOpenAiKey, replyToMessageId: messageId });
    return;
  }

  const wasProvider: AiProviderName | undefined = command.selected();
  command.select(provider);
  // 超管的权威决策：先过 durability barrier 再推给 Worker、再回执，口径同
  // `/ai_chat`。同值重复执行照样落盘并推送——那正是上一次推送失败后最自然的
  // 手工重试路径（理由同 superAdminToggle.ts 的 toggleReplyText），但回执必须
  // 如实说它没改变什么。
  await persistAuthoritativeState(command.persistContext);
  command.publish(provider);

  const label: string = PROVIDER_MODEL_LABELS[provider];
  await sendCommandMessage({
    chatId,
    text: wasProvider === provider ? command.texts.unchanged(label) : command.texts.switched(label),
    replyToMessageId: messageId,
  });
}
