# Harness Framework 开发指导文档

## 1. 执行原则

1. 每次只修改一小批强相关文件，不要一次性铺开到全部模块。
2. 每批修改完成后先做定点验证，再做全量验证。
3. 每批修改完成后立即做 Git 记录，保证问题与修复都有可回溯提交。
4. 为避免冲突，优先修改高内聚模块，避免跨层同时改动过多文件。
5. 每批修改结束后，重新检查本批未修改但与之相邻的模块，确认没有被隐式破坏。

## 2. 推荐迭代节奏

### 2.1 单批工作流程

1. 明确本批目标，只处理一个问题簇。
2. 先阅读相关实现与现有测试，确认影响面。
3. 只修改该问题簇直接涉及的代码文件。
4. 先运行定点测试或最小验证命令。
5. 通过后再运行全量测试。
6. 检查 Git diff，确认没有混入无关改动。
7. 提交 Git commit，并在提交信息中写明本批目的。

### 2.2 推荐拆分方式

- 一批只改目录/配置契约。
- 一批只改 Git 治理行为。
- 一批只改文档模板解析与 Schema。
- 一批只改状态恢复与断点续跑。
- 一批只改异常恢复、自愈与人工介入链路。

## 3. 高内聚低耦合要求

- `src/git/`、`src/dual_git_manager/` 相关修改应只围绕分支治理和仓库行为。
- `src/artifacts/` 相关修改应只围绕文档解析、Schema、校验结果。
- `src/orchestrator/` 相关修改应只围绕流程编排、恢复、重试、阶段切换。
- `src/state/` 相关修改应只围绕状态持久化与恢复，不混入业务判断。
- 测试新增或调整要与功能改动同批提交，避免“功能改了、验证缺席”。

## 4. 验证要求

### 4.1 不要一次跑全部

先跑与本批修改直接相关的最小测试集合，例如：

```bash
npm test -- test/m05_git_spec.test.ts --reporter=dot
```

### 4.2 跑完后必须自检

- 检查新增逻辑是否覆盖原始问题。
- 检查是否引入新的回归失败。
- 检查日志、状态文件、检查点文件是否仍能正常写入。
- 检查 Git 工作区是否只包含本批相关改动。

### 4.3 再做全量验证

```bash
npm test -- --reporter=json --outputFile=.tmp-vitest-report.json
```

## 5. Git 记录要求

- 每批功能完成后提交一次，不要把多批问题混成一个提交。
- 提交信息使用动词 + 范围 + 意图，例如：
  - `fix(meta): tighten protected branch handling`
  - `fix(artifacts): parse sprint contract fields structurally`
  - `feat(resume): restore interrupted sprint execution from checkpoints`

## 6. 邻接模块复核要求

每次修改完成后，不仅检查本批文件，还要检查未修改但紧邻的模块：

- 改 `src/git/manager.ts` 后，复核 `src/orchestrator/harness.ts` 的调用方式。
- 改 `src/artifacts/validator.ts` 后，复核 `src/orchestrator/pre-evaluation.ts` 和相关测试样例。
- 改 `src/orchestrator/harness.ts` 后，复核 `src/state/machine.ts`、`src/orchestrator/checkpoint.ts`、`src/orchestrator/rollback.ts`。

目标是及时发现“本文件没报错，但相邻模块已不一致”的问题，并当批修正。

## 7. 当前建议优先级

1. 先做断点续跑和恢复链路增强。
2. 再做异常自愈闭环的阶段级恢复。
3. 然后补强最终验收与交付文档生成。
4. 最后再继续做模板校验器的严格化增强。

