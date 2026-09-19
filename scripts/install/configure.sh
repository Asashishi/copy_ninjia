#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

# --------------------------------------------------------------------------
step "6/8 填写配置"
# --------------------------------------------------------------------------

# 首次填写（含仍是示例占位值的文件）固定 0600；重新填写已填过的文件沿用原 mode。
CONFIGURE_TELEGRAM=1
TELEGRAM_CONFIG_MODE_POLICY=new
if [ -e config/telegram.json ] &&
   ! grep -q 'replace-with-telegram-bot-token' config/telegram.json; then
  if confirm "config/telegram.json 已经填过，是否重新填写？" n; then
    TELEGRAM_CONFIG_MODE_POLICY=preserve
  else
    CONFIGURE_TELEGRAM=0
  fi
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
  commit_staged_config \
    "$TELEGRAM_CONFIG_STAGING_PATH" "$TELEGRAM_CONFIG_TARGET_PATH" "$TELEGRAM_CONFIG_MODE_POLICY"
  TELEGRAM_CONFIG_MODE="$(stat -c '%a' -- "$TELEGRAM_CONFIG_TARGET_PATH")" ||
    die "无法读取 config/telegram.json 权限。"
  info "已写入 config/telegram.json（权限 ${TELEGRAM_CONFIG_MODE}）。"
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
    commit_staged_config "$AGENT_CONFIG_STAGING_PATH" "$AGENT_CONFIG_TARGET_PATH" new
    info "已写入 config/agent.json（权限 600）：${CONFIGURED_CAPABILITIES[*]}"
    for required_capability in "${AGENT_REQUIRED_CAPABILITIES[@]}"; do
      case " ${CONFIGURED_CAPABILITIES[*]} " in
        *" ${required_capability} "*) ;;
        *) warn "缺少 ${required_capability}：AI 闲聊 /ai_chat enable 会被拒绝。" ;;
      esac
    done
  fi
fi

if [ ! -e config/g-auth.json ]; then
  info "未发现 config/g-auth.json：/translate 翻译不可用。需要的话把 GCP 服务账号密钥（结构见 config_example/g-auth.json）放到 config/ 再重启。"
fi
