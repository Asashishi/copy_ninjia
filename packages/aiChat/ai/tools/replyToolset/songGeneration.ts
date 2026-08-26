/**
 * generate_song 行动工具：调生歌模型写一首完整歌曲并发到当前群。
 *
 * 与 generate_image 的三处刻意差别：
 * 1. **不是每轮都存在。** 只有 agent.song 已配置且实现了 `generateSong` 时才会被
 *    组装进工具集（见同目录 orchestrator.ts）。执行侧仍再查一次，兜住直接调用与
 *    未来扩展时能力缺席的情况。
 * 2. **caption 必须自己放得下。** 生图那侧为超长图注补发了一条独立文本消息；这里
 *    直接在 schema 上把 caption 卡到「Telegram 上限减去元信息预留」，超了就退回
 *    参数错误让模型重写。理由是代价不对称：那条补发路径只在图已经生成之后才可能
 *    触发，而这里「图」是一首要等几分钟、按首计费的歌，多一条可能失败的补发分支
 *    换不来什么，反而让最贵的那次调用多一种收尾形态。预留必须扣在**模型可写的
 *    那一段**上：Bot API 对超长 caption 是整条拒绝而不是截断，拼完才发现超限时
 *    丢的是一首已经计过费的歌。
 *
 * 发出去的消息按常见音乐 bot 的样式排：播放条上是曲名/演唱者/时长/体积（时长由
 * utils/audioMetadata.ts 从 MP3 帧头解出来交给 sendAudio，体积 Telegram 自己算），
 * caption 末尾补一行容器、体积与码率的元信息（见 utils/songCaption.ts）。
 * 3. **失败一次就停。** SONG_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY 是 1：
 *    superAdmin 不吃冷却，若不设这道闸，一轮里能把同一个失败重放到工具轮数上限。
 *
 * 冷却核销的口径与生图完全一致，别改成「失败就退款」：一旦模型请求真的发出去，
 * 那次生成就已经在服务端出账；把冷却退回去等于允许同一轮里立刻再买一次。
 */

import type { AiToolDefinition } from "../../../../types/aiChat/provider";
import { parseToolArguments } from "../../utils/toolArgs";
import {
  claimSongGeneration,
  getSongGenerationAvailability,
  releaseSongGenerationClaim,
} from "../../../../cache/workers/aiChat/songGeneration";
import {
  MAX_GENERATED_SONGS_PER_REPLY,
  SONG_CAPTION_METADATA_RESERVED_CHARS,
  SONG_DEFAULT_TITLE,
  SONG_FALLBACK_PERFORMER,
  SONG_FILE_BASENAME,
  SONG_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY,
  SONG_GENERATION_MEMORY_PROMPT_MAX_CHARS,
  SONG_GENERATION_PROMPT_MAX_CHARS,
  SONG_PERFORMER_MAX_CHARS,
  SONG_TITLE_MAX_CHARS,
} from "../../../../consts/aiChat/songGeneration";
import { GENERATE_SONG_TOOL_INSTRUCTION } from "../../../../consts/aiChat/prompts/tools";
import { songSentTagTemplate } from "../../../../consts/aiChat/prompts/transcript";
import { TELEGRAM_CAPTION_MAX_CHARS } from "../../../../consts/telegram";
import { GENERATE_SONG_TOOL, REPLY_INVALIDATED_TOOL_ERROR } from "../../../../consts/tools";
import { toolError } from "../../utils/toolResult";
import { sendAudioWithResult } from "../../../../infra/telegram";
import { sanitizeInline, truncateInline } from "../../../../libs/text";
import { songAiProvider } from "../../../provider";
import { botInfoState } from "../../../../cache/workers/aiChat/identity";
import { probeAudioMetadata, type AudioTrackMetadata } from "../../utils/audioMetadata";
import { generateSongCover } from "../../songCover";
import { buildSongCaption } from "../../utils/songCaption";
import { songFileExtension } from "../../utils/songPayload";
import type { ReplyToolContext, RoundMessageState } from "../../../../types/aiChat/replies";
import type { AiSongProvider, AiSongRequest } from "../../../../types/aiChat/provider";
import type { GeneratedChatSong, SongGenerationAvailability, SongGenerationClaim } from "../../../../types/aiChat/songGeneration";
import type { TelegramSendResult } from "../../../../types/telegram";
import { cleanReply } from "../../utils/replyText";
import { modelAuthoredTextPolicyError } from "./modelAuthoredText";

/** 本轮生歌工具需要的上下文子集；与 buildGenerateImageToolDefinition 同一写法。 */
export type SongToolContext = Pick<
  ReplyToolContext,
  "chatId" | "mediaToolsRequested" | "bypassMediaToolCooldown"
>;

