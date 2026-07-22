# Skill 软连接扫描实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框跟踪进度。

**目标：** 让 SkillManager 发现根目录和递归目录中的文件/目录软连接，并安全处理循环目录链接。

**架构：** 保留现有用户可见路径作为 Skill 摘要的 `path`，仅在扫描时跟随软连接解析目标类型。递归进入目录前用 `realpath` 维护当前递归链，跳过已在链中的 canonical 目录，防止循环但不跨独立入口全局去重。

**技术栈：** TypeScript、Node.js `fs/promises`、项目现有 Node 原生 `node:test` + TypeScript `transpileModule` 测试方式。

---

## 文件职责

- 修改：`src/main/skills/SkillManager.ts`：软连接目标类型解析、根目录扫描接入、递归目录循环检测。
- 创建：`tests/skillManager.test.mjs`：通过真实临时目录验证目录软连接、Markdown 文件软连接、递归软连接和循环软连接。

### 任务 1：建立失败回归测试

**文件：** `tests/skillManager.test.mjs`

- [x] 编写测试加载器：读取并转译 `SkillManager.ts`，只 mock `electron.shell`，其余 Node 模块走真实实现；每个测试使用唯一临时 home，结束后递归删除。
- [x] 编写软连接创建辅助函数：目录使用 `junction`，文件使用 `file`；遇到 `EPERM`、`EACCES` 或 `ENOTSUP` 时抛出可识别错误。
- [x] 添加测试：`list` 能发现根目录下指向外部目录的 Skill 软连接，并保留链接路径作为摘要路径。
- [x] 添加测试：`pi-global` 根目录下指向 `.md` 文件的软连接能被发现为 `markdown` Skill。
- [x] 添加测试：普通目录中的递归软连接目录能发现其下的 `SKILL.md`。
- [x] 添加测试：递归目录的环形软连接不会导致 `list` 超时或抛出栈溢出，并仍能返回非循环目录中的 Skill。
- [x] 对不支持软连接创建的平台，在测试级别明确跳过，而不是把环境能力错误报告成实现失败。

### 任务 2：确认红灯

**运行：** `node --test tests/skillManager.test.mjs`

**结果：** 4 个测试中 3 个按预期因软连接未被识别而失败，循环测试因软连接被直接忽略而通过。

### 任务 3：实现软连接感知扫描

**文件：** `src/main/skills/SkillManager.ts`

- [x] 从 `node:fs/promises` 引入 `realpath` 和 `stat`，引入 `Dirent` 类型。
- [x] 增加私有 `getEntryKind(fullPath, entry)`：普通 Dirent 直接返回文件/目录；软连接用 `stat` 跟随目标；坏链接、特殊文件或 `stat` 失败返回 `other`。
- [x] 修改 `scanLocation`：为扫描根建立 canonical 路径集合，使用解析后的 entry kind，因此根目录 Markdown 文件软连接和目录软连接都走现有逻辑。
- [x] 修改 `collectDirectorySkills`：进入目录前用 `realpath` 检查当前递归链，循环或无法解析时跳过；通过复制当前祖先集合传递递归链；对子项使用 `getEntryKind` 后递归目录。
- [x] 添加简短注释说明当前递归链检测是为了处理软连接环，并且不做全局去重以保留现有入口语义。

### 任务 4：确认绿灯并做全量验证

- [x] 运行 `node --test tests/skillManager.test.mjs`，4/4 通过。
- [x] 运行 `npm run typecheck`，退出码为 0。
- [x] 运行 `git diff --check`，无空白错误。
- [x] 检查 `git diff --stat` 和 `git status --short`；本次新增/修改为规格、计划、扫描实现和测试文件，不执行 commit；工作区原有 `package-lock.json` 修改未触碰。
