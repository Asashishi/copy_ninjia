# 08 命令与行为参考

<p align="center">
  <b>简体中文</b> · <a href="../en/08-commands.md">English</a> · <a href="../ja/08-commands.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="07-operations.md">← 上一页：07 运维与排障</a> · <a href="09-performance.md">下一页：09 性能基准 →</a>
</p>

---

面向使用者的完整命令表、权限口径与行为细节。根 README 只留一句概述，具体口径以本页为准；
命令实现落在 `packages/commands/`，权限键定义见
[`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts)。

## 🎭 复读模式

复读目标是全局唯一的：同一实例同时只能「变成」一个目标，但复读只发生在发起命令的群中。`/copy stop` 可在任意群停止当前复读。

| 命令 | 行为 |
| :---: | :--- |
| `/copy` | 原样复读 |
| `/copy reverse` | 按字素簇反转文字与图注 |
| `/copy nya` | 在文字与图注末尾追加「喵~」 |
| `/icon steal` | 只复制头像 |
| `/icon reset` | 把头像换回机器人自己的默认那张 |
| `/copy stop` | 停止全局复读状态，并顺带复原头像 |

**发送方式**（`/copy` 系与随机复读相同）：文字和图注一律按字符串处理，带链接或 @ 的文字照样变换。纯文字重新发送，链接与 @username 由 Telegram 重新识别，原消息的链接预览设置照搬；粗体、隐藏链接、剧透、自定义表情等格式不保留，剧透文字会以明文发出。图片、视频、文件、贴纸等由 Telegram 在服务端原样复制，有图注时换成处理后的文字，本机不下载任何文件。付费媒体不能复制，只发文字。投票、骰子、位置、联系人这类没有文字也没有文件的消息原样复制。变换后超过 Telegram 的正文或图注长度上限时整条不发。

目标可通过「回复 TA 的消息」或 `@username` 指定。模式写在目标前，例如 `/copy reverse @username`、`/copy nya @username`；只换头像用 `/icon steal @username`。`/copy stop` 与 `/icon reset` 不接受额外参数。

目标解析遵循以下规则：

- **按用户名查找依赖机器人此前观察到该账号**；改名、移除用户名或用户名换绑会立即使旧别名失效。对 `/block … enable`、`/block … disable` 这类破坏性操作，优先回复目标消息或直接给用户 id（那两条命令额外接受裸 id），不要依赖历史用户名。
- **匿名管理员以当前群身份发言时，复读目标就是当前群**，因而可取得群头像并复读这层「皮套」；`/block` 会拒绝把当前群身份当作成员目标。
- **`/copy`、`/copy reverse`、`/copy nya` 与 `/icon steal`、`/icon reset` 共用 5 分钟全局冷却**；仅 `SUPER_ADMIN_USER_ID` 本人豁免，白名单身份仍受冷却限制。`/copy stop` 不占冷却。

## 🌐 按群翻译

翻译处理文字与图注，独立于全局 copy 目标、5 分钟冷却和头像操作。先由拥有 `isCanControllTranslatePermission` 的身份执行 `/translate enable`（默认关闭），并提供有效的 `g-auth.json`。翻译目标是另一个机器人时，需要在 @BotFather 为本机器人开启 Bot-to-Bot Communication Mode，否则收不到对方的普通消息（见 [01 环境搭建](01-getting-started.md)）。

| 命令 | 行为 |
| :--- | :--- |
| `/translate ja` | 回复目标消息，把后续文字翻成日语 |
| `/translate cn @username` | 按已观察到的用户名指定目标，翻成简体中文 |
| `/translate en` | 回复目标消息，翻成美式英语 |
| `/translate uk` | 回复目标消息，翻成乌克兰语 |
| `/translate ru` | 回复目标消息，翻成俄语 |
| `/translate list` | 以 JSON 代码块列出支持正则判断的语言 |
| `/translate stop` | 不带回复或目标时停止本群全部会话，保留功能开关 |
| `/translate stop @username` 或 `/translate stop 123456789` | 停止指定目标；也可回复目标消息，频道身份支持负数 ID |
| `/translate disable` | 删除本群全部会话并关闭翻译功能；需要翻译管理权限 |

所有方向均可回复目标或带 `@username`，支持用户与频道身份。群成员可以开始、停止会话；每群最多 5 个不同身份，每个身份独立选择方向，最多 25 群。新增超出容量时拒绝，不淘汰已有会话；同一身份换方向前先停止它。回复目标与参数冲突时拒绝，不会转为停止全群。`/copy stop` 不停止翻译；同一身份同时命中 copy 和翻译时由翻译路径处理，其他 copy 目标照常工作。

`/translate list` 的内容如下，发送时使用 Telegram `pre` 实体并标记 `json`，群内 30 秒后删除：

```json
{
  "ja": "日语",
  "cn": "简体中文",
  "en": "美式英语",
  "uk": "乌克兰语",
  "ru": "俄语"
}
```

文字与图注一律按字符串翻译，带链接、@ 或格式实体的文字同样翻译。正则识别为目标文字，或只有数字、标点、表情的文字时，不调用翻译 API，直接发送原文。日语需要假名；简体中文排除 Unicode Unihan 中具有简化变体的繁体字；英语接受 ASCII 字母。乌克兰语接受本语种字母与撇号，排除俄语的 `ёъыэ`；俄语接受 `Ё/ё`，排除乌克兰语的 `єіїґ`。共用汉字、无重音拉丁字母和共用西里尔字母短句仍可能有语种歧义，正则不做语义级语言识别。

翻译 API 失败时发送原文。文字消息按字符串发出，原消息的链接预览设置照搬，格式不保留；带图注的图片、视频、音频、文件由 Telegram 原样复制并把图注换成译文，本机不下载；付费媒体只发译文。没有文字的图片、贴纸、文件等以及投票、位置这类消息不发送，也不回落到同目标的 copy。译文超过正文或图注长度上限时不发。美式英语使用支持 `en-US` 的 [Google Translation LLM](https://docs.cloud.google.com/translate/docs/languages#translation-llm)。输出保留话题，拒绝可渲染命令；命令提示 30 秒后删除。

会话保存在 SQLite `chat_states` 本群行的 `translate` 数组中，格式与冷迁移见 [07 运维](07-operations.md)。停止单人只取消该目标；新增、停止其他人不取消当前目标的在途翻译。禁用和群 teardown 删除全群会话，异步结果在发送前重新核对该目标的会话对象。`/bot_status` 显示本群正在使用翻译的 `人数/5`。

## 🎮 命令与权限

<table width="100%">
<tr><th width="26%" align="left">命令</th><th width="19%" align="center">权限</th><th width="55%" align="left">说明</th></tr>
<tr><td><code>/copy</code> <code>/copy reverse</code> <code>/copy nya</code></td><td align="center">群成员</td><td>启动相应复读模式</td></tr>
<tr><td><code>/translate ja|cn|en|uk|ru [@username]</code><br><code>/translate list</code><br><code>/translate stop [@username/id]</code></td><td align="center">群成员</td><td>选择文字翻译方向、查看语言，或停止全群/指定目标</td></tr>
<tr><td><code>/copy stop</code></td><td align="center">群成员</td><td>停止当前全局复读，并顺带复原头像</td></tr>
<tr><td><code>/icon steal</code></td><td align="center">群成员</td><td>只偷头像</td></tr>
<tr><td><code>/icon reset</code></td><td align="center">群成员</td><td>把头像换回默认那张</td></tr>
<tr><td><code>/wed</code></td><td align="center">群成员</td><td>随机抽取群友老婆并显示头像；支持确认、更换和移除，需先 <code>/init enable</code></td></tr>
<tr><td><code>/h_image</code></td><td align="center">群成员</td><td>从随机图片目录均匀抽一张发到本群；图片长期保留，失败提示 30 秒后删除</td></tr>
<tr><td><code>/info [@username|id]</code></td><td align="center">群成员</td><td>查询目标的名称、用户名、id 与头像；回复、@username、用户 id 或频道 id 都可以，频道与 bot 同样可查；回执 30 秒后删除</td></tr>
<tr><td><code>/h_image add</code></td><td align="center"><code>isCanAddHImage</code></td><td>回复一条带图的消息，把这张图（相册则连同已见过的同组其余几张）收进随机图库；结果汇总 30 秒后删除</td></tr>
<tr><td><code>/&lt;1~2 个中文字&gt;</code></td><td align="center">群成员</td><td>动作命令，如 <code>/咬</code>、<code>/揪住</code> 回复「发起人 咬了 目标！」；成功结果长期保留</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">群成员</td><td>暂停随机插话、随机复读等主动行为，默认 3 分钟</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">群成员</td><td>提前解除安静模式</td></tr>
<tr><td><code>/mute … &lt;时长&gt;</code> <code>/unmute</code></td><td align="center"><code>isCanMute</code> / <code>isCanUnMute</code></td><td>在超级群临时禁言或提前解除；目标支持回复、<code>@username</code>、用户 id，时长支持 <code>m/h/d</code></td></tr>
<tr><td><code>/gag … [5|10|15] [用具]</code><br><code>/ungag …</code></td><td align="center"><code>isCanGag</code></td><td>让用户或频道身份只能经 Bot 的 inline 入口发言，或定向提前解除；目标支持回复、<code>@username</code>、用户 id 与频道负数 id</td></tr>
<tr><td><code>/block … enable</code></td><td align="center"><code>isCanBlock</code></td><td>拉黑：写进永久黑名单，并在所有机器人管理的群中封禁目标；目标可用回复消息、<code>@username</code> 或用户 id 指定</td></tr>
<tr><td><code>/block … disable</code></td><td align="center"><code>isCanUnBlock</code></td><td>从 SQLite 权威黑名单事务删除目标，并在机器人管理的全部群解除封禁；目标方式同 <code>/block … enable</code>，也接受频道负数 id，拒绝本群自己的身份</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>isCanControllAIPermission</code></td><td>开关本群 AI 闲聊</td></tr>
<tr><td><code>/prompt config &lt;提示词&gt;</code><br><code>/prompt remove</code></td><td align="center"><code>isCanConfigAiPrompt</code></td><td>配置或移除本群专属 AI 提示词；移除后使用默认人设</td></tr>
<tr><td><code>/clear_context</code></td><td align="center"><code>isCanClearContext</code></td><td>清空本群 AI 上下文记忆：Worker 内的滚动逐字缓存、中期摘要、待晋升摘要与心情，并将 <code>chat_states.ai_context</code> 置 NULL，保留本群自定义人设；使本群在途回复代数失效。不接受参数，部署配置写坏或 AI Worker 没起来时同样执行</td></tr>
<tr><td><code>/ad_detect enable|disable</code></td><td align="center"><code>isCanControllAdDetectPermission</code></td><td>开关本群广告检测，非受保护身份命中后按 <code>/block</code> 同权处置</td></tr>
<tr><td><code>/flood_control enable|disable</code></td><td align="center"><code>isCanControllFloodControlPermission</code></td><td>开关本群防刷屏禁言（默认关闭）</td></tr>
<tr><td><code>/antiraid enable|disable</code></td><td align="center"><code>isCanControllAntiRaidPermission</code></td><td>开关本群入群验证与防冲群私密模式（默认关闭）</td></tr>
<tr><td><code>/bot_status</code></td><td align="center"><code>isCanViewBotStatus</code></td><td>查看本机进程指标、全局模型能力、Telegram 429 出站队列、本群专属提示词是否已设置、AI 上下文容量、正在生效的 gag 数量、本群翻译人数（最多 5 人）、本天才在本群已拥有的权限（JSON 块）和本群各项功能开关的真假（JSON 块，逐项列出，没开的给 false）</td></tr>
<tr><td><code>/mood query</code></td><td align="center">群成员</td><td>查询本群 AI 当前有效心情，不触发重抽</td></tr>
<tr><td><code>/mood switch</code></td><td align="center"><code>isCanSwitchMood</code></td><td>立即重抽本群 AI 心情，并在 Worker 回执后回复新心情名</td></tr>
<tr><td><code>/translate enable|disable</code></td><td align="center"><code>isCanControllTranslatePermission</code></td><td>开关本群翻译能力（默认关闭）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>开关本群的业务处理总入口</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>在超级群中踢出滚动 24 小时内指定时间窗加入且仍在群内的成员；只踢不拉黑</td></tr>
<tr><td><code>/permission query</code><br><code>/permission help</code></td><td align="center">用户/频道身份</td><td>查询自身、回复目标或显式目标的完整权限，或以 JSON 列出权限说明；成功看板长期保留，读取失败只发送 30 秒提示</td></tr>
<tr><td><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>修改已有白名单用户/频道的一项权限；<code>all</code> 可全部打开</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center">新增：<code>isCanWhiteOther</code><br>删除：<code>SUPER_ADMIN_USER_ID</code></td><td>支持回复、<code>@username</code>、用户 id 与频道 id；委托新增只授予默认权限，修改已有权限由超级管理员执行</td></tr>
<tr><td><code>/qa set</code></td><td align="center"><code>isCanControllQaPermission</code></td><td>开一张表单，由发起者按「问题:」「回答:」分两条消息发进本群，两样齐了即登记一条本群问答；每群最多 15 条，问题 ≤ 256 字、回答 ≤ 3840 字</td></tr>
<tr><td><code>/qa query</code><br><code>/qa query &lt;问题文本&gt;</code></td><td align="center">群成员</td><td>以 JSON 代码块列出本群全部问答，或只查那一条；答案在看板上截断到 256 字，问题不截断；3 条一页，超过一页给翻页按钮。看板长期保留，查不到的提示 30 秒后删除</td></tr>
<tr><td><code>/qa remove &lt;问题文本&gt;</code></td><td align="center"><code>isCanControllQaPermission</code></td><td>删除本群指定问答；没删到会如实说本来就没有</td></tr>
<tr><td><code>/send &lt;群组 ID&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（仅私聊）</td><td>在机器人私聊中开始或结束向目标群的中转；中转期间把 TTS 请求整条作为代码块发送，可让机器人以语音气泡说出来</td></tr>
</table>

论坛话题自动填入的创建消息按“未显式回复”处理，命令仍可按参数指定目标；显式回复该创建消息本身也按同一规则处理。关联频道讨论组的评论回复正常保留。所有依赖目标黑白名单的身份修改与成员操作须先完成策略预热，失败只回复短时提示，不继续执行。

`/qa set` 的问题字段取消息原文并 trim，Telegram `pre` 格式不增加字面围栏；回答字段保留代码块围栏。查询、删除和直答均以同一问题文本匹配。

这四组功能在聊天框菜单中分别使用 `/copy`、`/qa`、`/mood`、`/icon` 作为统一入口，描述中列出各自参数。通过入口门禁后，`/qa`、`/mood`、`/icon` 缺少或使用非法子命令时只回复用法。`/qa set`、`/mood query`、`/mood switch` 不接受额外参数；`/qa query` 省略问题时列全部，`/qa remove` 必须带问题。查询和删除保留问题内部的空格与换行。

> **权限列的读法**：写 `isCanXxx` 的行按权限键授权，而 `SUPER_ADMIN_USER_ID` 这个身份本身恒持有**全部**权限键，因此那些行他一律可用，无需写入 SQLite 白名单表；写 `SUPER_ADMIN_USER_ID` 的行才是只认身份、无法通过白名单授权出去的。

### 行为细节

- **`/prompt` 与人设状态**：已初始化群中，`/prompt config <提示词>` 保存完整多行正文（去掉首尾空白，保留内部空格和换行），`/prompt remove` 清除本群覆盖并使用项目 `prompt/persona.md`。`isCanConfigAiPrompt` 默认 false；超级管理员可直接使用，或通过 `/permission` 授权。SQLite 确认落盘后推送 Worker，后续回复轮次使用新值，已开始的轮次保持原人设。`/bot_status` 直接读群缓存，按本群选定语气显示“已设置 / 未设置”，不公开提示词正文。配置与移除回执均在 30 秒后删除。
- **群内通知语气与菜单**：设置自定义 AI 人设的群使用普通版命令提示、权限 help、按钮和自动通知；未设置或移除后使用 `config/static/bot.json` 的 `atmosphere`（`mesugaki` 为缺省雌小鬼版，`normal` 为普通版）。AI 开关不影响选择。`/prompt` 落盘成功后同步本群菜单；移除人设会删除本群作用域，回到所有群聊作用域的 Bot 配置菜单。inline 运势没有目标群上下文，使用 Bot 配置语气。启动清除默认菜单作用域，私聊不显示菜单；私聊命令只响应超级管理员的 `/send`。
- **`/bot_status` 内存**：在收到命令时调用 `Bun.unsafe.memoryFootprint()`，展示整个 Bot 进程（含 Worker）的当前内存占用；Linux 使用 PSS，共享驻留页按进程分摊。百分比以容器内存约束为分母，无约束时使用本机物理内存总量；无法采样时显示「不可用」。
- **`/bot_status` 本群上下文容量**：滑动热记忆按 `VERBATIM_CONTEXT_MAX`（256 条）、冷记忆摘要按 `MAX_SUMMARY_ROUNDS`（7 轮）各算占用率，再按 7:3 加权求和，**只展示这一个百分比**——两段的原始条数属于记忆分层的内部机制，对群友一律不可见（见 [04 权威约束](04-invariants.md)）。两个计数由 AI Worker 随记忆快照上报（周期 `AI_SNAPSHOT_INTERVAL_MS`，30 秒）带过来，并在 hydrate 完成后全量播种，主线程只持有只读镜像。待晋升摘要不计入冷区（原文此刻仍在逐字热区里），镜像没有条目一律按 0 展示，因此读数最多滞后一个上报周期。
- **子命令词大小写**：`/copy stop|reverse|nya`、`/icon steal|reset`、`/qa set|remove|query`、`/translate <方向>|stop`、`/mood query|switch`、`/h_image add` 的子命令词一律不区分大小写，口径与 `/block`、`/white`、`/init`、`/prompt` 一致。跟在子命令词后面的目标参数与问答文本保持原样大小写，不跟着折叠。
- **按钮载荷**：入群验证、`/wed` 与 `/qa query` 看板翻页的 `callback_data` 里那串数字按规范十进制严格解析——不带正号、前导零、空白、小数点与指数。本机器人生成的按钮只可能是规范十进制，其余写法一律来自外部构造，当场按「按钮失效」应答。
- **命令入口**：群命令统一经过 `/init` 网关；未初始化群只接受超级管理员的 `/init`，所以 `/permission`、`/white` 也必须在已初始化群中使用。私聊斜杠命令只放行 `/send`。
- **动作命令**：姓名用 `first_name last_name` 形式，有公开用户名的一方挂上主页链接；目标同样通过「回复 TA 的消息」或 `@username` 指定。成功的动作结果与 `/permission help`、`/permission query` 一样长期保留；目标缺失、参数错误和 `/x` 用法提示仍在 30 秒后删除。
- **群问答**：`/qa set` 的表单靠**格式消息**收文本。开表单那一步按 `isCanControllQaPermission` 把关，随后只认「是不是开表单的那个身份」——**频道马甲与匿名管理员因此也能设置问答**：命令侧与投递侧看到的都是同一个 `sender_chat`，两边天然对得上。投递格式是行首的 `问题:` 或 `回答:`（半角、全角冒号都收，`答案:` 同义），取值可以换行，两条消息各带一样；写在同一条里也照收。答案里的 ```` ```json ```` 代码块会以**字面围栏**存下来，直答时再拆回代码块原样发出，因此围栏本身也算进 3840 字的上限。认领后那条投递消息会被删掉，不进 AI 或复读流水线；表单正文随即就地改写，「已收到的问题」「已收到的回答」两行跟着变成当前状态（同一条消息里两项都因超长被挡下时会话没有变化，不做改写）；两项加起来撑破 Telegram 单条 4096 字符时，**回显里的回答**按剩余预算截断并补省略号，问题原样摆出——截掉的只是这张表单上的显示，登记进库的仍是完整原文。表单按群唯一、15 分钟到期自动收走。**填到一半时重来**分三种：重发同一个字段直接覆盖上一次的值，表单继续等另一样；**同一个人**再发一次 `/qa set` 会把旧表单连同那条表单消息一起作废，从两项皆空重新开始；**另一个人**在别人填到一半时发 `/qa set` 会被当场拒绝，不悄悄顶掉别人那张——被顶掉的人只会看到表单凭空消失，无从排查。表单结算之后再发格式消息就不再被认领，会照常进消息流水线。未填完的表单被任何一次群 teardown 收走。**已登记的问答跟着这个群一起走**：`/init disable` 与「机器人被移出群」会把本群全部问答从库里删掉，重新 `/init enable` 之后要重新登记；只是被撤了管理员则一条都不删，权限加回来直答照旧生效。单条删除仍走 `/qa remove`。

  表单发送失败会关闭会话。TTL、重开或 teardown 后完成的旧投递不会登记问答；已进入删除流程的投递仍由表单入口认领。关闭后才返回的表单消息 id 会交回状态机清理。

- **问答看板的分页**：`/qa query` 的看板固定 3 条一页，超过一页就给「‹ 上一页 / 页码 / 下一页 ›」三颗按钮，点击就地改写同一条消息。页码不进任何会话状态——每次点击都按 callback_data 里的页号从热表重新装页，因此重启、`/qa remove` 改了条目、甚至整群条目被删光之后，旧看板再点一下也会自己收敛到当前事实。看板上的答案截断到 256 字并补省略号，**问题从不截断**：它是 `/qa remove` 的入参，截断过的问题照抄回去什么也删不掉。
- **问答直答**：本群已 `/init enable` 且消息文本与登记的问题**一字不差**时，机器人直接回答，不经过 AI，也不受 @、回复或随机插话那套触发条件约束——包括回复机器人和 @ 机器人的情形。前导 `@机器人 ` 会先剥掉再比对，其中用户名比对不区分大小写（与 Telegram 一致），问题文本本身仍要一字不差。语义相近但文本不同的提问不走这条路，交给 AI 那一轮的 `group_qa_query` 与 `group_qa_answer` 两个查询工具判断，两者都不消耗整轮可见动作预算，本群没有问答时根本不挂。
- **`/gag` 限制发言**：全局最多同时生效 5 个目标，同群可有多个目标但同一身份不能重复；入口只在已初始化且 Bot 有删除权限的群中建立。普通用户先在群里留下不带按钮的公开状态，再收到一条由 `ephemeral_message_parameters.receiver_user_id` 限定、仅本人可见且带「发言」按钮的临时入口；频道没有接收用户，只发送一条带按钮的公开状态。普通 `@机器人` 查询始终只进入运势。用户和频道按钮统一只预填 `gag:<目标 Telegram id>`（用户为正数、频道为负数）；首个空格前只允许这个目标 id，禁止加入 MD5、摘要、随机 token、群 id 或任何其他元数据。Telegram 的 inline query 不提供当前具体群 id，也没有 Bot 可拦截的发送前回调，因此这些额外字段不能证明实际输入群；正常入口固定使用当前聊天按钮。生成结果以隐藏文本链接携带 `<目标主页>#<会话群 id>`，该 URL 是公开校验材料，不是秘密或认证 token；消息落群后必须同时核对链接中的目标与会话群、实际 `from.id`/`sender_chat.id` 和实际 `message.chat.id`，身份或群不匹配就立即删除。频道候选标题不显示群名。任何 `gag:` 查询均由 gag 领域独占，非法、过期或身份不匹配时只返回空结果，不回退运势。开始状态不走普通命令回执的 30 秒删除。发言入口由会话刷新替换；对应 `/ungag`、超时或群运行时 teardown 停止刷新，并按各自消息 id 清理全部状态；任一删除失败都会保留有界的收尾状态并有限重试，同一目标须等全部状态确实消失后才能重新 gag。`/ungag` 必须通过回复、`@username` 或身份 id 定向。发言渲染逐个扩展字形抽样：75% 走填充分支，在该字形后追加 3~6 个点（相邻两点各以 1/3 概率插一个空格），其余 25% 把整个字形等概率替换成六种拟声字之一。同类操作最多连续作用于两个相邻字形，第三次候选由闸门挡下，因此 75% 只是抽样概率、不承诺最终文本里的填充占比；短文本另有保底档位（2~3、4~7、8~31、32~64 个字形分别至少操作 2、3、7、15 次）。

  发言入口按会话独立累计群消息，每 **7 条**触发一次刷新；会被 gag 删除的目标直发文字不计数，合法按钮发言与保留的无文字媒体计数。用户专属入口还在首次激活及每次刷新结算后等待 **30 秒**再补发，因此群里无人发言时也会维护；剩余 gag 时间不超过 30 秒时不再安排这轮补发。如果目标连续 **45 秒**未发言，下一次在本群发言时立即补发，并在刷新结算后重新开始 30 秒计时；45 秒只按目标发言计算，定时补发和消息计数刷新不重置它。首次发言前从 gag 激活时起算；不足 45 秒的同话题发言不会重设补发 timer。三种触发共用同一刷新任务，先发新入口再删旧入口，刷新不延长 gag 的到期时间。目标在其他论坛话题发言时，入口沿同一流程移到该话题。Telegram 发送失败时保留现有入口，下一轮消息阈值或定时触发再试；在途请求不重复排队。这个 30 秒是补发间隔，不是普通回执的删除延迟。[Telegram 专属临时消息](https://core.telegram.org/bots/api#ephemeral-messages-and-commands)仍可能自动消失或在客户端重启时消失，离线用户也不保证收到，不能把补发理解为同一弹窗永久可见。

- **`/block` 黑名单**：动作写在末位，与 `/white` 同一口径——`/block <目标> enable` 拉黑，`/block <目标> disable` 解除，回复目标时只写动作；缺动作或写错时回用法提示（30 秒删除）。两个动作分别要求 `isCanBlock` 与 `isCanUnBlock`。目标可通过回复 TA 的消息、`@username` 或直接给用户 id（正整数，群/频道的负数 id 不算）指定——id 那条最可靠，用户名被释放后可以被别人重新注册，而这条命令不可逆。id 落进持久化黑名单后，TA 出现在任何监听群的入群更新里都会被秒踢。机器人在某个群里「拿到管理权限」和「已 `/init enable`」两件事凑齐的那一刻（先后顺序不限），还会把名单里已经在群里的人补清一遍。补扫时如果某个用户在一个群里的全部查询和封禁都被 Telegram 以 `PARTICIPANT_ID_INVALID` 拒绝（已销号账号的表现），记一次；任一群查到或封到 TA 就清零，累计 5 次后视为已销号，自动移出黑名单和待踢队列。`/block disable` 会从权威 SQLite 黑名单事务删除目标，并默认在所有机器人管理的群解除封禁；即使目标不在动态名单里也仍会跨群解封。`/block disable` 比 `/block` 多认一种目标：**频道的负数 id**。频道马甲会以 `sender_chat` 的身份进名单（回复频道消息的 `/block`、广告检测命中），而广告检测会删掉原消息、没有公开 username 的频道也查不到缓存，不认负数 id 的话这类条目就再也划不掉了；反方向不开是因为 `/block` 粘错一个会话 id 就会封掉整个会话身份且不可逆。
- **机器人自身权限不足的提示**：按机器人在本群的权限快照说明原因——确证不是管理员时说不是管理员，并点名要授予的权限；是管理员但没勾某一项时只点名缺的那一项；快照查不到时只说暂时没查清。`/gag`、`/ungag` 缺「删除消息」时直接拒绝并这样说明；`/mute`、`/unmute` 被 Telegram 拒绝后，快照确证缺「限制与封禁成员」或不是管理员才点名原因，快照查不到或该项齐全时仍提示「缺权限或目标是管理员」两种可能；`/block` 在本群没有执行封禁时，说明是没查清还是不是管理员。
- **`/batch_kick` 慢速清理**：只允许超级管理员在已初始化的超级群中使用，参数是 `30m`、`2h`、`1d` 这类不超过 24 小时的单个窗口。命令按入群日志找出窗口内最后一次加入且仍在群中的成员，小并发执行只踢不封；白名单边界内的身份（含恒在边界内的超级管理员）和永久黑名单成员都不会被这条命令当作普通目标处理；每批开始前直接读库确认这两类身份，处理期间缓存被其它群流量挤掉也不影响判定。
- **`/ad_detect` 广告检测**：每条消息按发送者（`chatId:senderId`）归并成消息串，队列每秒一拍取一批交 `agent.ad_detect` 配置的模型判定，持续发言者的稳态判定间隔就是「一个节拍 + 一次分类往返」；90 秒的窗口只约束命中后的处置抑制与已消费上下文的保留，不是「同一个人多久判一次」。非受保护身份命中后执行与 `/block` 相同的处置，并在触发群播报封禁理由（30 秒后自撤）。仅在机器人是本群管理员时触发；剔除消息序号后，整串若只有普通姓名（可选）和链接（包括 `vless://`、`vmess://`、`trojan://`、`ss://` 代理节点或订阅链接）且姓名和正文均没有推广、招募或交易文案，一律不判广告。其余判定口径见 [`config/dynamic/ad_samples.json`](../../config_example/dynamic/ad_samples.json)。 个人候选的 `first_name`、`last_name` 与正文共同送检，姓名各限 128 个 UTF-16 码元且不占正文配额；姓名含广告时，正常正文不豁免该姓名。
- **入群验证与 Anti-Raid**：每群默认关闭，由持有 `isCanControllAntiRaidPermission` 的身份（超级管理员恒持有）执行 `/antiraid enable` 开启，两条链路共用这一个开关——它们吃的是同一批入群事件，分开开关只会造出「验证关着、私密模式还在踢人」这种组合。关闭时这两条链路一个事件都不再触发：不开验证窗口、不发提醒、不做超时踢出，也不再统计入群频率；已经开着的窗口连同待处置的终态一起作废：那两条已经发出去的验证提醒会被删掉——按钮此刻已经失效，不能永久留在群里——入群公告与成员自己的消息不动，也不踢人；仍生效的私密模式会把邀请权限还回去。同在一条 Worker 上的广告检测、防刷屏禁言、永久黑名单秒踢和 `/batch_kick` 依赖的入群日志都不受影响。
- **刷屏禁言**：每群默认关闭，由持有 `isCanControllFloodControlPermission` 的身份（超级管理员恒持有）执行 `/flood_control enable` 开启。同一个人在同一个超级群内一分钟发言达到 15 条，就地禁言 3 分钟并在群里说明一句（公告在发送成功 30 秒后自撤）。到点由 Telegram 自动解除，不写黑名单也不删消息。仅在机器人确有「限制成员」权限时触发；群主/管理员、频道马甲与匿名管理员不计数。豁免只看 `isCanBypassFloodControl` 一项，白名单条目缺省为 `true`，显式设为 `false` 后会参与计数；`SUPER_ADMIN_USER_ID` 恒持有该权限因而恒不计数。
- **`/send` 中转**：开启前先探测目标是否可达，期间超级管理员发送的每条消息都会原样转发到目标群一次；目标失联时自动终止并通知。
  - **语音代发**：把下面的 JSON 整条作为代码块发送（允许注释与尾逗号），机器人不转发原消息，而是把 `text` 合成语音、以语音气泡发到目标群；`tone` 可省，是这一句的语气，拼在固定的基础声线之后。台词上限 256、语气上限 64，均按 UTF-16 码元计数（常见 emoji 占 2 个）；超过上限会回格式提示，不会截断后发送。
    ```json
    { "type": "tts", "tone": "需要的语气", "text": "需要转换的文本" }
    ```
    不是整条代码块、解析不出 JSON 或 `type` 不是 `tts` 的消息照常转发；`type` 为 `tts` 但字段不合规时回一句格式提示。需要 `config/dynamic/agent.json` 配置 `agent.tts`，没配直接报错。合成较慢，请求交给后台执行，因此语音可能晚于紧随其后的文字到达；执行器满时回「稍后再试」；合成或发送失败只回一句提示；当日语音额度（`agent.tts.daily_limit`，缺省 100 次，与 AI 语音、cron 共用）用尽时回一句额度提示；两种情况中转会话都保持开启。中转状态保存在 SQLite `chat_states.status.isProxySendEnabled`，全局最多一个目标，重启后恢复；`state.json` 只保存全局设置。该命令不进入 Telegram 命令菜单，在群内调用或由其他用户触发时均不响应。

> [!TIP]
> **中文动作命令不需要预先登记**，任意 1~2 个中文字都能用。Telegram 的命令名只收 ASCII（拉丁字母、数字、下划线），因此：
> - 这类命令既不出现在命令菜单里，也不会有输入补全；菜单里只放了一条占位说明项 `/x`，命令名 `x` 就是那个变量，提示把它换成任意 1~2 个中文字。点它会收到一条用法提示并终止链路，不会被当成普通消息进入 AI/复读流水线。
> - `/咬人人` 这种三字及以上的写法不算动作命令，会按普通消息处理。
> - 正因为谁都能随手造一个，它采用全局滑动窗口限流：每 90 秒最多应答 450 次，不分群、不分用户合并计数，超额直接静默丢弃、不回提示。

> [!TIP]
> **`/luck_challenge` 不是斜杠命令**：在任意聊天输入 `@机器人用户名 [所求事项]` 即可使用 Inline Mode。需在 BotFather 中开启 Inline Mode，并建议通过 `/setinlinefeedback` 开启 100% 结果反馈。内联查询采用全局滑动窗口限流，每 90 秒最多应答 300 次。

## 💍 群友老婆：`/wed`

群已执行 `/init enable` 后，可用个人身份在群内发送 `/wed`，无需参数。机器人回复命令并发送所选用户的头像，图注为「发起人，你的群友老婆是 群友!」，下方是一排三个按钮：

| 按钮 | 行为 |
| :--- | :--- |
| 移除 | 删除这张结果并释放会话 |
| 娶老婆! | 确认当前结果，中间按钮变为「已确认♡」；仍可更换 |
| 换一只 | 在同一条消息中更换头像和图注，排除发起人及当前目标，恢复确认按钮 |

结果仅发起人本人可操作。更换前的旧按钮点击不会作用于新目标。再次发送 `/wed` 会重新随机抽取，删除旧结果后回复新命令，每位用户每群只保留一张结果。论坛群的结果跟随命令所在话题。频道身份、匿名群管理员、私聊和频道帖子不支持此命令。

候选来自每群独立、长期复用的 **`Set<number>`，最多 15 万人**。只记录已初始化群中以个人身份实际发言的用户，不从频道发言、回复、转发来源、频道自动转发或匿名群身份扩充候选。重复发言不改变集合；满额保留已有成员并暂停新增，退群腾出空间后继续记录。退群更新先删除 ID，群停用期间收到的退群事件也会清理已有记录。候选抽中后只按 ID 读头像，名字取自读头像时那次 `getChat` 返回的私聊资料，不调 `getChatMember`，所以机器人不是群管理员也能抽；不判断是否仍在群，也不回写集合；离群成员由退群更新和每日复核清理，Telegram 认不出 ID（`PARTICIPANT_ID_INVALID`）的已销号账号也在复核时移除。发起人不参与自己的抽取，每轮最多检查 8 个确认没有可用头像的候选；查询未完成不占配额，累计 3 次即放弃本轮。候选不足或头像不可用时提示稍后重抽。

头像先由 `getChat` 确认，再从 `getUserProfilePhotos` 返回的前 100 张头像中按 `big_file_unique_id` 匹配对应尺寸。匹配成功后，发送和更换都直接复用 `PhotoSize.file_id`，本机不下载或上传图片；未匹配或头像列表查询失败时，继续下载当前 ChatPhoto。必要时使用这次 `getChat` 返回的公开用户名，复用 `/icon steal` 的公开头像抓取能力。图注中的发起人和候选均使用用户提及实体。所有下载都有体积上限和取消边界；不会修改机器人自己的头像，也不消耗 copy 类命令的冷却。

命令和按钮共享主线程执行器：全局最多同时执行 **32 项**，执行槽持续占用到查询、下载和图片出站结算；额外最多 **512 项**按 FIFO 等待，满额时提示稍后重试。接纳后释放串行 update 处理，其他更新可继续执行；等待项尚未获取图片。图片、文字和按钮 API 均复用统一 Telegram 出站队列及各类别的 429 等待，没有 `/wed` 专用出站限速。正常停机先停止接纳并排空交互，再关闭出站；群关闭会撤销该群排队项和在途会话。

成员 ID 以数字数组保存于 `memory/wed/<chatId>.json`。只有实际增删才标脏，按统一 DiskIO 的累计 300 条变更或首条变更后 30 秒批量全量替换；无变化不落盘，缺失文件自动创建，重启从 JSON 恢复同一群的成员集合。文件名、ID、唯一性或容量非法会在联网前拒绝启动。正常停机提交剩余变更；突然退出可能丢失尚未落盘的变更。

每天东京时间 00:00，统一 Bun cron 通知主线程复核全部已保存的成员集合，所有群合计每秒最多查询 5 个 ID。确认不在对应群的 ID 从原 Set 删除，并按上述批量路径保存；查询失败或超时保留记录。这个复核依赖 `getChatMember`，只有机器人是群管理员时才保证查得到。**机器人不是管理员的群里，`/wed` 可能抽到已经退群的人**：复核删不掉人，离群的成员只能靠退群服务消息清理，而 Telegram 在较大的超级群或隐藏了成员列表时可能不发这条消息，没收到的会一直留在候选里。需要及时清理离群成员的群，给机器人管理员权限即可。整轮未完成时不叠加新一轮，停机取消复核并提交剩余变更；进程重启后等待下一次零点通知。

结果会话和图片不落盘，图片只在本次操作中持有，会话每群最多 512 张。交互只能在已有成员记录的群里建立，成员表限 25 群且满额拒绝新群，因此交互群同样不超过 25 个，不做淘汰。结果由按钮和群 teardown 管理，不挂固定 30 秒删除；用法、失败等文字提示仍在 30 秒后统一删除。`/init disable` 或机器人离群时会取消交互并删除本群成员记录及持久化文件；仅撤销管理员权限时保留成员记录。重启后旧按钮提示重新发送 `/wed`。

## 🔎 查资料：`/info`

群已执行 `/init enable` 后，任何人都能用 `/info` 查一个身份的公开资料：回复 TA 的消息发 `/info`，或写 `/info @username`、`/info <用户 id>`、`/info <频道或群 id>`。目标可以是频道、其他 bot，也可以是机器人自己。

- **内容**：名称（用户为 `first_name` 与 `last_name` 拼接，频道或群为标题）、用户名（没有则写「无」）、id（点一下即可复制），有头像时连同头像一起发出，没有则注明「头像：无」。
- **来源**：每次现查——用户读本群的成员身份，频道或群读会话资料，机器人自己用启动时的自身资料；查不到时退回机器人记得的身份，什么都没有就回「查不到」。头像与 `/wed` 同一套读取（用户头像按 file_id 复用，频道头像下载后上传，另有 t.me 页面兜底），读不到就不带图。 群资料查询只返回文字字段，不读取群头像。
- **留存与并发**：回执和所有提示都在 30 秒后删除。查询在延迟命令执行器里进行，不占住更新处理；一次最多 30 秒，超时按已拿到的资料回复，满额时回「稍后再试」。私聊里发 `/info` 不回复。

## 🖼️ 随机图片：`/h_image`

**图库配置**：`config/dynamic/assets.json` 的 `random_h_image_dir` 是专用目录，默认 `./h_image`，相对运行时数据根解析。通过 `/h_image add` 收图；手工放置必须按内容 SHA-256 命名。非法名称、子目录、文件链接和残留临时文件会拒绝启动；路径、权限与手工维护步骤见 [07 运维与排障](07-operations.md)。

群已执行 `/init enable` 后，任何人发送 `/h_image`（不带参数）即可；其它参数只回用法提示。机器人从 `config/dynamic/assets.json` 的 `random_h_image_dir`（缺省为数据根下的 `h_image/`，启动时不存在会自动创建）里均匀随机抽一张图，回复这条命令发到本群；论坛群里落在命令所在的话题。

- **图片来源**：只认目录这一层的 `jpg`、`jpeg`、`png`、`webp`，隐藏文件、子目录与符号链接不算。每次都重新列目录，放图、删图不用重启。抽中超过 10 MB 的图会被跳过，改从其余的图里重抽，所以目录里混进几张大图不影响正常抽图。
- **遮罩**：结果图片固定以 Telegram 剧透遮罩（`has_spoiler`）发送，群里显示为模糊图，点开才显示。
- **留存**：结果图片长期保留，不挂 30 秒删除；带参数的用法提示、忙碌提示，以及目录不存在、目录里没有图、没有一张在 10 MB 以内这三种失败提示，都在 30 秒后删除。
- 与 cron 任务的 `rand_image` 共用同一套抽图实现（`packages/infra/randomImage.ts`）。
- **并发**：命令接纳后立即返回，不占住更新处理；抽图与上传在主线程的延迟命令执行器里进行，全局最多同时 2 项、另有 16 个排队位，满额时回「稍后再试」。
- **限流**：`/h_image` 与 `/h_image add` 共用一条全局滑动窗口配额，每秒最多受理 5 次，不分群、不分用户合并计数。超额的那几次直接丢弃：不抽图、不收图，也不回任何消息。

### 收图：`/h_image add`

持有 `isCanAddHImage` 的身份（超级管理员恒有，其余由 `/permission` 授予）回复一条带图的消息并发送 `/h_image add`，机器人把图收进随机图库，之后 `/h_image` 与 cron 的 `rand_image` 都能抽到。

- **收哪些图**：被回复消息里的图片（取最大尺寸），或以文件形式发送的 `jpg`、`png`、`webp`。被回复的消息属于相册时，同一相册里机器人见过的其余图片一并收进来（每个相册至多 10 张）。相册记录只在内存里、最多保留最近 256 个相册，重启后清空——那之后回复相册只收得到被回复的那一张。
- **命名与去重**：文件名是**图片内容的 SHA-256** 加按文件头判定的扩展名（`.jpg`/`.png`/`.webp`），例如 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.jpg`。名字即内容摘要，因此重名就是重复：同一张图无论由谁转发、Telegram 的 `file_unique_id` 是否相同，都落到同一个文件名，目标已存在时直接报「已有」、不重复写盘，也永远不会盖掉别的内容。**去重排在下载之后**——要算出这个名字就得先拿到字节，同一张图会被重新下载一次，换来的是换人转发也照样判重。手工图片只有使用相同内容摘要和保存扩展名时才会命中已有目标；收图不扫描或重算已有文件。格式不对、超过 10 MB 的图不收。
- **尺寸**：`sendPhoto` 要求宽高之和不超过 10000、长宽比不超过 20，字节闸拦不住这一档——一张 12000×40 的长条图只有几十 KB。收图时读一次宽高，越过任一条的图不收；收进去的话，它只会在日后被 `/h_image` 或 cron `rand_image` 抽中时静默发不出去，群里没有任何反馈。
- **写入方式**：从 Telegram 下载到内存（上限 10 MB），先写成点号开头的临时文件，再在同一目录内改名为正式文件名，抽图永远看不到写到一半的文件。服务账号需要对图库目录有写权限。
- **回执**：不回复消息、被回复的消息里没有图、没有权限时只回一句提示；收完回一句汇总：新收几张、收图前图库里原有几张（口径同 `/h_image` 抽图的候选）；有图库里早已有而跳过的、因尺寸不合规没收的、或没收成的，再补上各自张数（尺寸那一档单独说明是宽高和超过 10000 还是长宽比超过 20）。所有提示都在 30 秒后删除。
- **时长**：收图走延迟命令执行器的后台档，交互请求优先；一次最多用 120 秒，超出后剩下的图记为失败。停机时正在收的这批静默放弃，已写入的文件保留。

## ⏰ 定时发送：`cron.json`

定时任务由部署方配置 `config/dynamic/cron.json`，支持热重载，无群内编辑命令。可向指定会话、所有已启用且有发送权限的群，或排除部分群后的集合发送文字、图片、文件与语音。支持时区、一次性任务和随机间隔；固定图片用 1–10 项 `url` 或文件 `path` 数组，2–10 张合为相册，仅首图带说明；随机模式每次一张，可指定独立目录。`is_blurred` 控制全部图片的剧透遮罩。`send_voice` 把 `content` 按可选的 `tone` 合成语音气泡发出，需要 `config/dynamic/agent.json` 配置 `agent.tts`：启动时缺失拒绝启动，运行中加入会被热重载拒绝。

定时消息长期保留，在论坛群落到 General。一次性记录和随机计时只在内存中，重启后重新登记；停机期间错过的触发不补发。字段、示例、目标选择与重试规则见 [部署配置说明](../../config_example/README/zh.md#cronjson)。
