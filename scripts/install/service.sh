#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

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

# 按 packages/consts/paths.ts 解析当前进程环境下的运行时数据根。
resolve_runtime_data_root() {
  bun -e '
    import { RUNTIME_DATA_ROOT } from "./packages/consts/paths";
    await Bun.write(Bun.stdout, RUNTIME_DATA_ROOT);
  '
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
# 权限不足）时返回非零，调用方拒绝确认稳定并保留备份。
service_journal_since() {
  local cursor="$1" since="$2"
  command -v journalctl >/dev/null 2>&1 || return 1
  if [ -n "$cursor" ]; then
    run_privileged journalctl -u "${SERVICE_NAME}.service" \
      --after-cursor "$cursor" --output=cat --no-pager 2>/dev/null
  else
    run_privileged journalctl -u "${SERVICE_NAME}.service" \
      --since "$since" --output=cat --no-pager 2>/dev/null
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
# 原地写入前核对既有 unit 生效的 COPY_NINJIA_DATA_ROOT（含 drop-in）与安装器环境一致；
# 身份库、部署输入校验和重写的 unit 都按安装器环境定位数据根。两侧同时缺省，或
# 都设置且经 packages/consts/paths.ts 解析为同一路径时放行，其余情况拒绝继续。
# 参数是安装器环境已解析的数据根，未设置该变量时传空串。
# `systemctl show -p Environment --value` 以单个空格分隔各项；含空白或 shell 特殊
# 字符的项整体加双引号，其中 " \ ` $ 前加反斜线，控制字符与非法 UTF-8 字节写成
# C 转义。解析器按这一格式逐项还原，格式不符或该变量值含控制字符时拒绝继续。
verify_service_data_root() {
  local installer_root="$1" load="" environment="" unit_entry="" unit_value="" unit_root=""
  local property="" value=""
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    return 0
  fi
  load="$(systemctl show "${SERVICE_NAME}.service" -p LoadState --value)" ||
    die "无法查询服务状态，拒绝修改部署。请按运维流程确认服务 inactive 后更新。"
  if [ "$load" = not-found ]; then
    return 0
  fi
  # 环境文件可能覆盖 Environment，传入与删除规则也会改变最终数据根。
  # 无法从静态 Environment 证明一致的 unit 必须先由部署方整理环境来源。
  for property in EnvironmentFiles PassEnvironment UnsetEnvironment; do
    value="$(systemctl show "${SERVICE_NAME}.service" -p "$property" --value)" ||
      die "${SERVICE_UNIT_PATH}: ${property} 必须可读取，拒绝修改部署。"
    case "$property:$value" in
      EnvironmentFiles:?*|PassEnvironment:*COPY_NINJIA_DATA_ROOT*|UnsetEnvironment:*COPY_NINJIA_DATA_ROOT*)
        die "${SERVICE_UNIT_PATH}: ${property} 必须不参与 COPY_NINJIA_DATA_ROOT 解析；请先将数据根明确配置在 Environment 中。"
        ;;
    esac
  done
  environment="$(systemctl show "${SERVICE_NAME}.service" -p Environment --value)" ||
    die "无法读取 ${SERVICE_UNIT_PATH} 的 Environment，拒绝修改部署。"
  unit_entry="$(bun -e '
    const input = Bun.argv[1];
    const prefix = `${Bun.argv[2]}=`;
    const escapes = { "\"": "\"", "\\": "\\", "`": "`", "$": "$", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    let offset = 0;
    let value;
    while (offset < input.length) {
      let item = "";
      if (input[offset] === "\"") {
        offset += 1;
        while (input[offset] !== "\"") {
          if (offset >= input.length) throw new Error("systemd Environment property has an unterminated quoted item.");
          if (input[offset] !== "\\") {
            item += input[offset];
            offset += 1;
            continue;
          }
          const escaped = input[offset + 1];
          if (escaped !== undefined && Object.hasOwn(escapes, escaped)) {
            item += escapes[escaped];
            offset += 2;
            continue;
          }
          if (!/^[0-7]{3}$/.test(input.slice(offset + 1, offset + 4))) {
            throw new Error("systemd Environment property has an invalid escape sequence.");
          }
          item += "\0";
          offset += 4;
        }
        offset += 1;
      } else {
        const end = input.indexOf(" ", offset);
        item = input.slice(offset, end === -1 ? input.length : end);
        if (item.length === 0 || /["\\]/.test(item)) {
          throw new Error("systemd Environment property has an invalid unquoted item.");
        }
        offset += item.length;
      }
      if (offset < input.length) {
        if (input[offset] !== " " || offset + 1 === input.length) {
          throw new Error("systemd Environment property items must be separated by single spaces.");
        }
        offset += 1;
      }
      if (item.startsWith(prefix)) {
        if (value !== undefined) throw new Error(`systemd Environment property repeats ${prefix}`);
        value = item.slice(prefix.length);
      }
    }
    if (value === undefined) {
      await Bun.write(Bun.stdout, "unset");
    } else if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`systemd Environment ${prefix} must not contain control characters.`);
    } else {
      await Bun.write(Bun.stdout, `=${value}`);
    }
  ' "$environment" COPY_NINJIA_DATA_ROOT)" ||
    die "${SERVICE_UNIT_PATH}: Environment 必须是 systemctl show 可解析的环境列表，且 COPY_NINJIA_DATA_ROOT 不含控制字符；拒绝修改部署。"
  case "$unit_entry" in
    unset)
      [ -z "$installer_root" ] ||
        die "${SERVICE_UNIT_PATH}: Environment.COPY_NINJIA_DATA_ROOT 与安装环境必须同时缺省或显式解析为同一数据根。"
      ;;
    =*)
      unit_value="${unit_entry#=}"
      [ -n "$installer_root" ] ||
        die "${SERVICE_UNIT_PATH}: Environment.COPY_NINJIA_DATA_ROOT 与安装环境必须同时缺省或显式解析为同一数据根。"
      unit_root="$(COPY_NINJIA_DATA_ROOT="$unit_value" resolve_runtime_data_root)" ||
        die "${SERVICE_UNIT_PATH}: Environment 的 COPY_NINJIA_DATA_ROOT 必须是非空路径；拒绝修改部署。"
      [ "$unit_root" = "$installer_root" ] ||
        die "${SERVICE_UNIT_PATH}: Environment.COPY_NINJIA_DATA_ROOT 与安装环境必须同时缺省或显式解析为同一数据根。"
      ;;
    *)
      die "${SERVICE_UNIT_PATH}: Environment 的 COPY_NINJIA_DATA_ROOT 无法确认；拒绝修改部署。"
      ;;
  esac
}

