/** `/h_image` 的用法与失败提示（嘲讽风格）；全部经 sendCommandMessage 发送，30 秒后删除。 */
export const H_IMAGE_TEXTS: Readonly<{
  usage: string;
  busy: string;
  missingDirectory: string;
  empty: string;
  tooLarge: (fileName: string) => string;
}> = {
  usage: "笨蛋，直接发 /h_image 就行，后面什么都不用加♡",
  busy: "一口气要这么多图，本天才忙不过来啦，杂鱼等会儿再来♡",
  missingDirectory: "图片目录都不见了，笨蛋管理员去看看 state.json 的 global.assets.randomImageDir 吧♡",
  empty: "图库里一张能发的都没有呀（只认 jpg、jpeg、png、webp），杂鱼先往里塞点图再来♡",
  tooLarge: (fileName: string): string => `抽到的 ${fileName} 超过 10 MB 啦，Telegram 可不收这么胖的图，换一张或者压一压再放进去♡`,
};