/**
 * 模型可写的 caption 上限：Telegram 的硬顶扣掉执行侧那段元信息的预留。
 *
 * 这个减法必须在**schema 上**就生效，而不是等拼完再截断——超长 caption 是整条
 * 拒绝，而那时歌已经生成、账已经出过。
 */
const MODEL_CAPTION_MAX_CHARS: number = TELEGRAM_CAPTION_MAX_CHARS - SONG_CAPTION_METADATA_RESERVED_CHARS;

/**
 * 演唱者缺省取机器人自己的账号显示名：这首歌确实是它「唱」的，署自己的名比署一个
 * 固定词准确。Worker 重建后 init 尚未到达的极短窗口里退回常量。
 */
function defaultPerformer(): string {
  const name: string = botInfoState.current?.first_name ?? "";
  return name ? truncateInline(sanitizeInline(name), SONG_PERFORMER_MAX_CHARS) : SONG_FALLBACK_PERFORMER;
}

export function buildGenerateSongToolDefinition(ctx: SongToolContext): AiToolDefinition {
  const availability: SongGenerationAvailability = getSongGenerationAvailability({
    chatId: ctx.chatId,
    bypassCooldown: ctx.bypassMediaToolCooldown,
  });
  const availabilityInstruction: string = !ctx.mediaToolsRequested
    ? "当前状态：不可生歌；当前消息不是直接回复或 @ 你的触发，本轮禁止调用。"
    : ctx.bypassMediaToolCooldown
    ? "当前状态：可以生歌；由你判断当前消息是否明确要求写歌或作曲。本轮由 superAdmin 触发，不受群冷却限制。"
    : availability.allowed
    ? "当前状态：可以生歌；由你判断当前消息是否明确要求写歌或作曲，没有明确意图就不要调用。"
    : `当前状态：暂不可生歌，群冷却剩余约 ${Math.ceil(availability.retryAfterMs / 1_000)} 秒；本轮不要调用，` +
      "并且必须用 send_message 明确告诉群友当前暂时不能写歌，请稍后再试。";
  return {
    name: GENERATE_SONG_TOOL,
    description: `${GENERATE_SONG_TOOL_INSTRUCTION}\n${availabilityInstruction}`,
    parametersJsonSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          maxLength: SONG_GENERATION_PROMPT_MAX_CHARS,
          description:
            "交给音乐模型的完整独立创作提示词，用英文写：曲风、情绪、乐器编制、BPM、调式、结构（verse/chorus/bridge）。" +
            "要有人声就写明语言（如 Chinese vocals）并把歌词原文写进来。",
        },
        title: {
          type: "string",
          maxLength: SONG_TITLE_MAX_CHARS,
          description:
            `这首歌的名字，会显示在 Telegram 播放条上、也会写进消息末尾的曲目信息；不超过 ${SONG_TITLE_MAX_CHARS} 字。` +
            `省略则用「${SONG_DEFAULT_TITLE}」。`,
        },
        performer: {
          type: "string",
          maxLength: SONG_PERFORMER_MAX_CHARS,
          description:
            "演唱者/艺名，显示在播放条上曲名旁边。想给这首歌安一个虚构的艺名就写在这里；" +
            "省略则署你自己的名字（这首歌本来就是你唱的）。",
        },
        caption: {
          type: "string",
          maxLength: MODEL_CAPTION_MAX_CHARS,
          description:
            "随歌一起发出的说明：连歌带话是同一条消息，不用再单独调用 send_message 说一遍。" +
            "写你想对群友说的原话，不要写创作说明或对工具的解释——那些属于 prompt；" +
            "也不用写曲名、格式、大小这些，执行侧会在消息末尾自动附上一段曲目信息。" +
            `没什么要说的就省略，只发歌。必须控制在 ${MODEL_CAPTION_MAX_CHARS} 字以内，超出会被直接判为参数错误。`,
        },
      },
      required: ["prompt"],
    },
  };
}

/**
 * 解析后的生歌入参。
 *
 * caption 已走过 send_message 同一套正文清洗，缺省为 null；title/performer 已按
 * 各自上限收好并填过默认值，因此下游只当普通字符串用，不再判空。
 */
interface ParsedSongArguments {
  prompt: string;
  title: string;
  performer: string;
  caption: string | null;
}

/** 曲名/演唱者共用的一段清洗：压成单行、按上限截断，空串按「没写」处理。 */
function normalizeTag(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const inline: string = sanitizeInline(value);
  return inline ? truncateInline(inline, maxChars) : null;
}

