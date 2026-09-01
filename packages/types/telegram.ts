/** Telegram 动作适配层与业务调用方共享的发送结果。 */

import type {
  MessageEntity,
  ReactionTypeCustomEmoji,
  ReactionTypeEmoji,
} from "grammy/types";
import type { TelegramApi } from "./telegramWorker";

/**
 * 本项目会发出的 Telegram 聊天状态取值。
 *
 * 单点定义：AI 回复心跳的挡位类型（types/aiChat/chatAction.ts 的
 * ChatActionPhase）由它加上 "idle" 派生，发送侧也直接吃它。两处各写一份联合
 * 类型的话，新增一个状态时漏改任何一处都编译通过，运行时才发现发出去的是
 * 另一个状态。
 */
export type TelegramChatAction = "typing" | "upload_photo" | "choose_sticker" | "upload_document";

/**
 * 机器人能够设置的可复制反应。付费反应不在 Bot API 的可设置类型中；自定义
 * emoji 仅用于复制目标刚刚在同一条消息上设置的反应。
 */
export type CopyableReaction = ReactionTypeEmoji | ReactionTypeCustomEmoji;

/** 一条已成功发送的 Telegram 消息；repliedToMessageId 只在服务端实际挂上
 * 回复关系时存在，不能用请求参数推断。 */
export interface TelegramSendResult {
  messageId: number;
  repliedToMessageId?: number;
}

/**
 * 一个查询者最近一次 inline 应答：他打进查询的源文本，以及这次应答渲染出的
 * 全部结果正文（同一次查询可能同时给出多条结果，只有被选中的那条会落群）。
 */
export interface InlineResultSource {
  readonly sourceText: string;
  readonly resultTexts: readonly string[];
}

/**
 * 一条带富文本实体的待发送消息：正文与调用方自行算好的实体表。
 *
 * `offset`/`length` 一律按 **UTF-16 code unit** 计——写死成别的长度不会报错，
 * 只会让 Telegram 把代码块画歪或整段吞掉。问答看板、问答直答与 libs/codeFence.ts
 * 共用这一个形状，发送侧直接把它铺进 sendMessage 的 text/entities。
 */
export interface RichTextMessage {
  readonly text: string;
  readonly entities: readonly MessageEntity[];
}

/** 等待跨线程自发消息标记的单个主线程 rendezvous。 */
export interface SelfSentWaiter {
  readonly resolve: (matched: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 延迟删除只需要单条与批量删除能力，真实客户端和 Worker 代理均可实现。 */
export type TelegramMessageDeletionApi = Pick<
  TelegramApi,
  "deleteMessage" | "deleteMessages"
>;

/** 主线程/Worker 各自登记的一条延迟删除任务。 */
export interface PendingMessageDeletion {
  readonly chatId: number;
  readonly messageId: number;
  readonly api: TelegramMessageDeletionApi;
  /** 停机提前兑现时是否允许与同客户端、同群条目合成 deleteMessages。 */
  readonly batchOnFlush: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 机器人自己在某个群里的完整管理员权限快照。
 *
 * 这一份同时取代旧 `botIsAdmin` 布尔值与主线程独立权限 Map：权威副本就是
 * `ChatState.botPermissions`，`my_chat_member` 与按需 `getChatMember` 都只替换这一份
 * 快照。字段对齐当前锁定的 `grammy/types` 中 `ChatAdministratorRights`；
 * 可选的频道/论坛权限也显式收敛为布尔值，不让「API 没返回」与「已确认没有」
 * 在持久化状态里混用。
 */
export interface BotChatPermissions {
  /** 是否为管理员或群主；其它权限为 false 时仍不能代替此身份位。 */
  readonly isAdministrator: boolean;
  /** 管理员身份是否匿名。 */
  readonly isAnonymous: boolean;
  /** 能否管理聊天的通用管理能力。 */
  readonly canManageChat: boolean;
  /** 能否删除别人的消息。 */
  readonly canDeleteMessages: boolean;
  /** 能否管理视频聊天。 */
  readonly canManageVideoChats: boolean;
  /** 能否限制、封禁或解封成员。 */
  readonly canRestrictMembers: boolean;
  /** 能否任免其它管理员。 */
  readonly canPromoteMembers: boolean;
  /** 能否修改聊天资料。 */
  readonly canChangeInfo: boolean;
  /** 能否邀请用户。 */
  readonly canInviteUsers: boolean;
  /** 能否管理普通成员标签。 */
  readonly canManageTags: boolean;
  /** 能否发布聊天故事。 */
  readonly canPostStories: boolean;
  /** 能否编辑聊天故事。 */
  readonly canEditStories: boolean;
  /** 能否删除聊天故事。 */
  readonly canDeleteStories: boolean;
  /** 能否在频道发布消息。 */
  readonly canPostMessages: boolean;
  /** 能否编辑频道消息。 */
  readonly canEditMessages: boolean;
  /** 能否置顶群消息。 */
  readonly canPinMessages: boolean;
  /** 能否管理论坛话题。 */
  readonly canManageTopics: boolean;
  /** 能否管理频道私信与建议帖。 */
  readonly canManageDirectMessages: boolean;
}

/**
 * Anti-Raid Worker 执行破坏性动作前实际需要的最小权限投影。
 * 完整快照只存于主线程 State；跨线程消息不传送 Worker 不会读取的字段。
 */
export interface BotActionPermissions {
  /** 能否限制、封禁或解封成员。 */
  readonly canRestrictMembers: boolean;
  /** 能否删除别人的消息。 */
  readonly canDeleteMessages: boolean;
}
