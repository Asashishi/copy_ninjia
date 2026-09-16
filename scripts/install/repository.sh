#!/usr/bin/env bash
# 由目标工作树 install.sh 按顺序 source；共享其严格模式、日志函数与安装上下文。

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
