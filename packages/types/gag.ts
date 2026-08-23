/** `/gag` 允许的离散分钟数。 */
export type GagDurationMinutes = 5 | 10 | 15;

/** `/gag` 解析完成后的稳定参数；目标为空表示使用回复消息。 */
export interface ParsedGagCommand {
  readonly durationMinutes: GagDurationMinutes;
  readonly rawTarget: string;
  readonly tool: string;
}

/**
 * gag 按钮预填查询；用户与频道均只携带目标 ID，不得扩展摘要、token 或群 ID
 * 字段。具体群属于落群后的 marker/message 校验边界。
 */
export interface ParsedGagInlineQuery {
  readonly targetId: number;
  readonly text: string;
}

/** 主线程 command 域维护的一条临时 gag 会话。 */
export interface GagSession {
  /** 命令入口确定的权威会话群；不得从 inline query 声称值或 token 派生。 */
  readonly chatId: number;
  /** 被 gag 的 Telegram 用户或频道身份。 */
  readonly targetId: number;
  /** 隐藏 marker 使用的目标主页；群 ID 另以公开 fragment 挂载，不承担保密。 */
  readonly targetProfileUrl: string;
  /** 群内提示使用的安全目标标签。 */
  readonly targetLabel: string;
  /** inline 结果列表使用的安全群标签。 */
  readonly chatLabel: string;
  /** 命令给出的用具；已压成单行并剥掉双向控制符。 */
  readonly tool: string;
  /** 会话长度，只允许 5、10 或 15 分钟。 */
  readonly durationMinutes: GagDurationMinutes;
  /** starting 只占容量不拦消息；active 才执行删除；ending 已被唯一结束方认领。 */
  phase: "starting" | "active" | "ending";
  /** active 后的绝对到期时间；starting 时为 0。 */
  expiresAt: number;
  /** 普通用户群内公开状态的 message_id；频道入口及发送成功前为 0。 */
  publicNoticeMessageId: number;
  /** 当前发言入口：用户为 ephemeral_message_id，频道为公开 message_id。 */
  speakNoticeMessageId: number;
  /** 滚动换新已经发出但尚未提交的入口 id；没有在途替换时为 0。 */
  pendingSpeakNoticeMessageId: number;
  /** 已被新入口取代但删除失败的入口 id；至多保留一个，避免无界堆积。 */
  retiredSpeakNoticeMessageId: number;
  /**
   * 当前发言入口**实际所在**的论坛话题；General、非论坛群为 undefined。
   *
   * 被管教的人换个话题说话时，入口必须跟着搬过去，否则他在话题 B 被删消息、
   * 按钮却留在话题 A，等于被封了口还找不到说话的地方。搬家复用换新那套
   * current/pending/retired 槽位：先在新话题发一条，再删旧的（见
   * commands/gag/inline.ts 的 replaceGagSpeakNotice）。本字段只在发送成功后
   * 更新，因此它永远指向「群里现在真的挂着按钮的那个话题」，判定是否需要搬家
   * 就拿它和来消息的话题比。删除不需要话题，故 pending/retired 只存 id。
   */
  speakNoticeThreadId: number | undefined;
  /** 当前入口发出后本群收到的消息数；达到固定阈值才换新。 */
  messagesSinceSpeakNotice: number;
  /** 唯一的入口换新任务；结束状态必须等它交出在途 message id。 */
  speakNoticeRefreshTask: Promise<void> | null;
  /** 全部开始提示的发送流程是否尚未结算；ending 必须等它交出所有 message id。 */
  noticePending: boolean;
  /** 到期 timer；starting/ending 时为 null，且 active timer 不阻止进程退出。 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 删除提示失败后的下一档有限重试下标。 */
  cleanupRetryIndex: number;
  /** 提示清理重试 timer；未排定或正在执行时为 null。 */
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  /** ending 阶段唯一的完整 Telegram 收尾，防止 timer、命令与停机重复或穿插。 */
  endingTask: Promise<boolean> | null;
}

/** renderGagSpeech 的入参；随机源可注入以精确测试概率区间。 */
export interface RenderGagSpeechOptions {
  readonly text: string;
  readonly tool: string;
  readonly random?: () => number;
}
