/**
 * 全量基准被测对象的人类可读名称。
 *
 * 报告 JSON、子进程参数与性能场景继续使用稳定 id；文档把这里的动作名称放在
 * 第一行、把 id 放在第二行。这样第一次接触项目的人先看到“做了什么”，排查者
 * 仍能拿 id 精确定位和复跑代码场景。
 */

import type { Language } from "./markdownCopy";

/** 一种语言下的被测对象名称与速率单位。 */
export interface BenchmarkEntryCopy {
  readonly labels: Readonly<Record<string, string>>;
  readonly operationsPerSecond: string;
  readonly recordsPerSecond: string;
}

const ZH: BenchmarkEntryCopy = {
  labels: {
    "module-graph": "加载生产模块",
    "instance-lock": "取得数据根单实例锁",
    "orphan-cleanup": "清理中断残留的原子写临时文件",
    "state-load": "读取并严格解析运行状态",
    "deployment-inputs": "校验部署配置与 AI 人设",
    "disk-io-init": "创建 Disk I/O Worker",
    "persisted-load": "从 SQLite 与快照恢复数据",
    hydrate: "填充主线程热缓存",
    "ready-total": "进程启动到本地恢复就绪",
    "incoming-message-spine": "单条群消息进入主干并完成基础分发",
    "sender-no-username": "解析无 username 的发送者身份",
    "sender-stable-username": "解析 username 未变化的发送者身份",
    "self-sent-empty": "拒绝机器人自身的空消息",
    "chat-state-read": "直接读取当前群状态",
    "chat-state-map-read": "从群状态 Map 查询一群",
    "ai-activity-window": "更新 AI 活跃度滑动窗口",
    "ai-activity-lru-miss": "AI 活跃度 LRU 未命中并新建记录",
    "identity-permission-read": "查询本地身份权限",
    "flood-window-hit": "查询已有刷屏控制窗口",
    "flood-window-growth": "刷屏控制窗口增长与淘汰",
    "flood-window-steady": "刷屏控制窗口稳态更新",
    "ad-empty-metadata": "广告检测空元数据快速路径",
    "ad-wire-clone": "复制广告候选的 Worker 消息载荷",
    "ad-capacity-reject": "广告检测队列满载拒绝",
    "buffered-message-build": "构造一条 AI 上下文消息",
    "transcript-render": "把 AI 群聊上下文渲染成提示词",
    "reply-reference": "提取回复引用",
    "mention-facts": "从 Telegram entity 提取 @ 提及",
    "mention-facts-plain": "无 entity 文本的提及快速路径",
    "gag-speak-counter": "更新 gag 发言计数",
    "luck-receipt-fast-path": "认领运势发送回执",
    "luck-tier-table": "按百分比查询运势档位",
    "redact-clean-log": "检查无需脱敏的日志文本",
    "join-log-append": "追加 1 条入群日志并收到落盘回执",
    "identity-policy-write": "批量写入 128 条身份策略并收到落盘回执",
    "chat-state-write": "写入 1 群状态并收到 SQLite 落盘回执",
    "ai-memory-snapshot": "重写 1 份 AI 记忆快照并收到落盘回执",
    "diagnostic-log": "追加 1 条诊断日志并收到落盘回执",
    "ad-detect-command": "广告检测：完整判定并处置 1 条群消息（不含网络）",
    "ai-reply-command": "ai_chat：生成并发送 1 轮回复（不含网络与拟人停顿）",
    "main-lru-read": "查询主线程身份 LRU 缓存",
    "main-write-through-acked": "主线程身份写透 SQLite 并等待回执",
    "storage-read-hot-connection": "SQLite 查询（复用热连接）",
    "storage-read-cold-connection": "SQLite 查询（每批新建连接）",
    "storage-write-hot-connection": "SQLite 事务写入（复用热连接）",
    "storage-write-cold-connection": "SQLite 事务写入（每批新建连接）",
    "linked-timestamp-window": "滑动时间窗口追加与过期淘汰",
    "bounded-rolling-buffer": "AI 有界滚动记忆追加与淘汰",
    snapshot: "复制 25 万条入群日志快照",
    capacity: "把 25 万条入群日志裁剪到容量上限",
  },
  operationsPerSecond: "次/s",
  recordsPerSecond: "条记录/s",
};

