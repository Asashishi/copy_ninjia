# 11 FAQ

<p align="center">
  <a href="../cn/11-faq.md">简体中文</a> · <b>English</b> · <a href="../ja/11-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="10-performance.md">← Prev: 10 Performance Benchmark</a> · <b>Next: None →</b>
</p>

---

If the bot process is running but fails to respond as expected in chat, work through this checklist. For essential BotFather toggles and required Telegram administrator privileges, see the [project README](README.md#botfather-setup).

## The Bot Is Running, Why Is There No Reply?

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">Symptom</th>
    <th width="72%" align="left">Troubleshooting Direction & Verification Steps</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>❌ <b>No response in the group</b></nobr></td>
    <td>
      • <b>Not initialized</b>: The superadmin has not run <code>/init enable</code> in this group yet.<br>
      • <b>Privacy mode blocking</b>: The bot lacks group administrator rights, and Group Privacy is still enabled in @BotFather (send <code>/setprivacy → Disable</code>). <i>Note: After changing privacy settings in BotFather, you must kick and re-add the bot for Telegram to apply the change.</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI stays silent</b></nobr></td>
    <td>
      • <b>Feature disabled</b>: Run <code>/ai_chat enable</code> in the group (disabled by default).<br>
      • <b>Missing configuration</b>: Requires valid <code>text</code>, <code>summary</code>, and <code>media</code> providers in <code>agent.json</code>, plus <code>stickers.json</code> and <code>mood.json</code>; missing any of these disables AI chat entirely.<br>
      • <b>Trigger mechanics</b>: Direct replies to the bot or <code>@bot_username</code> mentions always trigger a reply; regular messages trigger probabilistically (no interjections during <code>/quiet</code>).<br>
      • <b>Repeat mode conflict</b>: If active repetition (<code>/copy</code>) is running in the group, AI chat pauses automatically.<br>
      • <b>Rate limiting</b>: Frequent triggers engage sliding-window rate limits (see <code>RATE_LIMIT_LONG_WINDOW_MS</code> and <code>RATE_LIMIT_LONG_MAX_TRIGGERS</code>).
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>No reply in private chat</b></nobr></td>
    <td>
      • Private chat only responds to superadmin <code>/send</code> relay commands; all other messages and casual chats are ignored by design.
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>Notices vanish after 30 seconds</b></nobr></td>
    <td>
      • <b>Expected design</b>: Command validation errors, permission denials, usage hints, and operation receipts auto-delete after 30 seconds (<code>COMMAND_MESSAGE_AUTO_DELETE_MS</code>) to keep groups clean (exceptions detailed in <a href="09-commands.md#parameter-and-target-resolution-rules">09 Command Reference</a>).
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@Bot</code> fortune prompt does not appear</b></nobr></td>
    <td>
      • Inline Mode is not enabled in @BotFather (send <code>/setinline</code> to activate it).
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>Action commands (e.g. <code>/咬</code>) get no reply</b></nobr></td>
    <td>
      • Action commands only recognize 1–2 Chinese characters. A global sliding window limits calls (up to <code>CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW</code> per <code>CJK_ACTION_RATE_LIMIT_WINDOW_MS</code>); excess requests are dropped silently.
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>Cannot translate another bot's messages</b></nobr></td>
    <td>
      • You must enable <b>Bot-to-Bot Communication Mode</b> for this bot in @BotFather.<br>
      • Incoming messages from other bots are subject to global ingress throttling: messages from a bot exceeding <code>BOT_MESSAGE_ACTIVITY_LIMIT</code> are temporarily ignored until <code>BOT_MESSAGE_ACTIVITY_TTL_MS</code> of silence passes; new bots are ignored once <code>BOT_MESSAGE_ACTIVITY_MAX_ENTRIES</code> entries are tracked (see <a href="04-invariants.md">Dispatch Invariants</a>).<br>
      • Translation only processes text and captions; pure media, numeric strings, or messages already in the target language are skipped.
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>Anti-Raid / Ads / Flood inactive</b></nobr></td>
    <td>
      • <b>Disabled by default</b>: Explicitly run <code>/antiraid enable</code>, <code>/ad_detect enable</code>, or <code>/flood_control enable</code>.<br>
      • <b>Insufficient rights</b>: The bot must be an administrator with delete and ban permissions.<br>
      • <b>Configuration unready</b>: Ad detection requires <code>agent.ad_detect</code> in <code>config/dynamic/agent.json</code> and a populated <code>config/dynamic/ad_samples.json</code>.
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>Process dead, menu missing</b></nobr></td>
    <td>
      • <b>Check service status</b>: Inspect <code>systemctl status &lt;service&gt;</code>.<br>
      • <b>Fatal configuration error</b>: Check <code>logs/&lt;date&gt;.json</code> under the data root; malformed configs fail fast and terminate startup.<br>
      • <b>Token conflict (HTTP 409)</b>: Code 409 indicates multiple instances polling the same token or an uncleared webhook (see <a href="07-operations.md#startup-failures">07 Operations</a>).
    </td>
  </tr>
</tbody>
</table>

---

## How Do I Change the Notice Atmosphere?

- **Explicit configuration**: In `config/static/bot.json`, set `atmosphere` to `mesugaki` (teasing/bratty) or `normal` (reserved/standard). Restart the bot to apply changes. Explicit configuration always takes highest priority.
- **Default fallback**: When `atmosphere` is omitted, the bot selects tone based on the persona file: if a custom `prompt/persona.md` exists in the project root, all groups default to reserved tone; if using the built-in persona, it defaults to teasing tone.
- **Scope of influence**: The atmosphere setting only affects system notifications, command receipts, menu descriptions, and button labels; it does not alter the AI chat persona prompt.

---

## Why Does the Image Library Refuse Startup or Miss Duplicates?

- **Strict filename rules**: The dedicated image library (`random_h_image_dir` in `assets.json`) **strictly accepts image files only**. Filenames must be exactly the 64-character lowercase hexadecimal SHA-256 hash of the binary file, with `.jpg`, `.jpeg`, `.png`, or `.webp` extensions.
- **Startup inspection**: If subdirectories, symlinks, hidden files, or non-hash filenames are present, the bot halts immediately at boot. Stop the service and clean up directory contents per [07 Operations](07-operations.md).
- **Deduplication timing**: Deduplication during `/h_image add` occurs after downloading the image and computing its SHA-256 hash. If an identical hash already exists in the library, writing is skipped and reported as already collected. If manually copying files into the library, filenames must match their SHA-256 hash to deduplicate properly.

---

## Why Does a Scheduled Task Send Again After Restart?

- **One-off tasks (`just_once`)**: Execution records are maintained in memory only and will fire again after a process reboot. Remove completed one-off tasks from `config/dynamic/cron.json`.
- **Random intervals (`rand_cron`)**: Next execution times are recalculated randomly upon startup; missed triggers during downtime are not backfilled.
- **Path and URL formatting**: Fixed images require an array for `url` or `path` (see the [Configuration Guide](../../config_example/README/en.md#cronjson)); relative paths in `cron.json` resolve against the runtime data root (no `./` prefix needed).

---

## Why Is Scheduled Voice or `/send` Voice Not Sending?

Scheduled `send_voice` actions and superadmin private `/send` voice delegations both rely on `agent.tts` in `config/dynamic/agent.json`, synthesized asynchronously by the AI Worker:

### Key Log Troubleshooting

<table width="100%">
<thead>
  <tr>
    <th width="35%" align="left">Log Signature</th>
    <th width="65%" align="left">Root Cause & Troubleshooting Guidance</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>speech synthesis failed: worker unavailable</code></td>
    <td>The AI Worker has not finished initializing (verify that <code>stickers.json</code>, <code>mood.json</code>, and <code>agent.json</code> are configured properly).</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>The configured provider does not support speech synthesis (natively supported by <code>google</code> and <code>openai</code>).</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>Vendor API call failed or timed out; OpenAI-compatible endpoints must support <code>audio/speech</code> and <code>opus</code> format.</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>The returned audio encoding does not match the requested protocol format.</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>Voice synthesis quota for the current counting window (<code>TTS_USAGE_WINDOW_MS</code>) is exhausted.</td>
  </tr>
</tbody>
</table>

### Quota and Allocation Mechanics

- Private relay (`/send`) and `cron.json` scheduled tasks share an independent **`daily_reserve_quota`**, tracked in `reserveCount`.
- Conversational AI in groups independently uses the remaining **`daily_limit - daily_reserve_quota`**, tracked in `agentCount`.
- Both quotas are isolated from each other. The quota window begins on the first request; once `TTS_USAGE_WINDOW_MS` passes, the next request resets counters and starts a new window.

### Private Chat `/send` Format Requirements

When requesting voice delegation in private chat, **send the entire message as a JSON code block** with `type` set to `"tts"`:
```json
{ "type": "tts", "tone": "tsundere", "text": "line to synthesize" }
```
The payload is parsed as JSONC (supporting trailing commas and comments). If parsing fails or `type` is not `"tts"`, the message is forwarded as regular text. If `type` is `"tts"` but payload fields are invalid, the bot replies with an error notice in private chat without sending to the group.

---

## How Are Voice Length, Temperature, and Memory Configured?

| Entry Point | Line Limit (UTF-16) | Persisted to AI Memory |
| :--- | :---: | :--- |
| **AI `send_voice` Tool** | `VOICE_TEXT_MAX_CHARS` | Yes, recorded into conversational context |
| **Private `/send` TTS** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | No |
| **Scheduled `send_voice`** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | No |

- **Tone and length bounds**: The `tone` modifier is capped at `VOICE_TONE_MAX_CHARS` (UTF-16 code units), verified after whitespace normalization. Audio file size is capped at `VOICE_SPEECH_MAX_BYTES`.
- **Voices and base styles**:
  - Voice speaker is configured via `agent.tts.voice`.
  - Base voice style is defined in `agent.tts.style` (supports hot reload), defaulting to `TTS_DEFAULT_STYLE`.
  - Requests assemble parameters as `<base style>; 细节: <tone>`; AI chat inserts language pronunciation guidelines between them.
  - The `speech_protocol: "xai"` protocol does not support `style` or tone injection.
- **Language configuration (`bot_language`)**:
  - The language for AI `send_voice` is specified via `agent.tts.bot_language` (`en`, `zh`, or `ja`, default `ja`; hot-reloaded dynamically).
  - This switches tool descriptions for `send_voice` and `send_message`, applies system prompt deduplication rules, and appends language instructions to the voice style request (`<base style>; <language requirements>; 细节: <tone>`, defined in `VOICE_LANGUAGE_PROMPTS`).
  - This setting does not alter `style` directly, nor does it impact `/send` or cron voice delivery. For xAI, synthesis language is determined by `language`.
- **Recommended steps when changing languages**:
  - Update `style` with a voice description in the target language (default `TTS_DEFAULT_STYLE` is Japanese). Because `style` is shared with `/send` and cron, describe voice timbre rather than language constraints; specify language requirements in individual task tone modifiers instead. If speech sounds unnatural, select a `voice` optimized for the target language.
  - If a custom `prompt/voice_tool.md` is deployed, update script examples and tone guidelines to the target language, then restart the bot.
  - When using xAI, adjust the `language` field directly.
- **Custom voice tool instructions**: Placing `prompt/voice_tool.md` in the project root overrides the description of `send_voice` upon restart; parameter specifications for `text` and `tone` continue to align with `bot_language`. The file must contain valid UTF-8 and does not hot-reload.
- **Sampling temperature**: Gemini voice synthesis sampling temperature is fixed by the code constant `GEMINI_SPEECH_TEMPERATURE`.

---

## How Do I Call Google Models via Third-Party Gateways (e.g., Cloudflare AI Gateway)?

1. **Configure Endpoint**: Set `base_url` under the target capability to your gateway URL, for example:
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **Add Custom Headers**: Add custom authentication headers under that capability, for example:
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <token>"
   }
   ```
3. **Retain Google API Key**: The `api_key` field remains mandatory; provide your valid Google AI Studio API key. The `headers` option is supported for `provider: "google"`; sensitive credentials are redacted from logs automatically.
4. **Endpoint routing**: Text chat, vision, and image generation automatically route through `generateContent`; voice synthesis routes through the `Interactions API`. Test connectivity using `/send` with a voice payload in private chat.

---

<div align="center">

[← Prev: 10 Performance Benchmark](10-performance.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#11-faq)

</div>
