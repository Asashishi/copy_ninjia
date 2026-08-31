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
# 装的是 GitHub 上的 Latest Release：tag 取自 releases/latest 接口，取不到即失败退出。
# 已存在的工作树保持原有 checkout 不动，只报告当前版本。
#
# `curl | bash` 取到的脚本来自 master，代码来自 release tag；脚本跑完，装出来的代码
# 是该 release 的。
#
# 假设机器上什么都没装：缺 git/curl/unzip 会用系统包管理器补齐，缺仓库会 clone，
# 缺 Bun 会装官方发行版。唯一不代劳的是 /ja_copy 用的 g-auth.json：那是 GCP 服务
# 账号密钥，只能从控制台下载后带外传到机器上，问答里没法「输入」，因此当成前置
# 条件而不是脚本里的一步。
#
# 已经 clone 过仓库时，在仓库根跑 `bash install.sh` 等价，会跳过 clone 那一步。
# 源码若是解压发布包得到的（有源码、没有 .git），会就地补出 git 仓库并把 HEAD
# 指到与现有文件逐字一致的那个 tag，好让此后能用 git 更新；补仓库只动 .git 与
# 索引，不改工作树里任何已有文件。

set -Eeuo pipefail

readonly REPOSITORY_URL="https://github.com/Asashishi/copy_ninjia.git"
# Latest Release 的来源接口。
readonly RELEASE_API_URL="https://api.github.com/repos/Asashishi/copy_ninjia/releases/latest"
readonly SERVICE_NAME="copy-ninjia"
readonly SERVICE_UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
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

# 配置写入的临时文件与外部备份只属于本次安装进程。临时文件退出即清，外部
# 备份只有在 systemd 启动稳定性全部核验后才删；前台运行或任何失败都会保留。
CONFIG_STAGING_PATHS=()
CONFIG_BACKUP_TARGETS=()
CONFIG_CREATED_PATHS=()
CONFIG_BACKUP_DIRECTORY=""
CONFIG_BACKUP_MANIFEST=""
CONFIG_CHANGED=0

step() { printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    [注意] %s\n' "$1" >&2; }
die() { printf '\n[失败] %s\n' "$1" >&2; exit 1; }

# 把一个已解析的环境变量值写成 systemd Environment= 单项。
# systemd 会先按双引号规则反转义，再展开 `%` specifier；因此反斜线、双引号和
# 百分号必须分别转义。控制字符不是 systemd 环境值允许的输入，直接拒绝。
systemd_environment_assignment() {
  local variable_name="$1" value="$2" escaped_value=""
  [[ "$variable_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    die "无法生成 systemd 环境变量：名称不合法。"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    die "无法生成 systemd 环境变量 ${variable_name}：路径包含控制字符。"
  fi
  escaped_value="${value//\\/\\\\}"
  escaped_value="${escaped_value//\"/\\\"}"
  escaped_value="${escaped_value//%/%%}"
  printf 'Environment="%s=%s"' "$variable_name" "$escaped_value"
}

# 观察窗口开始处的 journal 游标；后面只读这一点之后新增的条目。
# unit 从来没写过日志（全新安装）时没有游标可取，返回空串——那种情况下这条 unit
# 的**全部**条目都是本次装出来的，调用方读全量即可，不会把旧崩溃算到本次头上。
service_journal_cursor() {
  # 末尾的 `|| true` 是必需的：pipefail 下 journalctl 失败会让整条管道非零，而
  # 调用点是 `CURSOR="$(service_journal_cursor)"`，赋值失败会被 set -e 当场打死。
  # 取不到游标只是「读全量」，不是安装失败。
  {
    run_privileged journalctl -u "${SERVICE_NAME}.service" -n 0 --show-cursor --no-pager 2>/dev/null |
      sed -n 's/^-- cursor: *//p' |
      tail -n 1
  } || true
}

# 观察窗口内该 unit 的新增 journal 正文。读不到（没有 journalctl、journald 未启用、
# 权限不足）时返回非零，调用方据此降级成提示，绝不把「读不到」判成「失败」。
service_journal_since() {
  local cursor="$1"
  command -v journalctl >/dev/null 2>&1 || return 1
  if [ -n "$cursor" ]; then
    run_privileged journalctl -u "${SERVICE_NAME}.service" \
      --after-cursor "$cursor" --output=cat --no-pager 2>/dev/null
  else
    run_privileged journalctl -u "${SERVICE_NAME}.service" \
      --output=cat --no-pager 2>/dev/null
  fi
}

# 从 journal 正文里挑出 systemd 记的非零退出。
# `code=exited, status=0/SUCCESS` 是正常停止，不算；非 0 状态码、以及被信号杀掉的
# `code=killed` / `code=dumped` 都算。这是 AGENTS.md 要求的「journal 无新增非零退出」
# 那一条的判据，与 NRestarts 增量互为交叉验证：重启计数只在 systemd 真的拉起下一次
# 时才涨，而「退出了但没被拉起来」只在这里留痕。
journal_nonzero_exit_lines() {
  grep -E 'code=exited, status=0*[1-9][0-9]*|code=(killed|dumped)' || true
}

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

# 这棵工作树自己是不是一个 git 仓库根。
#
# 刻意不只看 `.git` 存不存在，也不接受「恰好落在别的仓库的子目录里」——那种情况
# 更新时动的是外层那个仓库，不是这份部署。两边都取物理路径再比，避免符号链接
# 让同一个目录比出两种写法。
is_git_repository_root() {
  local target="" toplevel=""
  target="$(cd -- "$1" 2>/dev/null && pwd -P)" || return 1
  toplevel="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ "$toplevel" = "$target" ]
}

# 工作树没有 git 仓库时就地补一个，好让部署方此后能用 git 更新。
#
# 解压发布包（或整目录拷贝）得到的源码满足 is_repository_root 却没有 `.git`，
# 于是 clone 那一步被跳过，装出来的部署此后只能靠手工换文件更新。这里补上。
#
# **本函数不写工作树里的任何文件，也不把工作树里的文件收进对象库**，这是它敢在
# 一棵已经装好的部署上运行的前提：init 只建 `.git`，remote/fetch 只落 config 与
# 远端对象，read-tree / update-index 只动索引，diff-index / rev-parse / tag 只读，
# update-ref 只动 HEAD，而 `reset --mixed` 按定义就是「重置索引但不动工作树」。
#
# 失败一律降级而不是中断安装：装不上 git、拉不到 tag 都只是拿不到「能更新」这个
# 附加好处，不该把一次本来能成功的安装掀翻。
ensure_git_repository() {
  is_git_repository_root "$PWD" && return 0

  warn "这棵工作树没有 git 仓库（多半是解压发布包得到的），照现状此后没法用 git 更新。"
  if ! command -v git >/dev/null 2>&1; then
    info "缺少 git，尝试用系统包管理器安装……"
    if ! install_system_packages git || ! command -v git >/dev/null 2>&1; then
      warn "装不上 git，跳过建立仓库。此后更新只能手工替换文件。"
      return 0
    fi
  fi

  info "就地建立 git 仓库（只动 .git 与索引，不改任何已有文件）……"
  if ! git init --quiet; then
    warn "git init 失败（多半是对 ${PWD} 没有写权限），跳过建立仓库。"
    return 0
  fi
  if ! git remote get-url origin >/dev/null 2>&1 && ! git remote add origin "$REPOSITORY_URL"; then
    warn "设置 origin 失败，跳过建立仓库。"
    return 0
  fi

  info "拉取 ${REPOSITORY_URL} 的 tag（首次要下整段历史，会慢一会儿）……"
  if ! git fetch --tags --quiet origin; then
    warn "拉不到 tag（网络或限流）。仓库与 origin 已就绪，联网后自行 git fetch --tags。"
    return 0
  fi

  # 按**逐个 tag 比对内容**认版本，不按版本号猜：对上了才敢把 HEAD 指过去，
  # 那之后 `git status` 是干净的，更新就是一次普通的 fetch + checkout。
  #
  # 刻意不用 `git add --all` + `write-tree` 求工作树哈希：`add` 会为每个未被
  # .gitignore 排除的文件写一个 blob 进对象库，而这棵树里躺着 config/、
  # g-auth.json、state.json 这些部署数据——一旦 .gitignore 有缺口，密钥就进了
  # 仓库。`read-tree` 只读 tag 自带的对象，`diff-index` 只比该 tag 跟踪的那些
  # 文件、完全无视未跟踪文件，两条都不会把部署数据收进来。
  #
  # 代价是每个 tag 要比一遍内容；发布 tag 数量有限，装一次多花几秒可以接受。
  local candidate="" matched="" head_commit=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    git read-tree "${candidate}^{tree}" 2>/dev/null || continue
    # 先刷新 stat 信息：read-tree 之后索引对每个文件都是 stat-dirty 的，
    # 不刷新的话 `diff-index --quiet` 会仅因 stat 不同就报「有差异」。
    git update-index -q --refresh >/dev/null 2>&1 || true
    if git diff-index --quiet "${candidate}^{tree}" --; then
      matched="$candidate"
      break
    fi
  done < <(git tag --list)

  # 索引此刻还留着最后一个候选 tag 的内容；无论对上与否都要先复位，免得
  # 留下一份与 HEAD 对不上的索引，让部署方第一次 git status 就看到一片假差异。
  if [ -z "$matched" ]; then
    # 对不上任何已发布 tag：改过，或根本不是发布包。仓库给到位，但不替部署方
    # 决定 HEAD 指向哪个版本——猜错会让此后每次 git status 都是一片假差异。
    git read-tree --empty >/dev/null 2>&1 || true
    warn "工作树与任何已发布 tag 都对不上（改过，或不是发布包）。"
    warn "仓库与 origin/tags 已就绪，但 HEAD 未指向任何版本；核对后自行 git checkout <tag>。"
    return 0
  fi

  # 对上了：HEAD 指到该 tag 并让索引跟上，得到与 `clone --branch <tag>` 相同的
  # detached 状态。三条命令都不写工作树文件。
  head_commit="$(git rev-parse --verify "${matched}^{commit}" 2>/dev/null)" || head_commit=""
  if [ -z "$head_commit" ] ||
    ! git update-ref --no-deref HEAD "$head_commit" ||
    ! git reset --mixed --quiet; then
    git read-tree --empty >/dev/null 2>&1 || true
    warn "把 HEAD 指到 ${matched} 失败。仓库与 origin/tags 已就绪，自行 git checkout ${matched} 即可。"
    return 0
  fi
  info "git 仓库已就绪，HEAD 指向 ${matched}，与现有文件逐字一致；此后 git fetch --tags 再 checkout 新 tag 即可更新。"
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

# 软链接配置沿用其实际写入目标，避免原子替换将部署方软链接改成普通文件。
resolve_config_target_path() {
  local target_path="$1" result_name="$2" resolved_path=""
  if [ -L "$target_path" ]; then
    resolved_path="$(readlink -f -- "$target_path")" ||
      die "无法解析配置软链接：${target_path}。"
    [ -n "$resolved_path" ] || die "配置软链接没有可写目标：${target_path}。"
  else
    resolved_path="$target_path"
  fi
  printf -v "$result_name" '%s' "$resolved_path"
}

# 在实际写入目标同目录创建 0600 临时文件，使最后一步 mv 是同文件系统原子替换。
create_config_staging_path() {
  local target_path="$1" result_name="$2" target_directory="" target_name="" generated_path=""
  target_directory="$(dirname -- "$target_path")"
  target_name="$(basename -- "$target_path")"
  generated_path="$(mktemp "${target_directory}/.${target_name}.install.XXXXXX")" ||
    die "无法为 ${target_path} 创建配置临时文件。"
  CONFIG_STAGING_PATHS+=("$generated_path")
  chmod 600 -- "$generated_path" || die "无法收紧 ${target_path} 临时文件权限。"
  printf -v "$result_name" '%s' "$generated_path"
}

# 新建示例配置也先完整复制到同目录临时文件，避免中断留下半份 JSON。
create_config_from_example() {
  local source_path="$1" target_path="$2" staging_path="" source_mode=""
  local current_umask="" target_mode="" resolved_target_path=""
  resolve_config_target_path "$target_path" resolved_target_path
  create_config_staging_path "$resolved_target_path" staging_path
  cp -- "$source_path" "$staging_path" ||
    die "复制 ${source_path} 失败。"
  source_mode="$(stat -c '%a' -- "$source_path")" || die "无法读取 ${source_path} 权限。"
  current_umask="$(umask)"
  printf -v target_mode '%03o' \
    "$(( (8#$source_mode & 0777) & (~8#$current_umask & 0777) ))"
  chmod "$target_mode" -- "$staging_path" || die "无法设置 ${target_path} 权限。"
  mv -- "$staging_path" "$resolved_target_path" || die "建立 ${target_path} 失败。"
  CONFIG_CREATED_PATHS+=("$resolved_target_path")
  CONFIG_CHANGED=1
}

# 第一次覆盖部署配置前，在工作树外留一份带清单的原件；无法保留属主时仍逐份
# 核对 SHA-256，原属主记录在 manifest 里供恢复时使用。
backup_deployment_config() {
  local target_path="$1" existing_target="" backup_parent="" backup_parent_real=""
  local worktree_real="" backup_path="" source_hash="" backup_hash=""
  local original_mode="" original_uid="" original_gid=""
  [ -e "$target_path" ] || return 0
  for existing_target in "${CONFIG_CREATED_PATHS[@]}"; do
    [ "$existing_target" = "$target_path" ] && return 0
  done
  for existing_target in "${CONFIG_BACKUP_TARGETS[@]}"; do
    [ "$existing_target" = "$target_path" ] && return 0
  done

  if [ -z "$CONFIG_BACKUP_DIRECTORY" ]; then
    backup_parent="${TMPDIR:-/tmp}"
    [ -d "$backup_parent" ] || die "配置备份父目录不存在：${backup_parent}。"
    backup_parent_real="$(cd -- "$backup_parent" && pwd -P)" ||
      die "无法解析配置备份父目录：${backup_parent}。"
    worktree_real="$(pwd -P)"
    case "$backup_parent_real" in
      "$worktree_real"|"$worktree_real"/*)
        die "配置备份目录必须位于工作树外：${backup_parent_real}。"
        ;;
    esac
    CONFIG_BACKUP_DIRECTORY="$(mktemp -d "${backup_parent_real}/copy-ninjia-config-backup.XXXXXX")" ||
      die "无法创建工作树外配置备份目录。"
    chmod 700 -- "$CONFIG_BACKUP_DIRECTORY" || die "无法收紧配置备份目录权限。"
    CONFIG_BACKUP_MANIFEST="${CONFIG_BACKUP_DIRECTORY}/manifest.tsv"
    : > "$CONFIG_BACKUP_MANIFEST"
    chmod 600 -- "$CONFIG_BACKUP_MANIFEST" || die "无法收紧配置备份清单权限。"
  fi

  backup_path="${CONFIG_BACKUP_DIRECTORY}/original-${#CONFIG_BACKUP_TARGETS[@]}.json"
  if ! cp -p -- "$target_path" "$backup_path"; then
    rm -f -- "$backup_path"
    cp -- "$target_path" "$backup_path" ||
      die "备份 ${target_path} 失败。"
  fi
  source_hash="$(sha256sum -- "$target_path")" || die "无法计算 ${target_path} 的 SHA-256。"
  source_hash="${source_hash%% *}"
  backup_hash="$(sha256sum -- "$backup_path")" || die "无法计算 ${target_path} 备份的 SHA-256。"
  backup_hash="${backup_hash%% *}"
  [ "$source_hash" = "$backup_hash" ] || die "${target_path} 的备份 SHA-256 核对失败。"
  original_mode="$(stat -c '%a' -- "$target_path")" || die "无法读取 ${target_path} 权限。"
  original_uid="$(stat -c '%u' -- "$target_path")" || die "无法读取 ${target_path} 属主。"
  original_gid="$(stat -c '%g' -- "$target_path")" || die "无法读取 ${target_path} 属组。"
  printf '%s\tmode=%s\tuid=%s\tgid=%s\tsha256=%s\tbackup=%s\n' \
    "$target_path" "$original_mode" "$original_uid" "$original_gid" "$source_hash" \
    "$(basename -- "$backup_path")" >> "$CONFIG_BACKUP_MANIFEST"
  CONFIG_BACKUP_TARGETS+=("$target_path")
  info "已备份 ${target_path} 到 ${CONFIG_BACKUP_DIRECTORY}，SHA-256 已核对。"
}

# 目标内容已严格解析后才走这里；既有配置保持属主/属组，新文件固定为 0600，
# 原子替换时不会让服务账号失去原有读取能力，也没有宽权限窗口。
commit_staged_config() {
  local staging_path="$1" target_path="$2" target_uid="" target_gid=""
  local staging_uid="" staging_gid=""
  chmod 600 -- "$staging_path" || die "无法收紧 ${target_path} 候选文件权限。"
  if [ -e "$target_path" ]; then
    target_uid="$(stat -c '%u' -- "$target_path")" || die "无法读取 ${target_path} 属主。"
    target_gid="$(stat -c '%g' -- "$target_path")" || die "无法读取 ${target_path} 属组。"
    staging_uid="$(stat -c '%u' -- "$staging_path")" || die "无法读取 ${target_path} 候选文件属主。"
    staging_gid="$(stat -c '%g' -- "$staging_path")" || die "无法读取 ${target_path} 候选文件属组。"
    if [ "$staging_uid" != "$target_uid" ] || [ "$staging_gid" != "$target_gid" ]; then
      run_privileged chown "${target_uid}:${target_gid}" "$staging_path" ||
        die "无法保持 ${target_path} 的属主与属组，原文件未改动。"
    fi
  fi
  mv -- "$staging_path" "$target_path" || die "原子替换 ${target_path} 失败。"
  CONFIG_CHANGED=1
}

# 只验证候选 Telegram 文件，不读取部署目标 config/telegram.json。
#
# packages/config/telegram.ts 有模块级顶层 await：import 它就会按
# COPY_NINJIA_CONFIG_ROOT/telegram.json 严格加载一次，而那正是本函数要替换的
# 部署文件——全新安装时它还是示例占位符，损坏时更直接抛错，两种情况都会在候选
# 文件被看一眼之前就失败，并报成「候选校验未通过」。所以把配置根指向一个私有
# 临时目录，用符号链接把 telegram.json 指到候选文件：token 字节仍只存在于候选
# 文件里，不产生第二份副本，而模块自带的严格加载与随后的显式解析都作用在候选上。
validate_staged_telegram_config() {
  local staging_path="$1" probe_root="" probe_status=0 absolute_staging_path=""
  # 候选路径是相对仓库根的（resolve_config_target_path 对非软链接原样返回），
  # 而符号链接按所在目录解析，必须先转成绝对路径。
  absolute_staging_path="$(readlink -f -- "$staging_path")" ||
    die "无法解析 Telegram 候选文件的绝对路径。"
  [ -n "$absolute_staging_path" ] || die "Telegram 候选文件路径为空。"
  probe_root="$(mktemp -d)" || die "无法创建 Telegram 候选校验的临时配置根。"
  chmod 700 -- "$probe_root" || {
    rm -rf -- "$probe_root"
    die "无法收紧 Telegram 候选校验临时目录权限。"
  }
  ln -s -- "$absolute_staging_path" "${probe_root}/telegram.json" || {
    rm -rf -- "$probe_root"
    die "无法在临时配置根中引用 Telegram 候选文件。"
  }
  COPY_NINJIA_CONFIG_ROOT="$probe_root" bun -e '
    import { parseTelegramConfig } from "./packages/config/telegram";
    import { readJsonInput } from "./packages/libs/inputValidation";
    const path = process.argv[1];
    parseTelegramConfig(await readJsonInput(path), path);
  ' "$staging_path" || probe_status=$?
  rm -rf -- "$probe_root"
  return "$probe_status"
}

# agent 总闸本身接受路径参数，候选文件验证不会触碰部署目标。
# packages/config/agent.ts 没有顶层 await，import 无副作用；但总闸是 async，
# 必须 await，否则 bun -e 会在校验落地前退出。
validate_staged_agent_config() {
  local staging_path="$1"
  bun -e '
    import { validateAgentDeploymentConfig } from "./packages/config/agent";
    await validateAgentDeploymentConfig(process.argv[1]);
  ' "$staging_path"
}

# API key 只保存在问答局部变量和数组里；生成完成或失败后立即清空。
clear_agent_config_inputs() {
  unset api_key provider model base_url image_protocol
  unset AGENT_CONFIG_NAMES AGENT_CONFIG_PROVIDERS AGENT_CONFIG_API_KEYS
  unset AGENT_CONFIG_MODELS AGENT_CONFIG_BASE_URLS AGENT_CONFIG_IMAGE_PROTOCOLS
}

# EXIT 只清理尚未提交的候选文件；外部备份不能在失败路径被顺手删掉。
cleanup_install_staging() {
  local staging_path=""
  for staging_path in "${CONFIG_STAGING_PATHS[@]}"; do
    [ -n "$staging_path" ] && rm -f -- "$staging_path"
  done
  if [ -n "$CONFIG_BACKUP_DIRECTORY" ]; then
    warn "配置备份保留在 ${CONFIG_BACKUP_DIRECTORY}；核验或恢复后再手工删除。"
  fi
}
trap cleanup_install_staging EXIT

# 只有配置校验、ActiveState/SubState、重启计数与 journal 全部通过后才能清备份。
finalize_config_backup() {
  local backup_parent="" backup_name=""
  [ -n "$CONFIG_BACKUP_DIRECTORY" ] || return 0
  backup_parent="$(dirname -- "$CONFIG_BACKUP_DIRECTORY")"
  backup_name="$(basename -- "$CONFIG_BACKUP_DIRECTORY")"
  case "$backup_name" in
    copy-ninjia-config-backup.*) ;;
    *) die "拒绝清理无法识别的配置备份路径：${CONFIG_BACKUP_DIRECTORY}。" ;;
  esac
  rm -rf -- "${backup_parent}/${backup_name}" ||
    die "服务已稳定，但清理配置备份失败：${CONFIG_BACKUP_DIRECTORY}。"
  CONFIG_BACKUP_DIRECTORY=""
  CONFIG_BACKUP_MANIFEST=""
  CONFIG_BACKUP_TARGETS=()
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

# 三种到达方式：仓库根跑 `bash install.sh`、仓库外跑一份下载好的脚本、以及
# `curl | bash`。后者拿不到 BASH_SOURCE 对应的真实文件，所以按「脚本所在目录 ->
# 当前目录 -> clone」的顺序找工作树，不猜。
SCRIPT_DIRECTORY=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIRECTORY" ] && is_repository_root "$SCRIPT_DIRECTORY"; then
  cd -- "$SCRIPT_DIRECTORY"
  info "在脚本所在目录找到工作树：$(pwd)$(worktree_version_suffix)"
elif is_repository_root "$PWD"; then
  info "在当前目录找到工作树：$(pwd)$(worktree_version_suffix)"
elif is_repository_root "$PWD/$CLONE_TARGET"; then
  cd -- "$CLONE_TARGET"
  info "复用已存在的工作树：$(pwd)$(worktree_version_suffix)"
elif [ -e "$CLONE_TARGET" ]; then
  die "${PWD}/${CLONE_TARGET} 已存在但不是 Copy Ninjia 工作树。挪开它，或设 COPY_NINJIA_DIR 指定别的目录。"
else
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

# clone 那条分支天然带 .git，这里立刻返回；只有「解压发布包」那几种到达方式
# 会真的走进去补仓库。放在链尾统一调用，四条分支就不会各写一份。
ensure_git_repository

# --------------------------------------------------------------------------
step "3/8 基础工具与 Bun"
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
step "4/8 安装依赖"
# --------------------------------------------------------------------------

# 用锁文件安装：bun.lock 已进版本库，装出来的树必须和门禁跑过的那棵一致。
bun install --frozen-lockfile || die "bun install 失败。"
info "依赖安装完成。"

# --------------------------------------------------------------------------
step "5/8 准备配置目录"
# --------------------------------------------------------------------------

mkdir -p config
for example_file in config_example/*.json; do
  config_name="$(basename -- "$example_file")"
  if [ "$config_name" = "agent.json" ]; then
    # agent 示例含故意不可用的占位凭据；只有完成问卷后才生成部署文件。
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

# --------------------------------------------------------------------------
step "6/8 填写配置"
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
  TELEGRAM_CONFIG_STAGING_PATH=""
  TELEGRAM_CONFIG_TARGET_PATH=""
  resolve_config_target_path config/telegram.json TELEGRAM_CONFIG_TARGET_PATH
  create_config_staging_path "$TELEGRAM_CONFIG_TARGET_PATH" TELEGRAM_CONFIG_STAGING_PATH
  cat > "$TELEGRAM_CONFIG_STAGING_PATH" <<JSON
{
  "bot_token": "${BOT_TOKEN}",
  "super_admin_user_id": ${SUPER_ADMIN_USER_ID}
}
JSON
  unset BOT_TOKEN SUPER_ADMIN_USER_ID
  backup_deployment_config "$TELEGRAM_CONFIG_TARGET_PATH"
  validate_staged_telegram_config "$TELEGRAM_CONFIG_STAGING_PATH" ||
    die "候选 config/telegram.json 严格校验未通过，原文件未改动。"
  commit_staged_config "$TELEGRAM_CONFIG_STAGING_PATH" "$TELEGRAM_CONFIG_TARGET_PATH"
  info "已写入 config/telegram.json（权限 600）。"
fi

if [ -e config/agent.json ]; then
  info "保留既有 config/agent.json，未改动。"
elif confirm "现在配置 AI 能力（AI 闲聊、广告检测、生图、写歌）？不配也能启动。" n; then
  CONFIGURED_CAPABILITIES=()
  AGENT_CONFIG_NAMES=()
  AGENT_CONFIG_PROVIDERS=()
  AGENT_CONFIG_API_KEYS=()
  AGENT_CONFIG_MODELS=()
  AGENT_CONFIG_BASE_URLS=()
  AGENT_CONFIG_IMAGE_PROTOCOLS=()
  for capability in "${AGENT_CAPABILITIES[@]}"; do
    printf '\n'
    if ! confirm "配置 ${capability}？" n; then
      info "跳过 ${capability}。"
      continue
    fi
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
    CONFIGURED_CAPABILITIES+=("$capability")
    AGENT_CONFIG_NAMES+=("$capability")
    AGENT_CONFIG_PROVIDERS+=("$provider")
    AGENT_CONFIG_API_KEYS+=("$api_key")
    AGENT_CONFIG_MODELS+=("$model")
    AGENT_CONFIG_BASE_URLS+=("$base_url")
    AGENT_CONFIG_IMAGE_PROTOCOLS+=("$image_protocol")
    unset api_key provider model base_url image_protocol
  done

  printf '\n'
  if [ "${#CONFIGURED_CAPABILITIES[@]}" -eq 0 ]; then
    clear_agent_config_inputs
    info "一项都没配，未建立 config/agent.json；AI 相关功能保持不可用。"
  else
    AGENT_CONFIG_STAGING_PATH=""
    AGENT_CONFIG_TARGET_PATH=""
    resolve_config_target_path config/agent.json AGENT_CONFIG_TARGET_PATH
    create_config_staging_path "$AGENT_CONFIG_TARGET_PATH" AGENT_CONFIG_STAGING_PATH
    if ! {
      for capability_index in "${!AGENT_CONFIG_NAMES[@]}"; do
        printf '%s\0%s\0%s\0%s\0%s\0%s\0' \
          "${AGENT_CONFIG_NAMES[$capability_index]}" \
          "${AGENT_CONFIG_PROVIDERS[$capability_index]}" \
          "${AGENT_CONFIG_API_KEYS[$capability_index]}" \
          "${AGENT_CONFIG_MODELS[$capability_index]}" \
          "${AGENT_CONFIG_BASE_URLS[$capability_index]}" \
          "${AGENT_CONFIG_IMAGE_PROTOCOLS[$capability_index]}"
      done
    } | bun -e '
      const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
      const fields = new TextDecoder().decode(bytes).split("\0");
      fields.pop();
      if (fields.length === 0 || fields.length % 6 !== 0) {
        throw new Error("invalid agent config field stream");
      }
      const agent = {};
      for (let offset = 0; offset < fields.length; offset += 6) {
        const [name, provider, apiKey, model, baseUrl, imageProtocol] = fields.slice(offset, offset + 6);
        const entry = {
          provider,
          api_key: apiKey,
        };
        if (baseUrl.length > 0) entry.base_url = baseUrl;
        entry.model = model;
        if (imageProtocol.length > 0) entry.image_protocol = imageProtocol;
        agent[name] = entry;
      }
      await Bun.write(Bun.stdout, `${JSON.stringify({ agent }, null, 2)}\n`);
    ' > "$AGENT_CONFIG_STAGING_PATH"; then
      clear_agent_config_inputs
      die "生成 agent.json 失败。"
    fi
    clear_agent_config_inputs
    validate_staged_agent_config "$AGENT_CONFIG_STAGING_PATH" ||
      die "候选 config/agent.json 严格校验未通过，未建立部署文件。"
    commit_staged_config "$AGENT_CONFIG_STAGING_PATH" "$AGENT_CONFIG_TARGET_PATH"
    info "已写入 config/agent.json（权限 600）：${CONFIGURED_CAPABILITIES[*]}"
    for required_capability in "${AGENT_REQUIRED_CAPABILITIES[@]}"; do
      case " ${CONFIGURED_CAPABILITIES[*]} " in
        *" ${required_capability} "*) ;;
        *) warn "缺少 ${required_capability}：AI 闲聊 /ai_chat enable 会被拒绝。" ;;
      esac
    done
  fi
fi

if [ ! -e g-auth.json ]; then
  info "未发现 g-auth.json：/ja_copy 日语翻译不可用。需要的话把 GCP 服务账号密钥放到仓库根再重启。"
fi

# --------------------------------------------------------------------------
step "7/8 初始化身份数据库"
# --------------------------------------------------------------------------

# 身份库的真实位置由 packages/consts/paths.ts 决定：缺省是仓库根，设了
# COPY_NINJIA_DATA_ROOT 就在那个根下。这里向它要一次，不自己拼相对路径——
# 拼死的话，配了独立数据根的部署会在错误的目录上做存在性判断、建目录和 chmod，
# 而库其实建到了别处。顺带：那个变量存在但为空时，这一步就会当场报错。
IDENTITY_DATABASE_FILE="$(bun -e '
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
  await Bun.write(Bun.stdout, IDENTITY_DATABASE_PATH);
')" || die "无法解析身份数据库路径。"
IDENTITY_DATABASE_DIR="$(dirname -- "$IDENTITY_DATABASE_FILE")"

# systemd 的系统服务不会继承运行安装脚本的 shell 环境。只有部署方显式设置了
# COPY_NINJIA_DATA_ROOT 时才写 Environment=：缺省时继续让生产代码使用项目根，
# 不能把缺省根也写进去，否则会把 RUNTIME_DATA_ROOT_IS_CONFIGURED 错置为 true。
SYSTEMD_DATA_ROOT_ENVIRONMENT=""
if [ "${COPY_NINJIA_DATA_ROOT+x}" = "x" ]; then
  RESOLVED_RUNTIME_DATA_ROOT="$(bun -e '
    import { RUNTIME_DATA_ROOT } from "./packages/consts/paths";
    await Bun.write(Bun.stdout, RUNTIME_DATA_ROOT);
  ')" || die "无法解析运行时数据根。"
  SYSTEMD_DATA_ROOT_ENVIRONMENT="$(
    systemd_environment_assignment COPY_NINJIA_DATA_ROOT "$RESOLVED_RUNTIME_DATA_ROOT"
  )"
fi

if [ -e "$IDENTITY_DATABASE_FILE" ]; then
  info "${IDENTITY_DATABASE_FILE} 已存在，不动它。"
else
  mkdir -p -- "$IDENTITY_DATABASE_DIR"
  # 运行时按设计不会凭缺失数据库猜出一份空名单，所以全新部署必须显式建库。
  # 直接复用生产建库入口，不另写一份建表逻辑。
  #
  # createStorageDatabase 只建表；当前 schema-version 由初始化边界另写一笔。
  bun -e '
    import { createStorageDatabase } from "./packages/database/interact/migration";
    import {
      closeStorageDatabase,
      enableStorageDatabaseWal,
      openStorageDatabase,
    } from "./packages/database/interact/connection";
    import { initializeStorageDatabase } from
      "./packages/database/interact/initialization";
    import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
    createStorageDatabase(IDENTITY_DATABASE_PATH);
    const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
    try {
      initializeStorageDatabase(database);
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

# --------------------------------------------------------------------------
step "8/8 注册 systemd 服务并启动"
# --------------------------------------------------------------------------

# 没有可用 systemd 时（容器、非 systemd 发行版）跳过注册，改为前台运行。
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  warn "本机没有可用的 systemd，跳过服务注册。"
  if [ -n "$CONFIG_BACKUP_DIRECTORY" ]; then
    warn "前台进程无法自动完成稳定性观察；配置备份保留在 ${CONFIG_BACKUP_DIRECTORY}。"
  fi
  info "机器人将在前台运行；Ctrl-C 停止，下次直接用 bun run start。"
  printf '\n==> 启动\n\n'
  exec bun run start
fi

BUN_BINARY="$(command -v bun)" || die "找不到 bun 可执行文件。"
SERVICE_USER="$(id -un)"
SERVICE_WORKDIR="$(pwd)"

# 已存在的 unit 先问再覆盖。
WRITE_UNIT=1
if [ -e "$SERVICE_UNIT_PATH" ]; then
  info "${SERVICE_UNIT_PATH} 已存在。"
  confirm "覆盖它？（选 n 则保留现有 unit，只做 enable 与启动）" n || WRITE_UNIT=0
fi

# 保留现有 unit 时报告它实际的 WorkingDirectory 与 ExecStart。
if [ "$WRITE_UNIT" -eq 0 ]; then
  info "沿用现有 unit：$(systemctl show "${SERVICE_NAME}.service" -p WorkingDirectory --value)"
  info "                 $(systemctl show "${SERVICE_NAME}.service" -p ExecStart --value | head -c 160)"
fi

# NRestarts 是该 unit 的累计值，daemon-reload 不清零；这里记基线，后面比增量。
# 全新安装时 unit 还不存在，NRestarts 取回空串，补成 0 参与后面的比较。
RESTARTS_BEFORE="$(systemctl show "${SERVICE_NAME}.service" -p NRestarts --value 2>/dev/null)"
: "${RESTARTS_BEFORE:=0}"
# 与 NRestarts 基线同一时刻取 journal 游标，让两条判据覆盖同一个观察窗口。
JOURNAL_CURSOR="$(service_journal_cursor)"

if [ "$WRITE_UNIT" -eq 1 ]; then
  # 经 tee 写入，使 run_privileged 的提权作用于写文件的那个进程。
  printf '%s\n' \
    "[Unit]" \
    "Description=Copy Ninjia Telegram Bot" \
    "After=network-online.target" \
    "Wants=network-online.target" \
    "" \
    "[Service]" \
    "Type=simple" \
    "User=${SERVICE_USER}" \
    "WorkingDirectory=${SERVICE_WORKDIR}" \
    "${SYSTEMD_DATA_ROOT_ENVIRONMENT}" \
    "ExecStart=${BUN_BINARY} start" \
    "Restart=on-failure" \
    "RestartSec=5" \
    "" \
    "[Install]" \
    "WantedBy=multi-user.target" |
    run_privileged tee "$SERVICE_UNIT_PATH" >/dev/null ||
    die "写入 ${SERVICE_UNIT_PATH} 失败（需要 root 或 sudo）。"
  info "已写入 ${SERVICE_UNIT_PATH}（User=${SERVICE_USER}，WorkingDirectory=${SERVICE_WORKDIR}）。"
fi

run_privileged systemctl daemon-reload || die "systemctl daemon-reload 失败。"
run_privileged systemctl enable "${SERVICE_NAME}.service" ||
  die "启用 ${SERVICE_NAME}.service 失败。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
if [ "$CONFIG_CHANGED" -eq 1 ] || [ "$WRITE_UNIT" -eq 1 ]; then
  run_privileged systemctl restart "${SERVICE_NAME}.service" ||
    die "重启 ${SERVICE_NAME}.service 失败。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
else
  run_privileged systemctl start "${SERVICE_NAME}.service" ||
    die "启动 ${SERVICE_NAME}.service 失败。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
fi

# 观察至少两个重启间隔（RestartSec=5）后再判定，口径见 docs/cn/07-operations.md。
info "观察 ${SERVICE_NAME}.service 是否稳定（约 12 秒）……"
sleep 12
# systemctl show 是只读查询，不提权。
ACTIVE_STATE="$(systemctl show "${SERVICE_NAME}.service" -p ActiveState --value)"
SUB_STATE="$(systemctl show "${SERVICE_NAME}.service" -p SubState --value)"
RESTARTS_AFTER="$(systemctl show "${SERVICE_NAME}.service" -p NRestarts --value)"
if [ "$ACTIVE_STATE" != "active" ] || [ "$SUB_STATE" != "running" ]; then
  die "${SERVICE_NAME}.service 状态是 ${ACTIVE_STATE}/${SUB_STATE}，没有正常跑起来。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
fi
if [ "$RESTARTS_AFTER" -gt "$RESTARTS_BEFORE" ]; then
  die "${SERVICE_NAME}.service 在观察窗口内重启了 $((RESTARTS_AFTER - RESTARTS_BEFORE)) 次，说明启动后随即退出。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
fi

# NRestarts 只在 systemd 真的拉起下一次时才涨；启动后非零退出却没被拉起来（比如
# 配置校验失败被 Restart=on-failure 的次数上限挡住）不会改动那个计数，只在 journal
# 里留痕。两条判据都要过，口径见 docs/cn/07-operations.md。
# 收尾那行只能说这一轮真做过的事：核对不成时不得写成「journal 无非零退出」。
JOURNAL_VERDICT="、journal 无非零退出"
if JOURNAL_TAIL="$(service_journal_since "$JOURNAL_CURSOR")"; then
  NONZERO_EXITS="$(printf '%s\n' "$JOURNAL_TAIL" | journal_nonzero_exit_lines)"
  if [ -n "$NONZERO_EXITS" ]; then
    die "${SERVICE_NAME}.service 在观察窗口内记录了非零退出：${NONZERO_EXITS%%$'\n'*}。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
  fi
  finalize_config_backup
else
  JOURNAL_VERDICT="、journal 未能核对"
  warn "读不到 ${SERVICE_NAME}.service 的 journal（没有 journalctl、journald 未启用或权限不足），本次跳过非零退出核对。"
  info "请手动确认：journalctl -u ${SERVICE_NAME} -n 50"
fi

printf '\n'
info "${SERVICE_NAME}.service 运行中（${ACTIVE_STATE}/${SUB_STATE}，观察窗口内未重启${JOURNAL_VERDICT}），已设为开机自启。"
info "看日志：journalctl -u ${SERVICE_NAME} -f"
info "停止 / 重启：systemctl stop ${SERVICE_NAME} / systemctl restart ${SERVICE_NAME}"
