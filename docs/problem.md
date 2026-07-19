# 全仓 Code Review 问题清单

review 范围：`src/` 全部 152 个文件 + `index.ts`，对照 `docs/architecture.md` 与
`.claude/CLAUDE.md` 的既有约束逐一核实（未罗列的分类/文件视为未发现真实问题，
不为凑数硬编）。`eslint .` 与 `tsc --noEmit` 全仓零告警，以下不重复罗列它们已能
catch 的问题（未用类型、导入顺序等），只列工具查不出的部分。

> **处理状态（2026-07-19）**：每项末尾标注了核查与处置结果。已修复项均通过
> `bun run check`（lint + typecheck + 全量测试）；标注「不修」的项写明了核查后
> 的理由。

## 性能问题

- `src/workers/aiChat/rollingMemory.ts:96,99` — `ensureMemoryCapacity` 的
  `while` 条件和内层 `for...of` 各自独立调用一次 `chatMemoryIds()`，该函数每次都用
  展开运算符从三个 Map 重新构建一个新 Set；同一轮循环内结果不变，却计算了两次。
  → **已修复**：改为每轮淘汰取一次 `chatMemoryIds()` 共用。

- `src/ai/tools/stickers.ts:60-61` — `buildStickerPackMenu` 对白名单每个贴纸包用
  `for...of` 串行 `await getStickerSet(pack)`，未并发拉取；冷启动或
  某包 60s 失败重试窗口刚过期时，会把多个包的网络延迟串联起来。
  → **已修复**：改为 `Promise.allSettled` 并发（不用 `Promise.all`：单包异常
  不作废其余已拉回的包），按原顺序组装菜单。

- `src/ai/stickers/sets.ts:22-39` — `getStickerSet` 缓存未命中时直接
  `await api.getStickerSet(packName)`，没有像 `src/ai/imageDescription.ts` 的
  `describeMedia` 那样把在途 Promise 存入缓存做请求合并；两轮并发回复同时组装
  贴纸菜单会对同一未缓存包各发一次 Telegram API 请求。
  → **已修复**：新增 `cache/stickers/sets.ts` 的 `inflightStickerSets` 在途
  合并（settle 后移除），并补了并发合并的测试。

- `src/workers/antiRaid/recentComments.ts:26-34` — 缓存满载时先做一次 O(n) sweep，
  若仍满则再线性扫描全表找 `observedAt` 最小的条目淘汰；但该 Map 每次更新都是
  "先 delete 旧 key 再 set"，JS Map 天然保持插入序即观察时间序，最早项恒为
  `recentChannelComments` 迭代器的第一项，无需线性扫描即可 O(1) 拿到。
  → **已修复**：改为取迭代器第一项 O(1) 淘汰（已核实唯一生产调用方恒传
  `Date.now()`，插入序即时间序；现有容量淘汰测试覆盖）。

- `src/infra/telegram/avatar.ts:124-126` — `attemptCopyUserProfilePhoto` 顺序
  `await bot.api.getChat` 再 `await bot.api.getUserProfilePhotos`，但后者不依赖前者
  结果，可并发以缩短这条用户可见的头像复制路径的往返延迟。
  → **已修复**：`Promise.allSettled` 并发，任一 rejected 则重抛原因走外层
  catch 原有的 transient-failure 语义。

- `src/libs/linkedQueue.ts:50` — `last(n)` 总是从队首整表遍历一遍（O(队列长度)），
  即使 n=1 也一样，没有利用类内部已维护的 `tail` 指针做 O(1) 特判；
  `src/workers/aiChat/replyQueue.ts:53` 每次入队回复触发都用 `.last(1)[0]` 只取
  最新一条消息，实际执行的却是对整条缓存（上限 100）的线性扫描。
  → **已修复**：`last(1)` 走 tail 指针 O(1) 特判。

