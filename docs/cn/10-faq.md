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
  - 需要 `config/agent.json` 配好 AI，并在本群执行过 `/ai_chat enable`（默认关闭）。
  - 只有回复机器人的消息或 @ 它才一定触发；其余消息靠随机概率插话，`/quiet` 期间不插话。触发后开不开口也由 AI 按人设决定。
  - 本群正在 `/copy` 复读时，AI 与其他主动行为暂停。
  - 触发过密会被限频，限频提示按群冷却，不会每次都发。
- **私聊机器人没反应**：私聊只接受超级管理员的 `/send`，其他斜杠命令直接忽略；AI 闲聊只在群里进行。
- **提示发出来一会儿就消失了**：命令校验失败、权限拒绝、用法提示和操作回执都在发送成功 30 秒后自动删除；长期保留的例外见 [08 命令与行为参考](08-commands.md)。
- **`@机器人` 不出现运势候选**：没开 Inline Mode。
- **`/咬` 这类动作命令没反应**：只认 1~2 个中文字；全局每 90 秒最多应答 450 次，超出直接静默丢弃。
- **另一个机器人的消息没被翻译或复读，或时有时无**：需要开启 Bot-to-Bot Communication Mode（见 [BotFather 设置](../../README.md#botfather-setup)）。翻译只处理文字，图片、图注不翻，含可渲染 `/命令` 的消息整条跳过。
- **入群验证、广告检测、刷屏禁言没有动作**：三者默认关闭，需分别执行 `/antiraid enable`、`/ad_detect enable`、`/flood_control enable`，且机器人要是管理员并有 [群内管理员权限](../../README.md#botfather-setup) 表中对应的权限；广告检测还需要 `config/agent.json` 配好广告检测能力。
- **完全没反应，命令菜单也没有**：先确认进程在运行（`systemctl status <服务名>`、`journalctl -u <服务名>`），错误日志在数据根的 `logs/<日期>.json`。配置或状态写错时进程在启动阶段直接退出，日志写明文件路径和字段；日志反复出现 `Error fetching Telegram updates` 且错误码为 409，说明同一个 token 另有实例在拉取更新或设置了 webhook，进程会退出。排查步骤见 [07 运维与排障](07-operations.md#启动失败排查)。

---

<div align="center">

[← 上一页：09 性能基准](09-performance.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-常见问题)

</div>
