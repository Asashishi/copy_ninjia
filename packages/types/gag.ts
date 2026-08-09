/** `/gag` 允许的离散分钟数。 */
export type GagDurationMinutes = 5 | 10 | 15;

/** `/gag` 解析完成后的稳定参数；目标为空表示使用回复消息。 */
export interface ParsedGagCommand {
  readonly durationMinutes: GagDurationMinutes;
  readonly rawTarget: string;
  readonly tool: string;
}

/** gag 频道按钮预填的查询；普通用户入口使用无前缀的空查询。 */
export interface ParsedGagInlineQuery {
  readonly targetChannelId: number;
  readonly text: string;
}

/** 主线程 command 域维护的一条临时 gag 会话。 */
export interface GagSession {
  /** 会话所在群；主缓存以它定位同群的目标列表。 */
  readonly chatId: number;
  /** 被 gag 的 Telegram 用户或频道身份。 */
  readonly targetId: number;
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
  /** 普通用户提示的 ephemeral_message_id，或频道公开提示的 message_id；发送成功前为 0。 */
  noticeMessageId: number;
  /** 开始提示的发送 promise 是否尚未结算；ending 必须等它交出 message id。 */
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
