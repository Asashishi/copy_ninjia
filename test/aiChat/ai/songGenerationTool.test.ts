/**
 * generate_song 行动工具：资格闸、15 分钟群冷却与 superAdmin 旁路、参数校验、
 * 发送落地与自录，以及「占了冷却的失败一律不可重试」这条口径。
 *
 * 最贵的一条不变量：**冷却一旦被真实的模型请求占掉就不退**。退回去等于允许同一轮
 * 里再买一次按首计费的生成，还会逼机器人向群里播报一句与事实不符的冷却提示。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReplyToolContext, RoundMessageState } from "../../../packages/types/aiChat/replies";
import type { GeneratedChatSong } from "../../../packages/types/aiChat/songGeneration";
import type { TelegramSendResult } from "../../../packages/types/telegram";

/**
 * 一段能被帧头解析认出来的 MP3：MPEG1 Layer III / 44.1 kHz / 立体声 / 128 kbps，
 * 补齐到 1 600 000 字节 —— 正好 100 秒、1.53 MiB，下面几个断言都按这组数字写。
 * 用真实形状的字节而不是随便四个数：时长与码率是发出去的消息上真实可见的两项，
 * 拿一段解析不出来的载荷做夹具等于把这条路径整个跳过。
 */
const songBytes: Uint8Array = ((): Uint8Array => {
  const bytes: Uint8Array = new Uint8Array(1_600_000);
  bytes.set([0xff, 0xfb, 0x90, 0x00]);
  return bytes;
})();
const generateSong = mock(async (..._args: unknown[]): Promise<GeneratedChatSong | null> => ({
  bytes: songBytes,
  mimeType: "audio/mp3",
}));
const songAiProvider = mock((): unknown => ({ name: "google", generateSong }));
const coverBytes: Buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const generateSongCover = mock(async (..._args: unknown[]): Promise<Buffer | null> => coverBytes);
const sendAudioWithResult = mock(async (..._args: unknown[]): Promise<TelegramSendResult | undefined> => ({
  messageId: 88,
  repliedToMessageId: 42,
}));
const realTelegram = await import("../../../packages/infra/telegram");

const realProvider = await import("../../../packages/aiChat/provider");
// 只替换 songAiProvider 这一个导出：同模块的 imageAiProvider 仍被生图工具静态
// 引用，整份替换会让那条 import 在求值期就断掉。
mock.module("../../../packages/aiChat/provider", () => ({ ...realProvider, songAiProvider }));
mock.module("../../../packages/infra/telegram", () => ({ ...realTelegram, sendAudioWithResult }));
mock.module("../../../packages/aiChat/ai/songCover", () => ({ generateSongCover }));

const { buildGenerateSongToolDefinition, createGenerateSongExecutor } = await import("../../../packages/aiChat/ai/tools/replyToolset/songGeneration");
const { createRoundMessageState } = await import("../../../packages/aiChat/ai/tools/replyToolset/messageState");
const {
  claimSongGeneration,
  getSongGenerationAvailability,
  resetSongGenerationCache,
} = await import("../../../packages/cache/workers/aiChat/songGeneration");
const {
  SONG_CAPTION_METADATA_RESERVED_CHARS,
  SONG_DEFAULT_TITLE,
  SONG_FALLBACK_PERFORMER,
  SONG_GENERATION_COOLDOWN_MS,
  SONG_METADATA_HASHTAG,
  SONG_TITLE_MAX_CHARS,
} = await import("../../../packages/consts/aiChat/songGeneration");
const { TELEGRAM_CAPTION_MAX_CHARS } = await import("../../../packages/consts/telegram");
const { botInfoState } = await import("../../../packages/cache/workers/aiChat/identity");

/** 模型可写的 caption 上限：Telegram 硬顶扣掉执行侧那段曲目信息的预留。 */
const MODEL_CAPTION_MAX_CHARS: number = TELEGRAM_CAPTION_MAX_CHARS - SONG_CAPTION_METADATA_RESERVED_CHARS;

