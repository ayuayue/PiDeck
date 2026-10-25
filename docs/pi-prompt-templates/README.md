# PiDeck 内置 Prompt 模板（builtin://）

本目录是从 PiDeck 历史版本中整理还原的**内置 prompt 模板**。

这些模板曾写死在 PiDeck 主进程 `src/main/prompts/PromptManager.ts` 的
`BUILTIN_TEMPLATES` 数组中（路径以 `builtin://` 标识，无磁盘文件）：

- 2026-07-09 随 `b35ffbc1`（prompt templates 管理 UI + picker）加入 8 个
- 2026-08-25 随 `e1192eb9` 补充 commit-own / commit-split
- **2026-09-07 随 `02dc7953`（作用域下拉与内置资源优化）整体移除**，
  只保留「内置模板不可禁用」的注释残留

移除此后新装应用的用户看不到这批模板；有需求的用户可手动安装本目录文件。

## 模板清单（13 个）

| 命令 | 说明 |
|------|------|
| `/review` | 审查暂存的 Git 更改（bug、安全、错误处理、边界条件） |
| `/test` | 为函数或组件编写测试（主路径/边界/错误处理/类型） |
| `/fix` | 调试并修复问题：先根因分析→列影响文件→提修复方案→确认后应用 |
| `/refactor` | 重构代码：保持外部行为、提升可读性、减少重复、向后兼容 |
| `/doc` | 添加或改进文档：概述、参数返回值、示例、边界与假设 |
| `/explain` | 用简洁语言解释代码或架构：高层作用、关键设计、架构位置、改进点 |
| `/commit` | 根据暂存更改生成 Conventional Commits 提交信息 |
| `/commit-own` | 只提交自己改动的文件，不夹带无关变更（禁止 `git add -A`） |
| `/commit-split` | 把所有变更按功能拆分成多个自包含提交，按依赖顺序排列 |
| `/pi-system` | 查看 pi 默认系统提示词模板（身份、工具、行为准则） |
| `/skill-discipline` | 技能执行纪律：何时及如何触发 agent 技能（调用优先于思考） |
| `/enhance-prompt` | 提示词增强：把需求草稿改写为更清晰、更具体、更可执行的提示词（workbuddy 风格，语言一致、≤800 字） |
| `/enhance-prompt-deep` | 提示词深度增强：把开放型需求实质性扩展为丰富具体的提示词（creative 风格，保护代码/路径等精确内容、无长度限制） |

## 安装使用

1. 将本目录下除 `README.md` 外的所有 `.md` 文件拷贝到 `~/.pi/agent/prompts/`
   （项目内安装则拷贝到 `<项目>/.pi/prompts/`）
2. 重启 pi 会话（模板发现发生在启动时）
3. 在输入框输入 `/fix`、`/review`、`/commit` 等命令即可展开对应提示词

## 说明

- 文件内容与删除前的 `builtin://` 内置模板**逐字一致**（从 git 历史
  `e1192eb9` 提交的 `PromptManager.ts` 提取还原，未做任何改动）
- frontmatter `description` 即模板描述；PiDeck 提示词页中展示的中英文描述
  由 `src/renderer/src/composerBehavior.ts` 的 `BUILTIN_PROMPT_DESC_CN/EN`
  映射提供（该映射仍保留在代码中）
- 安装后这些模板属于用户自建模板，可在 PiDeck 提示词页正常编辑/删除
