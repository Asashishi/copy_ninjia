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
  - `config/agent.json` must configure the AI, and the chat must have run `/ai_chat enable` (off by default).
  - Only replying to the bot or mentioning it always triggers a round; other messages lead to random interjections by probability, and there are none during `/quiet`. Once triggered, the AI still decides from its persona whether to speak.
  - While the chat is running `/copy`, the AI and other proactive behaviours pause.
  - Triggers that come too fast are rate limited, and the rate-limit notice has a per-chat cooldown, so it is not sent every time.
- **Private messages to the bot get no response**: private chats accept only the super administrator's `/send`; other slash commands are ignored, and AI chat happens only in groups.
- **A notice appears and then disappears**: validation failures, permission refusals, usage hints and action receipts are deleted 30 seconds after they are sent; see [08 Commands](08-commands.md) for the messages that stay.
- **`@bot` shows no fortune result**: Inline Mode is not enabled.
- **Action commands such as `/咬` get no response**: only 1–2 Chinese characters are accepted, and at most 450 replies are sent globally every 90 seconds; the excess is dropped silently.
- **Another bot's messages are not translated or copied, or only sometimes**: enable Bot-to-Bot Communication Mode (see [BotFather Settings](README.md#botfather-setup)). Translation handles text and captions; pictures, stickers or files without text are not sent, and a message containing a renderable `/command` is skipped entirely.
- **Join verification, ad detection or flood muting does nothing**: all three are off by default. Run `/antiraid enable`, `/ad_detect enable` and `/flood_control enable` respectively, and make sure the bot is an administrator with the rights listed in [Administrator Rights in the Group](README.md#botfather-setup); ad detection also needs the ad detection capability configured in `config/agent.json`.
- **No response at all, and no command menu**: first confirm the process is running (`systemctl status <service>`, `journalctl -u <service>`); error logs are in `logs/<date>.json` under the data root. A misconfigured config or state file makes the process exit during startup, and the log names the file path and field. If the log keeps showing `Error fetching Telegram updates` with error code 409, another instance is polling with the same token or a webhook is set, and the process exits. See [07 Operations and Troubleshooting](07-operations.md#startup-failures).

## How do I change the notice style?

Set `atmosphere` in `config/bot.json` to `mesugaki` (default) or `normal` and restart. A group with a custom `/prompt config` AI persona uses ordinary notices and menus; `/prompt remove` restores the configured Bot style. Notice style does not change the AI prompt.

## Why does the library refuse startup or miss a duplicate?

The dedicated library accepts only regular images named by content SHA-256. Subdirectories, file symlinks, hidden files and leftover temporary files refuse startup. Stop and back up before reviewing entries as described in [Operations](07-operations.md); keep migration manifests outside the library. Collection does not read existing image contents: it checks the target name computed after downloading. Manual images match only with the same content digest and saved extension. Separate random directories explicitly configured for cron allow ordinary file names.

## Why does a scheduled task send again after restart?

`just_once` records live only in memory and are registered again after restart; remove completed tasks from `config/cron.json`. `rand_cron` waits also reset, and missed occurrences are not replayed. Fixed images require arrays of 1–10 items, whereas random-image `path` is a directory string. Cron relative paths use the project root; the dedicated library uses the data root. See [deployment configuration](../../config_example/README/en.md#cronjson) for examples.

---

<div align="center">

[← Prev: 09 Performance Benchmark](09-performance.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-faq)

</div>
