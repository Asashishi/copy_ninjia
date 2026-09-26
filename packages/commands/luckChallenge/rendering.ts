import { ATMOSPHERE_TEXTS } from "../../consts/atmosphere";
import { BOT_ATMOSPHERE } from "../../config/bot";
import type { AtmosphereTexts } from "../../types/atmosphere";
import type { InlineQueryResultArticle } from "grammy/types";
import { InlineKeyboard, InlineQueryResultBuilder } from "grammy";
import {
  RATE_LIMIT_MAX_CALLS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  SAME_QUESTION_LABEL_MAX_LEN,
} from "../../consts/luckChallenge";
import { getAssetConfig } from "../../config/assets";
import type { LuckDraw, SignedLuckResult } from "../../types/luckChallenge";
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

export interface BuildFortuneResultParams {
  draw: LuckDraw;
  userId: number;
  userLabel: string;
  text: string | undefined;
}

export function buildFortuneResult({
  draw,
  userId,
  userLabel,
  text,
}: BuildFortuneResultParams): InlineQueryResultArticle {
  const comment: string = ATMOSPHERE_TEXTS[BOT_ATMOSPHERE].LUCK_TIER_COMMENTS[draw.tier.label];
  const bodyText: string = text
    ? `你好，${userLabel}\n所求事项: ${text}\n结果: ${draw.tier.label}\n${comment}`
    : `你好，${userLabel}\n汝的今日运势: ${draw.tier.label}\n${comment}`;
  const signed: SignedLuckResult = signLuckResultText(bodyText, luckCacheKey(userId, text));
  return InlineQueryResultBuilder.article(text ? "luck-fortune-text" : "luck-fortune", "未卜先知", {
    description: text ? `所求事项：${text}` : "测测你今天的运势",
    reply_markup: buildRetryKeyboard(text),
    thumbnail_url: getAssetConfig().fortuneThumbnailUrl,
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
  const { label, percent }: { label: string; percent: number; } = pickDominantProbability(draw);
  const bodyText: string = `你好，${userLabel}\n汝今天${label}概率是 ${percent.toFixed(2)}%`;
  const signed: SignedLuckResult = signLuckResultText(bodyText, luckCacheKey(userId, undefined));
  return InlineQueryResultBuilder.article("luck-probability", "概率论！", {
    description: "看看你今天行大运/倒大霉的概率",
    reply_markup: buildRetryKeyboard(undefined),
    thumbnail_url: getAssetConfig().probabilityThumbnailUrl,
  }).text(signed.text, {
    entities: [
      { type: "spoiler", offset: signed.receiptOffset, length: signed.receiptLength },
      { type: "text_link", offset: signed.receiptOffset, length: signed.receiptLength, url: signed.receiptUrl },
    ],
    link_preview_options: { is_disabled: true },
  });
}

export function buildRateLimitedResult(): InlineQueryResultArticle {
  // inline 查询没有目标群上下文，使用本进程生效的 Bot 配置。
  const atmosphere: AtmosphereTexts = ATMOSPHERE_TEXTS[BOT_ATMOSPHERE];
  const windowSeconds: number = RATE_LIMIT_WINDOW_MS / 1000;
  return InlineQueryResultBuilder.article("luck-rate-limited", atmosphere.NOTICE_TEXTS.inlineRateLimitTitle, {
    description: atmosphere.NOTICE_TEXTS.inlineRateLimitDescription(windowSeconds, RATE_LIMIT_MAX_CALLS_PER_WINDOW),
  }).text(atmosphere.NOTICE_TEXTS.inlineRateLimitBody(windowSeconds, RATE_LIMIT_MAX_CALLS_PER_WINDOW));
}
