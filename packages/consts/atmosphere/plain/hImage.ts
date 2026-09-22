import type { HImageAddSummary } from "../../../types/hImage";

/** `/h_image` 与 `/h_image add` 的用法、失败与结果提示（普通风格）；全部经 sendCommandMessage 发送，30 秒后删除。 */
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
  usage: "发送 /h_image 抽一张图；回复一条带图片的消息并发送 /h_image add，可把图片收进随机图库。",
  busy: "图片请求过多，请稍后再试。",
  missingDirectory: "图片目录不存在，请检查 state.json 的 global.assets.randomHImageDir。",
  empty: "图片目录里还没有可发送的图片（支持 jpg、jpeg、png、webp）。",
  tooLarge: (fileName: string): string => `图片目录里没有能发送的图片，最后抽中的 ${fileName} 超过 10 MB，Telegram 不接受；请压缩后再放回，或移出超限文件。`,
  addUsage: "请先回复一条带图片的消息，再发送 /h_image add。",
  addRejected: (actorLabel: string): string => `${actorLabel} 没有 isCanAddHImage 权限，不能向随机图库添加图片。`,
  addNoImage: "这条消息里没有可收录的图片（只收图片，或 jpg、png、webp 格式的文件）。",
  addResult: ({ added, librarySize, existing, invalidDimensions, failed }: HImageAddSummary): string =>
    `已收录 ${added} 张，图库中原有 ${librarySize} 张` +
    (existing > 0 ? `，${existing} 张已在图库中，未重复收录` : "") +
    (invalidDimensions > 0
      ? `，${invalidDimensions} 张因宽高之和超过 10000 或长宽比超过 20 未收录，Telegram 无法发送这类图片`
      : "") +
    (failed > 0 ? `，${failed} 张未能收录（超过 10 MB、格式不支持或下载失败）` : "") + "。",
};
