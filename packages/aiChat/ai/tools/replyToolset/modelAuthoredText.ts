import {
  SELF_ACTION_TAG_MARKERS,
  SELF_ACTION_TAG_PATTERNS,
} from "../../../../consts/aiChat/prompts/transcript";
import { DUPLICATE_REPLY_RESULT } from "../../../../consts/aiChat/tools";
import { containsRenderableCommand } from "../../../../libs/renderableCommand";
import type { RoundMessageState } from "../../../../types/aiChat/replies";
import { toolError } from "../../utils/toolResult";
import { isDuplicateOfAcceptedText } from "./messageState";

type ModelAuthoredTextSurface = "message" | "picture" | "song";

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
 * Telegram 渲染成可点击入口；同轮重复文本静默丢弃。返回值是工具错误或零动作
 * 的跳过回执，null 表示允许继续执行。
 */
export function modelAuthoredTextPolicyResult(
  text: string,
  state: RoundMessageState,
  surface: "message" | "picture" | "song"
): string | null {
  if (isDuplicateOfAcceptedText(state, text)) {
    return DUPLICATE_REPLY_RESULT;
  }

  const forgedIndex: number = SELF_ACTION_TAG_PATTERNS.findIndex(
    (pattern: RegExp): boolean => pattern.test(text)
  );
  if (forgedIndex >= 0) {
    const forgedMarker: string = SELF_ACTION_TAG_MARKERS[forgedIndex] ?? "";
    return forgedActionError(surface, forgedMarker);
  }

  if (containsRenderableCommand(text)) {
    return renderableCommandError(surface);
  }
  return null;
}
