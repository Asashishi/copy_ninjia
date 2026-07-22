import { recordChatMedia } from "../../aiChat";
import { pickPhotoFile, resolveSpeaker } from "./facts";
import { buildAiRecordContext } from "./recordContext";
import type { MessageTriggerContext } from "./triggerContext";
import { claimRandomMediaTrigger } from "./triggerPolicy";

/** 记录图片占位/描述，并调度直接回复或随机评价。 */
export function handlePhotoMessage(context: MessageTriggerContext): boolean {
  const { message, directTrigger } = context;
  if (!Array.isArray(message.photo) || message.photo.length === 0) return false;

  const speaker = resolveSpeaker(message);
  const { candidate: commentOnResolveCandidate, claimed: claimedRandomTrigger } = claimRandomMediaTrigger(context, speaker.id);
  const photoFile = pickPhotoFile(message.photo);
  const caption: string = typeof message.caption === "string" ? message.caption : "";
  recordChatMedia({
    kind: "photo",
    ...buildAiRecordContext(context, speaker),
    caption,
    fileId: photoFile.fileId,
    fileUniqueId: photoFile.fileUniqueId,
    width: photoFile.width,
    height: photoFile.height,
    commentOnResolve: claimedRandomTrigger,
    // 直接回复/@ 只开放工具资格，具体是否要编辑图片交给模型判断。
    imageGenerationRequested: directTrigger !== undefined,
    directTrigger,
  });
  return directTrigger !== undefined || commentOnResolveCandidate;
}
