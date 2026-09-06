/**
 * generate_song 校验资格、群冷却、正文与单轮接纳限额，再返回独立生成发送链。
 * 歌曲、封面和 Telegram 发送在同一链内执行；实际模型请求开始后保留群冷却。
 * caption 预留执行侧曲目信息所需长度，真实发送后按同一消息登记歌曲与附言。
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
import type { ReplyToolContext, ReplyToolExecution, RoundMessageState } from "../../../../types/aiChat/replies";
import type { ChatActionControl } from "../../../../types/aiChat/chatAction";
import type { AiSongProvider, AiSongRequest } from "../../../../types/aiChat/provider";
import type {
  GeneratedChatSong,
  SongGenerationAvailability,
  SongGenerationClaim,
} from "../../../../types/aiChat/songGeneration";
import type { TelegramSendResult } from "../../../../types/telegram";
import { cleanReply } from "../../utils/replyText";
import { modelAuthoredTextPolicyResult } from "./modelAuthoredText";

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

/**
 * generate_song 的工具声明。**整段逐字恒定**，不接受任何本轮上下文，理由同
 * buildGenerateImageToolDefinition：带着每秒变化的冷却秒数的文案留在声明里，会把整段
 * 稳定前缀的指纹打散。群冷却因此连提示词都不进，只在调用真的发生时由执行侧判定并把
 * 剩余秒数回给模型（见 createGenerateSongExecutor 的冷却闸）；工具是否挂载仍由
 * createReplyToolset 按 mediaToolsRequested 与供应商能力决定。
 */
export function buildGenerateSongToolDefinition(): AiToolDefinition {
  return {
    name: GENERATE_SONG_TOOL,
    description: GENERATE_SONG_TOOL_INSTRUCTION,
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

/**
 * 冷却未过时回给模型的统一提示。
 *
 * 调用入口的只读判定与 claim 落空（同群并发轮抢在前面）共用这一段：模型的提示词里
 * 没有任何冷却状态，这条工具结果是它唯一一次知道「还要等多久」的机会，两条路径的
 * 文案与秒数口径因此必须同源。
 * @param retryAfterMs 冷却剩余毫秒，由生歌冷却表给出。
 */
function coolingDownError(retryAfterMs: number): string {
  const retryAfterSeconds: number = Math.ceil(retryAfterMs / 1_000);
  return toolError("Song generation is cooling down in this chat", {
    retry_after_seconds: retryAfterSeconds,
    retryable: false,
    required_action:
      `必须使用 send_message 明确告诉群友当前暂时不能写歌，请约 ${retryAfterSeconds} 秒后再试；` +
      "本轮不要再次调用 generate_song。",
  });
}

export function createGenerateSongExecutor(
  ctx: ReplyToolContext,
  state: RoundMessageState
): (argumentsJson: string) => ReplyToolExecution {
  let acceptedSongs: number = 0;
  return (argumentsJson: string): ReplyToolExecution => {
    if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
    if (!ctx.mediaToolsRequested) {
      return toolError(
        "Song generation is not authorized: the triggering message was not a direct reply to or mention of the bot",
        { retryable: false }
      );
    }
    if (acceptedSongs >= MAX_GENERATED_SONGS_PER_REPLY) {
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
    // 冷却整条不进提示词，模型是在不知道本轮还剩多久的情况下调用的：因此在解析参数和
    // 请求模型之前先做一次只读判定，冷却中直接把剩余秒数回给它。真正的原子闸仍是下面
    // 的 claim——只读判定与 claim 之间同群另一轮可能抢先占位，那条路径回同一段文案。
    const availability: SongGenerationAvailability = getSongGenerationAvailability({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!availability.allowed) return coolingDownError(availability.retryAfterMs);
    const parsed: ParsedSongArguments | null = parseArguments(argumentsJson);
    if (!parsed) {
      return toolError(
        "Invalid song arguments: prompt must be a non-empty string, title and performer must be strings, " +
        `and caption must be a string of at most ${MODEL_CAPTION_MAX_CHARS} characters`
      );
    }
    // 只有这一段是模型自己写的话；发出去的 caption 还会在它后面接一段执行侧的
    // 曲目信息，两者在自录与去重上必须分清（见下方 onSongSent 与 acceptedCanonicalTexts）。
    const modelCaption: string | null = parsed.caption;
    if (modelCaption !== null) {
      // 在实际生成和 claim 冷却前完成硬校验，拒绝的 caption 不产生账单或冷却。
      const policyResult: string | null = modelAuthoredTextPolicyResult(modelCaption, state, "song");
      if (policyResult !== null) return policyResult;
    }

    const claim: SongGenerationClaim = claimSongGeneration({
      chatId: ctx.chatId,
      bypassCooldown: ctx.bypassMediaToolCooldown,
    });
    if (!claim.allowed) return coolingDownError(claim.retryAfterMs);
    acceptedSongs++;
    if (modelCaption !== null) state.acceptedCanonicalTexts.add(modelCaption);
    return {
      result: JSON.stringify({ success: true, queued: true, actions_used: 1 }),
      run: async (chatAction: ChatActionControl): Promise<string> => {
        let modelRequestStarted: boolean = false;
        try {
          if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);

          chatAction.set("upload_document");
          let song: GeneratedChatSong | null;
          let cover: Uint8Array | null = null;
          try {
            modelRequestStarted = true;
            song = await generateSong({ prompt: parsed.prompt, signal: ctx.signal });

            if (song && ctx.isActive()) {
              cover = await generateSongCover({
                title: parsed.title,
                performer: parsed.performer,
                songPrompt: parsed.prompt,
                signal: ctx.signal,
              });
            }
          } finally {
            chatAction.set("idle");
            await chatAction.settle();
          }
          if (!ctx.isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
          if (!song) {
            return toolError("Song generation failed or returned no usable audio", { retryable: false });
          }

          const metadata: AudioTrackMetadata | null = probeAudioMetadata(song.bytes, song.mimeType);

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
            return toolError("Failed to send generated song", { retryable: false });
          }

          const memoryPrompt: string = truncateInline(sanitizeInline(parsed.prompt), SONG_GENERATION_MEMORY_PROMPT_MAX_CHARS);

          const songTag: string = songSentTagTemplate(memoryPrompt);
          ctx.onSongSent(
            modelCaption !== null ? `${songTag}${modelCaption}` : songTag,
            sent.messageId,
            sent.repliedToMessageId
          );

          return JSON.stringify({
            success: true,
            message_id: sent.messageId,
            actions_used: 1,
          });
        } finally {
          if (!modelRequestStarted) releaseSongGenerationClaim(ctx.chatId, claim.token);
        }
      },
    };
  };
}
