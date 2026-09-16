/** 二进制命令入口；部署工作目录包含配置、prompt 与运行时数据。 */
import type * as ApplicationEntry from "../index";
const arguments_: readonly string[] = Bun.argv.slice(2);
if (arguments_.length === 1 && arguments_[0] === "--help") {
  console.log("Usage: ./copy-ninjia [--help|--version]\nRun from the extracted deployment directory; use bash install.sh to configure it.");
} else if (arguments_.length === 1 && arguments_[0] === "--version") {
  const manifest: { readonly version: string } = await Bun.file("binary.json").json() as { readonly version: string };
  console.log(manifest.version);
} else if (arguments_.length === 0) {
  const { runApplication }: typeof ApplicationEntry = await import("../index");
  await runApplication();
} else {
  throw new Error("Usage: ./copy-ninjia [--help|--version]");
}