function buildContext(
  chatId: number = -1001,
  bypass: boolean = false,
  requested: boolean = true
): ReplyToolContext {
  return {
    chatId,
    replyToMessageId: 42,
    messageThreadId: undefined,
    mediaToolsRequested: requested,
    bypassMediaToolCooldown: bypass,
    chatAction: {
      current: (): "idle" => "idle",
      set: mock((..._args: unknown[]): void => {}),
      settle: mock(async (): Promise<void> => {}),
    },
    stickerLock: { tryAcquire: () => true, release: () => {} },
    roundHasTypo: false,
    isActive: () => true,
    onMessageSent: mock((..._args: unknown[]): void => {}),
    onStickerSent: mock((..._args: unknown[]): void => {}),
    onImageSent: mock((..._args: unknown[]): void => {}),
    onSongSent: mock((..._args: unknown[]): void => {}),
  };
}

function call(args: Record<string, unknown>): string {
  return JSON.stringify(args);
}

beforeEach(() => {
  resetSongGenerationCache();
  // 演唱者缺省署机器人自己的显示名；有用例会把它清空验证兜底，逐条恢复。
  botInfoState.current = { id: 999_999, username: "test_bot", first_name: "小忍" };
  for (const mocked of [generateSong, songAiProvider, sendAudioWithResult, generateSongCover]) mocked.mockClear();
  generateSongCover.mockImplementation(async (): Promise<Buffer | null> => coverBytes);
  generateSong.mockImplementation(async (): Promise<GeneratedChatSong | null> => ({
    bytes: songBytes,
    mimeType: "audio/mp3",
  }));
  songAiProvider.mockImplementation((): unknown => ({ name: "google", generateSong }));
  sendAudioWithResult.mockImplementation(async (): Promise<TelegramSendResult | undefined> => ({
    messageId: 88,
    repliedToMessageId: 42,
  }));
});

describe("generate_song 工具声明", () => {
  test("没有直接触发资格时明说本轮禁止调用", () => {
    const definition = buildGenerateSongToolDefinition({
      chatId: -1001,
      mediaToolsRequested: false,
      bypassMediaToolCooldown: false,
    });
    expect(definition.name).toBe("generate_song");
    expect(definition.description).toContain("不可生歌");
  });

  test("冷却中时把剩余秒数写进说明，并要求用 send_message 告知群友", () => {
    claimSongGeneration({ chatId: -1001, bypassCooldown: false });
    const definition = buildGenerateSongToolDefinition({
      chatId: -1001,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: false,
    });
    expect(definition.description).toContain("群冷却剩余约");
    expect(definition.description).toContain("send_message");
  });

  test("superAdmin 触发时说明里点出不受群冷却限制", () => {
    claimSongGeneration({ chatId: -1001, bypassCooldown: false });
    const definition = buildGenerateSongToolDefinition({
      chatId: -1001,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: true,
    });
    expect(definition.description).toContain("superAdmin");
    expect(definition.description).not.toContain("群冷却剩余约");
  });

  test("说明里写明 15 分钟的群共享冷却口径", () => {
    const definition = buildGenerateSongToolDefinition({
      chatId: -1001,
      mediaToolsRequested: true,
      bypassMediaToolCooldown: false,
    });
    expect(definition.description).toContain(`每 ${SONG_GENERATION_COOLDOWN_MS / 60_000} 分钟`);
  });
});

