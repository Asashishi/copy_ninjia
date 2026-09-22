#!/usr/bin/env bash
#
# Copy Ninjia 一键安装脚本。
#
# 直接跑：
#   curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
#   bash install.sh --binary  # 下载 GitHub Release 预编译发行包
#   bash install.sh --source  # 安装源码版本
#
# 按顺序执行这八步（与运行时打印的进度逐字一致）：
#   1/8 平台自检
#   2/8 获取仓库
#   3/8 基础工具与 Bun
#   4/8 安装依赖
#   5/8 准备配置目录
#   6/8 填写配置
#   7/8 初始化身份数据库
#   8/8 注册 systemd 服务并启动
# 不迁移、不卸载；重新填写部署配置时会在工作树外保留可核验备份，见
# docs/cn/07-operations.md。
#
# 新工作树使用 GitHub Latest Release；既有工作树保持 checkout，执行目标树的安装器。
# 依赖工具按需安装；g-auth.json 由部署方带外提供。

set -Eeuo pipefail

readonly REPOSITORY_URL="https://github.com/Asashishi/copy_ninjia.git"
# Latest Release 的来源接口。
readonly RELEASE_API_URL="https://api.github.com/repos/Asashishi/copy_ninjia/releases/latest"
readonly SERVICE_NAME="copy-ninjia"
readonly SERVICE_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
# clone 落地目录；已在仓库内运行时用不到。可用环境变量覆盖。
readonly CLONE_TARGET="${COPY_NINJIA_DIR:-copy_ninjia}"
INSTALL_MODE="${COPY_NINJIA_INSTALL_MODE:-}"

# 所有交互输入都从这里读，**不能用标准输入**：`curl | bash` 时 fd 0 是脚本正文，
# bash 还在一边执行一边从它读后面的内容，动了它脚本就会从中间断掉。
readonly TTY_DEVICE="/dev/tty"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    [注意] %s\n' "$1" >&2; }
die() { printf '\n[失败] %s\n' "$1" >&2; exit 1; }

for install_argument in "$@"; do
  case "$install_argument" in
    --source|--binary)
      [ -z "$INSTALL_MODE" ] || die "安装方式只能指定一次。"
      INSTALL_MODE="${install_argument#--}"
      ;;
    --help)
      printf 'Usage: bash install.sh [--source|--binary]\nCOPY_NINJIA_DIR selects a new installation directory.\n'
      exit 0
      ;;
    *) die "未知参数；使用 bash install.sh --help 查看用法。" ;;
  esac
done
case "$INSTALL_MODE" in ''|source|binary) ;; *) die "COPY_NINJIA_INSTALL_MODE 必须是 source 或 binary。" ;; esac

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 127
  fi
}

