# 全仓 Review 修复计划

审阅基线：`2c26b31`（2026-07-20）。已通读生产代码、配置、持久化协议与主要测试；`bun run check` 全部通过（lint、TypeScript、551 个测试，函数覆盖率 88.60%、行覆盖率 90.22%）。下面只保留有明确代码证据、故障窗口和可验证修复方式的问题，按优先级排序。

> 审阅期间工作区另有一处非本计划产生的改动：`src/consts/aiChat/tools.ts` 的 `MAX_TOOL_ROUNDS` 从 45 调为 35，文件 mode 也变为可执行。本次提交按用户要求一并保留该改动；第 4 项说明了为什么只调整这个数字不能根治生产日志里的错误。

## P0 — 会丢 update、绕过验证或永久改变群权限

### [ ] 1. 排空超时后仍确认最大 update offset，会永久跳过尚未完成的 update

- 证据：`src/app/registerHandlers.ts:37-43` 在 update 刚进入 middleware 时就更新 `lastSeenUpdateId`；`src/app/lifecycle.ts:153-166` 在 `waitForRunnerDrain` 返回后无条件用这个最大值调用 `getUpdates(offset + 1)`；`src/app/lifecycle.ts:231-245` 超时仅记日志，未把“仍有在途任务”返回给调用方。
- 故障窗口：某个 update 处理超过 5 秒时，退出流程会确认它以及更小的所有 update ID。进程随后退出，即使该 handler 尚未完成或已经被 Worker/进程终止，Telegram 也不会再投递它。
- 修复：让排空函数返回明确结果；只在 `runner.size() === 0` 时做显式 offset 确认。若以后需要在未完全排空时确认，只能维护“连续完成前沿”，不能使用“已开始处理的最大 ID”。
- 验收：增加 `runner.size()` 始终非零的超时测试，断言不调用 `getUpdates`；再覆盖并发 update 乱序完成，断言绝不跨过未完成的较小 ID。

### [ ] 2. 验证状态先删除、踢人副作用后执行，Worker/进程崩溃可让待验证成员漏网

- 证据：`src/states/verification.ts:202-210` 的刷屏分支和 `src/states/verification.ts:279-288` 的超时分支都返回 `next: undefined` 后再安排 `expel*`/`recheckInviter`；`src/workers/antiRaid/verificationRuntime.ts:77-97` 先同步删除状态并发布 `verificationDelete`，随后才异步执行 Telegram API 副作用。
- 故障窗口：删除已经写入主线程镜像/磁盘，但 Worker 在 `banChatMember`、消息清理或邀请人终核之前崩溃。重建时没有记录可接管，成员仍留在群里，也不会再次超时。
- 修复：增加可持久化的终态（例如 `checkingInviter`、`expelling`），保存待执行快照；只有幂等副作用确认完成后才发布 delete。启动和 Worker 重建时继续执行终态，重复踢人/删消息按成功或“目标已不存在”收敛。
- 验收：分别在“终核前”“踢人前”“部分消息已删除”三个边界模拟崩溃，恢复后必须完成处置，且不会误伤同一用户后来重新入群产生的新代际记录。

### [ ] 3. Lockdown 先改 Telegram 权限、后记录恢复信息，崩溃可永久关闭成员邀请

- 证据：`src/workers/antiRaid/lockdownRuntime.ts:120-139` 先读取权限并成功调用 `setChatPermissions`，之后才 `dispatchLockdown(applyResult)`；`src/workers/antiRaid/lockdownRuntime.ts:69-73` 再把事件回主线程；`src/antiRaid.ts:78-85` 最后才更新 `ChatState.lockdown` 并后台落盘。
- 故障窗口：权限已限制后，Anti-Raid Worker 在回报前崩溃，或进程在后台 `state.json` 写完前退出。新 Worker/新进程看不到 lockdown，因而永远不会恢复原权限。
- 修复：改成 write-ahead 协议：先持久化包含原权限的 `applying` intent 并等待确认，再修改 Telegram；成功后标记 `active`，恢复阶段标记 `restoring`。启动时对三种阶段做幂等对账，不能只恢复当前的 `active`。
- 验收：在 getChat 后、持久化后、setChatPermissions 后、active 回报前逐点故障注入；任一重启路径最终都应恢复权限或继续完成锁定，不能留下无 owner 的限制。

## P1 — 生产可见故障、状态生命周期或停机一致性

