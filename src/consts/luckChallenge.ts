/** /luck_challenge 内联抽签（src/commands/luckChallenge.ts）的调参常量。 */

/**
 * 「未卜先知」「概率论」两个内联结果各自固定的配图直链。TODO：占位 URL，
 * 图传到 Google Drive 后换成真实直链——注意 Drive 的普通分享链接
 * （.../file/d/<id>/view）是个网页，Telegram 抓不到图；要用
 * `https://drive.google.com/uc?export=view&id=<FILE_ID>` 这种直出图片字节
 * 的形式，且 Drive 对这种热链接有时大文件会插入确认页/偶尔限流的已知问题，
 * 如果发现缩略图时有时无，再考虑换成稳定的图床或自建静态资源。
 */
export const FORTUNE_THUMBNAIL_URL: string = "https://example.com/luck/fortune.jpg";
export const PROBABILITY_THUMBNAIL_URL: string = "https://example.com/luck/probability.jpg";
