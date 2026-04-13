# Harness Meta

自主多智能体代码开发框架的元程序实现。

## 配置约定

仓库中只保留可公开的基础配置：

- `harness_config.json`：默认配置，允许提交到 Git。
- `harness_config.example.json`：公开示例，给使用者参考。
- `harness_config.local.json`：本地覆盖配置，仅供本机使用，已加入 `.gitignore`。
- `harness_secrets.local.json`：独立 secrets 配置，仅供本机使用，已加入 `.gitignore`。
- `harness_secrets.example.json`：公开的 secrets 配置模板。

安全规则：

- 公开配置文件里不写真实 API Key。
- 真实 API Key 只放在 `harness_secrets.local.json` 或环境变量里。
- 如果 `harness_config.json` 或 `harness_config.local.json` 出现 `llm.apiKey`，程序会直接报错。

## 示例

公开仓库里保留这样的配置即可：

```json
{
  "llm": {
    "baseURL": "https://api.minimaxi.com/anthropic",
    "model": "MiniMax-M2.7-highspeed",
    "maxTokens": 32768,
    "temperature": 0.7
  }
}
```

推荐方式一：本地运行前设置环境变量：

```bash
export MINIMAX_API_KEY="your-real-key"
```

推荐方式二：把真实 key 放进独立的本地 secrets 配置：

```json
{
  "llm": {
    "apiKey": "your-real-key"
  }
}
```

如果你更偏好环境变量，也可以把 secrets 配置写成：

```json
{
  "llm": {
    "apiKeyEnvVar": "MINIMAX_API_KEY"
  }
}
```

如果你需要本地覆盖路径或模型参数，请新建 `harness_config.local.json`，例如：

```json
{
  "llm": {
    "model": "MiniMax-M2.7-highspeed"
  },
  "paths": {
    "targetProject": "../target_project"
  }
}
```

## 发布策略

可以做“双分支”，但要注意两点：`public` 分支必须只包含脱敏后的内容，而且不能把带敏感历史的本地分支直接合并过去。

推荐做法：

1. 本地开发使用 `private/main` 或你自己的常用分支，不公开推送。
2. 对外发布使用 `public/main`。
3. `public/main` 最好是单独整理出来的干净历史，或单独 public 仓库。
4. 从本地分支发布时，用 `cherry-pick`、导出快照、或人工筛选提交，不要直接 merge。
5. 如果历史里曾出现过真实密钥，先旋转密钥，再重写历史后再发布。

更稳妥的方案其实是“双仓”：

- 私有仓库：保留完整本地开发历史。
- 公共仓库：只接收脱敏后的代码和文档。

仓库内已经提供脚本来自动生成干净公开分支：

```bash
bash scripts/prepare_public_branch.sh public-main
```

它会基于你当前工作区的安全快照创建一个单提交、干净历史的 orphan 分支，适合直接推送到远程公开仓库。

## Git 忽略建议

当前 `.gitignore` 已额外忽略这些不应公开的内容：

- 运行日志和状态文件
- `audit/`、`checkpoints/` 等运行产物
- `harness_config.local.json`
- `harness_secrets.local.json`
- `.env*`、IDE 配置、临时文件

如果准备公开到 GitHub，发布前仍建议再检查一次：

```bash
git status --ignored
rg -n "sk-|apiKey|<workspace-path>" .
```