- `src/commands/kick.ts:81-82` — 对同一个 `targetChatId` 的 `isChatMember` 和
  `banChatMember` 顺序 `await`，清单认为互不依赖可并发。
  → **不修**：核查后认定两调用并非真正独立——`banChatMember` 的副作用会改变
  `isChatMember` 的结果，并发发出后若 ban 先被 Telegram 处理，`wasMember`
  会误判为 false，战报把「踢出去」错算成「提前拉黑」。串行「先查再封」是
  文案正确性的保证；手动管理命令省一次 RTT 不值得引入竞态。

- `src/auto/message/facts.ts:48,65`（由 `triggerContext.ts:34,50` 触发）—
  `isBotMentioned` 与 `mentionsOtherUser` 各自独立调用 `messageEntitySource(message)`
  并各自遍历一次 `entities`，对同一条消息的实体数组重复解析了两次。
  → **已修复**：新增 `resolveMentionFacts` 单遍解析两个事实，
  `createMessageTriggerContext` 改用它；原两函数保留为薄封装（含单测在用）。

## 代码格式问题

- `src/ai/tools/replyToolset/typoHandling.ts:50` — `remainingActions >= 3` 是硬编码
  魔法数字。
  → **已修复**：提取为 `consts/aiChat/tools.ts` 的 `TYPO_MIN_REMAINING_ACTIONS`。
- `src/workers/aiChat/mediaText.ts:48` — 贴纸解析失败且没有 `stickerFallbackText`
  时，兜底文本用的是 `IMAGE_FALLBACK_PLACEHOLDER`，把贴纸错误标注成了图片。
  → **已修复**：新增 `STICKER_FALLBACK_PLACEHOLDER`（"[贴纸：解析失败，请无视
  此消息]"）并补了测试。
- `src/cache/antiRaid/lockdown.ts:16`、`src/cache/antiRaid/verification.ts:30`、
  `src/cache/antiRaid/recentComments.ts:11` — `resetLockdownCache` /
  `resetVerificationCache` / `resetRecentCommentsCache` 三个导出函数全仓无任何调用
  点，是死代码。
  → **已修复**：三个函数已删除（同目录 `resetAdminCache` /
  `resetLinkedChannelCache` 确有测试调用，保留）。
- `src/workers/diskIO/logFiles.ts:103-148`（`writeDay`/`flushLogBuffer`）—
  与同目录其余 flush 路径不同，写入失败即丢弃本批日志、不重试。
  → **不修**：这是 `writeDay` 注释里明确写下的有意取舍——日志在
  console/journal 里有完整兜底副本，且日志高频，失败保留 pending 需要另设
  内存上限防持续故障期间无界增长；与低频、无第二副本的 luck/验证快照场景
  不可比。保持现状。
- `src/cache/diskIO/verification.ts`、`src/cache/diskIO/luck.ts` 对比
  `src/cache/diskIO/snapshots.ts`、`src/cache/diskIO/stickers.ts` — 同一概念
  命名不一致（`*WorkerCache` vs `*Cache`、`*FlushTimer` vs `*FlushState`）。
  → **不修**：纯改名 churn，跨多个文件与测试、零行为收益；名字在各自文件内
  语义清晰，不值得为对称性动刀。
- `src/workers/diskIO/aiMemoryFiles.ts:47-74` 与
  `src/workers/diskIO/stickerCatalogFiles.ts:33-52` — dirty-set 遍历/写入/成功后
  删除/失败重试的循环逻辑近乎逐字重复。
  → **已修复**：抽出 `workers/diskIO/dirtyFlush.ts` 的 `flushDirtyEntries`
  共用（错误文案与重排语义逐字保留）。
- `src/libs/chatState.ts:13-16` — 四行结构完全相同的布尔开关删除。
  → **已修复**：收敛为遍历 `as const` 字段名数组的循环。
- `src/libs/workerSupervisor.ts` 与 `src/libs/supervisedWorker.ts` — 文件名近乎
  首尾颠倒但内容不对称，容易看错/搜错。
  → **已修复**：`workerSupervisor.ts` 重命名为 `libs/restartThrottle.ts`
  （内容本就只有重启节流器；`consts/workerSupervisor.ts` 服务两个使用方，
  保留原名）。
