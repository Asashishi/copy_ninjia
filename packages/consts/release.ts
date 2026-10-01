/** 发行汇总支持的平台名；发布 CLI 逐项核对显式 --platforms，所属模块：scripts/release/assets.ts。 */
export const RELEASE_PLATFORMS: readonly string[] = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"];

/** 发行包必须唯一包含的普通文件；主程序另需属主执行位，所属模块：scripts/release/assets.ts。 */
export const RELEASE_REQUIRED_FILES: readonly string[] = [
  "copy-ninjia/binary.json", "copy-ninjia/package.json", "copy-ninjia/copy-ninjia",
  "copy-ninjia/install.sh", "copy-ninjia/scripts/install/runtime.js",
];

/** Release tag 与包内清单共用的无前缀版本形态，所属模块：scripts/release.ts。 */
export const RELEASE_VERSION_PATTERN: Readonly<RegExp> = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
