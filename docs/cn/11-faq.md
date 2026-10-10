# 11 常见问题

<p align="center">
  <b>简体中文</b> · <a href="../en/11-faq.md">English</a> · <a href="../ja/11-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="10-performance.md">← 上一页：10 性能基准</a> · <b>下一页：无 →</b>
</p>

---

当机器人进程已正常运行但群内没有预期响应时，请按照本页清单逐项排查。有关 BotFather 的必要开关以及各功能所需的群管理员权限，请参阅 [根目录 README](../../README.md#botfather-setup)。

## 机器人在运行，为什么没有回复？

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">常见现象</th>
    <th width="72%" align="left">排查方向与定位手段</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>❌ <b>群内任何消息均无回应</b></nobr></td>
    <td>
      • <b>未初始化激活</b>：超级管理员尚未在当前群组中执行 <code>/init enable</code> 开启接管。<br>
      • <b>群隐私模式阻断</b>：机器人未被赋予群管理员身份，且在 @BotFather 中未关闭群隐私模式（需发送 <code>/setprivacy → Disable</code>）。<i>注意：在 BotFather 中修改隐私设置后，必须把机器人移出群组并重新拉入，Telegram 才会刷新生效。</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI 闲聊不接话</b></nobr></td>
    <td>
      • <b>未开启功能</b>：需在群内显式执行 <code>/ai_chat enable</code>（默认关闭）。<br>
      • <b>核心配置缺失</b>：需要 <code>agent.json</code> 中的 <code>text</code>、<code>summary</code>、<code>media</code> 三项能力以及 <code>stickers.json</code> 和 <code>mood.json</code> 配置完整；缺失任何一项，AI 闲聊都会自动停用。<br>
      • <b>触发条件机制</b>：仅在用户显式回复机器人或 <code>@机器人</code> 时才会百分之百必回；常规群消息只按概率随机插话（群处于 <code>/quiet</code> 静音期时不插话）。<br>
      • <b>与复读互斥</b>：群内若正在执行 <code>/copy</code> 复读，AI 闲聊与主动插话会自动暂停。<br>
      • <b>限频机制保护</b>：短时间内发言过于频繁会触发滑动窗口限频保护（相关窗口与上限见 <code>RATE_LIMIT_LONG_WINDOW_MS</code>、<code>RATE_LIMIT_LONG_MAX_TRIGGERS</code>）。
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>私聊机器人没反应</b></nobr></td>
    <td>
      • 私聊窗口仅响应超级管理员发送的 <code>/send</code> 跨群中转指令，默认忽略所有其他命令与普通闲聊。
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>提示消息发出后自动消失</b></nobr></td>
    <td>
      • <b>正常设计</b>：命令校验失败、权限不足、用法提示与操作执行成功的回执，在发送成功 30 秒后（<code>COMMAND_MESSAGE_AUTO_DELETE_MS</code>）会自动删除，以保持群内整洁（长期保留例外请见 <a href="09-commands.md#参数与目标匹配准则">09 命令参考</a>）。
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@Bot</code> 运势候选不弹出</b></nobr></td>
    <td>
      • 尚未在 @BotFather 中为机器人开启 Inline Mode（发送 <code>/setinline</code> 开启）。
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>动作命令（如 <code>/咬</code>）不触发</b></nobr></td>
    <td>
      • 动作词仅识别 1~2 个汉字；系统具备全局滑动窗口防刷保护（在 <code>CJK_ACTION_RATE_LIMIT_WINDOW_MS</code> 窗口内最多处理 <code>CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW</code> 次），超出限额的请求会被静默丢弃。
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>无法翻译另一个 Bot 的发言</b></nobr></td>
    <td>
      • 必须先在 @BotFather 中为本机器人开启 <b>Bot-to-Bot Communication Mode</b>。<br>
      • 接收其他 Bot 消息受到全局入口限流保护：同一个 Bot 连续发言超过 <code>BOT_MESSAGE_ACTIVITY_LIMIT</code> 条后会被临时忽略，停止发言满 <code>BOT_MESSAGE_ACTIVITY_TTL_MS</code> 后重置计数；全局跟踪数达到 <code>BOT_MESSAGE_ACTIVITY_MAX_ENTRIES</code> 时暂不接收新 Bot（详见 <a href="04-invariants.md">消息分发约束</a>）。<br>
      • 翻译仅处理文本与图注，纯媒体、纯数字标点或已属于目标语种的消息不予翻译转发。
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>入群验证 / 广告 / 防刷屏无动作</b></nobr></td>
    <td>
      • <b>默认处于关闭状态</b>：需在群内显式执行 <code>/antiraid enable</code>、<code>/ad_detect enable</code>、<code>/flood_control enable</code>。<br>
      • <b>机器人权限不足</b>：机器人必须具备群管理员身份（并拥有“删除消息”与“封禁/限制用户”权限）。<br>
      • <b>检测配置未就绪</b>：广告检测依赖 <code>config/dynamic/agent.json</code> 中的 <code>agent.ad_detect</code> 配置以及 <code>config/dynamic/ad_samples.json</code> 样本库。
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>进程无响应，菜单也不显示</b></nobr></td>
    <td>
      • <b>检查服务运行状态</b>：执行 <code>systemctl status &lt;服务名&gt;</code> 查看进程是否正在运行。<br>
      • <b>排查启动配置错误</b>：查看数据根目录下的日志文件 <code>logs/&lt;日期&gt;.json</code>。配置非法会导致服务在启动阶段 Fail-Fast 报错退出，并在日志中明确指出出错字段。<br>
      • <b>Token 冲突（HTTP 409）</b>：日志中若出现 409 报错，说明同一个 Bot Token 存在多个实例并发轮询，或者此前设置的 Webhook 尚未清空（排障方法见 <a href="07-operations.md#启动失败排查">07 运维与排障</a>）。
    </td>
  </tr>
</tbody>
</table>

---

## 如何切换通知语气？

- **显式配置**：在 `config/static/bot.json` 中配置 `atmosphere` 字段为 `mesugaki`（调侃/雌小鬼版）或 `normal`（克制/普通版），重启服务后即可生效。显式配置具有最高优先级。
- **缺省判定**：若未显式配置 `atmosphere`，系统会根据人设文件自动选择：当项目根目录下存在 `prompt/persona.md` 自定义人设时，全群统一采用普通版；若使用内置人设，则默认采用调侃版。
- **作用边界**：通知语气配置仅影响机器人的系统通知、命令回执、菜单描述和按钮文案，不会改变 AI 闲聊的 System Prompt 人设内容。

---

## 图库为什么拒绝启动，或收图没有判重？

- **严格的文件命名规范**：专用图库目录（由 `assets.json` 中的 `random_h_image_dir` 指定）内**只允许存放纯图片文件**，文件名必须严格是图片二进制内容的 64 位小写十六进制 SHA-256 哈希值，扩展名仅支持 `.jpg`、`.jpeg`、`.png` 或 `.webp`。
- **启动预检拦截**：如果图库目录中包含子目录、文件软链接、隐藏文件或非哈希命名的文件，服务启动时将直接报错退出。请先停止服务，按照 [07 运维与排障](07-operations.md) 清理或规范化图库文件。
- **收图判重机制**：使用 `/h_image add` 收图时的去重逻辑发生在下载图片后计算哈希阶段。如果图库中已经存在相同哈希的文件，系统会跳过写盘并提示已收录。如果是手动拷贝图片到图库，必须保证文件名等于其 SHA-256 哈希值才能正确参与去重。

---

## 定时任务为什么重启后又发一次？

- **一次性任务（`just_once`）**：执行记录仅保存在内存中，服务重启后会重新加载并重新执行一次。已经执行完毕的一次性任务应及时从 `config/dynamic/cron.json` 中移除。
- **随机浮动定时（`rand_cron`）**：任务在服务重启后会重新在设定区间内随机计算下一次触发时间，停机期间错过的触发时刻不会进行事后补发。
- **路径与参数格式**：指定固定图片时，`url` 或 `path` 必须传入数组形式；`cron.json` 中的相对路径统一相对运行时数据根目录解析（无需强制添加 `./` 前缀）。

---

## 定时语音或 `/send` 语音为什么发不出来？

定时任务中的 `send_voice` 动作与超级管理员私聊中的 `/send` 语音代发，均依赖 `config/dynamic/agent.json` 中的 `agent.tts` 配置，由 AI Worker 线程在后台异步合成：

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
    <td>AI Worker 线程尚未完成初始化就绪（请检查 <code>stickers.json</code>、<code>mood.json</code> 与 <code>agent.json</code> 是否均已正确配置并加载成功）。</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>当前配置的模型供应商不支持语音合成（目前仅 <code>google</code> 与 <code>openai</code> 原生支持）。</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>模型服务端接口报错或网络请求超时；若使用 OpenAI 兼容端点，该端点必须支持 <code>audio/speech</code> 路径与 <code>opus</code> 音频格式。</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>模型服务端实际返回的音频流编码与请求头中声明的音频协议不符。</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>今日语音合成配额已耗尽，需等待当前统计周期窗口（<code>TTS_USAGE_WINDOW_MS</code>）结束后自动刷新。</td>
  </tr>
</tbody>
</table>

### 额度与配额机制

- 超管私聊 `/send` 与 `cron.json` 定时任务共用独立的预留配额 **`daily_reserve_quota`**（记录在全局状态的 `reserveCount` 字段）。
- AI 群内闲聊独立使用剩余的 **`daily_limit - daily_reserve_quota`** 配额（记录在 `agentCount` 字段）。
- 两者配额相互隔离，互不挤占。配额窗口从首个请求开始计时，窗口到期后（`TTS_USAGE_WINDOW_MS`）的下一个请求会自动开启新窗口并清空计数。

### 私聊 `/send` 格式要求

超级管理员在私聊中请求代发语音时，**必须将整条消息作为 JSON 代码块发送**，且 `type` 字段必须声明为 `tts`：
```json
{ "type": "tts", "tone": "傲娇", "text": "要合成的台词" }
```
代码块内容按 JSONC 标准解析（支持行尾注释与逗号容错）。若解析失败或 `type` 字段不等于 `"tts"`，消息将作为普通文字直接转发至目标群；若 `type` 为 `"tts"` 但字段格式不符合要求，机器人会在私聊中回复格式错误提示，不会发送到目标群。

---

## 语音长度、温度和记忆如何设置？

| 发起入口 | 台词上限 (UTF-16) | 发送成功后是否记录进 AI 记忆 |
| :--- | :---: | :--- |
| **AI `send_voice` 工具** | `VOICE_TEXT_MAX_CHARS` | 自动计入 AI 上下文记忆 |
| **私聊 `/send` TTS 代发** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | 不计入 AI 上下文记忆 |
| **定时任务 `send_voice`** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | 不计入 AI 上下文记忆 |

- **语气与长度限制**：`tone` 语气修饰词字符上限统一为 `VOICE_TONE_MAX_CHARS`（按 UTF-16 码元计，空白字符规范化后校验）。单次合成生成的音频二进制体积上限为 `VOICE_SPEECH_MAX_BYTES`。
- **音色与基础风格**：
  - 音色名称由 `agent.tts.voice` 指定。
  - 基础声线风格由可选的 `agent.tts.style` 指定（支持运行时热重载），缺省使用内置的 `TTS_DEFAULT_STYLE`。
  - 发送请求时，系统会自动拼装为 `<基础风格>; 细节: <语气>`；若为 AI 回复中的语音合成，还会在这两者之间自动追加当前语言的朗读要求。
  - 当使用 `speech_protocol: "xai"` 协议时，接口不支持 `style` 字段，语气描述也不会发送。
- **台词语言配置（`bot_language`）**：
  - AI `send_voice` 工具的台词语言由可选的 `agent.tts.bot_language` 设置（可选 `en`、`zh`、`ja`，缺省为 `ja`；支持热重载，下一轮回复立即生效）。
  - 该字段会同步切换 `send_voice` 与 `send_message` 的工具描述以及提示词中的去重规则，并在 AI 回复合成时向基础风格追加朗读语言指导（例如 `<基础风格>; <朗读语言要求>; 细节: <语气>`，模板登记在 `VOICE_LANGUAGE_PROMPTS` 的 `speechLanguageStyle`）。
  - 该配置不改变 `style` 的具体取值，也不影响私聊 `/send` 与定时任务中的台词语言；xAI 协议的合成语言直接由 `language` 字段决定。
- **更换台词语言时的推荐配置步骤**：
  - 将 `style` 修改为用目标语言撰写的声线描述（缺省的 `TTS_DEFAULT_STYLE` 为日语描述）。`style` 同时服务于 `/send` 与定时任务，建议只写音色特征、不写语言限制；若 `/send` 或定时任务需要指定语言，写在各自的语气参数中即可。若效果仍不理想，建议更换一个专门针对目标语言优化的 `voice` 音色。
  - 若配置了自定义提示词 `prompt/voice_tool.md`，需将文件中的台词示例与语气说明同步修改为目标语言，修改后需重启服务生效。
  - 使用 xAI 协议时由于不支持声线风格与语气注入，直接调整 `language` 即可。
- **自定义语音工具说明**：在项目根目录创建 `prompt/voice_tool.md` 后，重启服务即可用其全文替换 `send_voice` 的工具描述（不受 `bot_language` 影响）；`text` 与 `tone` 的参数说明仍根据 `bot_language` 动态选取。文件不能为空白，必须为合法 UTF-8 编码，不支持热重载。
- **采样温度**：Gemini 语音合成的采样温度由代码常量 `GEMINI_SPEECH_TEMPERATURE` 固定控制。

---

## 如何经三方网关（如 Cloudflare AI Gateway）调用 Google 模型？

1. **修改请求端点（Endpoint）**：将对应模型能力中的 `base_url` 替换为网关地址，例如：
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **配置自定义请求头（Headers）**：在该能力的配置下增加 `headers` 字段，例如：
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <token>"
   }
   ```
3. **保留 Google API Key**：`api_key` 仍然是必填项，填写原生的 Google AI API 密钥；使用网关托管密钥（BYOK / Unified Billing）时改为填写 Cloudflare 令牌，此时不需要 `headers`。`headers` 选项对 `provider: "google"` 与 `provider: "anthropic"` 有效（openai 不接受），日志输出时敏感信息会自动脱敏。
4. **接口路由适配**：文本对话、图像理解与图片生成路由自动走 `generateContent` 端点；语音合成走 `Interactions API`。配置完成后，超级管理员可在私聊中使用 `/send` 发送一条测试语音验证网关转发是否通畅。

---

## 如何经 Cloudflare AI Gateway 调用 Anthropic 模型？

`provider: "anthropic"` 的能力（`text`、`summary`、`media`、`web_search`、`ad_detect`）把 `headers` 经 SDK 的 `defaultHeaders` 附加到每个请求上。`base_url` 统一填写：
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`

1. **自带 Anthropic 密钥**：`api_key` 填写 Anthropic API Key（SDK 以 `x-api-key` 发送）。网关开启鉴权（Authenticated Gateway）时再加：
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <CF_AIG_TOKEN>"
   }
   ```
   网关未开启鉴权时不需要 `headers`。
2. **网关托管密钥（BYOK / Unified Billing）**：`api_key` 直接填写 Cloudflare 令牌 `<CF_AIG_TOKEN>`，不需要 `headers`。网关识别 `x-api-key` 中的 Cloudflare 令牌后，改用已存储的 Anthropic 密钥或 Unified Billing。`api_key` 填占位串时，占位串会被原样转发给 Anthropic 并返回鉴权失败。
3. **字段约束**：`headers` 不能包含 `x-api-key`（忽略大小写），Anthropic 凭据只经 `api_key` 传递；其余约束与 Google 一致。每个请求头值都会进入日志脱敏名单。

---

<div align="center">

[← 上一页：10 性能基准](10-performance.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-常见问题)

</div>
