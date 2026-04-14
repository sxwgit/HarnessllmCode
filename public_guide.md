# miniopencodev2 Workspace Guide

这个目录是本地开发工作区。

推荐工作方式：

- 平时一直在当前目录开发
- `harness_meta` 继续维护自己的 `main` 和 `public-main`
- 需要对外发布整个工作区时，用根目录脚本导出到同级目录 `../miniopencodev2-public`
- 你自己从导出的同级目录执行 `git push`

## 你修改了一处代码之后，应该做什么

下面假设你修改的是 `harness_meta`，并且你已经完成本地验证，准备把最新结果整理好后再推远程。

### Step 1：确认当前改动

先看 `harness_meta` 里有哪些改动：

```bash
git -C harness_meta status --short
```

如果你想看更详细的差异：

```bash
git -C harness_meta diff
```

### Step 2：运行验证

如果改动的是 `harness_meta`，先跑测试：

```bash
npm test --prefix harness_meta
```

如果你改的是 `target_project`，就运行它自己的构建、测试或你约定的验证命令。

目标是先确认本地代码可用，再做分支整理。

### Step 3：提交到 `harness_meta/main`

验证通过后，把这次改动提交到 `main`：

```bash
git -C harness_meta add .
git -C harness_meta commit -m "feat(scope): describe your change"
```

提交后确认 `main` 干净：

```bash
git -C harness_meta status --short --branch
```

理想结果是只看到：

```bash
## main
```

### Step 4：刷新 `harness_meta/public-main`

`public-main` 不是日常开发分支，它更像“对外发布快照分支”。

如果你只是想让它跟上最新的 `main`，可以按我们当前采用的方式，用一个临时 worktree 刷新它：

```bash
tmpdir=$(mktemp -d /tmp/harness-public-sync-XXXXXX)
trap 'git -C harness_meta worktree remove --force "$tmpdir" >/dev/null 2>&1 || true' EXIT
git -C harness_meta worktree add "$tmpdir" public-main
find "$tmpdir" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
git -C harness_meta archive main | tar -x -C "$tmpdir"
git -C "$tmpdir" add -A
git -C "$tmpdir" commit -m "chore(release): refresh public snapshot from main"
```

如果这次没有变化，最后一步可能会提示没有可提交内容，这属于正常情况。

完成后，检查两个分支状态：

```bash
git -C harness_meta status --short --branch
git -C harness_meta log --oneline --decorate --graph --all -n 6
```

目标是：

- 当前仍停在 `main`
- `main` 是干净的
- `public-main` 也已经有最新快照提交

## 如果你要发布整个工作区

当你不只是想更新 `harness_meta`，而是要把当前整个工作区中“可以公开的代码”整理出来推到远程，就使用根目录脚本：

```bash
bash scripts/create_public_workspace_repo.sh
```

这个命令会把可公开内容导出到同级目录：

```bash
../miniopencodev2-public
```

脚本会自动排除这些不该上传的内容：

- `node_modules/`
- `meta_logs/`
- `project_logs/`
- `audit/`
- `checkpoints/`
- 本地 `.git`
- `.local.json`
- `.env*`
- 临时文件和日志

## 导出后你要做什么

如果你的公开仓库远程已经提前配置好了，那么每次发布时你只需要做下面这几步。

### Step 1：刷新公开导出目录

先在当前工作区根目录执行：

```bash
bash scripts/create_public_workspace_repo.sh
```

这一步会把当前可公开内容同步到：

```bash
../miniopencodev2-public
```

### Step 2：检查待推内容

导出完成后，先看一下公开仓库状态：

```bash
git -C ../miniopencodev2-public status --short --branch
git -C ../miniopencodev2-public log --oneline -1
```

理想情况是：

- 当前分支是 `public-main`
- 工作区是干净的
- 最新一条提交是刚刚生成的公开快照提交

如果你还想确认远程已经配置好，可以额外看一下：

```bash
git -C ../miniopencodev2-public remote -v
```

### Step 3：推送到 GitHub

确认没问题后，直接推送：

```bash
git -C ../miniopencodev2-public push -u origin public-main
```

如果这不是第一次推送，也可以用：

```bash
git -C ../miniopencodev2-public push origin public-main
```

## 最短发布步骤

如果你的远程已经配置好了，并且你现在就是要把最新公开内容推上去，那最短只需要这 3 步：

```bash
bash scripts/create_public_workspace_repo.sh
git -C ../miniopencodev2-public status --short --branch
git -C ../miniopencodev2-public push -u origin public-main
```

## 最短工作流

如果你只想记住最少步骤，可以记这 5 步：

1. 在当前目录改代码
2. 跑验证命令
3. 提交到 `harness_meta/main`
4. 刷新 `harness_meta/public-main`
5. 执行 `bash scripts/create_public_workspace_repo.sh`，然后去 `../miniopencodev2-public` 里自己 `git push`

## 每次发布前建议检查

建议在推送前再看一眼：

```bash
git -C harness_meta status --short --branch
git -C ../miniopencodev2-public status --short --branch
rg -n "sk-|apiKey|<workspace-path>" harness_meta target_project docs
```

目标是：

- `harness_meta/main` 干净
- 导出的 `../miniopencodev2-public` 干净
- 没有敏感信息误入公开内容
