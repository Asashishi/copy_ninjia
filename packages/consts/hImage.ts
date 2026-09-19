/** `/h_image` 同时在途的抽取与发送上限，属 commands/hImage.ts；槽位覆盖目录枚举、读盘与出站等待。 */
export const H_IMAGE_MAX_CONCURRENT: number = 2;
/** `/h_image` 尚未开始的请求上限，属 commands/hImage.ts；满额时直接回「稍后再试」，不排队。 */
export const H_IMAGE_MAX_PENDING: number = 16;
