/** `/gag` 允许的离散分钟数。 */
export type GagDurationMinutes = 5 | 10 | 15;

/** `/gag` 解析完成后的稳定参数；目标为空表示使用回复消息。 */
export interface ParsedGagCommand {
  readonly durationMinutes: GagDurationMinutes;
  readonly rawTarget: string;
  readonly tool: string;
}

/** gag 按钮预填的保留查询；只有频道身份携带目标频道 id 与会话令牌。 */
export interface ParsedGagInlineQuery {
  readonly targetChannelId?: number;
  /** 频道分支的会话令牌；与 targetChannelId 同时出现或同时缺席。 */
  readonly token?: string;
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
  /**
   * 频道发言入口的会话令牌，只随群内那条带按钮的开始提示分发。
   *
   * 频道身份的 inline 查询没有可比对的发起者（普通用户按 `from.id` 匹配），
   * 只有持有本令牌才允许拿到本会话的 inline 结果，否则任何账号都能靠一个频道
   * id 读出 chatLabel 里的私有群名称。用户会话同样生成，但不进按钮预填。
   */
  readonly inlineToken: string;
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
