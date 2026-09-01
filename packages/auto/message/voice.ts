import type { Voice } from "grammy/types";
import { recordChatMedia } from "../../aiChat";
import { VOICE_MAX_DOWNLOAD_BYTES, VOICE_MAX_DURATION_SECONDS } from "../../consts/aiChat/voice";
import { resolveSpeaker } from "./facts";
import { buildAiRecordMediaMessage } from "./recordContext";
import { replyToUnresolvableMedia } from "./mediaFallback";
import type { MessageTriggerContext, RandomMediaTrigger } from "../../types/auto";
import { claimRandomMediaTrigger } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";

/**
 * 语音消息进入转写管线的准入判定。
 *
 * 两条上限在**下载之前**就拦掉，而不是等下载侧的字节闸：那道闸要先把整段音频拉
 * 下来才知道超限，一条一小时的语音会白占一个媒体执行槽和整段下载带宽，最后仍然
 * 只换来一行兜底占位。Telegram 在 update 里就带着 duration 与 file_size，这里直接
 * 用。file_size 是可选字段，缺失时只按时长判——真超限仍有下载侧兜底。
 */
function isTranscribable(voice: Voice): boolean {
  if (voice.duration > VOICE_MAX_DURATION_SECONDS) return false;
  return voice.file_size === undefined || voice.file_size <= VOICE_MAX_DOWNLOAD_BYTES;
}

/**
 * 记录语音占位/转写，并调度直接回复或随机评价。
 *
 * 结构与 animation.ts 一致：能解析就走「占位入缓存 -> 异步转写 -> 原位回填」的媒体
 * 管线，解析不了就退回一行纯文本上下文，并在直接触发时照样回一句——真人在等回应，
 * 「已读不回」比回一句「这条语音太长了没听」更糟。
 */
export function handleVoiceMessage(context: MessageTriggerContext): boolean {
  const { message, directTriggerReason }: MessageTriggerContext = context;
  const voice: Voice | undefined = message.voice;
  if (!voice) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  if (!isTranscribable(voice)) {
    // 时长写进转录行：模型至少知道「对方发了条多长的语音」，而不是只看到一个
    // 没有任何信息量的 [语音]。
    const label: string = `[语音 ${voice.duration} 秒]`;
    return replyToUnresolvableMedia({
      context,
      speaker,
      text: caption ? `${label} ${caption}` : label,
    });
  }

  const randomTrigger: RandomMediaTrigger = claimRandomMediaTrigger(context, speaker.id);
  recordChatMedia(buildAiRecordMediaMessage({
    context,
    speaker,
    media: {
      kind: "voice",
      caption,
      fileId: voice.file_id,
      fileUniqueId: voice.file_unique_id,
      // 语音没有画幅；两个尺寸字段恒为 0，形状约束见 types/aiChat/protocol.ts。
      width: 0,
      height: 0,
      commentOnResolve: randomTrigger === "claimed",
      // 直接回复/@ 只开放重媒体工具资格，具体调不调由模型判断；语音不作为
      // 生图参考素材（imageGenerationReferenceFor 只认图片和贴纸）。
      stickerFallbackText: undefined,
      voiceMime: voice.mime_type,
      voiceDurationSeconds: voice.duration,
    },
  }));
  return directTriggerReason !== undefined || randomTrigger !== "none";
}
