#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

# Bun 精确版本与本工作树的 packageManager 一致。
readonly REQUIRED_BUN_MAJOR=1
readonly REQUIRED_BUN_MINOR=4
readonly REQUIRED_BUN_PATCH=2
readonly REQUIRED_BUN_VERSION="${REQUIRED_BUN_MAJOR}.${REQUIRED_BUN_MINOR}.${REQUIRED_BUN_PATCH}"

# --------------------------------------------------------------------------
step "3/8 基础工具与 Bun"
# --------------------------------------------------------------------------

if [ "$INSTALL_MODE" = binary ]; then
  BINARY_EXECUTABLE="$PWD/copy-ninjia"
  # Bun 官方的 BUN_BE_BUN 模式只用于本包安装校验，不依赖系统 Bun。
  bun() { BUN_BE_BUN=1 "$BINARY_EXECUTABLE" "$@"; }
fi

if ! command -v bun >/dev/null 2>&1 && [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
  # 装过但当前 shell 没加载 PATH 的常见情形，直接用现成的，不重复安装。
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  info "在 ${BUN_INSTALL}/bin 找到已安装的 Bun。"
fi

if ! command -v bun >/dev/null 2>&1; then
  info "未检测到 Bun，准备安装官方发行版 ${REQUIRED_BUN_VERSION}。"
  require_command curl curl
  require_command unzip unzip
  curl -fsSL https://bun.sh/install | bash -s "bun-v${REQUIRED_BUN_VERSION}" ||
    die "Bun 安装脚本执行失败。"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 ||
    die "安装完成但 PATH 里仍然没有 bun。请手工把 ${BUN_INSTALL}/bin 加入 PATH 后重跑。"
  info "Bun 已安装到 ${BUN_INSTALL}。新开的终端需要重新加载 shell 配置才能直接用 bun。"
fi

BUN_VERSION="$(bun --version)" || die "无法读取 Bun 版本。"
if [ "$BUN_VERSION" != "$REQUIRED_BUN_VERSION" ]; then
  die "需要 Bun ${REQUIRED_BUN_VERSION}，当前是 ${BUN_VERSION}。请手工安装对应版本后重跑：curl -fsSL https://bun.sh/install | bash -s bun-v${REQUIRED_BUN_VERSION}"
fi
# 安装器与 manifest 必须在安装依赖和写入配置之前完成一致性核验。
bun -e '
  const manifest = await Bun.file("package.json").json();
  if (manifest?.packageManager !== `bun@${Bun.argv[1]}`) {
    throw new Error(`package.json: $.packageManager must equal bun@${Bun.argv[1]}.`);
  }
' "$REQUIRED_BUN_VERSION" || die "安装器与 package.json 的 Bun 版本不一致。"
info "Bun ${BUN_VERSION}，与 packageManager 一致。"

# --------------------------------------------------------------------------
step "4/8 安装依赖"
# --------------------------------------------------------------------------

verify_service_target "$PWD"

# systemd 的系统服务不会继承运行安装脚本的 shell 环境。只有部署方显式设置了
# COPY_NINJIA_DATA_ROOT 时才写 Environment=：缺省时继续让生产代码使用项目根，
# 不能把缺省根也写进去，否则会把 RUNTIME_DATA_ROOT_IS_CONFIGURED 错置为 true。
# 数据根在任何部署写入之前解析，并与既有 unit 的同名环境项核对。
SYSTEMD_DATA_ROOT_ENVIRONMENT=""
RESOLVED_RUNTIME_DATA_ROOT=""
if [ "${COPY_NINJIA_DATA_ROOT+x}" = "x" ]; then
  RESOLVED_RUNTIME_DATA_ROOT="$(resolve_runtime_data_root)" || die "无法解析运行时数据根。"
  SYSTEMD_DATA_ROOT_ENVIRONMENT="$(
    systemd_environment_assignment COPY_NINJIA_DATA_ROOT "$RESOLVED_RUNTIME_DATA_ROOT"
  )"
fi
verify_service_data_root "$RESOLVED_RUNTIME_DATA_ROOT"

# 用锁文件安装：bun.lock 已进版本库，装出来的树必须和门禁跑过的那棵一致。
if [ "$INSTALL_MODE" = source ]; then
  bun install --frozen-lockfile || die "bun install 失败。"
  info "依赖安装完成。"
else
  info "使用发行包自带的运行时与原生库，无需安装依赖。"
fi

# --------------------------------------------------------------------------
step "5/8 准备配置目录"
# --------------------------------------------------------------------------

# 旧文件在模板补缺之前拒绝，迁移必须由部署方显式执行。
bun -e '
  import { assertCurrentBotConfigDirectory } from "./scripts/install/runtime";
  await assertCurrentBotConfigDirectory("config");
' || die "先执行 migrate:bot-config 冷迁移；二进制包用 BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateBotConfig.js --help 查看用法。"

mkdir -p config
for example_file in config_example/*.json; do
  config_name="$(basename -- "$example_file")"
  if [ "$config_name" = "agent.json" ]; then
    # agent 示例含故意不可用的占位凭据；只有完成问卷后才生成部署文件。
    continue
  fi
  if [ "$config_name" = "g-auth.json" ]; then
    # 翻译凭据示例只示意结构，占位私钥必然被严格解析拒绝；真实密钥由部署方带外放入。
    continue
  fi
  if [ "$config_name" = "cron.json" ]; then
    # 定时任务示例只示意用法：会话 id 与地址都是假的，本地来源也不存在；缺省即没有定时任务。
    continue
  fi
  if [ -e "config/${config_name}" ]; then
    # 已有配置一律不覆盖：那是部署方数据，不能被示例值顶掉。
    info "保留 config/${config_name}（已存在）。"
    continue
  fi
  create_config_from_example "$example_file" "config/${config_name}"
  info "新建 config/${config_name}（来自示例）。"
done
