# 10 FAQ

<p align="center">
  <a href="../cn/10-faq.md">简体中文</a> · <b>English</b> · <a href="../ja/10-faq.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="09-performance.md">← Prev: 09 Performance Benchmark</a> · <b>Next: none →</b>
</p>

---

When the bot process is running but the chat gets no response, work through the list below. BotFather settings and the group administrator rights each feature needs are in the [project README](README.md#botfather-setup).

## The bot is running, so why doesn't it reply?

- **Nothing in the group gets a response**: the chat has not run `/init enable`. In an uninitialised chat every message and command except the super administrator's `/init` is dropped without any notice.
- **Ordinary messages get no response (no copying, translation, AI replies or Q&A answers)**: the bot cannot see ordinary messages. Privacy is still enabled and the bot is not an administrator, or privacy was changed without removing the bot from the group and adding it back.
- **The AI stays silent**:
  - `config/dynamic/agent.json` must configure the AI, and the chat must have run `/ai_chat enable` (off by default).
  - Only replying to the bot or mentioning it always triggers a round; other messages lead to random interjections by probability, and there are none during `/quiet`. Once triggered, the AI still decides from its persona whether to speak.
  - While the chat is running `/copy`, the AI and other proactive behaviours pause.
  - Triggers that come too fast are rate limited, and the rate-limit notice has a per-chat cooldown, so it is not sent every time.
- **Private messages to the bot get no response**: private chats accept only the super administrator's `/send`; other slash commands are ignored, and AI chat happens only in groups.
- **A notice appears and then disappears**: validation failures, permission refusals, usage hints and action receipts are deleted 30 seconds after they are sent; see [08 Commands](08-commands.md) for the messages that stay.
- **`@bot` shows no fortune result**: Inline Mode is not enabled.
- **Action commands such as `/咬` get no response**: only 1–2 Chinese characters are accepted, and at most 450 replies are sent globally every 90 seconds; the excess is dropped silently.
- **Another bot's messages are not translated or copied, or only sometimes**: enable Bot-to-Bot Communication Mode (see [BotFather Settings](README.md#botfather-setup)). Translation handles text and captions; pictures, stickers or files without text are not sent, and a message containing a renderable `/command` is skipped entirely.
- **Join verification, ad detection or flood muting does nothing**: all three are off by default. Run `/antiraid enable`, `/ad_detect enable` and `/flood_control enable` respectively, and make sure the bot is an administrator with the rights listed in [Administrator Rights in the Group](README.md#botfather-setup); ad detection also needs the ad detection capability configured in `config/dynamic/agent.json`.
- **No response at all, and no command menu**: first confirm the process is running (`systemctl status <service>`, `journalctl -u <service>`); error logs are in `logs/<date>.json` under the data root. A misconfigured config or state file makes the process exit during startup, and the log names the file path and field. If the log keeps showing `Error fetching Telegram updates` with error code 409, another instance is polling with the same token or a webhook is set, and the process exits. See [07 Operations and Troubleshooting](07-operations.md#startup-failures).

## How do I change the notice style?

Set `atmosphere` in `config/static/bot.json` to `mesugaki` (default) or `normal` and restart. A group with a custom `/prompt config` AI persona uses ordinary notices and menus; `/prompt remove` restores the configured Bot style. Notice style does not change the AI prompt.

## Why does the library refuse startup or miss a duplicate?

The dedicated library accepts only regular images named by content SHA-256. Subdirectories, file symlinks, hidden files and leftover temporary files refuse startup. Stop and back up before reviewing entries as described in [Operations](07-operations.md); keep migration manifests outside the library. Collection does not read existing image contents: it checks the target name computed after downloading. Manual images match only with the same content digest and saved extension. Separate random directories explicitly configured for cron allow ordinary file names.

## Why does a scheduled task send again after restart?

`just_once` records live only in memory and are registered again after restart; remove completed tasks from `config/dynamic/cron.json`. `rand_cron` waits also reset, and missed occurrences are not replayed. Fixed images require arrays of 1–10 items, whereas random-image `path` is a directory string. Cron relative paths use the project root; the dedicated library uses the data root. See [deployment configuration](../../config_example/README/en.md#cronjson) for examples.

## Why is a scheduled or `/send` voice message not sent?

Both synthesize on the AI Worker with `agent.tts` from `config/dynamic/agent.json`. If `cron.json` uses `send_voice` without `tts`, startup is refused, and a runtime edit that creates this combination is rejected by hot reload with an error log; a `/send` voice request replies that speech synthesis is not configured. If `tts` is configured and it still fails, check the logs: `speech synthesis failed: worker unavailable` means the AI Worker is not running (`stickers.json`, `mood.json` and `prompt/persona.md` must also be present), `tts unsupported` means the selected provider does not implement speech synthesis (currently only `google` does), and `synthesis failed` / `timed out` usually point to the model side, and `daily limit reached` means the daily voice quota is used up: the three entry points share `agent.tts.daily_limit` (default 100) uses a day, the AI may use at most `daily_limit - daily_reserve_quota` (default 75), and the counting window starts at its first request and restarts after 24 hours, recorded in `ttsUsage` in `memory/global/state.json`; both numbers are set in `agent.tts`, take effect on hot reload, and do not reset the used count. A `/send` voice request must be exactly one code block with `type` set to `tts`; anything else is relayed as a normal message. Fields and limits are in [deployment configuration](../../config_example/README/en.md#cronjson) and [08 commands](08-commands.md).

## How are voice length, temperature, and memory configured?

| Entry point | Text limit | AI memory after a successful send |
| :--- | ---: | :--- |
| AI `send_voice` | 64 | Records the spoken line |
| Private `/send` TTS | 256 | No automatic recording |
| cron `send_voice` | 256 | No automatic recording |

Lengths use UTF-16 code units; `tone` is limited to 64 for every entry point. Validation follows whitespace normalization. Oversized `/send` requests get a format hint. Invalid cron fields reject startup, or reject the entire hot-reload update with an error log. Audio responses also have an 8 MiB cap; text length does not guarantee a duration.

Set the voice with `agent.tts.voice` and the optional base style with `agent.tts.style` in `config/dynamic/agent.json`; both support hot reload. The style must be non-empty after trimming. Omitting or removing it selects [`GEMINI_SPEECH_STYLE`](../../packages/consts/aiChat/gemini.ts). All three entry points share it and append a supplied tone as `<base style>; 细节: <tone>`. New requests use the reloaded configuration; requests already issued retain their snapshot. Sampling temperature remains the source constant `GEMINI_SPEECH_TEMPERATURE` (currently `1.25`), so changing temperature requires a rebuild or a restart of the source service.

## How do I call Google models through a third-party gateway (such as Cloudflare AI Gateway)?

Set that capability's `base_url` to the Google AI Studio endpoint the gateway provides (for Cloudflare, `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`), and put the authentication header the gateway requires in the same capability's `headers`, for example `{ "cf-aig-authorization": "Bearer <token>" }`. `api_key` is still the required Google key; `headers` applies only to capabilities whose `provider` is `google`, and its values are redacted in logs as credentials. Text, vision, and image generation go through generateContent, and speech synthesis goes through the Interactions API; both carry `headers`. Whether the gateway forwards the Interactions API depends on the gateway itself, so after configuring it, send one voice message with `/send` to confirm. Field rules are in [deployment configuration](../../config_example/README/en.md#agentjson).

---

<div align="center">

[← Prev: 09 Performance Benchmark](09-performance.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-faq)

</div>
