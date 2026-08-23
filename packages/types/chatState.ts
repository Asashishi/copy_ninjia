import type { ChatPermissions } from "@grammyjs/types";
import type { BotChatPermissions } from "./telegram";

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
export type CopyMode = "reverse" | "nya" | "ja";

/**
 * 单个群聊各自独立的状态。机器人可能同时在多个群里运行，每个群各自维护一份，
 * 互不影响——主线程以容量 25 的 LRU 保留 SQLite `chat_states` 的热读值。复读目标不在
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
   * 缺省视为禁用，需通过 /ai_chat enable 显式开启（仅持有
   * isCanControllAIPermission 的身份可用，超级管理员恒持有，见
   * commands/aiChat.ts）。
   */
  isAIChatEnabled?: boolean;
  /**
   * 本群 /ja_copy 的日语翻译功能是否启用。缺省视为禁用，需通过
   * /ja_copy enable 显式开启（仅持有 isCanControllJATranslatePermission 的
   * 身份可用，超级管理员恒持有，见 commands/jaCopy.ts）。
   * 判断时必须使用 === true；false 与缺省等价，
   * 保存时会被规范化删除。
   */
  isJATranslationEnabled?: boolean;
  /**
   * 本群是否启用广告检测（消息串经配置的 provider 判定，命中即按 /block 处置）。
   * 缺省视为禁用，需通过 /ad_detect enable 显式开启（仅持有
   * isCanControllAdDetectPermission 的身份可用，超级管理员恒持有，见
   * commands/adDetect.ts）。
   * 判断时必须使用 === true。
   */
  isAdDetectEnabled?: boolean;
  /**
   * 本群是否启用防刷屏禁言。缺省视为禁用，需通过 /flood_control enable
   * 显式开启（仅持有 isCanControllFloodControlPermission 的身份可用，超级
   * 管理员恒持有，见 commands/floodControl.ts）。判断时必须使用 === true。
   */
  isFloodControlEnabled?: boolean;
  /**
   * 本群是否启用入群守卫：入群验证（按钮 + 超时踢出）与防冲群私密模式
   * （短时间大量入群时关闭邀请权限）两条链路合用这一个开关，缺省视为禁用，
   * 需通过 /antiraid enable 显式开启（仅持有 isCanControllAntiRaidPermission
   * 的身份可用，超级管理员恒持有，见 commands/antiRaid.ts）。判断时必须使用
   * === true。
   *
   * 它**不覆盖**同在 Anti-Raid Worker 里跑的其余能力：广告检测归
   * isAdDetectEnabled、防刷屏禁言归 isFloodControlEnabled、永久黑名单不设开关。
   * 关闭只让主线程停止投递入群链路的事件（见 antiRaid/updateIngress.ts），
   * 并让 Worker 清掉这个群已开的验证窗口、对仍生效的私密模式发起恢复
   * （见 antiRaid/workerBridge.ts 的 deactivateJoinGuardChat）。
   */
  isAntiRaidEnabled?: boolean;
  /**
   * 本群是否已初始化，机器人是否处理这个群的更新。缺省视为未初始化（false），
   * 需由超级管理员通过 /init enable 显式开启（见 commands/init.ts）。未初始化
   * 群的更新在
   * app/registerHandlers.ts 的前置网关处直接丢弃（除 /init 与本群无关的
   * my_chat_member 外），不进入授权维护、入群验证、普通指令匹配、AI 调用等
   * 后续处理——Bot API 长轮询没有「取消订阅某个群」
   * 的机制，这是应用层面能做到的最接近「不监听」的效果，避免被拉进大量群时
   * 被拖垮。
   */
  isInitEnabled?: boolean;
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
 * 所有群共用的外部素材直链，四项各自独立。
 *
 * **缺字段 = 从没设过**，该项回退到 consts/ui/assets.ts 的内置常量，行为与
 * 没有这一块时逐字相同。这四项**显式写进文件是
 * 常态**：写一个与常量相同的值没有行为差别，而把四个旋钮摆在 state.json 里，
 * 换图的人才不必先去代码里翻键名。因此启动时缺项会被自动补成当前生效值（见
 * infra/storage/stateStore.ts 的 seedMissingAssetState），文件里永远看得到这四个键。
 *
 * 没有任何命令会改这一块，运行期也没有写入方，只由部署方手工编辑 state.json（改完要
 * 重启，运行中的进程持有权威内存并会整份覆写文件）。放 state 而不放 config/：
 * 它是「这套部署长什么样」的全局取值，因此属于全局块。
 *
 * 补齐是**一次性快照**：之后再改代码里的常量，已经落过盘的部署不会跟着变，
 * 那正是「部署方写下的值不被覆盖」的另一面。要跟随新常量就把那一项从
 * state.json 里删掉再重启。
 */
export interface GlobalAssetState {
  /** 「未卜先知」内联结果的缩略图直链；缺省用 FORTUNE_THUMBNAIL_URL。 */
  fortuneThumbnailUrl?: string;
  /** 「概率论」内联结果的缩略图直链；缺省用 PROBABILITY_THUMBNAIL_URL。 */
  probabilityThumbnailUrl?: string;
  /** gag 发言内联结果的缩略图直链；缺省用 GAG_THUMBNAIL_URL。 */
  gagThumbnailUrl?: string;
  /** `/set_qa` 表单内联结果的缩略图直链；缺省用 QA_THUMBNAIL_URL。 */
  qaThumbnailUrl?: string;
  /** `/reset_icon`、`/stop_copy` 复原机器人默认头像时抓的图；缺省用 BOT_DEFAULT_AVATAR_URL。 */
  botDefaultAvatarUrl?: string;
}

/**
 * 所有群共用的全局状态，按用途分块：`copy` 是复读状态与冷却时钟，`assets`
 * 是外部素材直链。AI provider 与模型只由 config/agent.json 管理，不进入状态。
 */
export interface GlobalState {
  copy: GlobalCopyState;
  assets: GlobalAssetState;
}

/**
 * state.json 的整体结构只保留所有群共用的 global。群级状态由
 * `database/storage.sqlite` 的 `chat_states` 表持久化，不在这里保留镜像。
 *
 * 结构变更只做手工迁移，解码器里不留旧形状的兼容分支：顶层出现 `globalCopy`
 * 这类旧键会被 knownKeys 当场拒绝，让运维照着报错迁移，而不是静默把复读状态
 * 读成空。
 */
export interface StateFileSchema {
  global: GlobalState;
}

/**
 * `state.global.copy` **解码后**的形态。
 *
 * 与运行期的 `GlobalCopyState` 分开：后者是主线程那份可变持有者，初始只有
 * `copiedUser: null`、三个字段由 adoptCopyTarget 一次写齐，因此写不成判别联合。
 * 而解码器（libs/stateFileCodec.ts 的 globalCopy）**已经**强制了「copiedUser 为
 * null ⟺ 没有 copyMode/copyChatId；copiedUser 非空 ⟺ copyChatId 是合法负数群 id」
 * 这条配对，这里把它表达进类型：消费侧不必再用非空断言把 copyChatId 从 undefined
 * 里捞出来，将来漏掉哪一侧校验也会在编译期当场暴露，而不是等到运行期凭空捏造
 * 出一个 chatId。
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

/** 解码后的 global 块；只有 copy 的形态与运行期不同，assets 逐字相同。 */
export interface DecodedGlobalState {
  copy: DecodedGlobalCopyState;
  assets: GlobalAssetState;
}

/** decodeStateFile 与 StateStore.load 的返回形态；落盘侧仍用 StateFileSchema。 */
export interface DecodedStateFile {
  global: DecodedGlobalState;
}