### [ ] 4. Gemini 工具预算只限制客户端轮数，无法阻止服务端 `TOO_MANY_TOOL_CALLS`（Google Search 子项已限制为 3 次）

- 生产证据：`logs/2026-07-19.json` 与 `logs/2026-07-20.json` 共出现 6 次 `finishReason=TOO_MANY_TOOL_CALLS`，每次随后都是零动作轮。官方定义是“模型连续调用了过多工具，系统终止执行”：<https://ai.google.dev/api/generate-content#FinishReason>。
- 这次 `2026-07-20 02:00:45.490` 的上下文：02:00:26 的直接生图请求包含拼错的角色名，02:00:41 修正拼写后的并发请求随后成功；前一轮在 02:00:45 以零动作结束。结合 `src/consts/aiChat/prompts/search.ts:1-4` 对不确定信息的强制查证、`src/ai/tools/replyToolset/orchestrator.ts:56-64` 每轮都注册服务端 `googleSearch`，最可能是搜索/消歧连续调用过多，而不是本地 `MAX_TOOL_ROUNDS` 主动中止。现有日志不足以证明具体工具和次数，需先补遥测。
- 放大因素：`src/workers/aiChat/geminiReply.ts:58-100` 每个响应的所有 function call 都会执行，只限制往返轮数，没有“整轮调用总数”预算；`src/ai/tools/replyToolset/orchestrator.ts:31-36,99-125` 只给可见 action 计数，天气查询、查看贴纸包、失败/被拒调用均可反复消耗工具轮次。历史上把本地上限从 25 提到 45，只会扩大客户端循环空间，不能控制一次 Gemini 生成内部的服务端搜索次数。
- 已完成（2026-07-20）：系统提示词明确告诉模型“本轮累计最多 3 次”和当前剩余额度；代码统计服务端 Google Search invocation，累计达到 3 次后从后续请求移除搜索工具；遇到 `TOO_MANY_TOOL_CALLS` 且尚无外部动作时，关闭搜索后只降级重试一次。Google API 没有为一次内置搜索生成提供客户端可设置的逐调用硬上限，因此若服务端在单次响应内部已经超额，只能记录并阻止后续轮次继续搜索。
- 修复：
  1. [x] 为 `googleSearch` 增加累计 3 次预算，达到后从后续请求移除搜索工具。
  2. [ ] 增加独立的“总自定义工具调用数”硬顶，计入查询、查看、失败和同一响应里的并行调用；达到领域上限后从下一请求移除该工具，而不是继续返回错误诱导模型重试。
  3. [x] `TOO_MANY_TOOL_CALLS` 只在确认本轮尚无任何外部副作用时，允许一次移除搜索后的降级重试；已有副作用时直接终止，避免重复发消息/图片。
  4. [ ] 补全不含用户内容和工具参数的诊断字段：客户端 round、累计/分工具调用次数、服务端 tool invocation 数、`finishMessage`、是否已有副作用。当前新增日志只覆盖 chatId、观察到的搜索数、剩余额度及是否触发降级。
- 验收：用“错拼角色名 + 生图”场景做回归；构造连续 search、连续无效参数、同响应多调用三类夹具，均须在预算内收敛；降级重试不得重复任何已成功动作。

### [ ] 5. 被标为 unusable 的 Gemini candidate 仍返回上层，可能继续执行工具或消费异常文本

- 证据：`src/ai/gemini.ts:90-97` 对非 `STOP` 只记录日志，仍返回原 response；`src/workers/aiChat/geminiReply.ts:78-100` 随即提取并执行 function call，`src/ai/imageDescription.ts:122-127`、`src/workers/aiChat/compaction.ts:164-165` 和贴纸包摘要也直接提取文本。只有 `src/ai/imageGeneration.ts:77-97` 自己再次要求 `STOP`。
- 影响：`SAFETY`、`PROHIBITED_CONTENT`、`TOO_MANY_TOOL_CALLS`、未来新增 finish reason 若夹带部分 content/function call，仍可能触发外部副作用、写入摘要/目录或发送部分内容；“unusable”目前只是日志文案，不是代码契约。
- 修复：在 Gemini 公共边界集中返回判别后的结果类型，只允许正常 `STOP` candidate 进入文本/工具解析；所有异常 reason 返回失败，并保留结构化诊断。SDK 2.12.0 的本地 `FinishReason` 类型还没有服务端已返回的 `TOO_MANY_TOOL_CALLS`，因此校验要能容忍未知字符串，并安排升级 SDK，而不是依赖枚举穷尽。
- 验收：每个非 STOP reason 都用“夹带文本和 functionCall”的夹具测试，断言零工具执行、零缓存写入、零最终文本；正常 STOP 工具往返保持不变。

