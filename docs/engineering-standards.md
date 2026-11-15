# 工程标准（代码 / 测试 / 安全 / 兼容）

> **Status: Current（2026-10-31 核对；以代码与测试为准）**


> 写代码、写测试、改 IPC 边界或处理用户数据前读本文。
> 命令与门禁速查见根 `AGENTS.md`；域运维细节见 `docs/maintenance-domains.md`。

## 改动方法（内化自 unclebob/ub-mode）

来源 <https://github.com/unclebob/ub-mode>：Bob 大叔给自家 agent 的改动纪律（脱胎于 `poteto-mode` / `pstack`），配 crapper / dryer / mutator 三个确定性门禁工具。
原作者未声明 LICENSE；维护者明确「复制都没事，思想不要断」，因此这里**按原文结构逐条对译、全量保留**，不为了精简删条——包括已经被本仓库其他规则覆盖或与之冲突的条目，只在末尾「落地注记」里标出以哪个为准。
原文逐字副本：`docs/archive/research/ub-mode.SKILL.original.md`（3958 字节，sha256 `4120873d…`）；译文与它 20 个小节一一对应，上游发新版时拿它做 diff，再补译新增条目。

三个阶段顺序固定：**First Make it Work → Then Make it Right → Practice**。

### 一、First Make it Work

**Laziness Protocol（懒惰协议）**
- 一个决策只存在一处。
- 交能解决问题的最小改动。

**Foundational Thinking（地基优先）**
- 先定数据结构形状，再写逻辑。
- 先做那个能让后面每一步都变容易的动作。
- 如果并发写者会构成影响，就不共享状态。

**TDD**
- 先写会失败的测试，再改代码。
- 确认它是**因为预期原因**失败。
- 用能通过的最小改动让它变绿。
- 如果写不出诚实的测试，就不要写一个假测试。

**Redesign From First Principles（从第一性原理重设计）**
- 不要把新需求焊到旧设计上。
- 自问「如果这个需求一开始就在，我会怎么建」，想清楚后分片交付。

**Attack the Premise（攻击前提）**
- 两个共享同一前提的修复挂在同一道门禁上时，用一句话写下这个前提，并数清谁在承担不对称。
- 删掉那段赋值。
- 在写下这句话之前，不要开始下一次修复。

**Subtract Before You Add（先减后加）**
- 加任何东西之前，先把复杂度拿出去。

**Outcome-Oriented Execution（终态导向）**
- 瞄准一个你可以检查的终态。
- 中途允许断开，前提是计划过并且能撤回。

**Build the Lever（造杠杆）**
- 一眼看不完的活，就做那个替你做它的工具。
- 先手工做完一个单元，再让工具对齐这个单元。

**Architecture（架构）**
- *Model the Domain*：把领域放进让非法状态无法表达的结构里；维护领域术语表；如果代码已经清楚且局部，就别动它。
- *Boundary Discipline*：在数据入口处校验；内部信任已校验的数据；业务逻辑放在纯函数里。
- *Type System Discipline*：让非法值写不出来；外部数据只在入口解析一次；不要用强转把编译器消音。
- *Make Operations Idempotent*：跑两遍、或中途崩溃后再跑，终态必须相同。
- *Separate Before Serializing Shared State*：不需要同一份可变状态就各给一份；需要就只允许一个写者，并在结构里强制它。

### 二、Then Make it Right

**Fix Root Causes（修根因）**
- 先复现，再修原因。只把崩溃藏起来的守卫不是修复。

**Sequence Work into Verifiable Units（切成可验证单元）**
- 做完一个小单元并检查它，再开下一个。

**Test Behavior, Not Implementation（测行为不测实现）**
- 测试像它的使用者那样调用代码，检查使用者会看到的结果。
- 如果所有函数都返回空时这个测试还能过，就丢掉它。

**Crapper（CRAP < 10）**
- 用 crapper 工具；每个函数把 CRAP 压到 10 以下——拆分、补测试，或两者都做。
- 顺手判断 case/switch 分支是否值得压。

**Dryer（重复度 < 0.8）**
- 用 dryer 工具，消除相似度 ≥ 0.8 的重复。