# 原地写入前核对服务归属及停止状态；运维边界见 docs/cn/07-operations.md。
verify_service_target() {
  local target="$1" load="" active="" sub="" workdir="" entry="" executable="" arguments=""
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    [ ! -e "$SERVICE_UNIT_PATH" ] || die "无法确认既有服务状态，拒绝修改部署。请按运维流程确认服务 inactive 后更新。"
    return 0
  fi
  load="$(systemctl show "${SERVICE_NAME}.service" -p LoadState --value)" ||
    die "无法查询服务状态，拒绝修改部署。请按运维流程确认服务 inactive 后更新。"
  active="$(systemctl show "${SERVICE_NAME}.service" -p ActiveState --value)" || die "无法确认服务 inactive，拒绝修改部署。"
  sub="$(systemctl show "${SERVICE_NAME}.service" -p SubState --value)" || die "无法确认服务 dead，拒绝修改部署。"
  [ "$active" = inactive ] && [ "$sub" = dead ] ||
    die "服务尚未确认 inactive/dead，拒绝修改部署。请按运维流程停机并确认 inactive 后更新。"
  if [ "$load" = not-found ]; then
    [ ! -e "$SERVICE_UNIT_PATH" ] || die "既有 unit 尚未加载，拒绝修改部署。请先按运维流程核对 unit。"
    return 0
  fi
  [ "$load" = loaded ] || die "服务 unit 状态无法确认，拒绝修改部署。"
  workdir="$(systemctl show "${SERVICE_NAME}.service" -p WorkingDirectory --value)" || die "无法读取服务 WorkingDirectory。"
  [ -n "$workdir" ] && [ -d "$workdir" ] && [ -d "$target" ] || die "服务 WorkingDirectory 与目标工作树不符。"
  [ "$(cd -- "$workdir" && pwd -P)" = "$(cd -- "$target" && pwd -P)" ] || die "服务 WorkingDirectory 与目标工作树不符。"
  entry="$(systemctl show "${SERVICE_NAME}.service" -p ExecStart --value)" || die "无法读取服务 ExecStart。"
  [[ "$entry" == '{ path='*' ; argv[]='*' ; '*' }' ]] && [[ "${entry:1}" != *'{'* ]] && [[ "$entry" != *$'\n'* ]] || die "服务 ExecStart 形态无法确认。"
  executable="${entry#'{ path='}"
  executable="${executable%% ;*}"
  arguments="${entry#*' ; argv[]='}"
  arguments="${arguments%% ;*}"
  if [ "$executable" = "$workdir/copy-ninjia" ] && [ "$arguments" = "$executable" ] && is_binary_root "$workdir"; then
    return 0
  fi
  [[ "$executable" = /*/bun ]] || die "服务 ExecStart 必须使用 Bun 或本部署的 copy-ninjia 二进制入口。"
  case "$arguments" in
    "$executable start"|"$executable run start"|"$executable index.ts"|"$executable run index.ts"|"$executable $workdir/index.ts"|"$executable run $workdir/index.ts") ;;
    *) die "服务 ExecStart 必须使用 Bun 运行当前工作树入口。" ;;
  esac
}

# 用系统包管理器补齐基础工具。装不了就把该跑的命令原样打出来，不猜、不硬来。
install_system_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    run_privileged apt-get update -y && run_privileged apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    run_privileged dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    run_privileged yum install -y "$@"
  elif command -v zypper >/dev/null 2>&1; then
    run_privileged zypper --non-interactive install "$@"
  elif command -v pacman >/dev/null 2>&1; then
    run_privileged pacman -Sy --noconfirm "$@"
  elif command -v apk >/dev/null 2>&1; then
    run_privileged apk add --no-cache "$@"
  else
    return 1
  fi
}

# 报告已存在工作树的当前版本；不改动它的 HEAD。
worktree_version_suffix() {
  if is_binary_root "$PWD"; then printf '（二进制发行包）'; return 0; fi
  git describe --tags --always --dirty 2>/dev/null |
    sed 's/^/（当前 /; s/$/，本脚本不改动它的 checkout）/'
}

# 取 GitHub 上 Latest Release 的 tag；来源只有 releases/latest 接口。
# 任一环节失败时（pipefail）整条返回非零，由调用方 die，不回退到 master。
latest_release_tag() {
  curl -fsSL -H "Accept: application/vnd.github+json" -- "$RELEASE_API_URL" |
    grep -m1 -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' |
    cut -d'"' -f4
}

require_command() {
  local command_name="$1" package_name="$2"
  command -v "$command_name" >/dev/null 2>&1 && return 0
  info "缺少 ${command_name}，尝试用系统包管理器安装 ${package_name}……"
  if ! install_system_packages "$package_name"; then
    die "无法自动安装 ${package_name}。请先手工安装 ${command_name} 再重跑本脚本。"
  fi
  command -v "$command_name" >/dev/null 2>&1 ||
    die "安装 ${package_name} 之后仍然找不到 ${command_name}。"
}

# 目录是不是一个可用的 Copy Ninjia 工作树。
is_repository_root() {
  [ -d "$1/config_example" ] && [ -f "$1/package.json" ] && [ -f "$1/index.ts" ]
}

is_binary_root() {
  [ -f "$1/binary.json" ] && [ -x "$1/copy-ninjia" ] && [ -d "$1/config_example" ]
}

is_installation_root() {
  if [ "$INSTALL_MODE" != binary ] && is_repository_root "$1"; then return 0; fi
  [ "$INSTALL_MODE" != source ] && is_binary_root "$1"
}

# 只从同一 Release 下载包与校验和；不安装 Bun、不取源码、不在目标机器编译。
download_binary_release() {
  local architecture="" suffix="" asset="" url="" checksum="" digest="" member=""
  case "$(uname -m)" in
    x86_64) architecture=x64 ;;
    aarch64|arm64) architecture=arm64 ;;
    *) die "二进制发行包只支持 Linux x64 或 arm64。" ;;
  esac
  if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    suffix=""
  elif { ldd --version 2>&1 || true; } | grep -qi musl; then
    suffix=-musl
  else
    die "无法识别 libc；二进制安装仅支持 glibc 或 musl。"
  fi
  require_command tar tar
  require_command sha256sum coreutils
  asset="copy-ninjia-linux-${architecture}${suffix}.tar.gz"
  url="https://github.com/Asashishi/copy_ninjia/releases/download/${RELEASE_TAG}/${asset}"
  BINARY_DOWNLOAD_ROOT="$(mktemp -d)" || die "无法创建下载暂存目录。"
  trap 'rm -rf -- "$BINARY_DOWNLOAD_ROOT"' EXIT
  curl -fSL --output "$BINARY_DOWNLOAD_ROOT/$asset" -- "$url" ||
    die "该 Release 没有当前平台的二进制包或下载失败；请发布对应资产，或选择 --source。"
  curl -fsSL --output "$BINARY_DOWNLOAD_ROOT/$asset.sha256" -- "$url.sha256" || die "下载 SHA-256 失败。"
  checksum="$(cat "$BINARY_DOWNLOAD_ROOT/$asset.sha256")"
  digest="${checksum%% *}"
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] && [ "$checksum" = "$digest  $asset" ] || die "SHA-256 文件格式不正确。"
  (cd -- "$BINARY_DOWNLOAD_ROOT" && sha256sum -c "$asset.sha256") || die "二进制包 SHA-256 不匹配。"
  tar -tzf "$BINARY_DOWNLOAD_ROOT/$asset" > "$BINARY_DOWNLOAD_ROOT/members" || die "无法读取发行包。"
  while IFS= read -r member; do
    case "$member" in copy-ninjia/*) ;; *) die "发行包包含无效路径。" ;; esac
    case "/$member/" in *'/../'*|*'/./'*) die "发行包包含无效路径。" ;; esac
  done < "$BINARY_DOWNLOAD_ROOT/members"
  tar -tvzf "$BINARY_DOWNLOAD_ROOT/$asset" > "$BINARY_DOWNLOAD_ROOT/types" || die "无法读取发行包类型。"
  if grep -qvE '^[-d]' "$BINARY_DOWNLOAD_ROOT/types"; then die "发行包只允许普通文件与目录。"; fi
  tar -xzf "$BINARY_DOWNLOAD_ROOT/$asset" -C "$BINARY_DOWNLOAD_ROOT" --no-same-owner || die "解压发行包失败。"
  is_binary_root "$BINARY_DOWNLOAD_ROOT/copy-ninjia" || die "发行包缺少二进制或配置示例。"
  (cd -- "$BINARY_DOWNLOAD_ROOT/copy-ninjia" && BUN_BE_BUN=1 ./copy-ninjia -e '
    const metadata = await Bun.file("binary.json").json();
    if (metadata.version !== Bun.argv[1] || metadata.platform !== Bun.argv[2] || metadata.bun !== Bun.version) {
      throw new Error("binary.json: expected the selected Release, platform and embedded Bun version.");
    }
  ' "$RELEASE_TAG" "linux-${architecture}${suffix}") || die "发行包版本或平台不匹配。"
  [ ! -e "$CLONE_TARGET" ] && [ ! -L "$CLONE_TARGET" ] || die "安装目录已存在，拒绝覆盖。"
  mv -T -- "$BINARY_DOWNLOAD_ROOT/copy-ninjia" "$CLONE_TARGET" || die "无法放置二进制发行包。"
  rm -rf -- "$BINARY_DOWNLOAD_ROOT"
  trap - EXIT
}

# --------------------------------------------------------------------------
step "1/8 平台自检"
# --------------------------------------------------------------------------

[ "$(uname -s)" = "Linux" ] ||
  die "只支持 Linux：实例锁依赖 /proc/<pid>/stat 与 boot ID，其它平台会 fail-closed 拒绝启动。"
[ -r /proc/self/stat ] ||
  die "/proc 不可读：实例锁无法工作。容器请挂载 /proc 后重试。"
# 不看 `[ -t 0 ]`：`curl | bash` 时 fd 0 本来就是脚本正文，那个判断只会误伤。
# 真正要有的是一个能读能写的控制终端，后面所有问答都从它读。
{ [ -r "$TTY_DEVICE" ] && [ -w "$TTY_DEVICE" ]; } ||
  die "拿不到控制终端（${TTY_DEVICE}），无法询问配置。请在交互式终端里运行本脚本。"
info "Linux + 可读 /proc + 可用控制终端，均满足。"

# --------------------------------------------------------------------------
step "2/8 获取仓库"
# --------------------------------------------------------------------------

# 按脚本所在目录、当前目录、clone 目标的顺序定位工作树。
SCRIPT_DIRECTORY=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
fi

if [ -n "$SCRIPT_DIRECTORY" ] && is_installation_root "$SCRIPT_DIRECTORY"; then
  cd -- "$SCRIPT_DIRECTORY"
  info "在脚本所在目录找到工作树：$(pwd)$(worktree_version_suffix)"
elif is_installation_root "$PWD"; then
  info "在当前目录找到工作树：$(pwd)$(worktree_version_suffix)"
elif is_installation_root "$CLONE_TARGET"; then
  cd -- "$CLONE_TARGET"
  info "复用已存在的工作树：$(pwd)$(worktree_version_suffix)"
elif [ -e "$CLONE_TARGET" ]; then
  die "${CLONE_TARGET} 已存在但不是 Copy Ninjia 工作树。挪开它，或设 COPY_NINJIA_DIR 指定别的目录。"
else
  verify_service_target "$CLONE_TARGET"
  if [ -z "$INSTALL_MODE" ]; then
    printf '    安装方式：1) 源码  2) 二进制 [1]：'
    IFS= read -r INSTALL_MODE < "$TTY_DEVICE" || die "读取安装方式失败。"
    case "$INSTALL_MODE" in ''|1) INSTALL_MODE=source ;; 2) INSTALL_MODE=binary ;; *) die "安装方式只接受 1 或 2。" ;; esac
  fi
  require_command curl curl
  RELEASE_TAG="$(latest_release_tag)" ||
    die "取不到 GitHub 上的 Latest Release（${RELEASE_API_URL}）。装的必须是已发布版本，不会退回 master；确认网络与 API 限流后重跑。"
  info "Latest Release 是 ${RELEASE_TAG}，按这个 tag 安装。"
  [[ "$RELEASE_TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Release tag 必须是 MAJOR.MINOR.PATCH。"
  if [ "$INSTALL_MODE" = binary ]; then
    download_binary_release
    cd -- "$CLONE_TARGET"
  else
    require_command git git
    info "clone ${REPOSITORY_URL} 到 ${PWD}/${CLONE_TARGET} ……"
    # --branch 直接落在 tag 上，得到 detached HEAD。
    git -c advice.detachedHead=false clone --branch "$RELEASE_TAG" -- "$REPOSITORY_URL" "$CLONE_TARGET" ||
      die "git clone ${RELEASE_TAG} 失败。"
    cd -- "$CLONE_TARGET"
    is_repository_root "$PWD" || die "clone 出来的目录不像 Copy Ninjia 工作树。"
    info "工作树就绪：$(pwd)（${RELEASE_TAG}）"
  fi
fi

if is_binary_root "$PWD"; then INSTALL_MODE=binary; else INSTALL_MODE=source; fi

# 下载入口只负责定位工作树；后续步骤使用目标树自己的安装器。
if [ "$SCRIPT_DIRECTORY" != "$(pwd -P)" ]; then
  [ -f install.sh ] || die "目标工作树缺少 install.sh，无法继续安装。"
  COPY_NINJIA_INSTALL_MODE= exec bash ./install.sh "--${INSTALL_MODE}"
fi

# 原地写入前核验既有服务。
verify_service_target "$PWD"

# 只加载目标工作树自己的模块；全部存在且语法有效后才进行后续安装写入。
for install_module in repository service config runtime configure start; do
  [ -r "./scripts/install/${install_module}.sh" ] || die "目标工作树缺少安装模块：scripts/install/${install_module}.sh。"
  bash -n "./scripts/install/${install_module}.sh" || die "安装模块语法错误：scripts/install/${install_module}.sh。"
done
source "./scripts/install/repository.sh"
source "./scripts/install/service.sh"
source "./scripts/install/config.sh"
if [ "$INSTALL_MODE" = source ]; then ensure_git_repository; fi
source "./scripts/install/runtime.sh"
source "./scripts/install/configure.sh"
source "./scripts/install/start.sh"
