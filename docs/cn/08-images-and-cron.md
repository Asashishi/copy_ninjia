# 08 图库与定时任务

<p align="center">
  <b>简体中文</b> · <a href="../en/08-images-and-cron.md">English</a> · <a href="../ja/08-images-and-cron.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="07-operations.md">← 上一页：07 运维与排障</a> · <a href="09-commands.md">下一页：09 命令与行为参考 →</a>
</p>

---

本页说明如何准备专用图库、收录图片，以及配置定时图片、相册和语音。完整字段规格见 [部署配置说明](../../config_example/README/zh.md)，命令权限与行为细节见 [09 命令参考](09-commands.md)。

## 准备专用图库

在 `config/dynamic/assets.json` 中指定图库目录：

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  }
}
```

- 路径可以是绝对路径，或以 `./`、`../` 开头的相对路径。相对路径以运行时数据根为基准，数据根的设置见 [07 运维手册](07-operations.md)。
- 服务账号需要能读取、写入和遍历该目录。启动时可创建缺失的目录，并严格校验已有目录中的文件。
- 专用图库只接受普通图片文件，文件名为图片内容的 64 位小写十六进制 SHA-256，加上 `.jpg`、`.jpeg`、`.png` 或 `.webp` 扩展名。目录内存在子目录、文件符号链接或不合规名称时拒绝启动。
- 通过 `/h_image add` 收图会自动计算内容哈希并命名；已存在相同内容时跳过写入。图库中增删图片后，后续抽图会直接读取当前目录内容。

详细路径规则见 [assets.json](../../config_example/README/zh.md#assetsjson)。

## 收图与抽图

1. 由超级管理员在目标群执行 `/init enable`。
2. 持有 `isCanAddHImage` 权限的身份回复带图消息，发送 `/h_image add`。相册中机器人已接收到的同组图片也会一并收录。
3. 检查汇总回执中的收录、已有、尺寸不合规与失败数量。
4. 在群内发送 `/h_image`，从专用图库随机抽取一张图片。结果固定带 Telegram 剧透遮罩，点击后展开。

支持的图片形式、尺寸限制、命令限流和提示留存规则见 [随机图片命令](09-commands.md#random-images)。

## 定时发送图片

定时任务写在 `config/dynamic/cron.json` 中，顶层为任务数组，支持热重载。以下示例每天按指定时区抽取一张专用图库图片：

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
          "content": "每日随机图片",
          "is_blurred": true
        }
      }
    ]
  }
]
```

将示例群 ID 替换为实际目标群 ID，并按需要设置时间和配图文字。任务名在文件内必须唯一，动作按 `actions` 的声明顺序执行。

### 单图、相册与随机图

| 发送方式 | `send_image.payload` 的来源字段 |
| --- | --- |
| 固定单图 | `url: ["https://example.com/a.jpg"]`，或 `path: ["./posters/a.jpg"]` |
| 固定相册 | `url` 或 `path` 为多个图片来源的数组 |
| 专用图库随机图 | `rand_image: true`，省略 `path` |
| 自定义目录随机图 | `rand_image: true`，并设置目录字符串，如 `path: "./gallery"` |

固定图片的 `url` 与 `path` 互斥，单张也使用数组；多张会作为相册发送。随机模式的 `path` 是目录字符串，自定义目录中的图片不要求 SHA-256 命名。`is_blurred` 控制定时图片的剧透遮罩，省略时关闭。

### 时间与投递目标

- `cron` 使用五段表达式或 `@daily` 等宏；`time_zone` 使用 IANA 时区名，缺省时继承 `config/static/bot.json` 的 `time_zone`（其缺省值为 `Asia/Tokyo`）。
- `rand_cron` 设置每轮触发后的随机执行区间，如 `"6h-12h"`。`just_once: true` 表示进程本次运行期间只执行一次，两者不能同时使用。
- `chat_id` 可指定群 ID 数组；`["all"]` 覆盖所有已启用且具备发送权限的群；`["except", -1001234567890]` 在该范围中排除指定群。

## 定时语音与其他动作

定时语音先在 `config/dynamic/agent.json` 中配置 `agent.tts`。在任务的 `actions` 中加入以下动作：

```json
{
  "type": "send_voice",
  "payload": {
    "content": "晚安，明天见",
    "tone": "轻声"
  }
}
```

音色由 `agent.tts.voice` 指定，`tone` 为本句可选的语气修饰；同一轮向多个群投递时复用首次合成的音频。TTS 字段规格见 [语音配置](../../config_example/README/zh.md#agentjson)。

任务还支持 `send_message`、`send_file` 和 `send_web_digest`。动作字段、能力依赖、长度与数量上限见 [cron.json](../../config_example/README/zh.md#cronjson)。

## 验证与运行中修改

先确认图库路径、服务账号访问权限、目标群初始化与发送权限，再检查收图和抽图结果。设置定时任务后，核对预期时区与触发时间，并观察日志及目标群的实际投递结果。

`assets.json`、`cron.json` 和 `agent.json` 支持热重载；任务按名称对账，未变动的任务保留原有调度。启动校验、热重载、消息话题与停机约束见 [04 权威约束](04-invariants.md)，图库格式迁移见 [07 运维手册](07-operations.md)。

---

<div align="center">

[← 上一页：07 运维与排障](07-operations.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#08-图库与定时任务) · [下一页：09 命令与行为参考 →](09-commands.md)

</div>
