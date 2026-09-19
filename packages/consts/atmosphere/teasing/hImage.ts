import type { HImageAddSummary } from "../../../types/hImage";

/** `/h_image` 与 `/h_image add` 的用法、失败与结果提示（嘲讽风格）；全部经 sendCommandMessage 发送，30 秒后删除。 */
export const H_IMAGE_TEXTS: Readonly<{
  usage: string;
  busy: string;
  missingDirectory: string;
  empty: string;
  tooLarge: (fileName: string) => string;
  addUsage: string;
  addRejected: (actorLabel: string) => string;
  addNoImage: string;
  addResult: (summary: HImageAddSummary) => string;
}> = {
  usage: "笨蛋，直接发 /h_image 抽一张；回复一条带图的消息发 /h_image add 才是往图库里收图♡",
  busy: "一口气要这么多图，本天才忙不过来啦，杂鱼等会儿再来♡",
  missingDirectory: "图片目录都不见了，笨蛋管理员去看看 state.json 的 global.assets.randomImageDir 吧♡",
  empty: "图库里一张能发的都没有呀（只认 jpg、jpeg、png、webp），杂鱼先往里塞点图再来♡",
  tooLarge: (fileName: string): string => `抽到的 ${fileName} 超过 10 MB 啦，Telegram 可不收这么胖的图，换一张或者压一压再放进去♡`,
  addUsage: "笨蛋，要先回复一条带图的消息，再发 /h_image add 才行♡",
  addRejected: (actorLabel: string): string => `就 ${actorLabel} 也想往本天才的图库里塞东西？没有 isCanAddHImage 可不行，笨蛋♡`,
  addNoImage: "这条消息里没有能收的图呀（只收图片，或 jpg、png、webp 格式的文件），杂鱼♡",
  addResult: ({ added, librarySize, existing, failed }: HImageAddSummary): string =>
    `收好啦：新收 ${added} 张，图库里本来就有 ${librarySize} 张` +
    (existing > 0 ? `，有 ${existing} 张早就在图库里了，没再收` : "") +
    (failed > 0 ? `，还有 ${failed} 张没收成（超过 10 MB、格式不对或下载失败）` : "") + "，杂鱼♡",
};
