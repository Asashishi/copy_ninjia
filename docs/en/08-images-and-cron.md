# 08 Image Library and Scheduled Tasks

<p align="center">
  <a href="../cn/08-images-and-cron.md">简体中文</a> · <b>English</b> · <a href="../ja/08-images-and-cron.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="07-operations.md">← Prev: 07 Operations</a> · <a href="09-commands.md">Next: 09 Command Reference →</a>
</p>

---

This guide explains how to set up the dedicated image library, collect and draw images via bot commands, and schedule automated delivery for images, photo albums, voice notes, and AI-generated web summaries. For complete JSON field definitions, see the [Deployment Configuration Guide](../../config_example/README/en.md). For command permissions and behavior, see [09 Command Reference](09-commands.md).

## Prepare the Dedicated Library

Specify the image library path in `config/dynamic/assets.json`:

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  }
}
```

- **Path format**: Accepts absolute paths, or relative paths starting with `./` or `../`. Relative paths resolve against the runtime data root (see [07 Operations](07-operations.md) for data-root configuration).
- **Directory permissions**: The system user running the bot must have read, write, and directory traversal permissions. Missing directories are created automatically on startup; existing directories are scanned and validated thoroughly.
- **Naming conventions**: The library **strictly accepts image files only**. Filenames must be exactly the 64-character lowercase hexadecimal SHA-256 hash of the image binary, using `.jpg`, `.jpeg`, `.png`, or `.webp` extensions. If subdirectories, symbolic links, or non-compliant filenames are detected, startup halts with an error.
- **Dynamic updates**: Adding pictures via `/h_image add` automatically hashes and names the files on disk; duplicate files matching existing hashes are skipped. Adding or removing compliant images manually requires no restart—subsequent draws read the directory contents dynamically.

For detailed path rules, see [assets.json](../../config_example/README/en.md#assetsjson).

## Collect and Draw Pictures

Follow these steps to collect and draw images:

1. A superadmin executes `/init enable` in the target group to activate basic bot features.
2. A user with `isCanAddHImage` permission replies to an image message with `/h_image add`. If replying to an album message, all received images belonging to that album are collected in batch.
3. The bot replies with a receipt detailing newly added images, existing duplicates, oversized dimensions, and download failures.
4. Group members send `/h_image` to draw a uniformly random image from the library. Output images are sent with Telegram spoiler masks, requiring users to tap before revealing them.

For supported formats, size and dimension ceilings, command rate limits, and 30-second notice auto-deletion rules, see [Random Pictures](09-commands.md#random-images).

## Schedule Image Delivery

Scheduled tasks are defined as an array in `config/dynamic/cron.json` and support runtime hot-reloading. The following example schedules a daily random picture from the library in the specified time zone:

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

Replace the example group ID with your target group ID, and customize trigger times and captions. Task names (`name`) must be globally unique within the file. Multiple actions declared under a task execute sequentially in order.

### Single Images, Albums, and Random Pictures

Configure the source in `send_image.payload`:

| Delivery Mode | Field Combination |
| :--- | :--- |
| **Fixed single image** | `url: ["https://example.com/a.jpg"]` or `path: ["./posters/a.jpg"]` |
| **Fixed album** | Array with multiple image paths or URLs |
| **Dedicated library random picture** | Set `rand_image: true` and omit `path` |
| **Custom directory random picture** | Set `rand_image: true` and provide a directory string, e.g. `path: "./gallery"` |

- When sending fixed images, `url` and `path` are mutually exclusive. Single images must also be wrapped in an array; multiple images are delivered as a Telegram media group (album).
- In random mode, `path` accepts a single directory path string. Images inside custom directories do not need to follow SHA-256 hash naming rules.
- Set `is_blurred` to `true` to deliver scheduled images behind Telegram spoiler masks (defaults to `false`).

### Times and Delivery Targets

- **Cron expressions**: The `cron` field accepts standard 5-part cron syntax or standard macros like `@daily`. `time_zone` accepts IANA time zone identifiers (e.g. `Asia/Shanghai`); omitting it inherits the time zone from `config/static/bot.json` (defaults to `Asia/Tokyo`).
- **Random intervals**: Setting `rand_cron` enables randomized scheduling (e.g. `"6h-12h"`). The initial trigger fires based on `cron`, while subsequent runs schedule next executions uniformly at random within the interval (rounded up to whole minutes). Setting `just_once: true` runs the task once during the current process lifetime; `rand_cron` and `just_once` cannot be used together.
- **Target groups**: `chat_id` accepts an array of numerical group IDs. Specifying `["all"]` broadcasts to all enabled groups where the bot has send permissions. Specifying `["except", -1001234567890]` broadcasts to all enabled groups while excluding specified IDs.

## Scheduled Voice and Other Actions

Before scheduling voice notes, configure the `agent.tts` text-to-speech settings in `config/dynamic/agent.json`. Add the `send_voice` action to your task definition:

```json
{
  "type": "send_voice",
  "payload": {
    "content": "Good night, see you tomorrow",
    "tone": "Speak softly"
  }
}
```

- **Voice synthesis**: Voice synthesis adopts the speaker configured in `agent.tts.voice`, with `tone` providing optional emotion hints. When broadcasting a voice note across multiple groups, the bot reuses the initial synthesized audio file to avoid burning API quota. See [TTS Configuration](../../config_example/README/en.md#agentjson) for full field specs.
- **Other supported actions**: Scheduled tasks can also send text messages (`send_message`), documents/files (`send_file`), and scrape web pages for AI-generated summaries (`send_web_digest`). For field definitions and limits, see [cron.json](../../config_example/README/en.md#cronjson).

## Verify and Update at Runtime

- **Environment verification**: Verify directory permissions for your image library, ensure target groups have been initialized with `/init enable`, and confirm the bot holds message-sending permissions before testing collection and draw commands.
- **Cron observability**: Review startup logs to confirm correct time zone parsing and calculated next execution times. Monitor target groups during scheduled windows to verify delivery.
- **Hot-reloading**: `assets.json`, `cron.json`, and `agent.json` support dynamic reloading while running. The engine reconciles tasks by name: unmodified tasks maintain their existing schedules without interruption, while modified or newly added tasks recalculate their next run. For startup rules, topic routing, and shutdown drains, see [04 Runtime Invariants](04-invariants.md); for legacy library migrations, see [07 Operations](07-operations.md).

---

<div align="center">

[← Prev: 07 Operations](07-operations.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#08-image-library-and-scheduled-tasks) · [Next: 09 Command Reference →](09-commands.md)

</div>
