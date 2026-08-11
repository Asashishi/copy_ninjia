import {
  SELF_ACTION_TAG_MARKERS,
  SELF_ACTION_TAG_PATTERNS,
} from "../../../../consts/aiChat/prompts/transcript";
import { containsRenderableCommand } from "../../../../libs/renderableCommand";
import type { RoundMessageState } from "../../../../types/aiChat/replies";
import { toolError } from "../../utils/toolResult";
import { isDuplicateOfSentMessage } from "./messageState";

type ModelAuthoredTextSurface = "message" | "picture" | "song";

function duplicateError(surface: ModelAuthoredTextSurface): string {
  if (surface === "message") {
    return toolError(
      "An identical message was already sent in this round; do not repeat yourself. Say something new, or use add_reaction / send_sticker instead"
    );
  }
  return toolError(
    `An identical message was already sent in this round; write a different caption, or omit it and send the ${surface} alone`
  );
}

function forgedActionError(surface: ModelAuthoredTextSurface, marker: string): string {
  if (surface === "message") {
    return toolError(
      `Text must not narrate an action: "${marker}" is a transcript marker the execution side writes after the action really happened. ` +
      "Perform the action with its own tool (send_sticker / generate_image), or, if it is unavailable, say so plainly in your own words",
      { retryable: false }
    );
  }
  return toolError(
    `caption must not narrate an action: "${marker}" is a transcript marker the execution side writes after the action really happened. ` +
    `Just say what you want to say about the ${surface} in your own words`,
    { retryable: false }
  );
}

function renderableCommandError(surface: ModelAuthoredTextSurface): string {
  const fieldName: string = surface === "message" ? "Text" : "caption";
  return toolError(
    `${fieldName} must not contain a slash command such as "/example": Telegram renders it as a tappable command in the bot's own message. ` +
    "Write the command name without the leading slash"
  );
}

/**
 * 统一校验模型即将对外发送的正文或 caption。
 *
 * 执行侧转录记号只能由真实动作回执写入；机器人自身消息中的命令不能被
 * Telegram 渲染成可点击入口；同轮文本不能重复发送。返回值已经编码为统一的
 * 工具错误 wire 格式，null 表示允许继续执行。
 */
export function modelAuthoredTextPolicyError(
  text: string,
  state: RoundMessageState,
  surface: "message" | "picture" | "song"
): string | null {
  // 保留 send_message 原有的判定顺序，避免同一输入同时命中多条规则时改变
  // 模型收到的纠错指令；媒体 caption 原有顺序则是先拒绝伪造动作记号。
  if (surface === "message" && isDuplicateOfSentMessage(state, text)) {
    return duplicateError(surface);
  }

  const forgedIndex: number = SELF_ACTION_TAG_PATTERNS.findIndex(
    (pattern: RegExp): boolean => pattern.test(text)
  );
  if (forgedIndex >= 0) {
    const forgedMarker: string = SELF_ACTION_TAG_MARKERS[forgedIndex] ?? "";
    return forgedActionError(surface, forgedMarker);
  }

  if (surface !== "message" && isDuplicateOfSentMessage(state, text)) {
    return duplicateError(surface);
  }
  if (containsRenderableCommand(text)) {
    return renderableCommandError(surface);
  }
  return null;
}