**Mutator（变异测试）**
- 用 mutator 工具：覆盖未覆盖的，杀掉幸存者，删掉死代码。

**Refactoring（重构）**
- 先钉住代码现在的行为，再改结构，最后证明行为没变。

### 三、Practice

**Keep a Log**
- 记下每个动作和你做它的理由，完成后汇报这份日志。

**Guard the Context Window**
- 主线程保持小；大头送出去，只留摘要。

**Worktree Cleanup**
- 找出可以安全删除的东西，确认没有在用，再回收磁盘。
- 未提交的工作要等一个决定。

**Commit and Push**
- 经常提交，小步、有序。
- 每条提交说清为什么、改了什么、怎么证明。
- 最后推到主线。

### 本仓库的落地注记（与原文不同之处）

| 原文条目 | 本仓库怎么落 |
|---|---|
| Keep a Log | 日志不逐条播报（`~/.pi/agent/AGENTS.md`：不输出过程性独白），改成「协作 · 收尾」一次性汇报「做了什么 / 为什么 / 怎么验证」 |
| Commit and Push 到主线 | 与铁律 7「不自动提交」冲突，以铁律为准：列出改动等用户决定 |
| Crapper / Dryer / Mutator | 本仓库没有这三个 Python 工具（首次运行自举 `.venv` 联网装依赖），暂不引入。无工具时的替代：「先减后加」那条管重复，「复杂度」靠拆分与针对性测试压；真要上量化门禁得自己写脚本（Node 24 自带 `--experimental-test-coverage` 与 `--test-reporter=lcov`，够算 CRAP），属独立任务 |
| TDD、修根因、测行为、切成可验证单元、边界与类型纪律 | 与「测试」「安全」两节和铁律 4 重合，以那几处为细则 |
| Worktree Cleanup | 与铁律 8 一致：只清理本任务产物，别人的未提交工作不动 |
| 常驻精简版 | 根 `AGENTS.md` §改动方法 只留 5 条最不容易自发想到的（先减后加 / 攻击前提 / 不焊新需求 / 造杠杆 / 可重入），其余每次改代码时读本文 |

## 代码风格

- TypeScript strict；禁止新增 `any`（第三方交互用 `unknown` + 收窄并注释）；禁止 `as` 强转绕过类型错误；测试数据用工厂函数构造完整对象。
- 命名：类型/类 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE，IPC 通道 `domain:action`。
- React：函数组件 + hooks；副作用必须有清理；派生状态用 `useMemo`，可计算值不进 state。
- 日志走主进程 logging 模块，不留调试 `console.log`；用户可见错误走 toast/内联文案（i18n），不裸抛异常跨 IPC。

## 格式化（biome）

- 配置在根 `biome.jsonc`，覆盖 `src/`、`tests/`、`scripts/`、`e2e/`；`docs-site/`、`resources/extensions/`、CSS 不参与。
- 规则：tab 缩进、双引号、分号、尾逗号、LF；`lineWidth` 320 是刻意取上限——只统一缩进/空格/标点，不做实际折行，因为折行会打破大量「源码正则扫描」契约测试。
- 提交前 `npm run format`；CI 跑 `npm run check:format`，未格式化红灯。
- 本地 `git commit` 会跑 `.githooks/pre-commit`（实现见 `scripts/preCommitGate.mjs`）：`check:file-size` + `check:test-shape` + **本次暂存文件**的 biome 格式，全仓扫描但只查暂存文件，约 1–2 秒。跳过：`PI_DECK_SKIP_PRECOMMIT=1 git commit …`（CI 仍会再挡一次，且跳过不该成为常态）。
- **新增源码正则扫描契约测试时，正则必须空白容忍**：用 `\s*` 而非字面空格，定位代码块用 `^[\t ]*` 锚点。否则改一次格式整组断言失败。
- `linter` 仍为 `enabled: false`；lint 规则按触达面增量启用，不一次性引入存量告警。

## 注释

- 对核心逻辑、复杂判断、业务规则、状态流转、权限校验、数据转换、异常处理注释「为什么、对应什么规则、边界是什么」，不逐行解释显而易见的代码。
- 新增函数/类/模块加简短功能说明；改旧代码时缺上下文的顺手补。
- 事故与历史决策写在注释或 `docs/maintenance-domains.md`，根 `AGENTS.md` 只留一行结论。