describe("generate_song 执行器", () => {
  test("成功路径：发送音频、自录同一条消息、结算一个动作", async () => {
    const ctx: ReplyToolContext = buildContext();
    const state: RoundMessageState = createRoundMessageState();
    const execute = createGenerateSongExecutor(ctx, state);

    const result = JSON.parse(await execute(call({
      prompt: "a warm lo-fi ballad, 80 BPM, Chinese vocals",
      title: "夏天的尾巴",
      caption: "给你写了一首",
    })));

    expect(result).toEqual({ success: true, message_id: 88, actions_used: 1 });
    expect(generateSong).toHaveBeenCalledTimes(1);
    const sendParams = sendAudioWithResult.mock.calls[0]![0] as {
      chatId: number;
      fileName: string;
      caption: string;
      title: string;
      performer: string;
      duration: number;
      thumbnailBytes: Uint8Array;
      replyToMessageId: number;
    };
    expect(sendParams.chatId).toBe(-1001);
    expect(sendParams.fileName).toBe("song.mp3");
    expect(sendParams.title).toBe("夏天的尾巴");
    expect(sendParams.replyToMessageId).toBe(42);
    expect(sendParams.performer).toBe("小忍");
    // 封面是自己补的：Lyria 只回音频与歌词，响应里没有任何图像。
    expect(sendParams.thumbnailBytes).toBe(coverBytes);
    // 播放条上的时长来自帧头解析——Lyria 的响应里没有这一项。
    expect(sendParams.duration).toBe(100);
    // caption = 模型那句话 + 执行侧的曲目信息两行。
    expect(sendParams.caption).toBe(
      "给你写了一首\n\n「夏天的尾巴」- 小忍\n" +
      `${SONG_METADATA_HASHTAG} #mp3 1.53MB 128.00kbps`
    );
    // 同一个 message_id 只自录一次：歌和话是同一条消息。
    expect(ctx.onSongSent).toHaveBeenCalledWith(
      "（生成并发送了一首歌：a warm lo-fi ballad, 80 BPM, Chinese vocals）给你写了一首",
      88,
      42
    );
    // 说明文字计入本轮已说过的话，随后 send_message 复述会被去重拦下。
    expect(state.sentCanonicalTexts.get(88)).toBe("给你写了一首");
  });

  test("容器决定上传扩展名，WAV 不会被当成 mp3 发出去", async () => {
    generateSong.mockImplementationOnce(async (): Promise<GeneratedChatSong | null> => ({
      bytes: songBytes,
      mimeType: "audio/wav",
    }));
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.success).toBe(true);
    expect((sendAudioWithResult.mock.calls[0]![0] as { fileName: string }).fileName).toBe("song.wav");
  });

  test("顶格长度的 caption 加上曲目信息仍在 Telegram 硬顶内——预留是扣在模型那一段上的", async () => {
    const longCaption: string = "话".repeat(MODEL_CAPTION_MAX_CHARS);
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p", caption: longCaption })));
    expect(result.success).toBe(true);
    const caption = (sendAudioWithResult.mock.calls[0]![0] as { caption: string }).caption;
    expect(caption.startsWith(longCaption)).toBe(true);
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX_CHARS);
  });

  test("超过模型那一段上限的 caption 退回参数错误，不靠截断替模型改话", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({
      prompt: "p",
      caption: "话".repeat(MODEL_CAPTION_MAX_CHARS + 1),
    })));
    expect(result.error).toContain("Invalid song arguments");
    expect(generateSong).not.toHaveBeenCalled();
  });

  test("曲名与演唱者超长按截断处理：它们只是展示标签，不值得打回整次调用", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({
      prompt: "p",
      title: "名".repeat(SONG_TITLE_MAX_CHARS + 20),
      performer: "手".repeat(SONG_TITLE_MAX_CHARS + 20),
    })));
    expect(result.success).toBe(true);
    const sendParams = sendAudioWithResult.mock.calls[0]![0] as { title: string; performer: string };
    expect(sendParams.title.length).toBe(SONG_TITLE_MAX_CHARS);
    expect(sendParams.performer.length).toBe(SONG_TITLE_MAX_CHARS);
  });

  test("省略演唱者时署机器人自己的名字；身份还没注入才退回常量", async () => {
    botInfoState.current = null;
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    await execute(call({ prompt: "p" }));
    expect((sendAudioWithResult.mock.calls[0]![0] as { performer: string }).performer)
      .toBe(SONG_FALLBACK_PERFORMER);
  });

  test("省略曲名时用占位，不让播放条退化成显示文件名", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    await execute(call({ prompt: "p" }));
    expect((sendAudioWithResult.mock.calls[0]![0] as { title: string }).title).toBe(SONG_DEFAULT_TITLE);
  });

  test("解析不出容器时不传 duration，也不在 caption 里编一个码率", async () => {
    generateSong.mockImplementationOnce(async (): Promise<GeneratedChatSong | null> => ({
      bytes: new Uint8Array(1024),
      mimeType: "audio/wav",
    }));
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    await execute(call({ prompt: "p" }));
    const sendParams = sendAudioWithResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendParams.duration).toBeUndefined();
    expect(String(sendParams.caption)).not.toContain("kbps");
  });

  test("没有直接触发资格时不请求模型，也不占冷却", async () => {
    const execute = createGenerateSongExecutor(buildContext(-1001, false, false), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.error).toContain("not authorized");
    expect(result.retryable).toBe(false);
    expect(generateSong).not.toHaveBeenCalled();
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false })).toEqual({ allowed: true });
  });

  test("执行时生歌能力不可用会当场认出来，不对 undefined 取调用", async () => {
    songAiProvider.mockImplementationOnce((): unknown => null);
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.error).toContain("unconfigured provider does not support it");
    expect(result.retryable).toBe(false);
  });

  test("参数不合法时在占冷却之前退回，模型改完可以立即重试", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    for (const args of [
      {},
      { prompt: "   " },
      { prompt: "p", title: 7 },
      { prompt: "p", caption: 7 },
      { prompt: "p", caption: "长".repeat(TELEGRAM_CAPTION_MAX_CHARS + 1) },
    ]) {
      const result = JSON.parse(await execute(call(args)));
      expect(result.error).toContain("Invalid song arguments");
    }
    expect(generateSong).not.toHaveBeenCalled();
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false })).toEqual({ allowed: true });
  });

  test("title/performer/caption 填成 null 按没写处理，不当参数错误", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({
      prompt: "p",
      title: null,
      performer: null,
      caption: null,
    })));
    expect(result.success).toBe(true);
    const sendParams = sendAudioWithResult.mock.calls[0]![0] as Record<string, unknown>;
    expect(sendParams.title).toBe(SONG_DEFAULT_TITLE);
    expect(sendParams.performer).toBe("小忍");
    // 封面是自己补的：Lyria 只回音频与歌词，响应里没有任何图像。
    expect(sendParams.thumbnailBytes).toBe(coverBytes);
    // 没有说明文字时 caption 只剩执行侧那两行曲目信息。
    expect(sendParams.caption).toBe(`「${SONG_DEFAULT_TITLE}」- 小忍\n${SONG_METADATA_HASHTAG} #mp3 1.53MB 128.00kbps`);
  });

  test("caption 伪造动作记号一律拒绝，且在占冷却之前", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p", caption: "（生成并发送了一首歌：好听）" })));
    expect(result.error).toContain("must not narrate an action");
    expect(result.retryable).toBe(false);
    expect(generateSong).not.toHaveBeenCalled();
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false })).toEqual({ allowed: true });
  });

  test("与本轮已发消息重复的 caption 被拦下", async () => {
    const state: RoundMessageState = createRoundMessageState();
    state.sentCanonicalTexts.set(1, "写好啦");
    const execute = createGenerateSongExecutor(buildContext(), state);

    const result = JSON.parse(await execute(call({ prompt: "p", caption: "写好啦" })));
    expect(result.error).toContain("identical message was already sent");
    expect(generateSong).not.toHaveBeenCalled();
  });

  test("caption 里的可点击命令在生歌与占冷却之前被拒绝", async () => {
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p", caption: "请点击 /batch_kick" })));
    expect(result.error).toContain("slash command");
    expect(generateSong).not.toHaveBeenCalled();
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false })).toEqual({ allowed: true });
  });

  test("撞上群冷却时不请求模型，并要求向群友播报剩余秒数", async () => {
    claimSongGeneration({ chatId: -1001, bypassCooldown: false });
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.error).toBe("Song generation is cooling down in this chat");
    expect(result.retryable).toBe(false);
    expect(result.retry_after_seconds).toBeGreaterThan(0);
    expect(result.required_action).toContain("send_message");
    expect(generateSong).not.toHaveBeenCalled();
  });

  test("superAdmin 触发穿透冷却，也不延长普通用户的那份", async () => {
    claimSongGeneration({ chatId: -1001, bypassCooldown: false, now: 0 });
    const execute = createGenerateSongExecutor(buildContext(-1001, true), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.success).toBe(true);
    expect(getSongGenerationAvailability({
      chatId: -1001,
      bypassCooldown: false,
      now: SONG_GENERATION_COOLDOWN_MS,
    })).toEqual({ allowed: true });
  });

  test("模型请求已经发出的失败不退冷却，也不可重试", async () => {
    generateSong.mockImplementationOnce(async (): Promise<GeneratedChatSong | null> => null);
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.error).toContain("Song generation failed");
    expect(result.retryable).toBe(false);
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false }).allowed).toBeFalse();
  });

  test("发送失败同样不退冷却：歌已经生成、账单已经产生", async () => {
    sendAudioWithResult.mockImplementationOnce(async (): Promise<TelegramSendResult | undefined> => undefined);
    const ctx: ReplyToolContext = buildContext();
    const execute = createGenerateSongExecutor(ctx, createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.error).toBe("Failed to send generated song");
    expect(result.retryable).toBe(false);
    expect(ctx.onSongSent).not.toHaveBeenCalled();
    expect(getSongGenerationAvailability({ chatId: -1001, bypassCooldown: false }).allowed).toBeFalse();
  });

  test("一次失败之后本轮不再放行第二次尝试（superAdmin 不吃冷却，这是唯一的闸）", async () => {
    generateSong.mockImplementationOnce(async (): Promise<GeneratedChatSong | null> => null);
    const execute = createGenerateSongExecutor(buildContext(-1001, true), createRoundMessageState());

    JSON.parse(await execute(call({ prompt: "p" })));
    const second = JSON.parse(await execute(call({ prompt: "p" })));
    expect(second.error).toContain("disabled for the remainder of this reply");
    expect(generateSong).toHaveBeenCalledTimes(1);
  });

  test("每轮最多成功发送一首", async () => {
    const execute = createGenerateSongExecutor(buildContext(-1001, true), createRoundMessageState());

    expect(JSON.parse(await execute(call({ prompt: "p" }))).success).toBe(true);
    const second = JSON.parse(await execute(call({ prompt: "p2" })));
    expect(second.error).toContain("Song limit reached");
    expect(generateSong).toHaveBeenCalledTimes(1);
  });

  test("封面按曲目信息画，取消信号一路带下去", async () => {
    const ctx: ReplyToolContext = buildContext();
    const execute = createGenerateSongExecutor(ctx, createRoundMessageState());

    await execute(call({ prompt: "a lo-fi ballad", title: "夏天的尾巴", performer: "阿忍" }));

    expect(generateSongCover).toHaveBeenCalledTimes(1);
    expect(generateSongCover.mock.calls[0]![0]).toMatchObject({
      title: "夏天的尾巴",
      performer: "阿忍",
      songPrompt: "a lo-fi ballad",
      signal: ctx.signal,
    });
  });

  test("封面画不出来照样发歌：歌才是这次调用的主体", async () => {
    generateSongCover.mockImplementationOnce(async (): Promise<Buffer | null> => null);
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.success).toBe(true);
    expect((sendAudioWithResult.mock.calls[0]![0] as Record<string, unknown>).thumbnailBytes).toBeUndefined();
  });

  test("生歌失败时不再画封面——没有歌就没有可配的封面", async () => {
    generateSong.mockImplementationOnce(async (): Promise<GeneratedChatSong | null> => null);
    const execute = createGenerateSongExecutor(buildContext(), createRoundMessageState());

    JSON.parse(await execute(call({ prompt: "p" })));
    expect(generateSongCover).not.toHaveBeenCalled();
  });

  test("封面不计动作预算、不进自录：它是消息装帧，不是群友要的图", async () => {
    const ctx: ReplyToolContext = buildContext();
    const execute = createGenerateSongExecutor(ctx, createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p", caption: "写好啦" })));
    expect(result.actions_used).toBe(1);
    expect(ctx.onSongSent).toHaveBeenCalledWith(
      expect.stringContaining("写好啦"),
      88,
      42
    );
    expect(ctx.onImageSent).not.toHaveBeenCalled();
  });

  test("轮次作废时立刻收尾，不发请求", async () => {
    const ctx: ReplyToolContext = { ...buildContext(), isActive: (): boolean => false };
    const execute = createGenerateSongExecutor(ctx, createRoundMessageState());

    const result = JSON.parse(await execute(call({ prompt: "p" })));
    expect(result.error).toBe("Reply invalidated because AI chat was disabled");
    expect(generateSong).not.toHaveBeenCalled();
  });

  test("上传期间挂 upload_document 挡，落地前切回 idle 并等状态收敛", async () => {
    const ctx: ReplyToolContext = buildContext();
    const execute = createGenerateSongExecutor(ctx, createRoundMessageState());

    await execute(call({ prompt: "p" }));
    // 挡位一直挂到封面也画完才落回 idle：中途熄灭会让群里干等一段没有任何
    // 提示的空白。
    expect(ctx.chatAction.set).toHaveBeenNthCalledWith(1, "upload_document");
    expect(ctx.chatAction.set).toHaveBeenNthCalledWith(2, "idle");
    expect(ctx.chatAction.set).toHaveBeenCalledTimes(2);
    expect(generateSongCover).toHaveBeenCalledTimes(1);
    expect(ctx.chatAction.settle).toHaveBeenCalledTimes(1);
  });
});
