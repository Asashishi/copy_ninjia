# 10 常见问题

<p align="center">
  <b>简体中文</b> · <a href="../en/10-faq.md">English</a> · <a href="../ja/10-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="09-performance.md">← 上一页：09 性能基准</a> · <b>下一页：无 →</b>
</p>

---

机器人进程在运行、群里却没有回应时，按下面的清单逐条排查。BotFather 设置与各功能需要的群管理员权限见 [根目录 README](../../README.md#botfather-setup)。

## 机器人在运行，为什么没有回复？

- **群里发什么都没反应**：本群还没执行 `/init enable`。未初始化的群里，除超级管理员发的 `/init` 外，所有消息和命令都被直接忽略，不回任何提示。
- **普通消息没反应（不复读、不翻译、AI 不接话、问答不回）**：机器人看不到普通消息——隐私模式没关且机器人不是管理员，或改了隐私模式后没把机器人移出再拉回群。
- **AI 不说话**：
  - 需要 `config/dynamic/agent.json` 配好 AI，并在本群执行过 `/ai_chat enable`（默认关闭）。
  - 只有回复机器人的消息或 @ 它才一定触发；其余消息靠随机概率插话，`/quiet` 期间不插话。触发后开不开口也由 AI 按人设决定。
  - 本群正在 `/copy` 复读时，AI 与其他主动行为暂停。
  - 触发过密会被限频，限频提示按群冷却，不会每次都发。
- **私聊机器人没反应**：私聊只接受超级管理员的 `/send`，其他斜杠命令直接忽略；AI 闲聊只在群里进行。
- **提示发出来一会儿就消失了**：命令校验失败、权限拒绝、用法提示和操作回执都在发送成功 30 秒后自动删除；长期保留的例外见 [08 命令与行为参考](08-commands.md)。
- **`@机器人` 不出现运势候选**：没开 Inline Mode。
- **`/咬` 这类动作命令没反应**：只认 1~2 个中文字；全局每 90 秒最多应答 450 次，超出直接静默丢弃。
- **另一个机器人的消息没被翻译或复读，或时有时无**：需要开启 Bot-to-Bot Communication Mode（见 [BotFather 设置](../../README.md#botfather-setup)）。翻译处理文字与图注，没有文字的图片、贴纸、文件不发送，含可渲染 `/命令` 的消息整条跳过。
- **入群验证、广告检测、刷屏禁言没有动作**：三者默认关闭，需分别执行 `/antiraid enable`、`/ad_detect enable`、`/flood_control enable`，且机器人要是管理员并有 [群内管理员权限](../../README.md#botfather-setup) 表中对应的权限；广告检测还需要 `config/dynamic/agent.json` 配好广告检测能力。
- **完全没反应，命令菜单也没有**：先确认进程在运行（`systemctl status <服务名>`、`journalctl -u <服务名>`），错误日志在数据根的 `logs/<日期>.json`。配置或状态写错时进程在启动阶段直接退出，日志写明文件路径和字段；日志反复出现 `Error fetching Telegram updates` 且错误码为 409，说明同一个 token 另有实例在拉取更新或设置了 webhook，进程会退出。排查步骤见 [07 运维与排障](07-operations.md#启动失败排查)。

## 如何切换通知语气？

在 `config/static/bot.json` 设置 `atmosphere` 为 `mesugaki`（缺省）或 `normal`，重启后生效。群配置了 `/prompt config` 自定义 AI 人设时，通知与菜单优先使用普通版；`/prompt remove` 后回到 Bot 配置语气。通知语气不修改 AI 的提示词。

## 图库为什么拒绝启动，或收图没有判重？

专用图库只允许以内容 SHA-256 命名的普通图片，子目录、文件链接、隐藏文件和残留临时文件都会拒绝启动。先停机备份，再按 [运维手册](07-operations.md) 核对条目；不要把迁移工具的清单文件放进图库。收图不读取已有图片的内容，只核对下载后算出的目标文件名；手工图片必须使用相同内容摘要和保存扩展名才能命中。cron 显式指定的独立随机目录允许普通文件名。

## 定时任务为什么重启后又发一次？

`just_once` 的执行记录只保存在内存里，重启后会重新登记；已完成的任务应从 `config/dynamic/cron.json` 删除。`rand_cron` 的等待也会重置，停机期间错过的触发不补发。固定图片必须写 1–10 项数组，随机图的 `path` 则是目录字符串；cron 相对路径按项目根解析，专用图库路径按数据根解析。配置示例见 [部署配置说明](../../config_example/README/zh.md#cronjson)。

## 定时语音或 `/send` 语音为什么发不出来？

两者都用 `config/dynamic/agent.json` 的 `agent.tts` 在 AI Worker 上合成。`cron.json` 用到 `send_voice` 而没配 `tts` 时，启动直接拒绝，运行中改出这种组合的那一份改动会被热重载拒绝并记错误日志；`/send` 的语音请求会直接回「未配置语音合成」。配了 `tts` 仍失败时看日志：`speech synthesis failed: worker unavailable` 表示 AI Worker 没在运行（`stickers.json`、`mood.json`、`prompt/persona.md` 也要齐），`tts unsupported` 表示所选 provider 没实现语音合成（当前只有 `google`），`synthesis failed` / `timed out` 多为模型端问题，`daily limit reached` 表示当日语音额度已用尽：三个入口共用每天 `agent.tts.daily_limit`（缺省 100）次，AI 最多用 `daily_limit - daily_reserve_quota`（缺省 75）次，计数窗口从窗口内第一次请求起算、满 24 小时后重计，记在 `memory/global/state.json` 的 `ttsUsage`；这两个数在 `agent.tts` 里调整，改完热重载即生效，已用次数不清零。`/send` 的语音请求必须整条是代码块，且 `type` 为 `tts`，否则会按普通消息转发。字段与限制见 [部署配置说明](../../config_example/README/zh.md#cronjson) 与 [08 命令参考](08-commands.md)。

## 语音长度、温度和记忆如何设置？

| 入口 | 台词上限 | 发送成功后的 AI 记忆 |
| :--- | ---: | :--- |
| AI `send_voice` | 64 | 记录台词 |
| 私聊 `/send` TTS | 256 | 不自动记录 |
| cron `send_voice` | 256 | 不自动记录 |

长度按 UTF-16 码元计，`tone` 上限统一为 64；空白归一化后再校验。`/send` 超限会回格式提示；cron 的非法字段会使启动失败，热重载时则拒绝整份改动并记日志。音频响应另有 8 MiB 上限，文本长度不保证合成时长。

音色由 `agent.tts.voice` 设置，基础风格由可选的 `agent.tts.style` 设置，两者位于 `config/dynamic/agent.json`，支持热重载。`style` trim 后必须非空，缺省使用 [`GEMINI_SPEECH_STYLE`](../../packages/consts/aiChat/gemini.ts)，删除字段恢复默认；三个入口共用，给出语气时拼成 `<基础风格>; 细节: <语气>`。新请求使用重载后的配置，已发起的请求保留原快照。采样温度仍由源码常量 `GEMINI_SPEECH_TEMPERATURE`（当前 `1.25`）决定，修改温度需要重新构建或重启源码服务。

## 如何经三方网关（如 Cloudflare AI Gateway）调用 Google 模型？

把对应能力的 `base_url` 改成网关给出的 Google AI Studio 端点（Cloudflare 为 `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`），网关要求的鉴权头写进同一能力的 `headers`，例如 `{ "cf-aig-authorization": "Bearer <token>" }`。`api_key` 仍是必填的 Google key；`headers` 只对 `provider` 为 `google` 的能力有效，值按凭据在日志中脱敏。文字、识图与生图走 generateContent，语音合成走 Interactions API，两者都会带上 `headers`；网关是否转发 Interactions API 取决于网关本身，配好后先用 `/send` 发一条语音确认。字段规则见 [部署配置说明](../../config_example/README/zh.md#agentjson)。

---

<div align="center">

[← 上一页：09 性能基准](09-performance.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-常见问题)

</div>