function parseArguments(argumentsJson: string): ParsedSongArguments | null {
  const parsed: Record<string, unknown> | null = parseToolArguments(argumentsJson);
  if (parsed === null || typeof parsed.prompt !== "string") return null;
  const prompt: string = parsed.prompt.trim();
  if (!prompt || prompt.length > SONG_GENERATION_PROMPT_MAX_CHARS) return null;
  // title/performer/caption 都是「省略就用默认」的纯可选字段，因此 null 与
  // undefined 一样按没写处理：模型把可选参数填成 null 很常见，为此整条调用报参数
  // 错误会让它白跑一轮（口径同 replyToolset/imageGeneration.ts 的 caption）。
  for (const key of ["title", "performer", "caption"] as const) {
    const value: unknown = parsed[key];
    if (value !== undefined && value !== null && typeof value !== "string") return null;
  }
  // 曲名与演唱者超长按截断处理而不是报错：它们只是展示用的标签，为一个多写了
  // 几个字的艺名把整次调用打回去，代价与收益完全不成比例。caption 不同——那是
  // 群友要读的正文，截断等于替模型改话，因此仍然退回参数错误让它自己重写。
  const caption: string | null = typeof parsed.caption === "string" ? cleanReply(parsed.caption) : null;
  if (caption !== null && caption.length > MODEL_CAPTION_MAX_CHARS) return null;
  return {
    prompt,
    title: normalizeTag(parsed.title, SONG_TITLE_MAX_CHARS) ?? SONG_DEFAULT_TITLE,
    performer: normalizeTag(parsed.performer, SONG_PERFORMER_MAX_CHARS) ?? defaultPerformer(),
    caption,
  };
}