- `test/libs/boundedTaskRunner.test.ts` 等 4 个测试文件的 `deferred()` 逐字重复。
  → **已修复**：抽到 `test/libs/helpers.ts` 共用。
- `test/libs/boundedResponse.test.ts` 与 `test/libs/httpFetch.test.ts` 的
  `chunkedResponse()` 几乎相同。
  → **已修复**：统一为 `init?: ResponseInit` 签名后并入 `test/libs/helpers.ts`。
- `src/commands/kick.ts:31-33` 与 `src/commands/superAdminToggle.ts:34-36` —
  `mockerLabel` 三元表达式逐字重复。
  → **已修复**：抽到 `users/userLabel.ts` 的 `formatMockerLabel`。
- `src/commands/aiChat.ts`、`src/commands/init.ts`、`src/commands/jaCopy.ts` —
  三个开关命令处理器主体结构一致，清单建议抽参数化共享 helper。
  → **不修**：核查后「完全一致」不属实——`jaCopy` 没有 `invalidateAiChat`
  且带 /copy 透传分支，三者共用的权限/参数校验已抽在
  `resolveSuperAdminToggleArg` 里；剩余差异点（字段、是否失效、双份文案）做成
  config 对象后代码量不减反增、可读性下降。
- `src/auto/message/facts.ts:18-19` 与 `src/users/senderIdentity.ts:20-21` —
  `sender_chat`/`from`/频道帖发送者判定逐字重复。
  → **已修复**：抽出 `users/visibleSender.ts` 的 `visibleSenderChat`
  （两处输出形状不同，共享的是「sender_chat 优先、频道帖退回 chat」这条
  领域规则；`facts.ts` 的 `visibleSenderId` 一并复用）。
- `src/auto/message/animation.ts`、`photo.ts`、`sticker.ts` — 三个媒体 handler 里
  `shouldAttemptRandomTrigger` + `tryClaimUserReplyTrigger` 判定块完全相同。
  → **已修复**：抽出 `triggerPolicy.ts` 的 `claimRandomMediaTrigger`。

## 内存无限增长问题

- `src/cache/aiChat.ts:14`（`purgedAiMemoryChats`）+ `src/aiChat.ts` — 清单认为
  Worker 在 purge 期间崩溃会让 chatId 永久滞留、后续快照被误丢。
  → **不修**：核查后前提不成立——`recordChatMessage`/`recordChatMedia` 每次
  都先同步 `purgedAiMemoryChats.delete(chatId)`，而新的 memory 快照事件必然由
  新 record 触发（重启后的 Worker 不含该群记忆，无凭空快照），所以「新快照
  被永久误判丢弃」不会发生；滞留代价只是每个曾 purge 未回执的静默群占一个
  number，下一条消息即自愈。加超时兜底反而引入「超时后放行真正过期的迟到
  快照」的新风险，得不偿失。
- `src/cache/stickers/catalog.ts:21`（`failedEntries`）— 只增不删，贴纸被移出
  白名单包后失败记录滞留到 Worker 重启。
  → **已修复**：改为按包分桶的 `Map<pack, Set<file_unique_id>>`，
  `generatePackCatalog` 对账剪枝时同步清掉不在线上集合里的失败记录。

## 状态边界问题

- `src/workers/aiChat/rollingMemory.ts:165-204`（`hydrateMemories`）—
  try/catch 只包住 `JSON.parse` 本身，`snapshot.savedAt` 排序与
  `snapshot.buffer.slice(...)` 都在保护范围之外，形状不符会中断整个 hydrate
  并可能陷入崩溃循环。
  → **已修复**：解析成功后增加顶层形状校验（savedAt 数字、buffer/summaries
  数组、pendingSummary 为 string/null/缺省），不符即记日志丢弃该群、继续
  其余群，并补了坏语法/坏形状混合恢复的测试。

## 冲突机制问题

- `src/libs/inflight.ts:12-13`（`settleInflight`）— 用 `Promise.all` 实现，
  任一请求 reject 会提前整体失败返回，与函数名与注释承诺不符。
  → **已修复**：改为 `Promise.allSettled`，并补了「reject 不提前返回、仍等
  其余在途请求」的测试。