### [ ] 6. `/init disable`、退群和丢管理员权限没有统一拆除群级运行态

- 证据：`src/commands/init.ts:22-32` 禁用时只切开关并清 AI；`src/infra/botAdmin.ts:54-67` 退群/被踢时只清 AI 和 `ChatState`。两条路径都没有停止该群拥有的全局 copy、关闭 proxy、取消待验证计时器/持久化记录，或恢复 active lockdown；Anti-Raid 协议也没有 `deactivateChat` 消息。
- 影响：禁用后仍可能由旧计时器踢人；该群发起的全局 copy 会继续占位，其他群无法 `/copy`，但源群 update 已被网关丢弃；退群时直接删掉 lockdown 恢复信息，Telegram 上的默认邀请限制可能遗留。丢管理员权限后 Worker 仍会继续安排注定失败的管理动作。
- 修复：实现单一的群级 teardown 编排，并由 disable、left/kicked、管理员降级共同调用。顺序应覆盖：停止源群 copy、关闭 proxy、invalidate AI、取消/终结验证记录并持久化 tombstone、恢复或保留可恢复的 lockdown 记录，最后再修改/删除 ChatState。退群导致暂时无法恢复权限时，恢复记录不能直接丢弃，应保留到重新入群接管或给出明确人工恢复告警。
- 验收：为每个入口建立组合状态测试（copy + proxy + pending verification + lockdown），退出后不得有计时器副作用、全局占位或不可恢复的权限记录。

### [ ] 7. dispose 的时间预算不完整，且写入未停稳就释放单实例锁

- 无界等待：`src/app/lifecycle.ts:170-181,225-249` 在 emergency flush 预算生效前先无期限等待 `chatTitleRefreshTask`；`src/infra/chatTitle.ts:50-63` 的多个 `getChat` 没有生命周期级超时/取消。网络请求悬挂时，未捕获异常路径的 `process.exit(1)` 永远不会走到。
- 锁与写入竞态：`src/infra/storage/stateStore.ts:93-109` 和 `src/infra/diskIO.ts:276-299` 的 timeout 只结束等待，不会停止底层 writer/Worker；`src/app/lifecycle.ts:177-181` 随后仍释放 `bot.lock`。新进程可取得锁并写共享文件，而旧 writer/Worker 仍可能完成一次较旧的 rename/追加。
- 修复：让所有 flush 返回 `flushed | timedOut | failed`；为维护任务设置独立预算，emergency 路径直接跳过或取消非关键标题刷新；给 AI、Anti-Raid、Disk I/O supervisor 增加显式 quiesce/terminate。只有确认所有共享文件 writer 已停止后才释放锁；无法停止时保留锁到进程退出，由 stale-PID 恢复机制接管。
- 验收：注入永不 resolve 的标题请求、state write 和 Worker flush，断言 emergency dispose 在预算内结束，同时旧实例仍能写盘时绝不释放锁；正常路径仍完整 flush 并只释放一次。

## P2 — 恢复语义、外部并发修改和磁盘健壮性

### [ ] 8. Lockdown 到期会用旧快照覆盖管理员在锁定期间做的其它权限修改

- 证据：`src/workers/antiRaid/lockdownRuntime.ts:132-146` 保存完整 `ChatPermissions`，恢复时把整份旧对象原样 `setChatPermissions`。
- 场景：管理员在 5 分钟锁定期间调整默认媒体、投票、置顶等权限；到期恢复会把这些合法新设置回滚，甚至重新打开管理员本想继续关闭的邀请权限。
- 修复：只把 `can_invite_users` 当作本功能拥有的字段。恢复前重新 `getChat`，以当前权限为基底，仅合并原始邀请权限；同时明确管理员在锁定期间主动改邀请权限时的优先级/冲突策略。
- 验收：锁定期间修改任意非 invite 字段，恢复后必须保留；分别覆盖原邀请权限为 true、false/省略以及管理员主动改 invite 的情况。

### [ ] 9. 状态解码器拒绝合法的空 `ChatPermissions`，可能让下次启动失败