# 观察覆盖两次重启等待上限（含退避与随机延迟），另留两秒。
service_observation_seconds() {
  local interval="" steps="" maximum="" randomized=""
  interval="$(systemctl show "${SERVICE_NAME}.service" -p RestartUSec --value)" || return 1
  [ -n "$interval" ] || return 1
  steps="$(systemctl show "${SERVICE_NAME}.service" -p RestartSteps --value)" || return 1
  randomized="$(systemctl show "${SERVICE_NAME}.service" -p RestartRandomizedDelayUSec --value)" || return 1
  if [ -n "$steps" ] && [ "$steps" != 0 ]; then
    [[ "$steps" =~ ^[0-9]+$ ]] || return 1
    maximum="$(systemctl show "${SERVICE_NAME}.service" -p RestartMaxDelayUSec --value)" || return 1
    [ -n "$maximum" ] || return 1
  fi
  bun -e '
    const units = { us: 0.000001, "μs": 0.000001, ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, w: 604800, month: 2629800, y: 31557600 };
    function seconds(input) {
      if (input === "0") return 0;
      let rest = input.trim(), total = 0;
      if (!rest) throw new Error("RestartUSec must be a finite systemd duration.");
      while (rest) {
        const part = /^(\d+(?:\.\d+)?)\s*(us|μs|ms|min|month|s|h|d|w|y)(?:\s*|$)/.exec(rest);
        if (!part) throw new Error("RestartUSec must be a finite systemd duration.");
        total += Number(part[1]) * units[part[2]];
        rest = rest.slice(part[0].length);
      }
      return total;
    }
    const base = seconds(Bun.argv[1]), maximum = Bun.argv[2], randomized = Bun.argv[3];
    const ceiling = maximum && maximum !== "infinity" ? seconds(maximum) : base;
    const bound = base > 0 ? Math.max(base, ceiling) : base;
    const delay = Math.ceil(2 * (bound + (randomized ? seconds(randomized) : 0))) + 2;
    if (!Number.isSafeInteger(delay)) throw new Error("RestartUSec must fit a safe observation duration.");
    console.log(delay);
  ' "$interval" "$maximum" "$randomized"
}
