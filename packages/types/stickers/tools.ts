import type { Sticker } from "grammy/types";

export interface StickerSendLockControl {
  tryAcquire(): boolean;
  release(): void;
}

export interface StickerCandidate {
  sticker: Sticker;
  emoji: string;
  description: string;
}

export interface StickerPackCandidate {
  pack: string;
  title: string;
  summary: string;
  stickers: StickerCandidate[];
}

export interface StickerRoundState {
  viewedPackIntents: Map<number, string>;
  sentStickerUids: Set<string>;
}
