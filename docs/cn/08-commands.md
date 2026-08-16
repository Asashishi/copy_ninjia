# 08 命令与行为参考

<p align="center">
  <b>简体中文</b> · <a href="../en/08-commands.md">English</a> · <a href="../ja/08-commands.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 开发者文档首页</a> · <a href="07-operations.md">← 上一页：07 运维与排障</a> · <b>下一页：无 →</b>
</p>

---

面向使用者的完整命令表、权限口径与行为细节。根 README 只留一句概述，具体口径以本页为准；
命令实现落在 `packages/commands/`，权限键定义见
[`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts)。

## 🎭 复读模式

复读目标是全局唯一的：同一实例同时只能「变成」一个目标，但复读只发生在发起命令的群中。`/stop_copy` 可在任意群停止当前复读。

| 命令 | 行为 |
| :---: | :--- |
| `/copy` | 原样复读 |
| `/r_copy` | 按字素簇反转纯文本 |
| `/nya_copy` | 在纯文本末尾追加「喵~」 |
| `/ja_copy` | 使用 Google Cloud Translate 翻译为日语后复读 |
| `/steal_icon` | 只复制头像 |
| `/reset_icon` | 把头像换回机器人自己的默认那张 |
| `/stop_copy` | 停止全局复读状态，并顺带复原头像 |

目标可通过「回复 TA 的消息」或 `@username` 指定：

- **按用户名查找依赖机器人此前观察到该账号**；改名、移除用户名或用户名换绑会立即使旧别名失效。对 `/block`、`/unblock` 这类破坏性操作，优先回复目标消息或直接给用户 id（那两条命令额外接受裸 id），不要依赖历史用户名。
- **匿名管理员以当前群身份发言时，复读目标就是当前群**，因而可取得群头像并复读这层「皮套」；`/block` 会拒绝把当前群身份当作成员目标。
- **普通用户执行 copy 类命令时受 5 分钟全局冷却限制**，白名单边界内的身份不受限——SQLite 白名单表中的条目，以及恒在边界内的 `SUPER_ADMIN_USER_ID`。

## 🎮 命令与权限

<table width="100%">
<tr><th width="26%" align="left">命令</th><th width="19%" align="center">权限</th><th width="55%" align="left">说明</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">群成员</td><td>启动相应复读模式</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">群成员</td><td>停止当前全局复读，并顺带复原头像</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">群成员</td><td>只偷头像</td></tr>
<tr><td><code>/reset_icon</code></td><td align="center">群成员</td><td>把头像换回默认那张</td></tr>
<tr><td><code>/&lt;1~2 个中文字&gt;</code></td><td align="center">群成员</td><td>动作命令，如 <code>/咬</code>、<code>/揪住</code> 回复「发起人 咬了 目标！」；成功结果长期保留</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">群成员</td><td>暂停随机插话、随机复读等主动行为，默认 3 分钟</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">群成员</td><td>提前解除安静模式</td></tr>
<tr><td><code>/mute … &lt;时长&gt;</code> <code>/unmute</code></td><td align="center"><code>isCanMute</code> / <code>isCanUnMute</code></td><td>在超级群临时禁言或提前解除；目标支持回复、<code>@username</code>、用户 id，时长支持 <code>m/h/d</code></td></tr>
<tr><td><code>/gag … [5|10|15] [用具]</code><br><code>/ungag …</code></td><td align="center"><code>isCanGag</code></td><td>让用户或频道身份只能经 Bot 的 inline 入口发言，或定向提前解除；目标支持回复、<code>@username</code>、用户 id 与频道负数 id</td></tr>
<tr><td><code>/block</code></td><td align="center"><code>isCanBlock</code></td><td>拉黑：写进永久黑名单，并在所有机器人管理的群中封禁目标；目标可用回复消息、<code>@username</code> 或用户 id 指定</td></tr>
<tr><td><code>/unblock</code></td><td align="center"><code>isCanUnBlock</code></td><td>完整解除拉黑：把 id 从动态黑名单里划掉，并在所有机器人管理的群中解除封禁；目标指定方式同 <code>/block</code>，另外还接受频道的负数 id。静态黑名单身份拒绝解除</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>isCanControllAIPermission</code></td><td>开关本群 AI 闲聊</td></tr>
<tr><td><code>/ad_detect enable|disable</code></td><td align="center"><code>isCanControllAdDetectPermission</code></td><td>开关本群广告检测，非受保护身份命中后按 <code>/block</code> 同权处置</td></tr>
<tr><td><code>/flood_control enable|disable</code></td><td align="center"><code>isCanControllFloodControlPermission</code></td><td>开关本群防刷屏禁言（默认关闭）</td></tr>
<tr><td><code>/antiraid enable|disable</code></td><td align="center"><code>isCanControllAntiRaidPermission</code></td><td>开关本群入群验证与防冲群私密模式（默认关闭）</td></tr>
<tr><td><code>/bot_status</code></td><td align="center">群成员</td><td>查看本机进程指标、全局模型能力、Telegram 429 出站队列、正在生效的 gag 数量、本天才在本群已拥有的权限（JSON 块）和本群已开启功能</td></tr>
<tr><td><code>/query_mood</code></td><td align="center">群成员</td><td>查询本群 AI 当前有效心情，不触发重抽</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>isCanSwitchMood</code></td><td>立即重抽本群 AI 心情，并在 Worker 回执后回复新心情名</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>isCanControllJATranslatePermission</code></td><td>开关本群日语翻译能力（默认关闭）</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>开关本群的业务处理总入口</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>在超级群中踢出滚动 24 小时内指定时间窗加入且仍在群内的成员；只踢不拉黑</td></tr>
<tr><td><code>/permission query</code><br><code>/permission help</code></td><td align="center">白名单身份</td><td>查询发起用户/频道自己的完整权限，或以 JSON 列出权限说明；<code>help</code> 长期保留，<code>query</code> 30 秒后删除</td></tr>
<tr><td><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>修改已有白名单用户/频道的一项权限；<code>all</code> 可全部打开</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>新增或删除白名单用户/频道；支持回复、<code>@username</code>、用户 id 与频道 id</td></tr>
<tr><td><code>/send &lt;群组 ID&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code>（仅私聊）</td><td>在机器人私聊中开始或结束向目标群的中转</td></tr>
</table>

> **权限列的读法**：写 `isCanXxx` 的行按权限键授权，而 `SUPER_ADMIN_USER_ID` 这个身份本身恒持有**全部**权限键，因此那些行他一律可用，无需写入 SQLite 白名单表；写 `SUPER_ADMIN_USER_ID` 的行才是只认身份、无法通过白名单授权出去的。

### 行为细节

- **命令入口**：群命令统一经过 `/init` 网关；未初始化群只接受超级管理员的 `/init`，所以 `/permission`、`/white` 也必须在已初始化群中使用。私聊斜杠命令只放行 `/send`。
- **动作命令**：姓名用 `first_name last_name` 形式，有公开用户名的一方挂上主页链接；目标同样通过「回复 TA 的消息」或 `@username` 指定。成功的动作结果与 `/permission help` 一样长期保留；目标缺失、参数错误和 `/x` 用法提示仍在 30 秒后删除。
- **`/gag` 限制发言**：全局最多同时生效 5 个目标，同群可有多个目标但同一身份不能重复；入口只在已初始化且 Bot 有删除权限的群中建立。普通用户先在群里留下不带按钮的公开状态，再收到一条由 `receiver_user_id` 限定、仅本人可见且带「发言」按钮的临时入口；频道没有接收用户，只发送一条带按钮的公开状态。普通 `@机器人` 查询始终只进入运势。用户和频道按钮统一只预填 `gag:<目标 Telegram id>`（用户为正数、频道为负数）；首个空格前只允许这个目标 id，禁止加入 MD5、摘要、随机 token、群 id 或任何其他元数据。Telegram 的 inline query 不提供当前具体群 id，也没有 Bot 可拦截的发送前回调，因此这些额外字段不能证明实际输入群；正常入口固定使用当前聊天按钮。生成结果以隐藏文本链接携带 `<目标主页>#<会话群 id>`，该 URL 是公开校验材料，不是秘密或认证 token；消息落群后必须同时核对链接中的目标与会话群、实际 `from.id`/`sender_chat.id` 和实际 `message.chat.id`，身份或群不匹配就立即删除。频道候选标题不显示群名。任何 `gag:` 查询均由 gag 领域独占，非法、过期或身份不匹配时只返回空结果，不回退运势。开始状态不走 30 秒清理，只在对应 `/ungag`、超时或群运行时 teardown 时按各自消息 id 删除；任一删除失败都会保留有界的收尾状态并有限重试，同一目标须等全部状态确实消失后才能重新 gag。`/ungag` 必须通过回复、`@username` 或身份 id 定向。发言渲染逐个扩展字形抽样：75% 走填充分支，在该字形后追加 3~6 个点（相邻两点各以 1/3 概率插一个空格），其余 25% 把整个字形等概率替换成六种拟声字之一。同类操作最多连续作用于两个相邻字形，第三次候选由闸门挡下，因此 75% 只是抽样概率、不承诺最终文本里的填充占比；短文本另有保底档位（2~3、4~7、8~31、32~64 个字形分别至少操作 2、3、7、15 次）。
- **`/block` 黑名单**：目标可通过回复 TA 的消息、`@username` 或直接给用户 id（正整数，群/频道的负数 id 不算）指定——id 那条最可靠，用户名被释放后可以被别人重新注册，而这条命令不可逆。id 落进持久化黑名单后，TA 出现在任何监听群的入群更新里都会被秒踢。机器人在某个群里「拿到管理权限」和「已 `/init enable`」两件事凑齐的那一刻（先后顺序不限），还会把名单里已经在群里的人补清一遍。`/unblock` 移除时整份名单原子重写回文件，并默认在所有机器人管理的群解除封禁；即使目标不在动态名单里也仍会跨群解封。`/unblock` 比 `/block` 多认一种目标：**频道的负数 id**。频道马甲会以 `sender_chat` 的身份进名单（回复频道消息的 `/block`、广告检测命中），而广告检测会删掉原消息、没有公开 username 的频道也查不到缓存，不认负数 id 的话这类条目就再也划不掉了；反方向不开是因为 `/block` 粘错一个会话 id 就会封掉整个会话身份且不可逆。
- **`/batch_kick` 慢速清理**：只允许超级管理员在已初始化的超级群中使用，参数是 `30m`、`2h`、`1d` 这类不超过 24 小时的单个窗口。命令按入群日志找出窗口内最后一次加入且仍在群中的成员，小并发执行只踢不封；白名单边界内的身份（含恒在边界内的超级管理员）和永久黑名单成员都不会被这条命令当作普通目标处理。
- **`/ad_detect` 广告检测**：每条消息按发送者（`chatId:senderId`）归并成消息串，队列每秒一拍取一批交 `agent.ad_detect` 配置的模型判定，持续发言者的稳态判定间隔就是「一个节拍 + 一次分类往返」；90 秒的窗口只约束命中后的处置抑制与已消费上下文的保留，不是「同一个人多久判一次」。非受保护身份命中后执行与 `/block` 相同的处置，并在触发群播报封禁理由（30 秒后自撤）。仅在机器人是本群管理员时触发；剔除消息序号后，整串若只有链接（包括 `vless://`、`vmess://`、`trojan://`、`ss://` 代理节点或订阅链接）且没有链接之外的推广、招募或交易文案，一律不判广告。其余判定口径见 [`config/ad_samples.json`](../../config_example/ad_samples.json)。
- **入群验证与 Anti-Raid**：每群默认关闭，由持有 `isCanControllAntiRaidPermission` 的身份（超级管理员恒持有）执行 `/antiraid enable` 开启，两条链路共用这一个开关——它们吃的是同一批入群事件，分开开关只会造出「验证关着、私密模式还在踢人」这种组合。关闭时这两条链路一个事件都不再触发：不开验证窗口、不发提醒、不做超时踢出，也不再统计入群频率；已经开着的窗口连同待处置的终态一起作废（**不删**群里已经发出去的提醒，也不踢人），仍生效的私密模式会把邀请权限还回去。同在一条 Worker 上的广告检测、防刷屏禁言、永久黑名单秒踢和 `/batch_kick` 依赖的入群日志都不受影响。
- **刷屏禁言**：每群默认关闭，由持有 `isCanControllFloodControlPermission` 的身份（超级管理员恒持有）执行 `/flood_control enable` 开启。同一个人在同一个超级群内一分钟发言达到 15 条，就地禁言 3 分钟并在群里说明一句（公告在禁言解除时自撤）。到点由 Telegram 自动解除，不写黑名单也不删消息。仅在机器人确有「限制成员」权限时触发；群主/管理员、频道马甲与匿名管理员不计数。豁免只看 `isCanBypassFloodControl` 一项，白名单条目缺省为 `true`，显式设为 `false` 后会参与计数；`SUPER_ADMIN_USER_ID` 恒持有该权限因而恒不计数。
- **`/send` 中转**：开启前先探测目标是否可达，期间超级管理员发送的每条消息都会原样转发到目标群一次；目标失联时自动终止并通知。中转状态随 `state.json` 持久化，重启后仍可恢复。该命令不进入 Telegram 命令菜单，在群内调用或由其他用户触发时均不响应。

> [!TIP]
> **中文动作命令不需要预先登记**，任意 1~2 个中文字都能用。Telegram 的命令名只收 ASCII（拉丁字母、数字、下划线），因此：
> - 这类命令既不出现在命令菜单里，也不会有输入补全；菜单里只放了一条占位说明项 `/x`，命令名 `x` 就是那个变量，提示把它换成任意 1~2 个中文字。点它会收到一条用法提示并终止链路，不会被当成普通消息进入 AI/复读流水线。
> - `/咬人人` 这种三字及以上的写法不算动作命令，会按普通消息处理。
> - 正因为谁都能随手造一个，它采用全局滑动窗口限流：每 90 秒最多应答 450 次，不分群、不分用户合并计数，超额直接静默丢弃、不回提示。

> [!TIP]
> **`/luck_challenge` 不是斜杠命令**：在任意聊天输入 `@机器人用户名 [所求事项]` 即可使用 Inline Mode。需在 BotFather 中开启 Inline Mode，并建议通过 `/setinlinefeedback` 开启 100% 结果反馈。内联查询采用全局滑动窗口限流，每 90 秒最多应答 300 次。
