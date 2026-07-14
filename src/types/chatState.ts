import type { ChatPermissions } from "@grammyjs/types";

/**
 * 缓存的用户或频道信息，在内存中的 users map 里以小写 username 为键。`username`
 * 是可选的：通过回复某人消息解析出的目标（见 resolveReplyTarget）可能根本没有
 * 公开 username，这种情况下也不会被存入以 username 为键的 map。
 */
export interface CachedUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  isChannel?: boolean;
}

/** 在复读复制目标的纯文本消息前对其应用的文本变换。 */
export type CopyMode = "reverse" | "nya" | "ja";

/**
 * 单个群聊各自独立的状态。机器人可能同时在多个群里运行，每个群各自维护一份，
 * 互不影响——见 storage.ts 中 Map<chatId, ChatState> 的用法。复读目标不在
 * 这里——复读消耗的是机器人头像/人格这一份全局资源，同一时刻全局只有一个
 * 复读目标，见 GlobalCopyState。
 */
export interface ChatState {
  /**
   * /quiet 静默期的截止时间戳（ms）。在此之前机器人不主动刷存在感（AI 随机
   * 插话、随机复读等）；被动触发（回复/@机器人）和指令不受影响。
   */
  quietUntil?: number;
  /**
   * 反刷群私密模式生效中时，锁定前的原始群权限（进程重启后据此重放给守卫
   * Worker 重排解锁计时，见 src/antiRaid.ts）；不在私密模式时无此字段。
   */
  lockdown?: ChatPermissions;
}

/**
 * copy 类功能的全局状态：复读目标和冷却时钟所有群共用同一份（消耗的是机器人
 * 自己头像这一份全局资源，同一时刻只能"变成"一个人，不按群分别维护）。
 * 复读行为本身只发生在发起 /copy 的那个群里（copyChatId），但"手上有没有
 * 猎物"的判定是全局的——别的群想 /copy 得先 /stop_copy（任何群都可以停）。
 */
export interface GlobalCopyState {
  lastCopyTime?: number;
  /** 当前的复读目标；null 表示没有用 /copy 类命令锁定任何人。 */
  copiedUser: CachedUser | null;
  copyMode?: CopyMode;
  /** 发起 /copy 的群 id：复读/表情同步只发生在这个群里。 */
  copyChatId?: number;
}

/**
 * state.json 的整体结构：chats 以 chatId（字符串）为键分别保存各群聊各自的
 * 状态（静默期、私密模式镜像）；globalCopy 是所有群共用的那一份复读状态与
 * 冷却时钟。整个文件由内存中唯一一份状态全量序列化而来（见 storage.ts），
 * 不拆分文件、不做局部 patch——这点状态量全量写一份 JSON 毫无性能压力。
 */
export interface StateFileSchema {
  chats: Record<string, ChatState>;
  globalCopy: GlobalCopyState;
}
