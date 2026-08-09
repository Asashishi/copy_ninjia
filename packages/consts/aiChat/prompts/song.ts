/**
 * 生歌流水线里喂给**图片**模型的提示词。
 *
 * 单独成文件而不是并进 prompts/media.ts：那份是媒体**理解**（看图说话），这份是
 * 媒体**生成**，两者唯一的共同点只是都跟图片有关。
 * 所属模块：packages/aiChat/ai/songCover.ts。
 */

import { SONG_COVER_MAX_EDGE } from "../songGeneration";

/**
 * 按曲目信息拼一段封面画面说明。
 *
 * 三条约束是这段提示词的全部意义，别改软：
 * 1. **不要文字。** 生图模型写出来的字几乎必然是错的（尤其中日文），而封面缩略图
 *    只有 320 像素见方，一行糊掉的假字比留白难看得多。曲名与演唱者由 Telegram
 *    的播放条渲染，本来就不需要画进图里。
 * 2. **正方形、主体居中。** 缩略图会被客户端裁成方形小图，构图散开的画面缩完
 *    就是一团看不出内容的色块。
 * 3. **只描述画面。** songPrompt 是给音乐模型的创作说明（BPM、编制、歌词），
 *    原样转给图片模型会让它照着"Chinese vocals"之类的词去画字；这里只把它当作
 *    气氛线索，并明说不要照抄。
 *
 * @param title 曲名，仅作为气氛线索。
 * @param performer 演唱者，同上。
 * @param songPrompt 交给音乐模型的创作说明。
 */
export function songCoverPrompt(title: string, performer: string, songPrompt: string): string {
  return (
    "为一首歌画一张专辑封面。" +
    `歌名是「${title}」，演唱者是「${performer}」，这首歌的创作说明是：${songPrompt}` +
    "\n\n" +
    "请只把上面这些当作气氛与风格的线索，不要照抄其中的技术词汇（BPM、乐器名、歌词）去构图。" +
    "画面要求：正方形构图，主体居中且足够大——这张图会被缩到 " +
    `${SONG_COVER_MAX_EDGE}×${SONG_COVER_MAX_EDGE} 像素当缩略图显示，散开的构图缩完就看不出内容了。` +
    "整张图里**不要出现任何文字、字母、数字或书法**：歌名和演唱者会由播放器自己显示，" +
    "画进图里只会得到一行拼错的假字。用色彩、光线和意象表达这首歌的情绪即可。"
  );
}