## 测试

测试在 `tests/*.test.mjs`（node --test）。日常只跑**针对性测试**；全量 `npm test` 仅跨域大改动或合并前最终确认时运行。

1. **必过门禁**：合并前 `npm run typecheck` + 改动涉及的针对性测试全绿，不许「先合再修」。
   整链路回归由 CI 的**冒烟 e2e 集**守住（8 条 spec / 11 个 case，约 1.2 分钟）：冷启动、会话首发提升、预热历史+光标、markdown 图片、Git 面板、设置弹框、右抽屉、文件树 DOM 预算。环境依赖型 spec（`dsh-restart`、`remote*Acceptance`）刻意不在其中——它们要真实 DSH/SSH 环境，属人工验收。
   - **未进 CI 的 e2e 是未验证资产，引用前先跑**（2026-11-13 体检结论）：抽 15 条与重构面相关的 spec（39 个 case）在本机跑，14 条失败；在**重构前的基线 commit** 上重跑同样 14 条，**全部一样失败** → 与代码改动无关，属存量欠账。其中 12 条的失败症状统一是「Agent 卡在启动中、mock pi 一帧不回」（应用 spawn 临时 `.cmd` shim 跑 `e2e/mock-pi.cjs` 的链路在本机走不通；同一 shim 手工走 `cmd.exe /d /s /c` 是通的，说明问题在测试环境而非 mock 本身），2 条是 UI 断言漂移（`tab-context-menu` 的颜色值），1 条 flaky（`session-removal`）。**不要把它们当成产品缺陷清单，也不要在拆分 PR 上顺手「修绿」——先单独定位测试环境。**
2. **何时必须写**：修 bug 先写复现测试（红）再修到绿，持续保留仍有效的回归覆盖（用例可按第 6 条演进）；新增主进程业务逻辑、数据转换/解析/状态机必须有单测；交互状态流转的 hook 应有测试，纯 UI 布局不强求。
3. **写法**：测行为不测实现（从公开接口/IPC 边界断言）；不依赖执行顺序、真实网络、真实 pi 进程；一个测试验证一件事，命名即意图。
   - **定位代码别用可能出现在注释/文档里的自然语言句子**：这类字符串往往在文件头注释里也有，`indexOf(句子)` 会命中注释 ⇒ 顺序/存在性断言莫名变红或假绿。定位用**代码声明串**（如 `await test.step("…")`、`ipcMain.handle(ipcChannels.X`），或先剥注释再搜（正则扫描契约测试统一如此）。
4. **加载生产 TS 模块用现成 helper，禁止手写 vm 加载器**：
   - 完整依赖图用 `tests/helpers/loadTsCommonJs.mjs`；自定义 sandbox 全局用 `tests/helpers/createTsSandbox.mjs`。
   - 两者的相对 import 按源文件目录解析。手写沙箱把 specifier 丢给 `require(specifier)` 会以 `tests/` 为基准，生产代码新增本地 import 就整片 MODULE_NOT_FOUND。
   - 沙箱不注入 Node 全局（`setTimeout`/`clearTimeout` 等）；被 vm 加载的生产模块用定时器时必须显式 `import { setTimeout } from "node:timers"`。
5. **红名单归属判定**：全量测试出现失败时，先用 `git worktree add` 在改动前基线 commit 复跑同一批测试文件——基线也红的是上游/并行改动，不顺手修也不算进自己的回归；只修自己引入的。**取基线不要用 `git stash`**：并行 writer 活跃时 stash 会把对方在飞的工作一起抽走，`pop` 冲突一旦被重定向吞掉就是静默数据损坏；确需 stash 时不要吞掉 pop 输出，并在恢复后逐文件核对。
6. **测试更新与覆盖责任**：任务涉及需求变化、契约演进、缺陷修复或重构时，可以同步新增、修改、替换或删除相关的过时测试，无需仅因涉及既有测试另行确认。判据是任务需求、领域契约与可复现的缺陷证据，不能仅以当前实现的输出为正确答案。
   - 行为不变的重构保留原有行为与安全边界覆盖；可以调整测试组织、加载器、路径或改用行为测试，不要求实现细节断言原样不动。
   - 行为或契约变化时，用新契约的断言替换失效预期，覆盖新增及仍有效的边界；错误旧测试应纠正，不为通过它保留错误实现或造兼容壳。
   - 删除或合并用例时，说明原预期为何失效、重复或已被替代，以及仍有效的覆盖落在哪里；不借当前任务清理无关测试。
   - 交付说明测试修改依据、行为前后差异与覆盖变化，运行相关测试并报告结果。禁止仅为消红而降低有效覆盖、跳过失败用例、改成恒真或让断言迁就缺陷；涉及需求范围或安全策略的实质变化，仍遵守相应变更规则。
