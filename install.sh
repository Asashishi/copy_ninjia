#!/usr/bin/env bash
#
# Copy Ninjia 一键安装脚本。
#
# 直接跑：
#   curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
#
# 只做三件事，按顺序：配好环境 -> 问部署方要配置 -> 启动。不注册 systemd、不拉
# release tag、不备份、不迁移、不卸载——那些属于运维流程，见 docs/cn/07-operations.md。
#
# 假设机器上什么都没装：缺 git/curl/unzip 会用系统包管理器补齐，缺仓库会 clone，
# 缺 Bun 会装官方发行版。唯一不代劳的是 /ja_copy 用的 g-auth.json：那是 GCP 服务
# 账号密钥，只能从控制台下载后带外传到机器上，问答里没法「输入」，因此当成前置
# 条件而不是脚本里的一步。
#
# 已经 clone 过仓库时，在仓库根跑 `bash install.sh` 等价，会跳过 clone 那一步。

set -Eeuo pipefail

readonly REPOSITORY_URL="https://github.com/Asashishi/copy_ninjia.git"
# clone 落地目录；已在仓库内运行时用不到。可用环境变量覆盖。
readonly CLONE_TARGET="${COPY_NINJIA_DIR:-copy_ninjia}"

# Bun 官方发行版当前要求的最低版本；低于它启动会因 API 缺失而失败。
readonly REQUIRED_BUN_MAJOR=1
readonly REQUIRED_BUN_MINOR=4

# config_example/agent.json 里的六项 AI 能力，顺序与示例一致。
readonly AGENT_CAPABILITIES=(ad_detect text summary media image song)
# AI 闲聊的必备能力；缺任意一项，/ai_chat enable 会被拒绝。
readonly AGENT_REQUIRED_CAPABILITIES=(text summary media)

# 所有交互输入都从这里读，**不能用标准输入**：`curl | bash` 时 fd 0 是脚本正文，
# bash 还在一边执行一边从它读后面的内容，动了它脚本就会从中间断掉。
readonly TTY_DEVICE="/dev/tty"

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    [注意] %s\n' "$1" >&2; }
die() { printf '\n[失败] %s\n' "$1" >&2; exit 1; }

# 以 root 直接执行，否则借 sudo；两者都没有时由调用方决定怎么办。
run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    return 127
  fi
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

# 读一行普通输入到指定变量名。
ask() {
  local target_name="$1" prompt_text="$2" answer=""
  printf '    %s' "$prompt_text"
  IFS= read -r answer < "$TTY_DEVICE" || die "读取输入失败（终端已关闭）。"
  printf -v "$target_name" '%s' "$answer"
}

# 读一行不回显的输入；token、API key 走这条，避免留在终端回滚里。
ask_secret() {
  local target_name="$1" prompt_text="$2" answer=""
  printf '    %s' "$prompt_text"
  IFS= read -rs answer < "$TTY_DEVICE" || die "读取输入失败（终端已关闭）。"
  printf '\n'
  printf -v "$target_name" '%s' "$answer"
}

# 是/否询问；默认值由第二个参数给出（y 或 n）。
confirm() {
  local prompt_text="$1" default_answer="$2" answer=""
  local hint="[y/N]"
  [ "$default_answer" = "y" ] && hint="[Y/n]"
  while true; do
    printf '    %s %s ' "$prompt_text" "$hint"
    IFS= read -r answer < "$TTY_DEVICE" || die "读取输入失败（终端已关闭）。"
    [ -z "$answer" ] && answer="$default_answer"
    case "$answer" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) printf '    只接受 y 或 n。\n' ;;
    esac
  done
}

# --------------------------------------------------------------------------
step "1/7 平台自检"
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
step "2/7 获取仓库"
# --------------------------------------------------------------------------

# 三种到达方式：仓库根跑 `bash install.sh`、仓库外跑一份下载好的脚本、以及
# `curl | bash`。后者拿不到 BASH_SOURCE 对应的真实文件，所以按「脚本所在目录 ->
# 当前目录 -> clone」的顺序找工作树，不猜。
SCRIPT_DIRECTORY=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIRECTORY" ] && is_repository_root "$SCRIPT_DIRECTORY"; then
  cd -- "$SCRIPT_DIRECTORY"
  info "在脚本所在目录找到工作树：$(pwd)"
elif is_repository_root "$PWD"; then
  info "在当前目录找到工作树：$(pwd)"
elif is_repository_root "$PWD/$CLONE_TARGET"; then
  cd -- "$CLONE_TARGET"
  info "复用已存在的工作树：$(pwd)"
elif [ -e "$CLONE_TARGET" ]; then
  die "${PWD}/${CLONE_TARGET} 已存在但不是 Copy Ninjia 工作树。挪开它，或设 COPY_NINJIA_DIR 指定别的目录。"
