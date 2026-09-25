#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

# config_example/agent.json 里的六项 AI 能力，顺序与示例一致。
readonly AGENT_CAPABILITIES=(ad_detect text summary media image tts)
# AI 闲聊的必备能力；缺任意一项，/ai_chat enable 会被拒绝。
readonly AGENT_REQUIRED_CAPABILITIES=(text summary media)

# 配置写入的临时文件与外部备份只属于本次安装进程。临时文件退出即清，外部
# 备份只有在 systemd 启动稳定性全部核验后才删；前台运行或任何失败都会保留。
CONFIG_STAGING_PATHS=()
CONFIG_BACKUP_TARGETS=()
CONFIG_CREATED_PATHS=()
CONFIG_BACKUP_DIRECTORY=""
CONFIG_BACKUP_MANIFEST=""

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

# 目标内容已严格解析后才走这里。第三个参数为 preserve 时替换部署方已填写过的既有
# 配置：候选文件在 0600 下先改成原属主/属组，mv 前才改成原文件 mode，因此候选内容
# 的可读范围从不超过原文件，服务账号也保留原有读取能力。为 new 时文件固定 0600，
# 目标已存在则只保留属主/属组。
commit_staged_config() {
  local staging_path="$1" target_path="$2" mode_policy="$3" target_uid="" target_gid=""
  local target_mode="" staging_uid="" staging_gid="" owner_changed=0
  case "$mode_policy" in
    preserve|new) ;;
    *) die "无法确认 ${target_path} 的权限策略。" ;;
  esac
  chmod 600 -- "$staging_path" || die "无法收紧 ${target_path} 候选文件权限。"
  if [ -e "$target_path" ]; then
    target_uid="$(stat -c '%u' -- "$target_path")" || die "无法读取 ${target_path} 属主。"
    target_gid="$(stat -c '%g' -- "$target_path")" || die "无法读取 ${target_path} 属组。"
    staging_uid="$(stat -c '%u' -- "$staging_path")" || die "无法读取 ${target_path} 候选文件属主。"
    staging_gid="$(stat -c '%g' -- "$staging_path")" || die "无法读取 ${target_path} 候选文件属组。"
    if [ "$staging_uid" != "$target_uid" ] || [ "$staging_gid" != "$target_gid" ]; then
      run_privileged chown "${target_uid}:${target_gid}" "$staging_path" ||
        die "无法保持 ${target_path} 的属主与属组，原文件未改动。"
      owner_changed=1
    fi
    if [ "$mode_policy" = preserve ]; then
      target_mode="$(stat -c '%a' -- "$target_path")" || die "无法读取 ${target_path} 权限。"
      if [ "$owner_changed" -eq 1 ]; then
        run_privileged chmod "$target_mode" "$staging_path" ||
          die "无法保持 ${target_path} 的权限，原文件未改动。"
      else
        chmod "$target_mode" -- "$staging_path" ||
          die "无法保持 ${target_path} 的权限，原文件未改动。"
      fi
    fi
  fi
  mv -- "$staging_path" "$target_path" || die "原子替换 ${target_path} 失败。"
}

# 只验证候选 Bot 文件内容；候选可能位于配置软链接的外部目标目录。
validate_staged_telegram_config() {
  local staging_path="$1"
  bun -e '
    import { validateStagedBotConfig } from "./scripts/install/runtime";
    await validateStagedBotConfig(Bun.argv[1]);
  ' "$staging_path"
}

# 等待 agent 总闸验证候选文件，不触碰部署目标。
validate_staged_agent_config() {
  local staging_path="$1"
  bun -e '
    import { validateAgentDeploymentConfig } from "./scripts/install/runtime";
    await validateAgentDeploymentConfig(Bun.argv[1]);
  ' "$staging_path"
}

# API key 只保存在问答局部变量和数组里；生成完成或失败后立即清空。
clear_agent_config_inputs() {
  unset api_key provider model base_url image_protocol voice
  unset AGENT_CONFIG_NAMES AGENT_CONFIG_PROVIDERS AGENT_CONFIG_API_KEYS
  unset AGENT_CONFIG_MODELS AGENT_CONFIG_BASE_URLS AGENT_CONFIG_IMAGE_PROTOCOLS AGENT_CONFIG_VOICES
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