const EN: BenchmarkEntryCopy = {
  labels: {
    "module-graph": "Load production modules",
    "instance-lock": "Acquire the single-instance data-root lock",
    "orphan-cleanup": "Remove interrupted atomic-write temporary files",
    "state-load": "Read and strictly parse runtime state",
    "deployment-inputs": "Validate deployment config and AI personas",
    "disk-io-init": "Create the Disk I/O Worker",
    "persisted-load": "Recover data from SQLite and snapshots",
    hydrate: "Populate main-thread hot caches",
    "ready-total": "Process start to local recovery ready",
    "incoming-message-spine": "Route one group message through base dispatch",
    "sender-no-username": "Resolve a sender without a username",
    "sender-stable-username": "Resolve a sender whose username is unchanged",
    "self-sent-empty": "Reject an empty self-sent message",
    "chat-state-read": "Read the current chat state directly",
    "chat-state-map-read": "Look up one chat in the state Map",
    "ai-activity-window": "Update the AI activity sliding window",
    "ai-activity-lru-miss": "Create a missing AI activity LRU entry",
    "identity-permission-read": "Look up local identity permissions",
    "flood-window-hit": "Look up an existing flood-control window",
    "flood-window-growth": "Grow and trim a flood-control window",
    "flood-window-steady": "Update a steady-state flood-control window",
    "ad-empty-metadata": "Ad detection empty-metadata fast path",
    "ad-wire-clone": "Clone an ad candidate Worker payload",
    "ad-capacity-reject": "Reject a full ad-detection queue",
    "buffered-message-build": "Build one AI context message",
    "transcript-render": "Render AI chat context into a prompt",
    "reply-reference": "Extract a reply reference",
    "mention-facts": "Extract an @mention from Telegram entities",
    "mention-facts-plain": "No-entity mention fast path",
    "gag-speak-counter": "Update a gag speech counter",
    "luck-receipt-fast-path": "Claim a fortune-send receipt",
    "luck-tier-table": "Look up a fortune tier by percentage",
    "redact-clean-log": "Check log text that needs no redaction",
    "join-log-append": "Append one join log and receive its durable ACK",
    "identity-policy-write": "Write 128 identity policies and receive the durable ACK",
    "chat-state-write": "Write one chat state and receive its SQLite durable ACK",
    "ai-memory-snapshot": "Rewrite one AI memory snapshot and receive its durable ACK",
    "diagnostic-log": "Append one diagnostic log and receive its durable ACK",
    "ad-detect-command": "Ad detection: fully classify and dispose of one group message (no network)",
    "ai-reply-command": "ai_chat: generate and send one reply turn (no network or human-like pause)",
    "main-lru-read": "Query the main-thread identity LRU cache",
    "main-write-through-acked": "Write an identity through to SQLite and await its ACK",
    "storage-read-hot-connection": "SQLite query (reused warm connection)",
    "storage-read-cold-connection": "SQLite query (new connection per batch)",
    "storage-write-hot-connection": "SQLite transactional write (reused warm connection)",
    "storage-write-cold-connection": "SQLite transactional write (new connection per batch)",
    "linked-timestamp-window": "Append to and expire a sliding timestamp window",
    "bounded-rolling-buffer": "Append to and evict from bounded AI rolling memory",
    snapshot: "Copy a snapshot of 250k join-log records",
    capacity: "Trim 250k join-log records to the capacity limit",
  },
  operationsPerSecond: "ops/s",
  recordsPerSecond: "records/s",
};

