/** `/h_image` 的用法与失败提示（普通风格）；全部经 sendCommandMessage 发送，30 秒后删除。 */
export const H_IMAGE_TEXTS: Readonly<{
  usage: string;
  busy: string;
  missingDirectory: string;
  empty: string;
  tooLarge: (fileName: string) => string;
}> = {
  usage: "直接发送 /h_image 即可，不接受额外参数。",
  busy: "图片请求过多，请稍后再试。",
  missingDirectory: "图片目录不存在，请检查 state.json 的 global.assets.randomImageDir。",
  empty: "图片目录里还没有可发送的图片（支持 jpg、jpeg、png、webp）。",
  tooLarge: (fileName: string): string => `抽中的图片 ${fileName} 超过 10 MB，Telegram 不接受，请换一张或压缩后再放入目录。`,
};