export function createGenerateSongExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState
): (argumentsJson: string) => Promise<string> {
  let consecutiveFailures: number = 0;
  let generatedSongs: number = 0;
  return async (argumentsJson: string): Promise<string> => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (!ctx.mediaToolsRequested) {
      return toolError(
        "Song generation is not authorized: the triggering message was not a direct reply to or mention of the bot",
        { retryable: false }
      );
    }
    if (generatedSongs >= MAX_GENERATED_SONGS_PER_REPLY) {
      return toolError(
        `Song limit reached: at most ${MAX_GENERATED_SONGS_PER_REPLY} generated song per reply`,
        { retryable: false }
      );
    }
    // 工具通常只在能力存在时组装；这里仍防守直接调用与未来扩展，避免对 undefined
    // 取调用。
    const provider: AiSongProvider | null = songAiProvider();
    const generateSong: ((request: AiSongRequest) => Promise<GeneratedChatSong | null>) | undefined =
      provider?.generateSong;
    if (generateSong === undefined) {
      return toolError(
        `Song generation is unavailable: the ${provider?.name ?? "unconfigured"} provider does not support it`,
        { retryable: false }
      );
    }
    const parsed: ParsedSongArguments | null = parseArguments(argumentsJson);
    if (!parsed) {
      return toolError(
        "Invalid song arguments: prompt must be a non-empty string, title and performer must be strings, " +
        `and caption must be a string of at most ${MODEL_CAPTION_MAX_CHARS} characters`
      );
    }
    // 只有这一段是模型自己写的话；发出去的 caption 还会在它后面接一段执行侧的
    // 曲目信息，两者在自录与去重上必须分清（见下方 onSongSent 与 sentCanonicalTexts）。
    const modelCaption: string | null = parsed.caption;
    if (modelCaption !== null) {
      // 在实际生成和 claim 冷却前完成硬校验，拒绝的 caption 不产生账单或冷却。
      const policyError: string | null = modelAuthoredTextPolicyError(modelCaption, state, "song");
      if (policyError !== null) return policyError;
    }

    if (consecutiveFailures >= SONG_GENERATION_MAX_CONSECUTIVE_FAILURES_PER_REPLY) {
      return toolError(
        "Song generation is disabled for the remainder of this reply after a failure; respond without retrying",
        { retryable: false }
      );
    }

    const claim: SongGenerationClaim = claimSongGeneration({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!claim.allowed) {
      const retryAfterSeconds: number = Math.ceil(claim.retryAfterMs / 1_000);
      return toolError("Song generation is cooling down in this chat", {
        retry_after_seconds: retryAfterSeconds,
        retryable: false,
        required_action:
          `必须使用 send_message 明确告诉群友当前暂时不能写歌，请约 ${retryAfterSeconds} 秒后再试；` +
          "本轮不要再次调用 generate_song。",
      });
    }

    let modelRequestStarted: boolean = false;
    try {
      // 用 upload_document 而不是 upload_voice：Bot API 把 upload_voice 明确留给
      // voice note，一般文件（sendAudio 发的音乐文件正属此列）用 upload_document。
      // 挂错挡位会让群里以为有人发了条语音消息。
      ctx.chatAction.set("upload_document");
      let song: GeneratedChatSong | null;
      let cover: Uint8Array | null = null;
      try {
        modelRequestStarted = true;
        song = await generateSong({ prompt: parsed.prompt, signal: ctx.signal });
        // 封面是消息装帧，不是群友要的图：不占生图冷却、不计动作预算、不进自录，
        // 画不出来就静默不挂（见 aiChat/ai/songCover.ts）。它排在生歌之后、发送
        // 之前——歌都没出来就没有可配的封面，而歌一旦出来，无论封面成不成这条
        // 消息都必须发出去。也留在这个 try 内：它同样是一次分钟量级以下的模型
        // 往返，状态挡得一直挂着，否则群里会看到「正在发送文件」提前熄灭、又干等
        // 一段没有任何提示的空白。
        if (song && ctx.isActive()) {
          cover = await generateSongCover({
            title: parsed.title,
            performer: parsed.performer,
            songPrompt: parsed.prompt,
            signal: ctx.signal,
          });
        }
      } finally {
        // 与生图落地前的处理一致：先阻止新的 upload_document tick，再等已经发出的
        // 状态请求收敛，避免它晚于音频到达而重新挂出「正在发送文件」。
        ctx.chatAction.set("idle");
        await ctx.chatAction.settle();
      }
      if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      if (!song) {
        consecutiveFailures++;
        // 冷却已经被这次真实的模型请求占掉了；本轮再调一次必然撞上自家的冷却闸，
        // 而那条分支的 required_action 会逼机器人向群里播报「请约 N 秒后再试」——
        // 群里根本没收到过任何歌，那句话是假的。占了冷却的失败一律不可重试
        // （口径同 replyToolset/imageGeneration.ts）。
        return toolError("Song generation failed or returned no usable audio", { retryable: false });
      }

      // 时长要自己解出来：Lyria 的响应里没有，而不传 duration 的话播放条上就只有
      // 一个不动的进度条（见 utils/audioMetadata.ts）。解析不出就不传，Telegram
      // 自己去探，探不到也只是少显示一项。
      const metadata: AudioTrackMetadata | null = probeAudioMetadata(song.bytes, song.mimeType);
      // caption = 模型自己那句话 + 执行侧的曲目信息两行。长度已在参数校验时按
      // 「上限减去元信息预留」卡死，拼完不会顶爆 Telegram 的 caption 硬顶。
      const caption: string = buildSongCaption({
        modelCaption,
        title: parsed.title,
        performer: parsed.performer,
        byteLength: song.bytes.byteLength,
        mimeType: song.mimeType,
        metadata,
      });
      const sent: TelegramSendResult | undefined = await sendAudioWithResult({
        chatId: ctx.chatId,
        bytes: song.bytes,
        fileName: `${SONG_FILE_BASENAME}.${songFileExtension(song.mimeType)}`,
        replyToMessageId: ctx.replyToMessageId,
        signal: ctx.signal,
        messageThreadId: ctx.messageThreadId,
        caption,
        title: parsed.title,
        performer: parsed.performer,
        ...(metadata !== null ? { duration: metadata.durationSeconds } : {}),
        ...(cover !== null ? { thumbnailBytes: cover } : {}),
      });
      if (sent === undefined) {
        consecutiveFailures++;
        // 理由同上：歌已经生成、冷却已经占用，重试只能换来一句与事实不符的
        // 冷却播报。
        return toolError("Failed to send generated song", { retryable: false });
      }

      consecutiveFailures = 0;
      generatedSongs++;
      const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), SONG_GENERATION_MEMORY_PROMPT_MAX_CHARS);
      // 带说明时歌和话是同一条消息（同一个 message_id），自录也必须是同一条：
      // 拆成两次自录会让一个 message_id 在转录里出现两次，回复链回溯到它时
      // 无从判断指的是哪一条（口径同生图）。
      //
      // 自录与去重都只认**模型自己那句话**，不含执行侧附上的曲目信息：那两行是
      // 消息的装帧，不是机器人说的话。把它记进记忆会让下一轮的模型以为自己上次
      // 报过一串文件参数，进而学着复述。
      const songTag: string = songSentTagTemplate(memoryPrompt);
      ctx.onSongSent(
        modelCaption !== null ? `${songTag}${modelCaption}` : songTag,
        sent.messageId,
        sent.repliedToMessageId
      );
      // 说明文字同样计入本轮已说过的话，模型随后再用 send_message 复述会被去重拦下。
      if (modelCaption !== null) state.sentCanonicalTexts.set(sent.messageId, modelCaption);

      return JSON.stringify({
        success: true,
        message_id: sent.messageId,
        actions_used: 1,
      });
    } finally {
      if (!modelRequestStarted) releaseSongGenerationClaim(ctx.chatId, claim.token);
    }
  };
}