- 证据：`src/libs/stateFileCodec.ts:88-101` 要求至少一个权限字段；但 Telegram `ChatPermissions` 的所有字段均为 optional，`{}` 合法表示没有被授予的默认权限。`src/workers/antiRaid/lockdownRuntime.ts:132-134` 会把 API 返回对象直接持久化。
- 影响：权限全关的群触发 lockdown 时可能写入 `originalPermissions: {}`；下次 `loadState` 抛错，整个 bot 拒绝启动。缺失原权限与“已知且所有权限为 false”是两个不同状态，当前用非空校验错误地混在一起。
- 修复：允许空对象；仍严格拒绝未知键和非 boolean 值。用字段/状态层面的 presence 表达“未取得原权限”，不要靠对象是否为空判断。
- 验收：空权限对象能完整保存、重启、恢复；未知字段和错误类型仍 fail closed。

### [ ] 10. Disk I/O Worker 运行时重建忽略 load 失败，随后可用部分缓存覆盖旧数据

- 证据：`src/infra/diskIO.ts:103-110` 只在启动期有人等待 `pendingLoad` 时消费 `loaded`；`src/infra/diskIO.ts:149-161` 运行时重建后立即发送 load 并重放镜像；`src/workers/diskIOWorker.ts:61-87` 恢复任一领域失败时会返回带 `error` 的部分缓存。运行时这条 error 回执无人处理，Worker 继续接受写入。
- 影响：损坏/不兼容文件在运行时 respawn 时被静默忽略，部分成功恢复的缓存加主线程镜像随后可能重写磁盘，破坏启动期“恢复失败就拒绝空状态运行”的严格语义。
- 修复：运行时也必须走显式 load handshake；成功前缓冲或拒绝所有业务写入和镜像重放。load 失败时停止该 Worker、按退避重试或让进程故障退出，绝不能进入 writable 状态。
- 验收：模拟 AI、贴纸、运势、验证任一恢复失败，断言不重放、不 flush、不覆盖文件，并有明确的 unavailable/fatal 信号。

### [ ] 11. 单条待验证记录解码失败会被静默跳过，重启后可绕过验证

- 证据：`src/workers/diskIO/verificationFiles.ts:162-175` 对 JSON 顶层损坏会抛错，但对单条 `decodeVerificationSnapshot` 失败只打印 `ignoring` 后继续启动。
- 影响：正处于 pending 的那名成员从恢复集合消失，不再有超时踢人；这与启动恢复“必要状态不兼容就拒绝启动”的总体约定不一致。
- 修复：非 null 的无效 active 记录应 fail closed：保留/隔离原文件并中止恢复，或先提供显式版本迁移。不能在不知道成员处置结果时当作已删除。
- 验收：同一文件中一条合法、一条损坏时启动必须失败且原文件不被覆盖；提供迁移后再测试两条都恢复。

### [ ] 12. 追加型 JSON 写入没有处理 short write，内存 offset 会与物理文件错位

- 证据：`src/workers/diskIO/appendOnlyDayFile.ts:147-154` 只调用一次 `writeSync`，忽略返回的实际字节数，却按完整 `Buffer.byteLength(data)` 推进 `state.size`。该组件同时承载日志、运势和验证增量。
- 影响：磁盘空间不足、I/O 中断或底层短写时，文件只写入前缀，下一次仍从错误的未来 offset 写，扩大损坏；验证 delete/upsert 还可能因此丢失。
- 修复：以 `Buffer` 为单位循环写到全部完成；返回 0 或抛错时不要推进 `state.size`，关闭 fd 后重新 stat/标记需要恢复。保留现有截断修复作为崩溃兜底，但不能把短写当成功。
- 验收：注入分段短写、零字节写和中途异常，分别断言完整写入或显式失败；后续 append 不能从虚假 offset 开始。

## 建议实施顺序

1. 先修 P0 的 update 确认与 Anti-Raid 两个崩溃窗口，并加故障注入测试。
2. 再处理 Gemini 的有界工具阶段、异常 response 契约与诊断；用现有 6 条生产事件作为回归基线。
3. 统一群 teardown 和 dispose/quiesce 协议，消除跨模块生命周期残留。
4. 最后完成权限合并、严格恢复 handshake、验证文件 fail-closed 与 short-write 硬化。

每项完成时应重新运行 `bun run check`；涉及崩溃恢复的项目不能只测纯状态转移，必须覆盖“副作用前/后”和“落盘前/后”的边界。
