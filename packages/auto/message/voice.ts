import type { Voice } from "grammy/types";
import { recordChatMedia } from "../../aiChat";
import { VOICE_MAX_DOWNLOAD_BYTES, VOICE_MAX_DURATION_SECONDS } from "../../consts/aiChat/voice";
import { resolveSpeaker } from "./facts";
import { buildAiRecordMediaMessage, mediaReplyBackpressurePlaceholder } from "./recordContext";
import { replyToUnresolvableMedia } from "./mediaFallback";
import type { MessageTriggerContext, RandomMediaTrigger } from "../../types/auto";
import { claimRandomMediaTrigger, mediaTriggerHandled } from "./triggerPolicy";
import type { AiSpeakerSnapshot } from "../../types/aiChat/speaker";
import { voiceDurationPlaceholder } from "../../consts/auto";
import { composeMediaText } from "../../libs/text";

/**
 * 语音消息进入转写管线的准入判定：按 update 里携带的 duration 与 file_size 在下载之前判定
 * （上限见 VOICE_MAX_DURATION_SECONDS 与 VOICE_MAX_DOWNLOAD_BYTES）。
 * file_size 是可选字段，缺失时只按时长判，下载侧另有字节闸。
 */
function isTranscribable(voice: Voice): boolean {
  if (voice.duration > VOICE_MAX_DURATION_SECONDS) return false;
  return voice.file_size === undefined || voice.file_size <= VOICE_MAX_DOWNLOAD_BYTES;
}

/**
 * 记录语音占位/转写，并调度直接回复或随机评价。
 *
 * 结构与 animation.ts 一致：能解析就走「占位入缓存 -> 异步转写 -> 原位回填」的媒体
 * 管线，解析不了就退回一行纯文本上下文，直接触发时仍回一句（见 mediaFallback.ts）。
 */
export function handleVoiceMessage(context: MessageTriggerContext): boolean {
  const { message }: MessageTriggerContext = context;
  const voice: Voice | undefined = message.voice;
  if (!voice) return false;

  const speaker: AiSpeakerSnapshot = resolveSpeaker(message);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  if (!isTranscribable(voice)) {
    return replyToUnresolvableMedia({
      context,
      speaker,
      text: composeMediaText(voiceDurationPlaceholder(voice.duration), caption),
    });
  }

  const randomTrigger: RandomMediaTrigger = claimRandomMediaTrigger(context, speaker.id);
  recordChatMedia(buildAiRecordMediaMessage({
    context,
    speaker,
    kind: "voice",
    caption,
    fileId: voice.file_id,
    fileUniqueId: voice.file_unique_id,
    // 语音没有画幅，两个尺寸字段为 0，形状约束见 types/aiChat/protocol.ts。
    width: 0,
    height: 0,
    replyTelegramBackpressured: mediaReplyBackpressurePlaceholder(context, randomTrigger),
    // 直接回复/@ 只开放重媒体工具资格，具体调用由模型判断；语音不作为
    // 生图参考素材（imageGenerationReferenceFor 只认图片和贴纸）。
    stickerFallbackText: undefined,
    voiceMime: voice.mime_type,
  }));
  return mediaTriggerHandled(context, randomTrigger);
}
