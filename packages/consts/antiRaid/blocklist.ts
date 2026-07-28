/** /block 黑名单处置（入群秒踢与新晋管理员补扫）的节奏常量。 */

/**
 * 单个 id 的封禁最多尝试几次。第一次失败通常是 429 或瞬时 5xx，
 * grammY 的 autoRetry 已经吃掉了一部分，这里兜的是它放弃之后那一层。
 * 黑名单没有验证窗口兜底：一次失败不重试就等于把人永久留在群里。
 * 所属模块：workers/antiRaid/blocklistEffects.ts。
 */
export const BLOCKLIST_REMOVAL_MAX_ATTEMPTS: number = 3;

/** 两次尝试之间的退避基数，按尝试次数线性放大（1x、2x……）。 */
export const BLOCKLIST_REMOVAL_RETRY_DELAY_MS: number = 5_000;

/**
 * 补扫时每批处理多少个 id。Bot API 没有枚举群成员的接口，一次补扫固定是
 * O(名单长度) 次请求，而它们与验证超时踢人共用 joinVerificationApi 队列：
 * 不分批的话，几千条名单会把真正的踢人请求堵在后面几分钟。
 */
export const BLOCKLIST_SWEEP_BATCH_SIZE: number = 25;

/** 每批之间让出的时间，给排在后面的验证副作用留出插空的机会。 */
export const BLOCKLIST_SWEEP_BATCH_PAUSE_MS: number = 1_000;

/**
 * 「同一次入群已经记过反刷群计数」这张去重表的容量上界。正常情况下条目在
 * JOIN_WINDOW_MS 之后就被淘汰，这道闸兜的是一分钟内涌入海量黑名单入群的极端
 * 情形：宁可让超出的那些多记一次，也不让表跟着刷群规模无界增长。
 * 所属模块：antiRaid/blocklistGuard.ts。
 */
export const BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES: number = 5_000;

/**
 * 持久化黑名单移除 outbox 的批次数硬顶。达到上限时 `trackBlockedRemoval` 抛错。
 *
 * 这个抛错**不构成背压**，绝不能逃到 update 边界去：满仓通常正是一批永远封不掉
 * 的处置堆出来的，扣住 offset 只会变成「重投 -> 再抛 -> 非零退出」的重启循环，
 * 只能靠手改 removals.json 解开（见 blocklistGuard.ts 的 claimBlockedJoiner）。
 * 调用方一律就地降级：记一行点名日志，再用 requestBlocklistResweep 把这个群挂
 * 回补扫，等 outbox 腾出位置后补做。已登记的批次留在 outbox，没登记上的由补扫
 * 覆盖，两边都不丢任务。
 * 所属模块：infra/blocklist.ts。
 */
export const BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES: number = 10_000;

/**
 * 处置消息投递前，「落盘 → 再看一眼权威镜像还是不是同一批」的对账最多重来几轮。
 *
 * 正常一轮就够：重来意味着 flush 等待期间真的有 `/unblock` 或停管裁剪了这批，
 * 那是人为操作、次数有界。这道闸是兜底——每一轮都是一次整份 outbox 深拷贝 +
 * 带 fsync 的整文件重写，而本函数跑在 update 处理里面；没有上限的话，一个持续
 * 变动的镜像就能让这条 update 一直转下去，把 runner drain 拖到超时、扣住
 * Telegram offset、整批 update 重投。用尽只是这一次投递放弃并留一行错误日志，
 * outbox 里的任务不受影响，下一次边沿会重投。
 * 所属模块：antiRaid/blocklistDelivery.ts。
 */
export const BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS: number = 5;

type BlocklistRemovalOutboxVersion = 1;
/**
 * 黑名单移除 outbox 当前唯一支持的文件版本。
 * 所属模块：workers/diskIO/blocklistRemovalOutbox.ts。
 */
export const BLOCKLIST_REMOVAL_OUTBOX_VERSION: BlocklistRemovalOutboxVersion = 1;

/**
 * durable outbox 允许记录的失败边界。类型层从本常量派生，codec 也复用同一
 * 列表，避免新增分类时协议与校验分叉。
 * 所属模块：infra/blocklist.ts、workers/diskIO/blocklistRemovalOutbox.ts。
 */
export const BLOCKLIST_REMOVAL_FAILURE_TYPES: readonly [
  "delivery-boundary",
  "side-effect-incomplete",
  "worker-restarted",
  "missing-permission"
] = Object.freeze([
  "delivery-boundary",
  "side-effect-incomplete",
  "worker-restarted",
  // 机器人在那个群没有封禁权限（或目标本身是管理员）：与其它几档的区别在于
  // 「再试一次也没用」。它是 outbox 里一条批次卡住的**唯一自解释标记**——运维
  // 看到它就知道该去补权限，而不是去查网络或磁盘；主线程据此停掉这个群按时间
  // 的重试，只等一次确证的权限变更（见 infra/blocklist.ts）。
  "missing-permission",
]);

/**
 * outbox 单条处置参数允许出现的字段；codec 据此拒绝未知格式。
 * 所属模块：workers/diskIO/blocklistRemovalOutbox.ts。
 */
export const BLOCKLIST_REMOVAL_PARAM_KEYS: readonly string[] = Object.freeze([
  "chatId",
  "userIds",
  "probeMembership",
  "removalId",
  "joinedAt",
  "announcementMessageId",
]);

/**
 * outbox 单条任务允许出现的字段；codec 据此拒绝未知格式。
 * 所属模块：workers/diskIO/blocklistRemovalOutbox.ts。
 */
export const BLOCKLIST_REMOVAL_ENTRY_KEYS: readonly string[] = Object.freeze([
  "params",
  "createdAt",
  "attempts",
  "lastFailure",
]);

/**
 * outbox 顶层文件允许出现的字段；codec 据此拒绝未知格式。
 * 所属模块：workers/diskIO/blocklistRemovalOutbox.ts。
 */
export const BLOCKLIST_REMOVAL_FILE_KEYS: readonly string[] = Object.freeze([
  "version",
  "entries",
]);

/**
 * 同一批处置连续确认未落地达到该次数时升级诊断。任务仍留在 durable outbox，
 * 只能由完成回执、解除拉黑、停止管理或新补扫取代；安全任务不得因重试耗尽
 * 被静默删除。
 * 所属模块：infra/blocklist.ts。
 */
export const BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS: number = 5;

/**
 * 一次补扫没能全部落定后，最少隔多久才允许对同一个群再试。补扫由
 * 「是管理员 && 已 /init enable」的边沿触发，而失败重试挂在后续的管理员
 * 身份观测上——那类更新每条入群都会来一次，没有这道闸就是请求风暴。
 * 所属模块：infra/blocklist.ts。
 */
export const BLOCKLIST_SWEEP_RETRY_INTERVAL_MS: number = 300_000;

/**
 * 连续没落定的补扫，退避按失败次数线性放大后的上限。
 *
 * 固定 5 分钟一轮兜不住「永远封不掉」的目标：目标自己就是这个群的管理员、或
 * 机器人是管理员但没有封禁权限时，每一轮补扫都注定 `complete: false`，于是每
 * 5 分钟就重扫一次整份名单——O(名单长度) 次 getChatMember + banChatMember，
 * 而它们与验证超时踢人共用 joinVerificationApi 队列，真正的踢人请求会被永久
 * 顶在后面几分钟。退避必须有上限：`sweptAt` 那道闩锁始终要有打开的路径，
 * 权限修好之后不能等到进程重启才重扫（见 docs/04-invariants.md）。
 * 所属模块：infra/blocklist.ts。
 */
export const BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS: number = 21_600_000;
