# 08 图库与定时任务

<p align="center">
  <b>简体中文</b> · <a href="../en/08-images-and-cron.md">English</a> · <a href="../ja/08-images-and-cron.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="07-operations.md">← 上一页：07 运维与排障</a> · <a href="09-commands.md">下一页：09 命令与行为参考 →</a>
</p>

---

本页介绍如何配置专用图库、通过命令收录与抽取图片，以及如何配置定时发送图片、相册、语音与网页摘要等定时任务。完整 JSON 字段说明请参阅 [部署配置说明](../../config_example/README/zh.md)，相关命令权限与详细行为请参考 [09 命令参考](09-commands.md)。

## 准备专用图库

在 `config/dynamic/assets.json` 中配置图库目录路径：

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  }
}
```

- **路径格式**：支持绝对路径，或以 `./`、`../` 开头的相对路径。相对路径统一以运行时的数据根目录（Data Root）为基准解析，数据根配置详见 [07 运维手册](07-operations.md)。
- **读写权限**：运行服务的系统账号必须对该目录拥有读、写及遍历权限。如果目录不存在，服务启动时会自动创建；若目录已存在，启动时会严格扫描内部所有文件。
- **命名规范**：专用图库目录内**只允许存放纯图片文件**，文件名必须严格是图片二进制内容的 64 位小写十六进制 SHA-256 哈希值，扩展名仅支持 `.jpg`、`.jpeg`、`.png` 或 `.webp`。如果目录内包含子目录、文件软链接或任何不符合哈希命名规则的文件，服务启动时将直接报错退出。
- **动态读写**：通过 `/h_image add` 命令收图时，系统会自动计算图片哈希并安全保存；若图库中已存在相同哈希的图片则跳过重复写入。手动在图库目录中增删合规图片后无需重启服务，后续抽图会直接实时读取当前目录内容。

更详细的路径规则请参阅 [assets.json](../../config_example/README/zh.md#assetsjson)。

## 收图与抽图

按以下步骤收录与抽取图片：

1. 超级管理员在目标群执行 `/init enable` 启用机器人基础功能。
2. 拥有 `isCanAddHImage` 权限的用户，在群内回复某条包含图片的消息，发送 `/h_image add`。如果被回复的消息属于某个图片相册，机器人接收到的同组图片也会被批量收录。
3. 机器人会返回本次收图汇总回执，明确列出成功收录数、已有重复数、尺寸超出限制数以及下载失败数。
4. 群内成员发送 `/h_image` 命令时，机器人会从专用图库中均匀随机抽选一张发送。发出的图片默认带有 Telegram 剧透遮罩（Spoiler），用户点击后才会展开展示。

支持的图片格式、体积与尺寸限制、命令防刷限流与提示消息 30 秒自删规则，请参阅 [随机图片命令](09-commands.md#random-images)。

## 定时发送图片

定时任务集中配置在 `config/dynamic/cron.json` 中，最外层为任务数组，支持运行时动态热重载。下面的示例展示了每天在指定时区定时发送一张专用图库随机图：

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

将示例中的群 ID 替换为真实的群组 ID，并根据需要调整触发时间与附带文本。任务名称 `name` 在整个文件中必须全局唯一；单个任务内的多个动作将按 `actions` 数组的声明顺序依次串行执行。

### 单图、相册与随机图

`send_image.payload` 支持灵活的来源配置：

| 发送形式 | 对应字段组合 |
| :--- | :--- |
| **指定单张图片** | `url: ["https://example.com/a.jpg"]` 或 `path: ["./posters/a.jpg"]` |
| **发送图片相册** | 将 `url` 或 `path` 配置为包含多个图片地址的数组 |
| **专用图库随机图** | 设置 `rand_image: true`，且省略 `path` 字段 |
| **自定义目录随机图** | 设置 `rand_image: true`，并将 `path` 设为自定义目录字符串（如 `path: "./gallery"`） |

- 指定固定图片时，`url` 与 `path` 互斥，即使发送单张图片也需使用数组形式；包含多张时将以 Telegram 相册（Media Group）形式聚合发送。
- 采用随机模式时，`path` 需传入单个目录路径字符串；自定义目录下的图片不强制要求符合 SHA-256 命名规则。
- `is_blurred` 用于控制发送的图片是否附带 Telegram 剧透遮罩，缺省为 false（不遮罩）。

### 时间与投递目标

- **时间表达式**：`cron` 字段支持标准的五段式 cron 表达式或 `@daily` 等常见宏定义；`time_zone` 填入标准的 IANA 时区名称（如 `Asia/Shanghai`），若省略则默认继承 `config/static/bot.json` 中的 `time_zone`（缺省值为 `Asia/Tokyo`）。
- **随机浮动间隔**：配置 `rand_cron` 可开启随机触发模式（如 `"6h-12h"`）。此时首次触发点仍按 `cron` 计算，后续每轮执行完毕后，会在区间范围内均匀随机计算下一次触发时间（向上取整到整分钟）。若配置了 `just_once: true`，表示本次进程运行期间只触发一次；`rand_cron` 与 `just_once` 两者互斥，不能同时设置。
- **目标群组范围**：`chat_id` 支持传入具体的群组 ID 数组；传入 `["all"]` 表示向所有已启用且机器人具备发送权限的群组广播；传入形如 `["except", -1001234567890]` 的格式表示全量广播但排除指定的群组。

## 定时语音与其他动作

配置定时语音前，需先在 `config/dynamic/agent.json` 中配置好 `agent.tts` 语音合成相关参数。在任务的 `actions` 列表中添加 `send_voice` 动作即可：

```json
{
  "type": "send_voice",
  "payload": {
    "content": "晚安，明天见",
    "tone": "轻声"
  }
}
```

- **语音合成**：合成音色统一读取 `agent.tts.voice`，`tone` 为当前台词可选填的语气词描述；当同一个任务同时向多个群组发送语音时，系统会自动复用首次合成好的音频文件，避免重复请求模型接口浪费配额。TTS 详细字段说明请参阅 [语音配置](../../config_example/README/zh.md#agentjson)。
- **其它支持的动作类型**：定时任务还支持发送普通文本（`send_message`）、发送文件文档（`send_file`）以及抓取网页生成 AI 总结（`send_web_digest`）。各项动作的字段结构、模型能力依赖与字数限制请参阅 [cron.json](../../config_example/README/zh.md#cronjson)。

## 验证与运行中修改

- **环境验证**：设置完成后，请先检查图库目录是否存在且权限正确、目标群组已通过 `/init enable` 启用且机器人拥有发言权限，然后进行收图与抽图测试。
- **定时监控**：配置好定时任务后，请核对日志中的时区解析与下一次调度时间，并在预定触发时刻观察目标群组中的实际消息送达情况。
- **动态热重载**：`assets.json`、`cron.json` 与 `agent.json` 均支持运行时动态热重载。系统会按照任务名称对账：未修改的任务保持原有的计时调度不中断，修改或新增的任务会重新计算下次触发时间。启动阶段的严格校验、热重载广播机制、论坛话题路由以及停机平滑等待规则请参阅 [04 运行时权威约束](04-invariants.md)；历史图库文件格式迁移请参考 [07 运维手册](07-operations.md)。

---

<div align="center">

[← 上一页：07 运维与排障](07-operations.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#08-图库与定时任务) · [下一页：09 命令与行为参考 →](09-commands.md)

</div>
