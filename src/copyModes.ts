import type { CopyMode } from "./types";
import { translateToJapanese } from "./translate";

/**
 * Reverses a string by Unicode extended grapheme clusters (falls back to code
 * points if Intl.Segmenter isn't available), so emoji / surrogate pairs /
 * combining marks don't get split apart into garbled mojibake.
 * @param text The text to reverse.
 */
function reverseText(text: string): string {
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const clusters: string[] = Array.from(segmenter.segment(text), (s) => s.segment);
    return clusters.reverse().join("");
  } catch {
    return Array.from(text).reverse().join("");
  }
}

const NYA_SUFFIX: string = "喵~";

/**
 * Appends " 喵~" (with a leading half-width space) to text that doesn't
 * already end with 喵~. Caller is responsible for the security gate (see
 * isPlainText in handleIncomingMessage) — this only ever runs on messages
 * that already passed that check, and the result is still sent through
 * sendMessage() with no parse_mode.
 * @param text The text to append the suffix to.
 */
function appendNyaSuffix(text: string): string {
  return text.endsWith(NYA_SUFFIX) ? text : text + " " + NYA_SUFFIX;
}

/**
 * Applies the active copy mode's text transform to a plain-text message.
 * Returns null when there's no mode, or the transform itself failed (e.g. the
 * "ja" translation call errored) — the caller should fall back to forwarding
 * the message as-is via copyMessage() instead of dropping it.
 * @param text The plain-text message to transform.
 * @param mode The active copy mode, if any.
 */
export async function applyCopyModeTransform(text: string, mode: CopyMode | undefined): Promise<string | null> {
  switch (mode) {
    case "reverse":
      return reverseText(text);
    case "nya":
      return appendNyaSuffix(text);
    case "ja":
      return await translateToJapanese(text);
    default:
      return null;
  }
}

/**
 * Describes a copy mode's effect for the /*_copy start message, e.g.
 * "，之后 TA 说的纯文字都会被本天才倒过来念". Returns "" when there's no mode.
 * @param mode The copy mode being started.
 */
export function describeCopyModeEffect(mode: CopyMode | undefined): string {
  switch (mode) {
    case "reverse":
      return "，之后 TA 说的纯文字都会被本天才倒过来念";
    case "nya":
      return "，之后 TA 说的纯文字后面本天才都会给它加上喵~";
    case "ja":
      return "，之后 TA 说的纯文字都会被本天才翻译成日语哦";
    default:
      return "";
  }
}
