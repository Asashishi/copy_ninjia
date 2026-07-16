# copy_ninjia

一个基于 [grammY](https://grammy.dev/) 的 Telegram 群聊复读机机器人：锁定某个用户/频道后逐条复读其消息，支持文本反转、加喵~后缀、日语翻译三种复读变体，并附带入群验证、反刷群私密模式、AI 闲聊等群管理功能。

## 功能特性

- **复读（Copy）**：通过 `/copy`（回复目标消息，或 `/copy @username`）锁定某个用户或频道，之后 TA 发的每条消息都会被机器人复读一遍。复读目标全局唯一（机器人只有一张脸，同一时刻只能"变成"一个人）：任何群在复读时其他群想 `/copy` 都会被挡；复读行为只发生在发起 `/copy` 的那个群里，`/stop_copy` 在任何群都能停。
  - `/copy` — 原样复读
  - `/r_copy` — 复读并按字形簇反转文本
  - `/nya_copy` — 复读并在文本末尾追加 " 喵~"
  - `/ja_copy` — 复读并翻译为日语（基于 Google Cloud Translate）
  - `/steal_icon` — 只把目标的头像偷来设为机器人头像，不开启复读（目标指定方式与 `/copy` 一致，共用 copy 类命令冷却）
  - `/stop_copy` — 停止当前复读
  - `/kick` — 将目标从机器人当前是管理员的所有群同时踢出并永久封禁（仅白名单用户可用）。发起命令的这个群若机器人不是管理员，本群踢不动，但照常连坐其它管理的群，并在回复里说明；一个管理的群都没有才整体拒绝，见下方「管理员身份门控」。
- **消息反应同步**：复读目标本人点下的 reaction（不论点在哪条消息上）会被机器人同步点到同一条消息上，模仿目标点反应这个动作本身；目标取消自己的反应时也会跟着清除。
- **管理员身份门控**：机器人持续追踪自己在各群的管理员身份（`my_chat_member` 更新近实时维护、收到别人的 `chat_member` 更新即视为证明、存量群按需 `getChatMember` 现查回填一次），记在各群状态里随 `state.json` 持久化。Bot API 无法枚举机器人所在的群，这份记录同时也是 `/kick` 的群清单。机器人在某群不是管理员时，入群验证/反刷群守卫在该群直接不启动（现查失败按非管理员处理，宁可漏跑一次守卫也不带着没权限的身份硬跑刷 API 报错）。
- **入群验证**：新成员需在限定时间（90 秒）内点击验证按钮，超时则踢出（不封禁）并清理 TA 的入群公告、验证提醒与等待期间发的所有消息。管理员/群主入群、管理员拉人入群均免验证。机器人在本群不是管理员时整个流程不启动（见上方「管理员身份门控」）。
  - **机器人不豁免**：其他机器人入群同样要走验证并计入刷群统计。机器人自己点不了按钮（Bot API 也不向它投递验证提醒），须由 `PRIVILEGED_USERS_ID` 白名单用户在限时内代点按钮作保，否则照常踢出；管理员/白名单用户亲自拉进来的机器人仍走「管理员拉人免验证」豁免。平台限制：Bot API 收不到其他机器人发的消息，被踢机器人等待期间的发言无法被追踪清理，超时只能清掉入群公告与验证提醒。
  - **频道评论区感知**：关联频道的帖子下留言会被 Telegram 自动拉进讨论群，人在频道侧看不到群里的验证按钮。直接回复频道帖（确证的真人评论）直接免验证；楼中楼回复无法确证线程根，不豁免，改为把验证提醒追发到 TA 的回复下（评论线程双向同步，按钮在频道侧可见可点）并重置计时。留言与入群更新的到达顺序不保证，先到的留言会暂存 2 分钟等入群时消费。判定无状态（只看 `is_automatic_forward` / `message_thread_id`），并按群缓存「是否有关联频道」作开关，普通群的回复链不会误触发。
  - **提醒触达**：待验证成员一旦在群里开口发言，验证提醒会改锚成回复 TA 发言的形式（回复会推通知）；无论哪种补发，原来那条独立提醒都会立刻删除，同一时刻群里只有一条。验证通过的欢迎消息回复到同一条消息下，楼中楼场景随之落进评论线程。
- **反刷群（Anti-Raid）**：采用滑动窗口算法检测刷群行为，最近 60 秒内入群人数超过 45 人时，自动临时开启私密模式（禁止普通成员拉人），到期后自动恢复原权限；私密模式期间的新入群一律直接踢出、不开验证窗口（只踢不封，可重新申请加入）；管理员拉人凭管理员表缓存同步放行（触发/接管私密模式时会预热缓存），管理员/群主身份入群、直接回复频道帖的确证真人评论也照常豁免（免验证且不计入刷群统计）。私密模式状态持久化在 `state.json` 里，在进程重启后能自动接管并重排恢复计时，避免群权限被永久锁定。
- **AI 闲聊**：基于 Google Gemini（`gemini-3.1-flash-lite`，走 `generateContent` 接口、官方 `@google/genai` SDK）和自定义人设（`prompt/persona.md`），概率性地在群里生成闲聊回复；回复机器人或 @ 机器人时必回，纯按概率命中的随机搭话则不挂 Telegram 回复引用，改为在文字里点名称呼触发者。按群配置 `isUseAIChat`（`ChatState`，随 `state.json` 持久化），**缺省禁用**，需通过 `/ai_chat enable`（对应 `/ai_chat disable` 关闭）显式开启；该指令仅限定用户可用，其他人使用无效。关闭的群既不攒对话缓存也不触发任何 AI 回复。
  - 开启 Gemini 内置的 **googleSearch** 服务端工具：模型自主决定何时联网查证，搜索在 Google 服务器侧自动执行；回复里若附带行内引用标记会在发送前剥掉。另有基础函数工具（`src/tools/`）供模型按需调用：查东京今日天气（Open-Meteo，1 小时缓存）、发一枚应景贴纸（`send_sticker`，见下方「应景贴纸」）。时间不走工具也不做意图判断：当前时间（东京时区）默认拼进每次请求的系统提示词，对话缓存里每条消息也带发送时间（记录时格式化一次的东京时间串，转录行以「[年/月/日 时:分:秒]」开头），模型对「几点了」「那句话是什么时候说的」都以真实时间作答，不瞎编。
  - 上下文由本群滚动缓存拼装：逐字区 50~100 条最新消息 + 最多 7 轮 AI 压缩摘要（约 350 条冷历史），模型可感知约 400~450 条跨度的对话；机器人发出的回复、跟发的贴纸、随机复读出去的文本、洗澡触发的「看看」都会自录入缓存并随批次轮换自然压缩进中期摘要，并在提示词中注明自己的账号（@username + id），能在上下文中认出自己说过的话、以及谁在 @ 或回复自己。各群 dirty 的记忆快照定期落盘到 `memory/ai/`（进程重启/意外崩溃后自动恢复，丢失量有上界），目录不进 git，按日志同等隐私等级对待。
  - **读图 / 读贴纸 / 读 GIF**：群友发的图片、贴纸、GIF 都会先以占位文本（如「[图片：识别中]」）记入上下文（保住时序位置），随后异步下载并喂给 Gemini 视觉输入，解析出一行中文描述后原位回填；图片描述不超过 120 字，贴纸/GIF 更短（不超过 75 字）。图片本体就是 jpeg；贴纸/GIF 的素材不一定是视觉接口通吃的 jpg/png（静态贴纸是 webp、GIF 实际多为 mp4），会先按需转码/取代表帧：静态贴纸下载本体转 png，动态/视频贴纸与 GIF 用 Telegram 自带缩略图（GIF 因此只能分析封面帧，非完整动图）；两者都取不到素材就放弃视觉解析。解析失败图片/GIF 回填失败说明，贴纸回填现有的元数据行（情绪 emoji + 所属贴纸包，不丢失信息）；相册多图逐条各自占位、各自解析，配文跟在描述后面一并入上下文。媒体按 Telegram 的 `file_unique_id` 在内存中缓存去重（上限 500 条，图片/贴纸/GIF 共用）：重发/刷屏不重复下载解析，并发重复发送会合并到同一次在途解析上。贴纸若恰好来自「应景贴纸」白名单包，直接复用该包的目录描述（见下方），免一次视觉调用。三类媒体共用同一份评价概率（默认 1/8）：解析成功后按此概率主动回复那条消息、以人设评价内容（受 `/quiet`、随机回复冷却与分群限频约束）。
  - 分群三重限频：0.5 秒冷却 + 每分钟最多 45 次 + 每 5 分钟最多 150 次（滑动窗口），超限的触发直接丢弃，防止恶意刷屏烧穿 API 配额；滑动窗口打满时会明确回一句「你们太快了……」（提示本身每群每分钟至多一条，不会跟着刷屏）。
  - **不会自己触发自己**：机器人发到自己管理的频道里的消息，Telegram 会把 `channel_post` 更新（以及转发进关联讨论组的自动转发副本）原样推回来，不区分是谁发的；内联模式抽签结果也带着 `via_bot` 标记。机器人识别出这两类「自己造成的」更新后会整条跳过自动流水线（不重复记入对话缓存、不触发随机回复/随机复读/洗澡触发），避免自说自话的循环，见 `src/infra/selfSentTracker.ts`。
- **应景贴纸**：不是「回复后按概率跟发」，而是做成一个 function calling 工具（`send_sticker`）——模型在生成回复的同一次对话里，如果判断配一枚贴纸合适，就直接从候选清单里选一个调用；判断不合适就不调用，没有触发概率。候选清单只列白名单包（`config/stickers.json`）里已经生成过画面描述的贴纸：每一枚都有一份 AI 生成的画面描述（角色/动作/文字/情绪，不超过 75 字，落盘到 `memory/stickers/<pack>.json`），工具描述里按编号列出「emoji + 画面描述」，模型直接照着选，不需要额外一次选择用的 API 调用，也不需要关键词匹配兜底。**每次启动都会对账一遍**：现查一次线上贴纸集合，与持久化目录双向比对——线上有、目录没有的补（已有描述的不重新生成），目录有、线上已经没有的剪掉（贴纸被移出包/包被整理过，避免拿陈旧描述误导挑选）；查线上失败则整包跳过、保留现状，不会把网络失败误判成「贴纸都没了」进而清空目录。白名单本身若从 `config/stickers.json` 移除某个包，其持久化文件在下次启动读盘时会被当孤儿直接清掉。白名单见 `config/stickers.json`，改配置不需要碰代码。
- **应景反应**：AI 回复触发时（含随机搭话），按概率（默认 1/3）给触发消息扣一个应景的 emoji 反应，情绪匹配逻辑同上。emoji 限于 Telegram 允许 bot 设置的固定反应表情集合，配置见 `config/reactions.json`。
- **`/luck_challenge`（内联模式抽签）**：在任意聊天框里输入 `@机器人用户名 [所求事项]`（不需要把机器人拉进那个群）即可触发，结果以查询者本人名义发出（带"通过 @机器人"标注），不占用命令列表，也不需要机器人在场。
  - 不带文本给出两个结果：「未卜先知」（今日吉凶：大吉/吉/小吉/尚可/小凶/凶/大凶）与「概率论」（当天吉凶档对应的行大运/倒大霉概率，取数字较大的那一个；每个吉凶档对应一个概率浮动区间，具体数值在抽签时于区间内滚动一次，精确到小数点后两位）；带文本则以该文本为「所求事项」测吉凶，仅出吉凶不出概率。
  - 结果按「用户 ID（+ 所求事项文本）」每日缓存一次，同一天内重复查询/重复选中给出一致结果，东京时间零点重置；同时落盘到 `memory/luck/`（按东京日期一个文件、只留当天，与日志同一套按位置追加/截断修复机制），进程重启后当天结果不变，过期文件自动清理。确认「真的测过」的主信号是 `chosen_inline_result` 更新（在哪个聊天里用都能确认，需在 BotFather 用 `/setinlinefeedback` 开启）；兜底是结果消息现身认领——机器人在任何看得见的聊天里（含未 `/init` 的群、机器人私聊）看到文本与待确认抽签渲染原文一致的消息（via_bot 直发或转发副本都算）即确认。
  - 结果消息自带「我也试试」「转发」按钮，方便旁观者原地重新发起查询或分享到别的聊天。
  - 全局限频每分钟最多应答 30 次内联查询（不分群、不分用户合计），超限时回一条提示而非静默不回。
  - 需要先在 [@BotFather](https://t.me/BotFather) 为机器人开启 Inline Mode 才能使用。
- **`/quiet`**：让机器人在本群安静一段时间（`/quiet [分钟数]`，1~15，缺省 3 分钟），期间不触发 AI 随机搭话、随机复读等主动行为；回复/@ 机器人的必回和各类指令不受影响。静默期内不允许重复 `/quiet` 叠加，用 **`/unquiet`** 提前解除。
- **`/ai_chat enable|disable`**：按群开关 AI 闲聊功能（缺省禁用）。仅限定用户（`SUPER_ADMIN_USER_ID` 环境变量，不走 `PRIVILEGED_USERS_ID` 白名单）可用，其他人使用无效。
- **`/ja_copy enable|disable`**：按群开关 `/ja_copy` 的日语翻译功能本身（缺省启用），与不带参数的 `/ja_copy`（复读并翻译）共用同一个命令名。权限同上，仅 `SUPER_ADMIN_USER_ID` 可用；关闭后本群 `/ja_copy` 复读会被拒绝。
- **状态持久化**：静默时间、反刷群私密模式、AI 闲聊开关、日语翻译开关、机器人管理员身份记录按群独立维护；复读目标和 copy 类命令的冷却时钟全局共用一份。全部状态启动时从 `state.json` 一次性读入内存，之后只在内存中交互，每次变更走异步串行队列全量覆写回文件（先写临时文件再原子 rename，进程被杀也不会留下半截 JSON），重启后自动恢复。AI 记忆快照、白名单贴纸目录与每日运势缓存走独立的 `memory/` 目录（AI 记忆在 `memory/ai/`、贴纸目录在 `memory/stickers/`，均定时整份原子写；运势在 `memory/luck/`，与日志一样按位置追加写 + 启动时截断修复、条数/时间双阈值批量落盘），由统一的磁盘 IO 线程（diskIOWorker）落盘，`logs/`、`memory/` 均不进 git。

## 环境要求

- 推荐服务器配置：4 核 CPU / 2GB 内存及以上（机器人主线程 + AI 闲聊/入群守卫/磁盘 IO（日志 + AI 记忆 + 每日运势统一落盘）三个 Worker 线程常驻，多群（建议一个bot实例不要同时处理超过15个群以上的信息）高并发场景下建议按此配置起步）
- [Bun](https://bun.com) 运行时
- Telegram Bot Token（通过 [@BotFather](https://t.me/BotFather) 获取）
- Google Gemini API Key（用于 AI 闲聊/读图功能，[aistudio.google.com](https://aistudio.google.com/apikey) 获取）
- Google Cloud 服务账号凭据（用于 `/ja_copy` 日语翻译功能，`g-auth.json`）

## 安装

```bash
bun install
```

## 配置

复制 `.env.example` 为 `.env`，并填写以下变量：

| 变量名 | 说明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `PRIVILEGED_USERS_ID` | 白名单用户 ID，多个用逗号分割（可免受 `/copy` 冷却限制、使用 `/kick`） |
| `SUPER_ADMIN_USER_ID` | 唯一可使用 `/ai_chat`、`/ja_copy`、`/init` 的 `enable\|disable` 的用户 ID |
| `GEMINI_API_KEY` | Google Gemini API 密钥，供 AI 闲聊/读图功能使用 |

日语翻译功能还需要将 Google Cloud 服务账号密钥文件放置为项目根目录下的 `g-auth.json`（已加入 `.gitignore`，不会被提交）。

## 运行

```bash
bun run index.ts
```

## 项目结构

```
index.ts               # 入口：注册命令/更新处理器，启动 grammY runner
src/
  aiChat.ts             # AI 闲聊入口（主线程侧代理，向 AI Worker 投递事件）
  antiRaid.ts           # 入群守卫入口（主线程侧代理：入群验证 + 反刷群私密模式）
  auto.ts               # 自动流程入口（src/auto/ 各处理器的统一出口）
  commands.ts           # 指令处理入口（src/commands/ 各处理器的统一出口）
  auto/                 # 自动流程：机器人自己看时机触发的行为
    message.ts             # 消息自动流水线（复读目标、AI 记录/触发、洗澡「看看」、随机复读）
    reactionSync.ts        # 同步复制目标的表情反应
  commands/             # 显式指令处理
    copy.ts                # /copy 系列与 /stop_copy
    copyShared.ts          # copy 类命令的公共零件（冷却检查、目标解析、后台偷头像）
    stealIcon.ts           # /steal_icon 只偷头像不复读
    targetResolution.ts    # 从回复消息 / @username 参数解析出目标用户（各命令共用）
    quiet.ts               # /quiet 与 /unquiet
    kick.ts                # /kick（白名单限定，在所有管理员群同时踢出并封禁）
    aiChat.ts               # /ai_chat enable|disable（限定用户，按群开关 AI 闲聊）
    luckChallenge.ts       # /luck_challenge 内联模式抽签（吉凶 + 行大运/倒大霉概率）
  workers/              # 独立的工作子线程
    aiChatWorker.ts        # AI 闲聊流水线 Worker 线程（限频、Gemini 调用、读图/贴纸/GIF 占位与回填、发送、记忆快照与贴纸目录定期上报）
    antiRaidWorker.ts      # 入群守卫 Worker 线程（src/states/ 两台状态机的解释器：翻译投递、落状态、跑副作用）
    diskIOWorker.ts        # 磁盘 IO Worker 线程入口：日志 + AI 记忆快照 + 贴纸目录 + 每日运势统一落盘（消息路由、统一 flush、启动恢复编排）
    diskIO/                # diskIOWorker.ts 的具体落盘逻辑
      logFiles.ts            # 日志文件的缓冲/追加/保留期清理
      luckFiles.ts           # 每日运势的缓冲/追加调度（条数/时间双阈值窗口）
      snapshotFiles.ts       # AI 记忆快照 / 贴纸目录的原子写（tmp+rename）+ 运势追加纯函数 + 三者的启动恢复与结构校验
      appendOnlyDayFile.ts   # 日志/运势共用的「按天文件、按位置追加」与损坏修复字节机制
  states/               # 入群验证 + 反刷群私密模式的纯状态机（无 I/O，同步转移函数 + 副作用描述）
    verification.ts        # 入群验证生命周期状态机
    lockdown.ts             # 反刷群私密模式生命周期状态机
  infra/                # 基础设施
    logger.ts              # 统一日志门面（error 级经 diskIO.ts 投递）
    diskIO.ts              # 磁盘 IO Worker 的主线程侧宿主（创建/自愈、flush/load 握手、postDiskIO 投递句柄）
    telegram.ts            # Telegram Bot API 封装与限流
    updateGate.ts          # isInit 网关判断（未初始化群的更新在入口整条丢弃）
    selfSentTracker.ts     # 登记机器人刚发出的消息，供自动流水线识别「频道自回环」并整体跳过
    storage.ts             # 状态持久化（state.json）
    config.ts              # 密钥与部署配置（从环境变量读取）
    botAdmin.ts            # 追踪机器人自身在各群的管理员身份，供入群守卫与 /kick 门控
  ai/                   # AI 回复流水线的配套积木
    gemini.ts              # Gemini generateContent 的底层收发（走官方 @google/genai SDK）与响应解析（回复/摘要/读图共用）
    imageDescription.ts    # 图片/贴纸/GIF 的下载、按需转码与视觉描述（供读图/读贴纸/读 GIF 占位回填、贴纸目录生成）
    reactions.ts           # AI 回复触发时概率给触发消息扣应景 emoji 反应（config/reactions.json）
    stickers.ts            # 应景贴纸做成 send_sticker 工具：候选清单组装、工具定义、执行发送（白名单见 config/stickers.json）
    stickerSets.ts         # 贴纸包拉取缓存、情绪关键词匹配、视觉解析素材选择等公共积木
    stickerConfig.ts       # config/stickers.json 的解析结果（独立成模块避免 stickers.ts/stickerCatalog.ts 互相 import 成环）
    stickerCatalog.ts      # 白名单贴纸包的画面描述目录：生成（diff+串行调视觉模型）、持久化上报、跨包查找
  copy/                 # 复读功能的配套积木
    copyModes.ts           # 反转 / 喵~ / 日语翻译等复读文本变换
    translate.ts           # Google Cloud Translate 封装
    reactionQueue.ts       # 消息反应同步队列
  users/                # 用户身份
    senderIdentity.ts      # 消息发送者身份解析与 username 缓存
    userLabel.ts           # 用户/频道的人类可读标签
  tools/                # 供 aiChatWorker.ts 调用的静态 AI 工具（无入参/无副作用的纯查询；
                        # send_sticker 有副作用、清单随目录变化，按次请求现组装，不在这份静态清单里，见 ai/stickers.ts）
    index.ts               # 工具定义清单 + 按名分发执行
    weather.ts             # 查东京今日天气（Open-Meteo，1 小时缓存）
  libs/                 # 通用算法积木
    linkedQueue.ts         # 通用链式队列
    supervisedWorker.ts    # 业务 Worker 的启动/崩溃自愈/日志转投骨架（aiChat.ts、antiRaid.ts 共用）
    workerSupervisor.ts    # Worker 崩溃重启的节流器（滑动窗口内超限即放弃自愈）
    httpFetch.ts           # 带超时与统一报错的 JSON API 请求封装
    text.ts                # 转录文本清洗（压单行防注入、按码元截断）
    time.ts                # 毫秒数转中文时长文案 + 东京日期串/当前时间（东京时区，默认注入每次请求的系统提示词，不是 function calling 工具）
    random.ts              # 从数组中均匀随机挑一项
    sleep.ts               # Promise 化的 sleep
    image.ts               # 按魔数嗅探图片格式 + webp/gif 转 png（sharp），供视觉接口只收 jpg/png 的场景
  consts/               # 各模块的调参常量（同名对应其所服务的模块）
  cache/                # 各模块的内存状态/缓存（同名对应其所服务的模块）
  types/                # 全项目共享类型（types/index.ts 统一重导出）
test/                   # 单元测试（bun test），目录结构与 src/ 对应
```

本项目基于 `bun init`（Bun v1.3.14）创建。
