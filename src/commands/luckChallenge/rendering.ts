import type { InlineQueryResultArticle } from "@grammyjs/types";
import { InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import {
  FORTUNE_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  SAME_QUESTION_LABEL_MAX_LEN,
} from "../../consts/luckChallenge";
import type { LuckDraw } from "../../types/luckChallenge";
import { splitGraphemes } from "../../libs/text";
import { luckCacheKey } from "./key";
import { signLuckResultText } from "./receipt";

function pickDominantProbability(draw: LuckDraw): { label: string; percent: number } {
  const misfortunePercent: number = Math.round((100 - draw.fortunePercent) * 100) / 100;
  return draw.fortunePercent >= misfortunePercent
    ? { label: "行大运", percent: draw.fortunePercent }
    : { label: "倒大霉", percent: misfortunePercent };
}

/** 原地重试、复用同款问题或转发到其他聊天。 */
function buildRetryKeyboard(text: string | undefined): InlineKeyboard {
  const keyboard: InlineKeyboard = new InlineKeyboard().switchInlineCurrent("我也试试", "");
  if (text) {
    const characters: string[] = splitGraphemes(text);
    const sameQuestionLabel: string = characters.length > SAME_QUESTION_LABEL_MAX_LEN
      ? `${characters.slice(0, SAME_QUESTION_LABEL_MAX_LEN).join("")}...`
      : text;
    keyboard.switchInlineCurrent(sameQuestionLabel, text);
  }
  keyboard.row().switchInline("转发", text ?? "");
  return keyboard;
}

export function buildFortuneResult({
  draw,
  userId,
  userLabel,
  text,
}: {
  draw: LuckDraw;
  userId: number;
  userLabel: string;
  text: string | undefined;
}): InlineQueryResultArticle {
  const bodyText: string = text
    ? `你好，${userLabel}\n所求事项: ${text}\n结果: ${draw.tier.label}\n${draw.tier.comment}`
    : `你好，${userLabel}\n汝的今日运势: ${draw.tier.label}\n${draw.tier.comment}`;
  const signed = signLuckResultText(bodyText, luckCacheKey(userId, text));
  return InlineQueryResultBuilder.article(text ? "luck-fortune-text" : "luck-fortune", "未卜先知", {
    description: text ? `所求事项：${text}` : "测测你今天的运势",
    reply_markup: buildRetryKeyboard(text),
    thumbnail_url: FORTUNE_THUMBNAIL_URL,
  }).text(signed.text, {
    entities: [
      { type: "spoiler", offset: signed.receiptOffset, length: signed.receiptLength },
      { type: "text_link", offset: signed.receiptOffset, length: signed.receiptLength, url: signed.receiptUrl },
    ],
    link_preview_options: { is_disabled: true },
  });
}

export function buildProbabilityResult(
  draw: LuckDraw,
  userId: number,
  userLabel: string
): InlineQueryResultArticle {
  const { label, percent } = pickDominantProbability(draw);
  const bodyText: string = `你好，${userLabel}\n汝今天${label}概率是 ${percent.toFixed(2)}%`;
  const signed = signLuckResultText(bodyText, luckCacheKey(userId, undefined));
  return InlineQueryResultBuilder.article("luck-probability", "概率论！", {
    description: "看看你今天行大运/倒大霉的概率",
    reply_markup: buildRetryKeyboard(undefined),
    thumbnail_url: PROBABILITY_THUMBNAIL_URL,
  }).text(signed.text, {
    entities: [
      { type: "spoiler", offset: signed.receiptOffset, length: signed.receiptLength },
      { type: "text_link", offset: signed.receiptOffset, length: signed.receiptLength, url: signed.receiptUrl },
    ],
    link_preview_options: { is_disabled: true },
  });
}

export function buildRateLimitedResult(): InlineQueryResultArticle {
  const windowSeconds: number = RATE_LIMIT_WINDOW_MS / 1000;
  return InlineQueryResultBuilder.article("luck-rate-limited", "太快啦，本天才应付不过来～", {
    description: `本天才每 ${windowSeconds} 秒最多接 ${RATE_LIMIT_MAX_CALLS_PER_WINDOW} 次，杂鱼先歇会儿再来吧`,
  }).text(`笨蛋，问太快啦，本天才每 ${windowSeconds} 秒最多接 ${RATE_LIMIT_MAX_CALLS_PER_WINDOW} 次，杂鱼先歇会儿再来吧♡`);
}
