# 08 Image Library and Scheduled Tasks

<p align="center">
  <a href="../cn/08-images-and-cron.md">简体中文</a> · <b>English</b> · <a href="../ja/08-images-and-cron.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="07-operations.md">← Prev: 07 Operations</a> · <a href="09-commands.md">Next: 09 Command Reference →</a>
</p>

---

This page covers preparing the dedicated image library, collecting pictures, and configuring scheduled images, albums, and voice. Complete field specifications live in [Deployment Configuration](../../config_example/README/en.md); command permissions and behavior live in [09 Command Reference](09-commands.md).

## Prepare the Dedicated Library

Set the library directory in `config/dynamic/assets.json`:

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  }
}
```

- Use an absolute path or a relative path starting with `./` or `../`. Relative paths resolve against the runtime data root; see [07 Operations](07-operations.md) for data-root configuration.
- The service account needs permission to read, write, and traverse the directory. Startup can create a missing directory and strictly validates files in an existing one.
- The dedicated library accepts regular image files named with their content's 64-character lowercase hexadecimal SHA-256 and a `.jpg`, `.jpeg`, `.png`, or `.webp` extension. Subdirectories, file symlinks, or invalid names in the directory cause startup to fail.
- Collecting through `/h_image add` calculates the content hash and assigns the filename automatically; identical content already present is not written again. Later draws read the current directory contents after images are added or removed.

See [assets.json](../../config_example/README/en.md#assetsjson) for detailed path rules.

## Collect and Draw Pictures

1. Have a super administrator execute `/init enable` in the target group.
2. An identity with `isCanAddHImage` replies to an image message with `/h_image add`. Other pictures in the same album already received by the bot are collected together.
3. Check the summary counts for added, existing, invalid-dimension, and failed pictures.
4. Send `/h_image` in the group to draw one picture from the dedicated library. Results always use Telegram spoiler masks and expand when tapped.

Supported image inputs, dimension limits, command rate limits, and notice retention are described under [Random Pictures](09-commands.md#random-images).

## Schedule Image Delivery

Configure scheduled tasks in `config/dynamic/cron.json`, a task array that supports hot reload. This example draws one dedicated-library image every day in the specified time zone:

```json
[
  {
    "name": "daily-library-image",
    "chat_id": [-1001234567890],
    "cron": "0 12 * * *",
    "time_zone": "Asia/Tokyo",
    "actions": [
      {
        "type": "send_image",
        "payload": {
          "rand_image": true,
          "content": "Daily random picture",
          "is_blurred": true
        }
      }
    ]
  }
]
```

Replace the example group ID with the real target group ID, then set the time and caption as needed. Task names must be unique within the file; actions execute in their declared order.

### Single Images, Albums, and Random Pictures

| Delivery mode | Source fields in `send_image.payload` |
| --- | --- |
| Fixed single image | `url: ["https://example.com/a.jpg"]`, or `path: ["./posters/a.jpg"]` |
| Fixed album | Multiple image sources in the `url` or `path` array |
| Random dedicated-library image | `rand_image: true`, with `path` omitted |
| Random custom-directory image | `rand_image: true`, plus a directory string such as `path: "./gallery"` |

Fixed-image `url` and `path` are mutually exclusive, and even a single image uses an array; multiple images are sent as an album. Random-mode `path` is a directory string, and custom-directory images do not require SHA-256 filenames. `is_blurred` controls scheduled-image spoiler masks and defaults to off.

### Times and Delivery Targets

- `cron` accepts five-field expressions or macros such as `@daily`; `time_zone` takes an IANA time zone name and inherits `time_zone` from `config/static/bot.json` when omitted (the Bot default is `Asia/Tokyo`).
- `rand_cron` sets a random execution interval after each trigger, such as `"6h-12h"`. `just_once: true` executes once during the current process run; the two cannot be used together.
- `chat_id` accepts an array of group IDs; `["all"]` covers all enabled groups with send permissions; `["except", -1001234567890]` excludes specified groups from that set.

## Scheduled Voice and Other Actions

Configure `agent.tts` in `config/dynamic/agent.json` before scheduling voice. Add this action to a task's `actions`:

```json
{
  "type": "send_voice",
  "payload": {
    "content": "Good night, see you tomorrow",
    "tone": "Speak softly"
  }
}
```

`agent.tts.voice` selects the voice, and optional `tone` modifies this line's delivery. Sending to several groups in the same round reuses the first synthesized audio. See [TTS Configuration](../../config_example/README/en.md#agentjson) for field specifications.

Tasks also support `send_message`, `send_file`, and `send_web_digest`. Action fields, capability dependencies, and length and count limits are specified in [cron.json](../../config_example/README/en.md#cronjson).

## Verify and Update at Runtime

Confirm library paths, service-account access, group initialization, and send permissions, then check collection and drawing results. After configuring a scheduled task, verify its expected time zone and trigger time, and inspect logs and actual delivery in the target group.

`assets.json`, `cron.json`, and `agent.json` support hot reload. Tasks are reconciled by name, and unchanged tasks retain their schedules. See [04 Invariants](04-invariants.md) for startup validation, hot reload, message topics, and shutdown rules, and [07 Operations](07-operations.md) for library format migration.

---

<div align="center">

[← Prev: 07 Operations](07-operations.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#08-image-library-and-scheduled-tasks) · [Next: 09 Command Reference →](09-commands.md)

</div>