else
  require_command git git
  info "clone ${REPOSITORY_URL} 到 ${PWD}/${CLONE_TARGET} ……"
  git clone -- "$REPOSITORY_URL" "$CLONE_TARGET" || die "git clone 失败。"
  cd -- "$CLONE_TARGET"
  is_repository_root "$PWD" || die "clone 出来的目录不像 Copy Ninjia 工作树。"
  info "工作树就绪：$(pwd)"
fi

# --------------------------------------------------------------------------
step "3/7 基础工具与 Bun"
# --------------------------------------------------------------------------

if ! command -v bun >/dev/null 2>&1 && [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
  # 装过但当前 shell 没加载 PATH 的常见情形，直接用现成的，不重复安装。
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  info "在 ${BUN_INSTALL}/bin 找到已安装的 Bun。"
fi

if ! command -v bun >/dev/null 2>&1; then
  info "未检测到 Bun，准备安装官方发行版。"
  require_command curl curl
  require_command unzip unzip
  curl -fsSL https://bun.sh/install | bash ||
    die "Bun 安装脚本执行失败。"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 ||
    die "安装完成但 PATH 里仍然没有 bun。请手工把 ${BUN_INSTALL}/bin 加入 PATH 后重跑。"
  info "Bun 已安装到 ${BUN_INSTALL}。新开的终端需要重新加载 shell 配置才能直接用 bun。"
fi

BUN_VERSION="$(bun --version)"
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_VERSION_REST="${BUN_VERSION#*.}"
BUN_MINOR="${BUN_VERSION_REST%%.*}"
if [ "$BUN_MAJOR" -lt "$REQUIRED_BUN_MAJOR" ] ||
   { [ "$BUN_MAJOR" -eq "$REQUIRED_BUN_MAJOR" ] && [ "$BUN_MINOR" -lt "$REQUIRED_BUN_MINOR" ]; }; then
  die "需要 Bun ${REQUIRED_BUN_MAJOR}.${REQUIRED_BUN_MINOR}+，当前是 ${BUN_VERSION}。请升级后重跑：curl -fsSL https://bun.sh/install | bash"
fi
info "Bun ${BUN_VERSION}，满足 ${REQUIRED_BUN_MAJOR}.${REQUIRED_BUN_MINOR}+ 要求。"

# --------------------------------------------------------------------------
step "4/7 安装依赖"
# --------------------------------------------------------------------------

# 用锁文件安装：bun.lock 已进版本库，装出来的树必须和门禁跑过的那棵一致。
bun install --frozen-lockfile || die "bun install 失败。"
info "依赖安装完成。"

# --------------------------------------------------------------------------
step "5/7 准备配置目录"
# --------------------------------------------------------------------------

mkdir -p config
AGENT_CONFIG_WAS_CREATED=0
for example_file in config_example/*.json; do
  config_name="$(basename -- "$example_file")"
  if [ -e "config/${config_name}" ]; then
    # 已有配置一律不覆盖：那是部署方数据，不能被示例值顶掉。
    info "保留 config/${config_name}（已存在）。"
    continue
  fi
  cp -- "$example_file" "config/${config_name}"
  [ "$config_name" = "agent.json" ] && AGENT_CONFIG_WAS_CREATED=1
  info "新建 config/${config_name}（来自示例）。"
done

# --------------------------------------------------------------------------
step "6/7 填写配置"
# --------------------------------------------------------------------------

CONFIGURE_TELEGRAM=1
if [ -e config/telegram.json ] &&
   ! grep -q 'replace-with-telegram-bot-token' config/telegram.json; then
  confirm "config/telegram.json 已经填过，是否重新填写？" n || CONFIGURE_TELEGRAM=0
fi

if [ "$CONFIGURE_TELEGRAM" -eq 1 ]; then
  info "Bot token 找 @BotFather 用 /newbot 创建；超级管理员 ID 是你自己的数字用户 ID。"
  BOT_TOKEN=""
  while true; do
    ask_secret BOT_TOKEN "Telegram bot token（输入不回显）："
    # 形态是 <数字>:<字母数字_->。先卡形态，写 JSON 时才不必再考虑转义。
    [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] && break
    warn "token 形态不对，应形如 123456789:AA...；请重新输入。"
  done
  SUPER_ADMIN_USER_ID=""
  while true; do
    ask SUPER_ADMIN_USER_ID "超级管理员用户 ID（纯数字）："
    [[ "$SUPER_ADMIN_USER_ID" =~ ^[1-9][0-9]*$ ]] && break
    warn "只接受正整数，请重新输入。"
  done
  cat > config/telegram.json <<JSON
{
  "bot_token": "${BOT_TOKEN}",
  "super_admin_user_id": ${SUPER_ADMIN_USER_ID}
}
JSON
  chmod 600 config/telegram.json
  info "已写入 config/telegram.json（权限 600）。"
fi

if [ "$AGENT_CONFIG_WAS_CREATED" -eq 0 ] && [ -e config/agent.json ]; then
  info "保留既有 config/agent.json，未改动。"
elif confirm "现在配置 AI 能力（AI 闲聊、广告检测、生图、写歌）？不配也能启动。" n; then
  CONFIGURED_CAPABILITIES=()
  for capability in "${AGENT_CAPABILITIES[@]}"; do
    printf '\n'
    if ! confirm "配置 ${capability}？" n; then
      info "跳过 ${capability}。"
      continue
    fi
    capability_key="$(printf '%s' "$capability" | tr '[:lower:]' '[:upper:]')"
    provider=""
    while true; do
      ask provider "  ${capability} 的 provider（google 或 openai）："
      case "$provider" in google|openai) break ;; esac
      warn "只接受 google 或 openai。"
    done
    api_key=""
    while [ -z "$api_key" ]; do
      ask_secret api_key "  ${capability} 的 api_key（输入不回显）："
      [ -z "$api_key" ] && warn "api_key 不能为空。"
    done
    model=""
    while [ -z "$model" ]; do
      ask model "  ${capability} 的 model："
      [ -z "$model" ] && warn "model 不能为空。"
    done
    base_url=""
    image_protocol=""
    if [ "$provider" = "openai" ]; then
      ask base_url "  ${capability} 的 base_url（可留空用官方端点；只接受 https，明文 http 仅限本机）："
      if [ "$capability" = "image" ]; then
        while true; do
          ask image_protocol "  image 的 image_protocol（openai / openai-standard / xai）："
          case "$image_protocol" in openai|openai-standard|xai) break ;; esac
          warn "只接受 openai、openai-standard 或 xai。"
        done
      fi
    fi
    # 逐字段导出成环境变量，交给 Bun 拼 JSON：api_key 里可能有任何字符，
    # 在 shell 里手工拼 JSON 迟早会拼出一份解析不了的配置。
    export "CN_${capability_key}_PROVIDER=${provider}"
    export "CN_${capability_key}_API_KEY=${api_key}"
    export "CN_${capability_key}_MODEL=${model}"
    export "CN_${capability_key}_BASE_URL=${base_url}"
    export "CN_${capability_key}_IMAGE_PROTOCOL=${image_protocol}"
    CONFIGURED_CAPABILITIES+=("$capability")
  done

  printf '\n'
  if [ "${#CONFIGURED_CAPABILITIES[@]}" -eq 0 ]; then
    rm -f config/agent.json
    info "一项都没配，已移除 config/agent.json；AI 相关功能保持不可用。"
  else
    CN_AGENT_CAPABILITIES="$(IFS=,; printf '%s' "${CONFIGURED_CAPABILITIES[*]}")" \
    bun -e '
      const names = (process.env.CN_AGENT_CAPABILITIES ?? "").split(",").filter(Boolean);
      const agent = {};
      for (const name of names) {
        const prefix = `CN_${name.toUpperCase()}_`;
        const entry = {
          provider: process.env[`${prefix}PROVIDER`],
          api_key: process.env[`${prefix}API_KEY`],
        };
        const baseUrl = process.env[`${prefix}BASE_URL`] ?? "";
        if (baseUrl.length > 0) entry.base_url = baseUrl;
        entry.model = process.env[`${prefix}MODEL`];
        const imageProtocol = process.env[`${prefix}IMAGE_PROTOCOL`] ?? "";
        if (imageProtocol.length > 0) entry.image_protocol = imageProtocol;
        agent[name] = entry;
      }
      process.stdout.write(`${JSON.stringify({ agent }, null, 2)}\n`);
    ' > config/agent.json.tmp || { rm -f config/agent.json.tmp; die "生成 agent.json 失败。"; }
    mv -- config/agent.json.tmp config/agent.json
    chmod 600 config/agent.json
    info "已写入 config/agent.json（权限 600）：${CONFIGURED_CAPABILITIES[*]}"
    for required_capability in "${AGENT_REQUIRED_CAPABILITIES[@]}"; do
      case " ${CONFIGURED_CAPABILITIES[*]} " in
        *" ${required_capability} "*) ;;
        *) warn "缺少 ${required_capability}：AI 闲聊 /ai_chat enable 会被拒绝。" ;;
      esac
    done
  fi
elif [ "$AGENT_CONFIG_WAS_CREATED" -eq 1 ]; then
  # 示例里的 api_key 是占位串，留着只会让人以为配好了；缺文件才是诚实的状态。
  rm -f config/agent.json
  info "已移除示例 config/agent.json；AI 相关功能保持不可用，之后可从 config_example/agent.json 复制填好再重启。"
fi

if [ ! -e g-auth.json ]; then
  info "未发现 g-auth.json：/ja_copy 日语翻译不可用。需要的话把 GCP 服务账号密钥放到仓库根再重启。"
fi

# --------------------------------------------------------------------------
step "7/7 初始化身份数据库并启动"
# --------------------------------------------------------------------------

# 身份库的真实位置由 packages/consts/paths.ts 决定：缺省是仓库根，设了
# COPY_NINJIA_DATA_ROOT 就在那个根下。这里向它要一次，不自己拼相对路径——
# 拼死的话，配了独立数据根的部署会在错误的目录上做存在性判断、建目录和 chmod，
# 而库其实建到了别处。顺带：那个变量存在但为空时，这一步就会当场报错。
IDENTITY_DATABASE_FILE="$(bun -e '
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
  process.stdout.write(IDENTITY_DATABASE_PATH);
')" || die "无法解析身份数据库路径。"
IDENTITY_DATABASE_DIR="$(dirname -- "$IDENTITY_DATABASE_FILE")"

if [ -e "$IDENTITY_DATABASE_FILE" ]; then
  info "${IDENTITY_DATABASE_FILE} 已存在，不动它。"
else
  mkdir -p -- "$IDENTITY_DATABASE_DIR"
  # 运行时按设计不会凭缺失数据库猜出一份空名单，所以全新部署必须显式建库。
  # 直接复用生产建库入口，不另写一份建表逻辑。
  #
  # createStorageDatabase 只建表：storage_metadata 的 schema-version 行不在
  # migration 里（0001/0002 只 UPDATE 它，空表上是 no-op），必须由建库方补。
  # 漏掉这一行，库建出来是好的，但启动 hydrate 会以「storage_metadata must
  # contain exactly one schema-version row」拒绝——错误出现在下一步，很难往回
  # 想到是建库少了一笔。
  bun -e '
    import { createStorageDatabase } from "./packages/database/interact/migration";
    import {
      closeStorageDatabase,
      enableStorageDatabaseWal,
      openStorageDatabase,
    } from "./packages/database/interact/connection";
    import { seedStorageDatabase } from "./packages/database/interact/admin";
    import {
      IDENTITY_DATABASE_SCHEMA_DATA,
      IDENTITY_DATABASE_SCHEMA_KEY,
    } from "./packages/consts/identityStorage";
    import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
    createStorageDatabase(IDENTITY_DATABASE_PATH);
    const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
    try {
      seedStorageDatabase(database, {
        metadata: [{
          key: IDENTITY_DATABASE_SCHEMA_KEY,
          data: IDENTITY_DATABASE_SCHEMA_DATA,
        }],
        whitelist: [],
        blocklist: [],
        removals: [],
      });
    } finally {
      closeStorageDatabase(database);
    }
    enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
  ' || die "创建 database/storage.sqlite 失败。"
  # 与 packages/consts/identityStorage.ts 的 IDENTITY_DATABASE_{DIRECTORY,FILE}_MODE 一致：
  # setgid 让 WAL/SHM 旁路文件继承同一个协作组。
  chmod 2770 -- "$IDENTITY_DATABASE_DIR"
  chmod 660 -- "$IDENTITY_DATABASE_FILE"
  info "已建立空的 ${IDENTITY_DATABASE_FILE}（黑白名单为空）。"
fi

# 配置全部就位之后、对外提供服务之前，跑一次和启动总闸同一份校验：
# 有问题现在就点名文件与字段，好过启动后进重启循环。
info "校验已存在的部署输入……"
bun -e '
  import { validateExistingDeploymentInputs } from "./packages/config/readiness";
  validateExistingDeploymentInputs();
' || die "部署输入校验未通过。按上面报出的文件与字段路径修好后重跑本脚本。"
info "配置校验通过。"

printf '\n'
info "首次启动前还需要在 BotFather 侧关闭 Privacy Mode 并开启 Inline Mode。"
info "机器人进群后，由超级管理员在群里执行 /init enable 打开本群业务入口——未 init 的群，普通业务 update 在入口网关直接丢弃。"
info "其余三个开关都是可选、缺省关闭：/ai_chat enable（AI 闲聊）、/ad_detect enable（广告检测）、/antiraid enable（入群验证与防冲群）。"
info "/ad_detect 与 /antiraid 还要求机器人在本群是管理员，否则打开了也不会真正触发。"
printf '\n==> 启动（Ctrl-C 停止；下次直接用 bun run start）\n\n'
exec bun run start
