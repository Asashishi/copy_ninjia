/** 在无系统 Bun、无配置的临时目录真实执行发行包携带的全部冷迁移。 */
import { join } from "node:path";
import { prepareMigratedDeployment } from "./fixtures/migrationDeployment";
import type { MigratedDeployment } from "./fixtures/migrationDeployment";

/** 两种合法 schema v11 谱系均核对非空 WAL 与全部业务表；产物交给安装检查。 */
export async function checkBinaryMigrations(packageRoot: string): Promise<MigratedDeployment> {
  await prepareMigratedDeployment({
    packageRoot, root: join(packageRoot, "historical-migration-check"), binary: true, historical: true,
  });
  return prepareMigratedDeployment({
    packageRoot, root: join(packageRoot, "cold-migration-check"), binary: true,
  });
}
