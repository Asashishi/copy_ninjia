# 11 常见问题

<p align="center">
  <b>简体中文</b> · <a href="../en/11-faq.md">English</a> · <a href="../ja/11-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="10-performance.md">← 上一页：10 性能基准</a> · <b>下一页：无 →</b>
</p>

---

机器人进程在运行、群里却没有回应时，按下面的清单逐条排查。BotFather 设置与各功能需要的群管理员权限见 [根目录 README](../../README.md#botfather-setup)。

## 机器人在运行，为什么没有回复？

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">现象分类</th>
    <th width="72%" align="left">排查方向与定位手段</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>❌ <b>群内任何消息均无回应</b></nobr></td>
    <td>
      • <b>未初始化</b>：群内尚未由超级管理员执行 <code>/init enable</code>。<br>
      • <b>隐私模式阻断</b>：Bot 不是群管理员，且 BotFather 中未关闭群隐私模式（<code>/setprivacy → Disable</code>）。<i>注：修改后需将机器人移出群再重新拉入以刷新。</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI 闲聊不接话</b></nobr></td>
    <td>
      • <b>未开启功能</b>：需在群内执行 <code>/ai_chat enable</code>（默认关闭）。<br>
      • <b>触发条件</b>：仅回复 Bot 或 <code>@Bot</code> 必定触发；其余普通消息按随机概率插话（<code>/quiet</code> 安静期内不插话）。<br>
      • <b>复读互斥</b>：群内正在进行 <code>/copy</code> 复读时，AI 闲聊与主动行为暂停。<br>
      • <b>限频机制</b>：发言过密触发 5 分钟滑动窗口限频保护。
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>私聊机器人没反应</b></nobr></td>
    <td>
      • 私聊仅响应超级管理员的 <code>/send</code> 跨群中转指令，忽略其他命令与普通闲聊。
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>提示消息发出后自动消失</b></nobr></td>
    <td>
      • <b>正常设计</b>：命令校验失败、权限拒绝、用法提示和操作回执均在发送成功 <b>30 秒后自动删除</b>（例外见 <a href="09-commands.md">09 命令参考</a>）。
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@Bot</code> 运势候选不弹出</b></nobr></td>
    <td>
      • 未在 @BotFather 开启 Inline Mode（<code>/setinline</code>）。
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>动作命令（如 <code>/咬</code>）不触发</b></nobr></td>
    <td>
      • 仅识别 1–2 个中文字的动作词；全局每 90 秒最多响应 450 次，超额静默丢弃。
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>无法翻译另一个 Bot 的发言</b></nobr></td>
    <td>
      • 需在 @BotFather 为本 Bot 开启 <b>Bot-to-Bot Communication Mode</b>。<br>
      • 收到的其他 Bot 消息受全局入口限流：同一 Bot 连续活跃时第 16 条起忽略，停止发言 90 分钟后重新计数；记录满 512 个 Bot 时不接收新 Bot 的消息（见 <a href="04-invariants.md">消息分发约束</a>）。<br>
      • 翻译仅处理文字与图注，且不转发纯媒体、纯数字标点或已是目标语种的消息。
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>入群验证 / 广告 / 防刷屏无动作</b></nobr></td>
    <td>
      • <b>默认关闭</b>：需显式执行 <code>/antiraid enable</code>、<code>/ad_detect enable</code>、<code>/flood_control enable</code>。<br>
      • <b>缺少权限</b>：Bot 必须具备群管理员身份（含删除消息、封禁成员权限）。<br>
      • <b>模型未配</b>：广告检测需要在 <code>config/dynamic/agent.json</code> 中配置 <code>agent.ad_detect</code>。
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>进程无响应，菜单也不显示</b></nobr></td>
    <td>
      • <b>服务状态</b>：运行 <code>systemctl status &lt;服务名&gt;</code> 确认进程活跃度。<br>
      • <b>配置错误致命退出</b>：检查数据根 <code>logs/&lt;日期&gt;.json</code>，非法配置会在启动阶段报错退出并点名错误字段。<br>
      • <b>Token 冲突（409 错误）</b>：日志中若有 409，说明同 Token 存在多实例并发轮询或配置了 Webhook（排障见 <a href="07-operations.md#启动失败排查">07 运维与排障</a>）。
    </td>
  </tr>
</tbody>
</table>

---

## 如何切换通知语气？

- 在 `config/static/bot.json` 中显式设置 `atmosphere` 为 `mesugaki`（雌小鬼版）或 `normal`（普通版），优先于人设文件的缺省判定，重启后生效。
- 未配置 `atmosphere` 时，存在项目根 `prompt/persona.md` 自定义人设则全部群的通知与菜单使用普通版，否则使用雌小鬼版。
- 通知语气仅改变系统外发通知风格，不改变 AI 闲聊的 System Prompt 人设。

---

## 图库为什么拒绝启动，或收图没有判重？

- **文件规范**：专用图库目录（`assets.json` 的 `random_h_image_dir`）只允许存放以**内容 SHA-256**（64 位小写十六进制）命名的普通图片。
- **启动拦截**：目录内若存在子目录、符号链接、隐藏文件或残留临时文件，启动检查将拒绝启动。先停机备份，按 [07 运维与排障](07-operations.md) 清理残留。
- **去重逻辑**：收图去重发生在下载后计算哈希阶段，图库已有相同哈希文件时直接跳过并提示已收录。手工放置的图片必须保持一致的内容摘要与扩展名才能命中去重。

---

## 定时任务为什么重启后又发一次？

- `just_once` 执行记录仅保存在内存中，重启后会重新登记；已完成的任务应从 `config/dynamic/cron.json` 中移除。
- `rand_cron` 的随机时刻重启后也会重新在区间内抽取，停机期间错过的触发不补发。
- 固定图片需配置 1–10 项数组；`cron.json` 中的相对路径统一相对运行时数据根解析（不要求 `./` 前缀）。

---

## 定时语音或 `/send` 语音为什么发不出来？

定时任务 `send_voice` 与超管私聊 `/send` 语音代发均依赖 `config/dynamic/agent.json` 的 `agent.tts` 配置，在 AI Worker 上异步合成：

### 关键日志特征排查

<table width="100%">
<thead>
  <tr>
    <th width="35%" align="left">错误日志特征</th>
    <th width="65%" align="left">核心原因与排障建议</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>speech synthesis failed: worker unavailable</code></td>
    <td>AI Worker 尚未就绪（检查 <code>stickers.json</code>、<code>mood.json</code> 与 <code>agent.json</code> 是否均已正确配置）。</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>所选供应商不支持语音合成（当前仅 <code>google</code> 与 <code>openai</code> 原生支持）。</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>模型端调用失败或网络超时；OpenAI 兼容端点必须支持 <code>audio/speech</code> 与 <code>opus</code> 格式。</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>服务端返回的音频流编码与请求协议不匹配。</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>语音配额已耗尽，需等待当前 24 小时滚动窗口结束。</td>
  </tr>
</tbody>
</table>

### 额度与配额机制

- `/send` 与 `cron.json` 共用独立的 **`daily_reserve_quota`**（缺省 25 次），记录于 `reserveCount`。
- AI 闲聊独立使用剩余的 **`daily_limit - daily_reserve_quota`**（缺省 75 次），记录于 `agentCount`。
- 两者配额相互隔离，互不挤占。配额在 24 小时滚动窗口到期后重置。

### 私聊 `/send` 格式要求

私聊中的语音请求必须**整条消息为代码块**，且 `type` 必须声明为 `tts`：
```json
{ "type": "tts", "tone": "傲娇", "text": "要合成的台词" }
```
代码块内容按 JSONC 解析，允许注释和尾随逗号。解析失败或 `type` 不是 `"tts"` 时，原消息照常复制到目标群；`type` 为 `"tts"` 但字段非法时只向超管私聊回格式提示，不代发。

---

## 语音长度、温度和记忆如何设置？

| 入口 | 台词上限 (UTF-16) | 发送成功后的 AI 记忆 |
| :--- | :---: | :--- |
| **AI `send_voice`** | 64 | 记录台词 |
| **私聊 `/send` TTS** | 256 | 不自动记录 |
| **cron `send_voice`** | 256 | 不自动记录 |

- **语气与长度**：`tone` 上限统一为 64 UTF-16 码元；空白经规范化后校验。音频响应体积上限为 8 MiB。
- **音色与风格**：
  - 音色由 `agent.tts.voice` 设置。
  - 基础风格由可选的 `agent.tts.style` 设置（支持热重载），缺省使用内置的 `TTS_DEFAULT_STYLE`。
  - 发送时自动拼接为 `<基础风格>; 细节: <语气>`；AI 回复的合成在两者之间追加朗读语言要求（见下方台词语言）。
  - `speech_protocol: "xai"` 协议不支持 `style` 字段，语气亦不发送。
- **台词语言**：AI `send_voice` 的台词语言由可选的 `agent.tts.bot_language` 设置（`en` / `zh` / `ja`，缺省 `ja`；支持热重载，下一轮回复生效）。它切换 `send_voice`、`send_message` 的工具说明与系统提示词里的语音去重规则，并在 AI 回复的合成请求里给基础风格追加该语言的朗读语言要求（`<基础风格>; <朗读语言>; 细节: <语气>`，文案登记在 `VOICE_LANGUAGE_PROMPTS` 的 `speechLanguageStyle`）；不改变 `style`，也不影响 `/send` 与 cron 的台词和合成请求；xai 协议发给接口的合成语言仍由 `language` 决定。
- **换台词语言时一起改的配置**：AI 回复的朗读语言要求随 `bot_language` 自动追加；`voice`、`style` 与 `prompt/voice_tool.md` 不随它切换。更换 `bot_language` 时建议：
  - 把 `style` 改成用对应语言写的声线描述（缺省的 `TTS_DEFAULT_STYLE` 是日语描述）。`style` 同时用于 `/send` 与 cron，只写声线、不写朗读语言；`/send` 与 cron 需要指定语言时写在各自的语气里。改了 `style` 仍不理想时，换一个按对应语言设计的音色（`voice`）。
  - 部署了 `prompt/voice_tool.md` 的，把其中的台词语言、台词示例与语气示例改成对应语言；该文件改完须重启。
  - xai 协议没有风格字段，朗读语言要求与语气都不发送；改 `language`。
- **自定义语音工具说明**：在项目根放置 `prompt/voice_tool.md` 后，重启即以其正文整份替换 `send_voice` 的工具说明，不论 `bot_language` 取何值；`text` / `tone` 参数说明与语音去重规则仍按 `bot_language` 选取。文件为空白或非合法 UTF-8 时拒绝启动；不热重载。
- **采样温度**：Gemini 语音采样的温度由源码常量 `GEMINI_SPEECH_TEMPERATURE`（当前为 `1`）固定。

---

## 如何经三方网关（如 Cloudflare AI Gateway）调用 Google 模型？

1. **设置 Endpoint**：将对应能力的 `base_url` 改为网关地址，例如：
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **附加鉴权头**：在同一能力下配置 `headers`，例如：
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <token>"
   }
   ```
3. **保留 API Key**：`api_key` 仍为必填的 Google API 密钥。`headers` 仅对 `provider: "google"` 有效，敏感值在日志输出时会自动脱敏。
4. **路由覆盖**：文本、识图与生图走 generateContent 路由；语音合成走 Interactions API。配置完成后可通过 `/send` 触发一次语音测试网关连通性。

---

<div align="center">

[← 上一页：10 性能基准](10-performance.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-常见问题)

</div>