- `src/commands/luckChallenge/cache.ts:78-91`（`promotePendingDraw`）—
  跨东京零点后 `chosen_inline_result` 迟到时，pending 未命中会退化为用新一天
  密钥重新派生并直接落盘"确认"一个用户没见过的结果，与签名回执路径的
  fail closed 不一致。
  → **已修复**（实现比清单所述更细）：不能无条件 fail closed——回退派生同时
  承担着「同日进程重启后凭 chosen/回执重建确认」的正当职责（派生是确定性的，
  重建结果与用户所见一致，现有重启测试覆盖）。实修为：进程内一旦发生过跨零点
  日切换（`adoptLuckSecret` 清空过旧日 pending），pending 未命中即 fail
  closed 丢弃；签名回执验签通过自带「属于当天」的证明，仍允许重建派生。
  跨天专项测试并入 `test/commands/luckChallenge.test.ts`（末尾一个用例，
  经开关式 time mock 驱动；不能拆独立文件——见该文件注释记录的两个
  bun mock.module 行为坑）。

## 注释未更新等问题

- `src/ai/stickers/catalog.ts:73-74` — 指向 `types/aiChat.ts` 应为
  `types/stickers/protocol.ts`。→ **已修复**。
- `src/types/diskIO.ts:57,60-61` — 指向 `commands/luckChallenge.ts` 应为
  `commands/luckChallenge/cache.ts` 与 `commands/luckChallenge/key.ts`。
  → **已修复**。
- `src/infra/diskIO.ts:155` — 同上遗漏处。→ **已修复**。
- `src/workers/diskIO/snapshotFiles.ts:264` — 指向 `types/diskIO.ts` 应为
  `types/diskIO/storage.ts`。→ **已修复**。
- `src/cache/luckChallenge.ts:9-10,15-16` — 指向已拆分的
  `commands/luckChallenge.ts`。→ **已修复**：分别改指
  cache.ts / receipt.ts / telegramAdapter.ts。
- `src/consts/luckChallenge.ts:53-61`（`PENDING_LUCK_CACHE_MAX` 注释）—
  描述的"双向索引两个 Map"与函数名 `ensureCacheFreshForToday` 均不存在。
  → **已修复**：注释重写为单个 `pendingLuckDraws` Map + 正确函数名，并说明
  签名回执自描述验签、不占反向索引。

## 附：测试隔离风险专项核查

针对 CLAUDE.md 记录的历史事故（测试未完整 mock `infra/storage` 导致真实
`saveStateInBackground()` 覆盖了线上 `state.json`），本次对全部测试文件
逐一核对了 `mock.module` 覆盖范围是否与被测文件实际 import 的 storage/diskIO
导出一一对应。结论：

- 除下述一项外，各测试文件的 mock 覆盖完整，或经 `mkdtempSync`/显式 `dir` 参数
  重定向到临时目录，没有会漏到真实 `state.json`/`bot.lock`/`memory/` 的路径。
- `test/productionModules.test.ts` 原本只拦截 `Worker`/`fetch`/`setInterval`
  三类副作用，文件系统写入没有等价兜底——未来若有生产模块在 import 阶段引入
  落盘副作用，该测试不会报错拦截。
  → **已修复**：新增 `node:fs` / `node:fs/promises` 写路径拦截（`mock.module`
  包装真实模块、写函数计数并抛错，读取走真实实现），与其余三类副作用同级断言
  `fsWriteStarts: 0`。实现要点：本 bun 版本对 builtin 的 mock.module 装上后
  无法用二次 mock 还原，非 `--isolate` 的 `bun test` 会把 mock 泄漏给同进程
  随后加载的测试文件，因此拦截做成「带开关的透传包装」——测试结束关闭开关后，
  泄漏出去的只是对真实实现的纯透传（真实模块须先展开成普通对象快照再引用，
  否则命名空间会被追溯重绑定到 mock 自身）。
