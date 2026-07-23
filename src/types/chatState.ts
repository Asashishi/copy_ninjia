import type { ChatPermissions } from "@grammyjs/types";

/** 反刷群锁定的持久化恢复记录。 */
export interface LockdownRecord {
  /** 当前持久化阶段；恢复时必须按该阶段继续幂等对账。 */
  phase: "applying" | "active" | "restoring";
  /** write-ahead 阶段的正整数标识。 */
  intentId: number;
  originalPermissions: ChatPermissions;
  /** 应恢复原始权限的绝对时间戳（ms）；续期必须同步刷新。 */
  expiresAt: number;
}

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
 * 互不影响——见 infra/storage/stateStore.ts 中 Map<chatId, ChatState> 的用法。复读目标不在
 * 这里——复读消耗的是机器人头像/人格这一份全局资源，同一时刻全局只有一个
 * 复读目标，见 GlobalCopyState。
 */
export interface ChatState {
  /**
   * /quiet 静默期的截止时间戳（ms）。在此之前机器人不主动刷存在感（AI 随机
   * 插话、随机复读等）；被动触发（回复/@机器人）和指令不受影响。
   */
  quietUntil?: number;
  /** 当前生效的反刷群锁定；未锁定时无此字段。 */
  lockdown?: LockdownRecord;
  /**
   * 本群是否启用 AI 闲聊功能（对话缓存、随机插话、回复/@ 机器人触发的回复）。
   * 缺省视为禁用，需通过 /ai_chat enable 显式开启（仅 SUPER_ADMIN_USER_ID
   * 本人可用该指令，见 commands/aiChat.ts）。
   */
  isAIChatEnabled?: boolean;
  /**
   * 本群 /ja_copy 的日语翻译功能是否启用。缺省视为禁用，需通过
   * /ja_copy enable 显式开启（仅 SUPER_ADMIN_USER_ID 本人可用该指令，见
   * commands/jaCopy.ts）。判断时必须使用 === true；false 与缺省等价，
   * 保存时会被规范化删除。
   */
  isJATranslationEnabled?: boolean;
  /**
   * 本群是否已初始化，机器人是否处理这个群的更新。缺省视为未初始化（false），
   * 需通过 /init enable 显式开启（仅 SUPER_ADMIN_USER_ID 本人可用该指令，见
   * commands/init.ts）。未初始化的群，其更新在
   * app/registerHandlers.ts 最前端的网关中间件
   * 处直接丢弃（除 /init 本身和机器人自身的 my_chat_member 更新外），不进入
   * 入群验证、指令匹配、AI 调用等任何后续处理——Bot API 长轮询没有「取消
   * 订阅某个群」的机制，这是应用层面能做到的最接近「不监听」的效果，避免
   * 被拉进大量群时被拖垮。
   */
  isInitEnabled?: boolean;
  /**
   * 机器人自己在本群是否为管理员。由 my_chat_member 更新近实时维护，未知时
   * 按需 getChatMember 现查回填（见 src/infra/botAdmin.ts）。这是入群守卫和
   * /kick 的权限门控依据，也是「/kick 在所有管理员群同步生效」的群清单来源
   * ——Bot API 无法枚举机器人所在的群，只能这样记下来。
   */
  botIsAdmin?: boolean;
  /**
   * 本群名称，纯粹供人读 state.json 时核对某个 chatId 是哪个群，不参与任何
   * 业务判断。启动时全量现查一轮回填，此后每条群消息顺手用消息自带的
   * chat.title 刷新（零额外 API 开销），见 src/infra/chatTitle.ts。
   */
  title?: string;
  /**
   * 本群是否为唯一的 /send 中转目标。状态挂在目标群并持久化，避免另存目标
   * ID 形成双份事实；命令入口负责全局唯一约束。
   */
  isProxySendEnabled?: boolean;
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
 * 冷却时钟。整个文件由内存中唯一一份状态全量序列化而来（见
 * infra/storage/stateStore.ts），
 * 不拆分文件、不做局部 patch——这点状态量全量写一份 JSON 毫无性能压力。
 */
export interface StateFileSchema {
  chats: Record<string, ChatState>;
  globalCopy: GlobalCopyState;
}
