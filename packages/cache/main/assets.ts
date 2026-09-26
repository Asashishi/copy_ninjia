import { DEFAULT_ASSET_CONFIG } from "../../consts/ui/assets";
import type { AssetConfig } from "../../types/config";

/**
 * Owner: 主线程。config/dynamic/assets.json 的已生效素材快照（packages/config/assets.ts）。
 *
 * 初值为内置缺省；启动总闸在文件存在时整体替换，config/dynamic/ 热重载每轮按读取结果整体替换，
 * 文件被删除时换回 DEFAULT_ASSET_CONFIG。只整体替换、不就地改写，容量恒为一个对象。
 * 内联结果渲染、头像复原与随机图片都在主线程读取，Worker 不持有副本；进程重启从
 * 缺省重新填充。
 */
export const assetConfigCache: { current: Readonly<AssetConfig> } = { current: DEFAULT_ASSET_CONFIG };
