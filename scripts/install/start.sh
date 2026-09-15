#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

# --------------------------------------------------------------------------
step "7/8 初始化身份数据库"
# --------------------------------------------------------------------------

# 身份库的真实位置由 packages/consts/paths.ts 决定：缺省是仓库根，设了
# COPY_NINJIA_DATA_ROOT 就在那个根下。这里向它要一次，不自己拼相对路径——
# 拼死的话，配了独立数据根的部署会在错误的目录上做存在性判断、建目录和 chmod，
# 而库其实建到了别处。
IDENTITY_DATABASE_FILE="$(bun -e '
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
  await Bun.write(Bun.stdout, IDENTITY_DATABASE_PATH);
')" || die "无法解析身份数据库路径。"
IDENTITY_DATABASE_DIR="$(dirname -- "$IDENTITY_DATABASE_FILE")"

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
  await validateExistingDeploymentInputs();
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

verify_service_target "$SERVICE_WORKDIR"

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

# journal 游标覆盖 unit 写入与启动观察窗口。
JOURNAL_CURSOR="$(service_journal_cursor)"
JOURNAL_SINCE="$(date -u '+%Y-%m-%d %H:%M:%S.%6N UTC')"

if [ "$WRITE_UNIT" -eq 1 ]; then
  backup_deployment_config "$SERVICE_UNIT_PATH"
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
OBSERVATION_SECONDS="$(service_observation_seconds)" || die "无法确认服务实际重启间隔。"
run_privileged systemctl start "${SERVICE_NAME}.service" ||
  die "启动 ${SERVICE_NAME}.service 失败。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
# 手动 start 会清零停机前累计的 NRestarts，基线在 start 成功返回后读取。
RESTARTS_BEFORE="$(systemctl show "${SERVICE_NAME}.service" -p NRestarts --value 2>/dev/null)"
[[ "$RESTARTS_BEFORE" =~ ^[0-9]+$ ]] || die "无法确认服务重启计数。"

info "观察 ${SERVICE_NAME}.service 是否稳定（${OBSERVATION_SECONDS} 秒）……"
sleep "$OBSERVATION_SECONDS"
# systemctl show 是只读查询，不提权。
ACTIVE_STATE="$(systemctl show "${SERVICE_NAME}.service" -p ActiveState --value)"
SUB_STATE="$(systemctl show "${SERVICE_NAME}.service" -p SubState --value)"
RESTARTS_AFTER="$(systemctl show "${SERVICE_NAME}.service" -p NRestarts --value)"
if [ "$ACTIVE_STATE" != "active" ] || [ "$SUB_STATE" != "running" ]; then
  die "${SERVICE_NAME}.service 状态是 ${ACTIVE_STATE}/${SUB_STATE}，没有正常跑起来。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
fi
[[ "$RESTARTS_AFTER" =~ ^[0-9]+$ ]] || die "无法确认服务观察后的重启计数。"
if (( 10#$RESTARTS_AFTER < 10#$RESTARTS_BEFORE )); then
  die "${SERVICE_NAME}.service 的重启计数在观察窗口内从 ${RESTARTS_BEFORE} 回落到 ${RESTARTS_AFTER}，无法确认启动后是否重启。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
fi
if (( 10#$RESTARTS_AFTER != 10#$RESTARTS_BEFORE )); then
  die "${SERVICE_NAME}.service 在观察窗口内重启了 $((10#$RESTARTS_AFTER - 10#$RESTARTS_BEFORE)) 次，说明启动后随即退出。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
fi

# 重启计数与新增非零退出必须同时通过；失败保留备份。
if JOURNAL_TAIL="$(service_journal_since "$JOURNAL_CURSOR" "$JOURNAL_SINCE")"; then
  NONZERO_EXITS="$(printf '%s\n' "$JOURNAL_TAIL" | journal_nonzero_exit_lines)"
  if [ -n "$NONZERO_EXITS" ]; then
    die "${SERVICE_NAME}.service 在观察窗口内记录了非零退出：${NONZERO_EXITS%%$'\n'*}。用 journalctl -u ${SERVICE_NAME} -n 50 看原因。"
  fi
  finalize_config_backup
else
  die "journal 未能核对，无法确认服务稳定；保留配置备份与现场。请按运维流程核验。"
fi

printf '\n'
info "${SERVICE_NAME}.service 运行中（${ACTIVE_STATE}/${SUB_STATE}，观察窗口内未重启、journal 无非零退出），已设为开机自启。"
info "看日志：journalctl -u ${SERVICE_NAME} -f"
info "停止 / 重启：systemctl stop ${SERVICE_NAME} / systemctl restart ${SERVICE_NAME}"
