/** 头像基础设施的兼容入口；新实现按网页解析、复制与恢复职责分布在 avatar/。 */
export { copyUserProfilePhoto } from "./avatar/copy";
export type { CopyUserProfilePhotoOptions } from "./avatar/copy";
export {
  extractAvatarUrlFromProfileHtml,
  extractPublicUsername,
  fetchAvatarFromWebProfile,
  normalizePublicUsername,
} from "./avatar/webProfile";
export { restoreDefaultProfilePhoto } from "./avatar/restore";
