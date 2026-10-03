# 11 FAQ

<p align="center">
  <a href="../cn/11-faq.md">简体中文</a> · <b>English</b> · <a href="../ja/11-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="10-performance.md">← Prev: 10 Performance Benchmark</a> · <b>Next: None →</b>
</p>

---

When the bot process is running but there is no response in the chat, troubleshoot step-by-step using the checklist below. BotFather settings and the required group administrator permissions for each feature can be found in the [project README](README.md#botfather-setup).

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
      • <b>Not initialized</b>: Group has not been initialized via <code>/init enable</code> by the super administrator.<br>
      • <b>Privacy mode blocking</b>: Bot is not a group admin, and Group Privacy mode is not disabled in BotFather (<code>/setprivacy → Disable</code>). <i>Note: Remove and re-add bot to refresh state after changing.</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI stays silent</b></nobr></td>
    <td>
      • <b>Not enabled</b>: Must run <code>/ai_chat enable</code> in the group (off by default).<br>
      • <b>Trigger rules</b>: Direct replies to the bot or <code>@bot</code> mentions are guaranteed to trigger; other messages trigger probabilistically (no interjections during <code>/quiet</code>).<br>
      • <b>Mode conflict</b>: If the group is actively running <code>/copy</code>, AI chat is paused.<br>
      • <b>Rate limit</b>: Fast triggers engage a 5-minute sliding-window rate limit.
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>No reply in private chat</b></nobr></td>
    <td>
      • Private chats only respond to the super administrator's <code>/send</code> command; other commands and casual chats are ignored.
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>Notices vanish after a while</b></nobr></td>
    <td>
      • <b>Intended behavior</b>: Command errors, permission denials, usage hints, and receipts are <b>automatically deleted 30s after delivery</b> (exceptions in <a href="09-commands.md">09 Commands</a>).
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@bot</code> shows no fortunes</b></nobr></td>
    <td>
      • Inline Mode is not enabled in @BotFather (<code>/setinline</code>).
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>Action commands get no reply</b></nobr></td>
    <td>
      • Only recognizes 1–2 Chinese characters as action words; global sliding-window limits responses to 450 per 90 seconds.
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>Cannot translate other bots</b></nobr></td>
    <td>
      • Must enable <b>Bot-to-Bot Communication Mode</b> for this bot in @BotFather.<br>
      • Incoming messages from other bots have a global ingress limit: the 16th message from a continuously active bot is ignored, the count resets after 90 minutes of silence, and new bot IDs are ignored when 512 are tracked (see <a href="04-invariants.md">dispatch invariants</a>).<br>
      • Translation only handles text/captions; does not forward pure media, numeric punctuation, or target-language text.
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>Anti-Raid / Ads / Flood inactive</b></nobr></td>
    <td>
      • <b>Disabled by default</b>: Explicitly enable via <code>/antiraid enable</code>, <code>/ad_detect enable</code>, <code>/flood_control enable</code>.<br>
      • <b>Missing admin rights</b>: Bot must be promoted to group admin with delete and restrict rights.<br>
      • <b>Model missing</b>: Ad detection requires <code>agent.ad_detect</code> in <code>config/dynamic/agent.json</code>.
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>Process dead, no menu</b></nobr></td>
    <td>
      • <b>Service status</b>: Check <code>systemctl status &lt;service&gt;</code>.<br>
      • <b>Fatal config error</b>: Check <code>logs/&lt;date&gt;.json</code> under the data root; invalid configs fail fast and exit at boot.<br>
      • <b>Token conflict (409)</b>: Code 409 means another instance is polling or a webhook is configured (see <a href="07-operations.md#startup-failures">07 Operations</a>).
    </td>
  </tr>
</tbody>
</table>

---

## How Do I Change the Notice Atmosphere?

- In `config/static/bot.json`, explicitly set `atmosphere` to `mesugaki` (teasing) or `normal` (plain). This takes priority over the persona-based default and applies after restart.
- When `atmosphere` is omitted, notices and menus across all groups use plain style if the project-root `prompt/persona.md` exists, otherwise teasing style.
- Notice atmosphere only alters system outward notification style; it does not change the AI chat System Prompt persona.

---

## Why Does the Image Library Refuse Startup or Miss Duplicates?

- **File Specifications**: The dedicated image library directory (`assets.json`'s `random_h_image_dir`) only allows regular images named by **content SHA-256** (64-character lowercase hexadecimal).
- **Startup Interception**: If subdirectories, symbolic links, hidden files, or residual temporary files exist in the directory, startup inspection will refuse startup. Stop the service and back up, then clean up residuals per [07 Operations](07-operations.md).
- **Deduplication Logic**: Deduplication occurs after downloading when computing hashes; if the library already contains an identical hash, it is skipped and reported as already collected. Manually placed images must maintain consistent content digests and extensions to hit deduplication.

---

## Why Does a Scheduled Task Send Again After Restart?

- `just_once` execution records are held only in memory and re-register after restart; completed tasks should be removed from `config/dynamic/cron.json`.
- Randomized moments in `rand_cron` are redrawn within intervals upon restart; missed executions during downtime are not replayed.
- Fixed images require a 1–10 item array; relative paths in `cron.json` resolve against the runtime data root (no `./` prefix required).

---

## Why Is Scheduled Voice or `/send` Voice Not Sending?

Scheduled `send_voice` tasks and superadmin private `/send` voice delegation both depend on `agent.tts` in `config/dynamic/agent.json`, synthesized asynchronously on the AI Worker:

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
    <td>AI Worker is not ready (verify that <code>stickers.json</code>, <code>mood.json</code>, and <code>agent.json</code> are configured).</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>Selected provider does not implement speech synthesis (only <code>google</code> and <code>openai</code> natively supported).</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>Model call failed or timed out; OpenAI-compatible endpoints must support <code>audio/speech</code> and <code>opus</code> format.</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>Returned audio stream encoding does not match requested protocol.</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>Daily voice quota is exhausted; resets after the 24-hour rolling window.</td>
  </tr>
</tbody>
</table>

### Quota and Allocation Mechanics

- `/send` and `cron.json` share an independent **`daily_reserve_quota`** (default 25), recorded in `reserveCount`.
- AI chat independently uses the remaining **`daily_limit - daily_reserve_quota`** (default 75), recorded in `agentCount`.
- Both quotas are mutually isolated and do not preempt each other. Quotas reset when the 24-hour rolling window expires.

### Private Chat `/send` Format Requirements

Voice requests in private chat must have the **entire message as a code block**, with `type` declared as `tts`:
```json
{ "type": "tts", "tone": "tsundere", "text": "line to synthesize" }
```
The code block is parsed as JSONC, so comments and trailing commas are accepted. If parsing fails or `type` is not `"tts"`, the original message is copied to the target group. If `type` is `"tts"` but its fields are invalid, the administrator receives a format notice in private and the message is not relayed.

---

## How Are Voice Length, Temperature, and Memory Configured?

| Entry Point | Line Limit (UTF-16) | AI Memory After Successful Send |
| :--- | :---: | :--- |
| **AI `send_voice`** | 64 | Records spoken line |
| **Private `/send` TTS** | 256 | Not automatically recorded |
| **cron `send_voice`** | 256 | Not automatically recorded |

- **Tone and Length**: `tone` is capped at 64 UTF-16 code units across all entry points; validated after whitespace normalization. Audio response volume is capped at 8 MiB.
- **Voice and Style**:
  - Voice is configured via `agent.tts.voice`.
  - Base style is configured via optional `agent.tts.style` (supports hot reload), defaulting to built-in `TTS_DEFAULT_STYLE`.
  - Automatically joined upon sending as `<base style>; 细节: <tone>`.
  - `speech_protocol: "xai"` does not support `style`, nor does it send tone.
- **Sampling Temperature**: Gemini speech sampling temperature is fixed by source constant `GEMINI_SPEECH_TEMPERATURE` (currently `1`).

---

## How Do I Call Google Models via Third-Party Gateways (e.g., Cloudflare AI Gateway)?

1. **Configure Endpoint**: Set the capability's `base_url` to the gateway address, e.g.:
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **Attach Auth Headers**: Configure `headers` under the same capability, e.g.:
   ```json
   "headers": {
     "cf-aig-authorization": "Bearer <token>"
   }
   ```
3. **Retain API Key**: `api_key` remains the required Google API key. `headers` is only effective for `provider: "google"`; sensitive values are automatically masked in logs.
4. **Route Coverage**: Text, vision, and image generation use the generateContent route; speech synthesis uses the Interactions API. After configuration, test gateway connectivity via `/send` with a voice message.

---

<div align="center">

[← Prev: 10 Performance Benchmark](10-performance.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#11-faq)

</div>
