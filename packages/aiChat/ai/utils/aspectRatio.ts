/**
 * 生图宽高比的解析与归一，与供应商无关。领域侧（生图工具的入参校验、工具
 * 说明文案）与两家实现包的画幅映射共用这里的比值口径。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_ASPECT_RATIOS,
} from "../../../consts/aiChat/imageGeneration";
import type { ImageGenerationAspectRatio } from "../../../types/aiChat/imageGeneration";

/** `W:H` 形式的官方比例转数值宽高比。 */
export function aspectRatioValue(ratio: ImageGenerationAspectRatio): number {
  const [width, height]: number[] = ratio.split(":").map(Number);
  return width! / height!;
}

/**
 * 官方比例表对应的数值宽高比，模块加载时一次算好。
 *
 * 输入是构造后只读的常量表、没有失效边界，每次归一都重算一遍等于每次生图
 * 调用白产生一个临时数组和十次字符串切分（见 AGENTS.md 的「性能、内存与
 * Bun/JSC JIT」一节对 map 中间结果的约束）。
 */
const ASPECT_RATIO_VALUES: readonly number[] = IMAGE_GENERATION_ASPECT_RATIOS.map(aspectRatioValue);

/**
 * 在候选比值里取与目标最接近的一项。距离按 log(target / candidate) 计算，
 * 这样横竖互换时距离仍对称（4:3 到 1:1 与 3:4 到 1:1 应当等距）。
 * @param target 目标宽高比数值，必须为正有限数。
 * @param candidates 候选比值，至少一项。
 * @returns 最接近项在 candidates 中的下标。
 */
export function closestRatioIndex(target: number, candidates: readonly number[]): number {
  let closest: number = 0;
  let closestDistance: number = Number.POSITIVE_INFINITY;
  for (let i: number = 0; i < candidates.length; i++) {
    const distance: number = Math.abs(Math.log(target / candidates[i]!));
    if (distance < closestDistance) {
      closest = i;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * 官方比例原样保留；其它正数比例按最近项收敛。支持 W:H、W/H、WxH 与 W×H 写法。
 * @returns 归一后的官方比例；写法不合法或数值无效时返回 null。
 */
export function normalizeImageAspectRatio(requested: string | undefined): ImageGenerationAspectRatio | null {
  if (requested === undefined || requested.trim() === "") return DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
  const match: RegExpExecArray | null = /^(\d+(?:\.\d+)?)\s*(?::|\/|x|×)\s*(\d+(?:\.\d+)?)$/i.exec(requested.trim());
  if (!match) return null;
  const width: number = Number(match[1]);
  const height: number = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const index: number = closestRatioIndex(width / height, ASPECT_RATIO_VALUES);
  return IMAGE_GENERATION_ASPECT_RATIOS[index] ?? DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
}
