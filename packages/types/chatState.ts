import type { ChatPermissions } from "grammy/types";
import type { BotChatPermissions } from "./telegram";
import type { TranslateState } from "./translate";
import type { TtsDailyUsage } from "./aiChat/voiceMessage";

/** 反刷群锁定跨 Worker 与持久化共用的离散阶段。 */
export type LockdownPhase = "applying" | "active" | "reconciling" | "restoring";

/** 反刷群锁定的持久化恢复记录。 */
export interface LockdownRecord {
  /** 当前持久化阶段；恢复时必须按该阶段继续幂等对账。 */
  phase: LockdownPhase;
  /** write-ahead 阶段的正整数标识。 */
  intentId: number;
  originalPermissions: ChatPermissions;
  /** 本轮封锁公告是否确实发送过；决定恢复后能否发送解锁公告。 */
  announced: boolean;
  /**
   * 封锁公告的消息 ID；解除封锁时按它删除群里那条公告。发送失败、或接管的是
   * 更早进程留下的记录时缺省——删不掉就不删，绝不猜 ID。
   */
  announcementMessageId?: number;
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
export type CopyMode = "reverse" | "nya";

/**
 * 单个群聊各自独立的状态。机器人可能同时在多个群里运行，每个群各自维护一份，
 * 互不影响——主线程以容量 25 的 LRU 保留 SQLite `chat_states` 的热读值。复读目标不在
 * 这里——复读消耗的是机器人头像/人格这一份全局资源，同一时刻全局只有一个
 * 复读目标，见 GlobalCopyState。
 *
 * `is*Enabled` 七个开关在内存中恒为 boolean，默认 false；读取统一写 `=== true` 或
 * `!== true`。持久化时只写入为 true 的开关，缺省键解码为 false（见
 * database/codec/chatState.ts）。其余字段缺省为 undefined，表示从没设过。
 */
export interface ChatState {
  /** 本群自定义 AI 人设；缺省使用 prompt/persona.md，独立存入 ai_persona 列。 */
  aiPersona?: string;
  /**
   * /quiet 静默期的截止时间戳（ms）。在此之前机器人不主动刷存在感（AI 随机
   * 插话、随机复读等）；被动触发（回复/@机器人）和指令不受影响。
   */
  quietUntil?: number;
  /** 当前生效的反刷群锁定；未锁定时无此字段。 */
  lockdown?: LockdownRecord;
  /**
   * 本群是否启用 AI 闲聊功能（对话缓存、随机插话、回复/@ 机器人触发的回复）。
   * 缺省视为禁用，需通过 /ai_chat enable 显式开启（仅持有
   * isCanControllAIPermission 的身份可用，超级管理员恒持有，见
   * commands/aiChat.ts）。
   */
  isAIChatEnabled: boolean;
  /**
   * 本群 /translate 翻译功能是否启用。缺省视为禁用，需通过
   * /translate enable 显式开启（仅持有 isCanControllTranslatePermission 的
   * 身份可用，超级管理员恒持有，见 commands/translate.ts）。
   */
  isTranslationEnabled: boolean;
  /**
   * 本群是否启用广告检测（消息串经配置的 provider 判定，命中即按 /block 处置）。
   * 缺省视为禁用，需通过 /ad_detect enable 显式开启（仅持有
   * isCanControllAdDetectPermission 的身份可用，超级管理员恒持有，见
   * commands/adDetect.ts）。
   */
  isAdDetectEnabled: boolean;
  /**
   * 本群是否启用防刷屏禁言。缺省视为禁用，需通过 /flood_control enable
   * 显式开启（仅持有 isCanControllFloodControlPermission 的身份可用，超级
   * 管理员恒持有，见 commands/floodControl.ts）。
   */
  isFloodControlEnabled: boolean;
  /**
   * 本群是否启用入群守卫：入群验证（按钮 + 超时踢出）与防冲群私密模式
   * （短时间大量入群时关闭邀请权限）两条链路合用这一个开关，缺省视为禁用，
   * 需通过 /antiraid enable 显式开启（仅持有 isCanControllAntiRaidPermission
   * 的身份可用，超级管理员恒持有，见 commands/antiRaid.ts）。
   *
   * 它**不覆盖**同在 Anti-Raid Worker 里跑的其余能力：广告检测归
   * isAdDetectEnabled、防刷屏禁言归 isFloodControlEnabled、永久黑名单不设开关。
   * 关闭只让主线程停止投递入群链路的事件（见 antiRaid/updateIngress.ts），
   * 并让 Worker 清掉这个群已开的验证窗口、对仍生效的私密模式发起恢复
   * （见 antiRaid/workerBridge/controller.ts 的 deactivateJoinGuardChat）。
   */
  isAntiRaidEnabled: boolean;
  /**
   * 本群是否已初始化，机器人是否处理这个群的更新。缺省视为未初始化，
   * 需由超级管理员通过 /init enable 显式开启（见 commands/init.ts）。未初始化
   * 群的更新在 app/registerHandlers.ts 的前置网关处直接丢弃（除 /init 与本群
   * 无关的 my_chat_member 外），不进入授权维护、入群验证、普通指令匹配、AI
   * 调用等后续处理。
   */
  isInitEnabled: boolean;
  /**
   * 机器人自己在本群的完整管理员权限快照。由主线程的 `my_chat_member`
   * 更新近实时替换，未知时按需 `getChatMember` 现查回填（见
   * packages/infra/botAdmin.ts）。`undefined` 仅表示尚未确证；已确证不是管理员时
   * 仍保存一份 `isAdministrator: false` 且其它权限全 false 的完整快照。
   *
   * 这是主线程唯一的权威副本：入群守卫、/block 群清单与具体动作权限
   * 都直接读它，不再并行维护第二张主线程 Map。
   */
  botPermissions?: BotChatPermissions;
  /**
   * 本群名称，纯粹供人核对 SQLite 中某个 chatId 是哪个群，不参与任何
   * 业务判断。启动时全量现查一轮回填，此后每条群消息顺手用消息自带的
   * chat.title 刷新（零额外 API 开销），见 packages/infra/chatTitle.ts。
   */
  title?: string;
  /**
   * 本群是否为唯一的 /send 中转目标。状态挂在目标群并持久化，避免另存目标
   * ID 形成双份事实；命令入口负责全局唯一约束。
   */
  isProxySendEnabled: boolean;
  /**
   * 本群的 /translate 翻译会话；每项一个目标，按目标去重，最多
   * TRANSLATE_CHAT_USER_LIMIT 项。没有会话时为 undefined，不保存空数组。替换会话时
   * 创建新对象，用对象身份撤销旧会话的在途响应（见 translate/message.ts）。
   */
  translate?: readonly TranslateState[];
}

/**
 * ChatState 上取值为布尔的群功能开关字段名。关闭开关经 infra/storage/stateStore.ts 的
 * disableChatStateSwitch；`/bot_status` 的功能块按 consts/botStatus.ts 的
 * BOT_STATUS_FEATURE_KEYS 逐项列出。
 */
export type ChatStateSwitchKey = {
  [Key in keyof ChatState]-?: boolean extends ChatState[Key] ? Key : never;
}[keyof ChatState];

/** ChatState 上以 undefined 表示「从没设过」的可选字段名；清除经 clearChatStateField。 */
export type ChatStateOptionalField = Exclude<keyof ChatState, ChatStateSwitchKey>;

/**
 * copy 类功能的全局状态：复读目标和冷却时钟所有群共用同一份（消耗的是机器人
 * 自己头像这一份全局资源，同一时刻只能"变成"一个人，不按群分别维护）。
 * 复读行为本身只发生在发起 /copy 的那个群里（copyChatId），但"手上有没有
 * 猎物"的判定是全局的——别的群想 /copy 得先 /copy stop（任何群都可以停）。
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
 * memory/global/state.json 的落盘形态：所有群共用的全局状态，按用途分块。`copy` 是
 * 复读状态与冷却时钟，`ttsUsage` 是语音合成的每日计数（缺省表示从没用过）。按群的状态
 * 由 `database/storage.sqlite` 的 `chat_states` 表持久化；外部素材由 config/dynamic/assets.json、
 * AI provider 与模型由 config/dynamic/agent.json 管理，都不进入状态。
 */
export interface GlobalState {
  copy: GlobalCopyState;
  ttsUsage?: TtsDailyUsage;
}

/**
 * 全局状态 `copy` 块解码后的形态，与运行期的 `GlobalCopyState` 分开维护
 * （后者是主线程可变持有者，初始只有 `copiedUser: null`，三个字段由
 * adoptCopyTarget 一次写齐）。判别联合强制「copiedUser 为 null ⟺ 没有
 * copyMode/copyChatId；copiedUser 非空 ⟺ copyChatId 是合法负数群 id」这条配对，
 * 由解码器（libs/stateFileCodec.ts 的 globalCopy）保证成立。
 */
export type DecodedGlobalCopyState =
  | Readonly<{
    copiedUser: null;
    lastCopyTime?: number;
    copyMode?: undefined;
    copyChatId?: undefined;
  }>
  | Readonly<{
    copiedUser: CachedUser;
    copyChatId: number;
    copyMode?: CopyMode;
    lastCopyTime?: number;
  }>;

/** decodeGlobalStateFile 与 StateStore.load 的返回形态；copy 的形态与运行期不同，落盘侧用 GlobalState。 */
export interface DecodedGlobalState {
  copy: DecodedGlobalCopyState;
  /** 缺省为 undefined，表示从没发起过语音合成请求。 */
  ttsUsage: TtsDailyUsage | undefined;
}
