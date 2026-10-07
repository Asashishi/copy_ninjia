#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

# 这棵工作树自己是不是一个 git 仓库根：不只看 `.git` 是否存在，落在别的仓库子目录里
# 的不算；两边都取物理路径再比。
is_git_repository_root() {
  local target="" toplevel=""
  target="$(cd -- "$1" 2>/dev/null && pwd -P)" || return 1
  toplevel="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ "$toplevel" = "$target" ]
}

# 工作树没有 git 仓库时就地补一个，使部署方此后能用 git 更新。
#
# 解压发布包（或整目录拷贝）得到的源码满足 is_repository_root 却没有 `.git`，
# clone 那一步因此被跳过；这里补上仓库。
#
# 本函数不写工作树里的任何文件，也不把工作树里的文件收进对象库：init 只建 `.git`，
# remote/fetch 只落 config 与远端对象，read-tree / update-index 只动索引，
# diff-index / rev-parse / tag 只读，update-ref 只动 HEAD，`reset --mixed` 重置索引
# 但不动工作树。
#
# 失败一律降级而不是中断安装：装不上 git、拉不到 tag 只影响此后能否用 git 更新。
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

  # 逐个 tag 比对内容认版本，不按版本号推断：对上了才把 HEAD 指过去，此后
  # `git status` 干净，更新是一次普通的 fetch + checkout。
  #
  # 比对只用 `read-tree`（只读 tag 自带的对象）与 `diff-index`（只比该 tag 跟踪的
  # 文件、无视未跟踪文件），不把 config/、memory/、database/ 等部署数据写进对象库。
  local candidate="" matched="" head_commit=""
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    git read-tree "${candidate}^{tree}" 2>/dev/null || continue
    # 先刷新 stat 信息：read-tree 之后索引对每个文件都是 stat-dirty，
    # `diff-index --quiet` 在刷新后比对。
    git update-index -q --refresh >/dev/null 2>&1 || true
    if git diff-index --quiet "${candidate}^{tree}" --; then
      matched="$candidate"
      break
    fi
  done < <(git tag --list)

  # 索引此刻留着最后一个候选 tag 的内容；两个分支都要复位索引（未对上用
  # `read-tree --empty`，对上用 `reset --mixed`）。
  if [ -z "$matched" ]; then
    # 对不上任何已发布 tag：改过，或不是发布包。建好仓库，HEAD 不指向任何版本，
    # 由部署方自行选择。
    git read-tree --empty >/dev/null 2>&1 || true
    warn "工作树与任何已发布 tag 都对不上（改过，或不是发布包）。"
    warn "仓库与 origin/tags 已就绪，但 HEAD 未指向任何版本；核对后自行 git checkout <tag>。"
    return 0
  fi

  # 对上了：HEAD 指到该 tag 并让索引跟上，得到与 `clone --branch <tag>` 相同的
  # detached 状态；这些命令都不写工作树文件。
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
