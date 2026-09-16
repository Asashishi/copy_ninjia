#!/usr/bin/env bash
#
# Copy Ninjia 一键安装脚本。
#
# 直接跑：
#   curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
#
# 按顺序做四件事：配好环境 -> 取最新 release -> 问部署方要配置 -> 注册 systemd 并启动。
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

# 所有交互输入都从这里读，**不能用标准输入**：`curl | bash` 时 fd 0 是脚本正文，
# bash 还在一边执行一边从它读后面的内容，动了它脚本就会从中间断掉。
readonly TTY_DEVICE="/dev/tty"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    [注意] %s\n' "$1" >&2; }
die() { printf '\n[失败] %s\n' "$1" >&2; exit 1; }

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
  [[ "$executable" = /*/bun ]] || die "服务 ExecStart 必须使用 Bun 运行当前工作树入口。"
  arguments="${entry#*' ; argv[]='}"
  arguments="${arguments%% ;*}"
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

if [ -n "$SCRIPT_DIRECTORY" ] && is_repository_root "$SCRIPT_DIRECTORY"; then
  cd -- "$SCRIPT_DIRECTORY"
  info "在脚本所在目录找到工作树：$(pwd)$(worktree_version_suffix)"
elif is_repository_root "$PWD"; then
  info "在当前目录找到工作树：$(pwd)$(worktree_version_suffix)"
elif is_repository_root "$CLONE_TARGET"; then
  cd -- "$CLONE_TARGET"
  info "复用已存在的工作树：$(pwd)$(worktree_version_suffix)"
elif [ -e "$CLONE_TARGET" ]; then
  die "${CLONE_TARGET} 已存在但不是 Copy Ninjia 工作树。挪开它，或设 COPY_NINJIA_DIR 指定别的目录。"
else
  verify_service_target "$CLONE_TARGET"
  require_command git git
  require_command curl curl
  RELEASE_TAG="$(latest_release_tag)" ||
    die "取不到 GitHub 上的 Latest Release（${RELEASE_API_URL}）。装的必须是已发布版本，不会退回 master；确认网络与 API 限流后重跑。"
  info "Latest Release 是 ${RELEASE_TAG}，按这个 tag 安装。"
  info "clone ${REPOSITORY_URL} 到 ${PWD}/${CLONE_TARGET} ……"
  # --branch 直接落在 tag 上，得到 detached HEAD。
  git -c advice.detachedHead=false clone --branch "$RELEASE_TAG" -- "$REPOSITORY_URL" "$CLONE_TARGET" ||
    die "git clone ${RELEASE_TAG} 失败。"
  cd -- "$CLONE_TARGET"
  is_repository_root "$PWD" || die "clone 出来的目录不像 Copy Ninjia 工作树。"
  info "工作树就绪：$(pwd)（${RELEASE_TAG}）"
fi

# 下载入口只负责定位工作树；后续步骤使用目标树自己的安装器。
if [ "$SCRIPT_DIRECTORY" != "$(pwd -P)" ]; then
  [ -f install.sh ] || die "目标工作树缺少 install.sh，无法继续安装。"
  exec bash ./install.sh
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
ensure_git_repository
source "./scripts/install/runtime.sh"
source "./scripts/install/configure.sh"
source "./scripts/install/start.sh"