7. **禁止新增「只读源码」的测试**：`readFileSync("src/…")` + 正则断言「代码长什么样」对行为零验证，却会在搬迁/改名/换实现时红掉（2026-10 死代码清理撞了 5 处），还会反向掩盖 bug。`npm run check:test-shape` 按基线（`scripts/testShapeBaseline.json`）挡住新增，CI 已接入；确实无法运行时验证时用 `--update` 刷新基线并在 PR 说明理由。本批正式发版的 19 个结构契约例外及覆盖来源见 [`release-test-shape-exceptions.md`](release-test-shape-exceptions.md)。

## 安全

1. **IPC 最小权限**：preload 只暴露页面需要的 API，禁止 `ipcRenderer` 透传。
2. **输入校验在边界**：IPC handler 第一行职责是校验入参（类型/路径合法性/枚举范围）；渲染层数据一律不可信。
3. **路径安全**：文件读写限制在项目目录或应用数据目录内；拼接前规范化 + 逃逸检查，禁止直接拼用户输入。
4. **进程调用**：spawn/exec 参数必须数组形式，禁止字符串插值拼 shell；子进程环境变量经 `sanitizePiChildEnv` 类函数清洗；所有 spawn（含 fire-and-forget 的 `open`/`taskkill`/安装器）必须挂 `error` 监听或等价兜底——未处理的 `error` 事件会直接崩主进程；可能长时间不返回的外部命令（如 `reg query /s`）必须带超时 kill。
5. **Webview**：禁止加载 `file://` 以外任意本地内容；`allowpopups`/node integration 保持最小化，新增 webview 属性需评审。
6. **密钥与令牌**：Auth 配置只经 `config/` 模块读写；日志/错误上报/遥测禁止输出 token/key。
7. **依赖引入**：新增依赖需说明理由，优先用已有能力，禁止为小功能引重型库。

## 稳定性与可扩展性

1. **错误处理分层**：主进程 catch 后写日志 + 返回结构化错误；渲染层用户可感知错误走 toast/内联文案；异步函数禁止无 catch 的裸 promise。
2. **生命周期配对**：注册 listener/timer/子进程/watcher 的地方，同一模块必须有清理路径；退出清单统一登记到 `QuitCleanupRegistry`。
3. **资源边界**：大文件读取、会话扫描、diff 计算要有大小上限或流式处理；渲染进程不做全量日志/历史的主存。
4. **向后兼容**：设置项、会话文件、缓存格式变更必须有迁移或默认值兜底；删旧字段前保留一个版本读取兼容。
5. **特性开关**：高风险/实验功能必须可从设置关闭/回退，默认取保守项。
6. **扩展点**：新增能力优先注册式（IPC 域注册、面板注册），不在既有 switch/if 链上加分支。

## i18n 文案

- 用户可见文本一律走词典，JSX 禁止硬编码中英文。
- 四组词典：`rendererCopy.*`、`mainProcessCopy.*`、`WebI18n.*`、`FeishuI18n.*`；zh-CN 与 en-US 同步加 key。词典清单与 locale 分支点见 `docs/maintenance-domains.md` §繁体中文。
- **改任何 zh-CN 词典后必须重跑 `node scripts/genZhTwCopy.mjs`**；四份 `*.zh-TW.ts` 是生成物，禁止手改。
- 漏跑的表现：先 typecheck 报 TS2739；只改值不加 key 则由 `source-sha256` 指纹门禁拦下。