const JA: BenchmarkEntryCopy = {
  labels: {
    "module-graph": "本番モジュールを読み込む",
    "instance-lock": "データルートの単一インスタンスロックを取得する",
    "orphan-cleanup": "中断された原子的書き込みの一時ファイルを削除する",
    "state-load": "実行時状態を読み込み厳密に解析する",
    "deployment-inputs": "デプロイ設定と AI ペルソナを検証する",
    "disk-io-init": "Disk I/O Worker を生成する",
    "persisted-load": "SQLite とスナップショットからデータを復元する",
    hydrate: "メインスレッドのホットキャッシュを満たす",
    "ready-total": "プロセス起動からローカル復元完了まで",
    "incoming-message-spine": "グループメッセージ 1 件を基本ディスパッチする",
    "sender-no-username": "username のない送信者を解決する",
    "sender-stable-username": "username が変わらない送信者を解決する",
    "self-sent-empty": "Bot 自身からの空メッセージを拒否する",
    "chat-state-read": "現在のチャット状態を直接読む",
    "chat-state-map-read": "状態 Map から 1 チャットを検索する",
    "ai-activity-window": "AI 活動スライディングウィンドウを更新する",
    "ai-activity-lru-miss": "AI 活動 LRU の未登録項目を作成する",
    "identity-permission-read": "ローカルの ID 権限を検索する",
    "flood-window-hit": "既存の連投制御ウィンドウを検索する",
    "flood-window-growth": "連投制御ウィンドウを追加・削除する",
    "flood-window-steady": "定常状態の連投制御ウィンドウを更新する",
    "ad-empty-metadata": "広告検出の空メタデータ高速経路",
    "ad-wire-clone": "広告候補の Worker ペイロードを複製する",
    "ad-capacity-reject": "満杯の広告検出キューを拒否する",
    "buffered-message-build": "AI コンテキストメッセージ 1 件を構築する",
    "transcript-render": "AI チャット文脈をプロンプトに描画する",
    "reply-reference": "返信参照を抽出する",
    "mention-facts": "Telegram entity から @メンションを抽出する",
    "mention-facts-plain": "entity のないメンション高速経路",
    "gag-speak-counter": "gag 発言カウンターを更新する",
    "luck-receipt-fast-path": "運勢送信レシートを引き受ける",
    "luck-tier-table": "パーセントから運勢ランクを検索する",
    "redact-clean-log": "秘匿不要のログテキストを検査する",
    "join-log-append": "参加ログ 1 件を追記して永続化 ACK を受け取る",
    "identity-policy-write": "ID ポリシー 128 件を書き込み永続化 ACK を受け取る",
    "chat-state-write": "チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る",
    "ai-memory-snapshot": "AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る",
    "diagnostic-log": "診断ログ 1 件を追記して永続化 ACK を受け取る",
    "ad-detect-command": "広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）",
    "ai-reply-command": "ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）",
    "main-lru-read": "メインスレッドの ID LRU キャッシュを検索する",
    "main-write-through-acked": "ID を SQLite まで書き通し ACK を待つ",
    "storage-read-hot-connection": "SQLite クエリ（ウォーム接続を再利用）",
    "storage-read-cold-connection": "SQLite クエリ（バッチごとに新規接続）",
    "storage-write-hot-connection": "SQLite トランザクション書き込み（ウォーム接続を再利用）",
    "storage-write-cold-connection": "SQLite トランザクション書き込み（バッチごとに新規接続）",
    "linked-timestamp-window": "時刻スライディングウィンドウの追加と期限切れ削除",
    "bounded-rolling-buffer": "AI 有界ローリングメモリの追加と削除",
    snapshot: "参加ログ 25 万件のスナップショットを複製する",
    capacity: "参加ログ 25 万件を容量上限まで切り詰める",
  },
  operationsPerSecond: "回/s",
  recordsPerSecond: "レコード/s",
};

/** 文档语言对应的人类可读被测对象名称。 */
export function benchmarkEntryCopy(language: Language): BenchmarkEntryCopy {
  switch (language) {
    case "zh":
      return ZH;
    case "en":
      return EN;
    case "ja":
      return JA;
  }
}
