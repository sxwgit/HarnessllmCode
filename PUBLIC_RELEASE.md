# Whole Workspace Public Release

如果你要公开的是整个 `miniopencodev2` 工作目录，推荐继续在当前目录开发，然后用脚本把“可公开代码”导出到同级目录，再从那个同级目录推送到 GitHub。

这样做的好处是：

- 当前工作目录不用切换
- 不会把顶层 `node_modules/`、日志、状态文件和本地配置直接带上去
- 不会把 `harness_meta/.git`、`target_project/.git` 这类嵌套仓库历史公开出去
- 每次发布都能得到一个干净的 `public-main` 快照仓库

## 默认工作流

在当前目录开发，发布时执行：

```bash
bash scripts/create_public_workspace_repo.sh
```

脚本默认会把可公开内容导出到当前目录同级的：

```bash
../miniopencodev2-public
```

并在那个目录里维护一个独立的 Git 仓库和 `public-main` 分支。

## 一次命令直接推送

如果你已经有 GitHub 仓库地址，可以直接导出、提交并推送：

```bash
bash scripts/create_public_workspace_repo.sh \
  --remote git@github.com:you/miniopencodev2-public.git \
  --push
```

如果你更喜欢 HTTPS，也可以：

```bash
bash scripts/create_public_workspace_repo.sh \
  --remote https://github.com/you/miniopencodev2-public.git \
  --push
```

## 常用参数

- `--out-dir <path>`：自定义导出目录
- `--branch <name>`：自定义公开分支名，默认 `public-main`
- `--remote <url>`：设置导出仓库的 `origin`
- `--commit-message <text>`：自定义提交信息
- `--push`：导出后直接推送

例如：

```bash
bash scripts/create_public_workspace_repo.sh \
  --out-dir ../miniopencodev2-release \
  --branch public-main \
  --commit-message "chore(release): refresh public snapshot"
```

## 脚本会自动排除的内容

- `.claude/`
- `node_modules/`
- `meta_logs/`
- `project_logs/`
- `audit/`
- `checkpoints/`
- `dist/`
- `*.local.json`
- `*.log`
- `*.tmp`
- `*.temp`
- `.tmp-vitest-report.json`
- `meta_state.json`
- `project_state.json`
- 所有子目录中的 `.git`

同时还会对导出结果做基础脱敏，替换常见 API Key、邮箱和本机绝对路径痕迹。

## 建议

GitHub 远程仓库建议把默认分支设成 `public-main`，并限制 `main` 分支的创建和更新。这样你的公开仓库会更接近“发布镜像”，而不是开发主仓库。
