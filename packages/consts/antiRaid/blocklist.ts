/** /block 黑名单处置（入群秒踢与新晋管理员补扫）的节奏常量。 */

/**
 * 单个 id 的封禁最多尝试次数。带 retry_after 的 429 由 Telegram 总闸承接；
 * 本值约束网络错误、有限 5xx 重试耗尽及其它可恢复失败的重试。
 * 所属模块：workers/antiRaid/blocklistEffects.ts。
 */
export const BLOCKLIST_REMOVAL_MAX_ATTEMPTS: number = 3;

/** 两次尝试之间的退避基数，按尝试次数线性放大。 */
export const BLOCKLIST_REMOVAL_RETRY_DELAY_MS: number = 5_000;

/**
 * 黑名单用户被判定为已销号所需的 PARTICIPANT_ID_INVALID 连续次数。
 *
 * 一个群的一次补扫处置里，该用户的全部探测与封禁请求都被 Telegram 以
 * PARTICIPANT_ID_INVALID 拒绝，记 1 次；任一群的处置落定即清零。达到本值时
 * 把该用户移出黑名单并裁剪待踢批次。`blocklist_entries.data.participantInvalidCount`
 * 只保存 1 到本值减 1。
 * 所属模块：infra/blocklist/participantInvalid.ts、database/codec/identity.ts。
 */
export const BLOCKLIST_PARTICIPANT_INVALID_LIMIT: number = 5;

/**
 * 一条回执的销号计数写入最多预热几轮。预热等待期间相关身份被 LRU 淘汰时重新预热；
 * 轮数用尽只记错误并跳过这条回执。
 * 所属模块：infra/blocklist/participantInvalid.ts。
 */
export const BLOCKLIST_PARTICIPANT_INVALID_WRITE_ATTEMPTS: number = 3;

/**
 * 补扫时每批处理多少个 id。一次补扫是 O(名单长度) 次请求，
 * 与验证超时踢人共用主线程 kick 类 429 车道；分批并在批间让步，
 * 允许新到的验证踢人在下一批之前插入。
 */
export const BLOCKLIST_SWEEP_BATCH_SIZE: number = 15;

/** 每批之间让出的时间，给排在后面的验证副作用留出插空的机会。 */
export const BLOCKLIST_SWEEP_BATCH_PAUSE_MS: number = 1_000;

/**
 * 「同一次入群已经记过反刷群计数」这张去重表的容量上界。条目在
 * JOIN_WINDOW_MS 之后淘汰；超过上限时，超出的入群可能多记一次计数。
 * 所属模块：antiRaid/blocklistGuard.ts。
 */
export const BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES: number = 5_000;

/**
 * 持久化黑名单移除 outbox 的批次数硬顶。达到上限时 `trackBlockedRemoval` 抛错。
 *
 * 这个抛错**不构成背压**，不得逃到 update 边界（见 blocklistGuard.ts 的
 * claimBlockedJoiner）。调用方一律就地降级：记一行点名日志，再用
 * requestBlocklistResweep 把这个群挂回补扫，等 outbox 腾出位置后补做。
 * 已登记的批次留在 outbox，没登记上的由补扫覆盖。
 * Disk I/O 启动 inspect 对 `pending_blocked_removals` 行数执行同一上限，超出即拒绝启动。
 * 所属模块：infra/blocklist/。
 */
export const BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES: number = 4_096;

/**
 * 启动恢复从 SQLite 顺序接管待踢 outbox 时的单页行数。使用 removal_id 游标，
 * 每页完成存储形态与领域解码后才读取下一页。
 * 所属模块：database/interact/inspection.ts、database/interact/validation.ts。
 */
export const BLOCKLIST_REMOVAL_HYDRATION_PAGE_SIZE: number = 2_048;

/**
 * 处置消息投递前，「落盘 → 再看一眼权威镜像还是不是同一批」的对账最多重来几轮。
 *
 * 重来表示 flush 等待期间 `/block disable` 或停管裁剪了这批。每一轮是一次整份
 * outbox 深拷贝加带 fsync 的整文件重写，而本函数跑在 update 处理里面，因此轮数有上限。
 * 用尽只是这一次投递放弃并留一行错误日志，outbox 里的任务不受影响，下一次边沿会重投。
 * 所属模块：antiRaid/blocklistDelivery.ts。
 */
export const BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS: number = 5;

/**
 * durable outbox 允许记录的失败边界。类型层从本常量派生，codec 复用同一列表。
 * 所属模块：infra/blocklist/、database/codec/identity.ts。
 */
export const BLOCKLIST_REMOVAL_FAILURE_TYPES: readonly [
  "delivery-boundary",
  "side-effect-incomplete",
  "worker-restarted",
  "missing-permission"
] = [
  "delivery-boundary",
  "side-effect-incomplete",
  "worker-restarted",
  // 机器人在该群没有封禁权限（或目标本身是管理员）：重试无效；主线程据此停掉
  // 这个群按时间的重试，只等一次确证的权限变更（见 infra/blocklist/）。
  "missing-permission",
];

/**
 * outbox 单条处置参数允许出现的字段；codec 据此拒绝未知格式。
 * 所属模块：database/codec/identity.ts。
 */
export const BLOCKLIST_REMOVAL_PARAM_KEYS: readonly string[] = [
  "chatId",
  "userIds",
  "probeMembership",
  "removalId",
  "joinedAt",
  "announcementMessageId",
];

/**
 * outbox 单条任务允许出现的字段；codec 据此拒绝未知格式。
 * 所属模块：database/codec/identity.ts。
 */
export const BLOCKLIST_REMOVAL_ENTRY_KEYS: readonly string[] = [
  "params",
  "createdAt",
  "attempts",
  "lastFailure",
];

/**
 * 同一批处置连续确认未落地达到该次数时升级诊断。任务仍留在 durable outbox，
 * 只能由完成回执、解除拉黑、停止管理或新补扫取代；安全任务不得因重试耗尽
 * 被静默删除。
 * 所属模块：infra/blocklist/。
 */
export const BLOCKLIST_REMOVAL_REPLAY_ALERT_ATTEMPTS: number = 5;

/**
 * 一次补扫没能全部落定后，同一个群再试的最短间隔。补扫由
 * 「是管理员 && 已 /init enable」的边沿触发，失败重试挂在后续的管理员
 * 身份观测上，本间隔限制重试频率。
 * 所属模块：infra/blocklist/。
 */
export const BLOCKLIST_SWEEP_RETRY_INTERVAL_MS: number = 300_000;

/**
 * 连续没落定的补扫，退避按失败次数线性放大后的上限。
 *
 * 目标自己是该群管理员、或机器人是管理员但没有封禁权限时，每一轮补扫都是
 * `complete: false`，每轮是 O(名单长度) 次 getChatMember + banChatMember；
 * 重扫间隔随失败次数增大，直到本上限。`sweptAt` 闩锁始终有打开的路径，
 * 权限修好之后不必等到进程重启才重扫（见 docs/cn/04-invariants.md）。
 * 所属模块：infra/blocklist/。
 */
export const BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS: number = 21_600_000;
