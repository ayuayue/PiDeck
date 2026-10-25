# 对话内 chip 渲染统一重构计划（引用 / 会话 / 技能 / 提示词模板 / 文件）

状态：**W1–W5 已落地**（2026-10-20，W4 按「与 pi 的资源类型对齐」执行、视觉零变化），CI 接入未做。2026-10-21 追加 §10 所有权矩阵、§11 与 pi/DSH 的对齐账本、§12 已知缺口台账（供日后回顾）。
落地记录见 §9；常驻维护要点已并入 `docs/maintenance-domains.md`「用户消息 chip 与自包含块」。
起点：`docs/maintenance-domains.md`「用户消息 chip 与自包含块」相关小节；现场问题见 §1.2。
目标：把「输入框 chip → 落盘 → 时间线 chip」这条链路的**五种结构**收敛成**一条契约、一条发送管线、一个清单来源**，同时修掉两个已被复现的展开越界 bug。

---

## 1. 现状与证据

### 1.1 八类斜杠/引用结构的实际行为

| # | 类型 | 输入框存什么 | 谁展开 | 落盘形态 | 重载后凭什么还原 chip | 状态 |
|---|------|--------------|--------|----------|------------------------|------|
| 1 | `@文件` | `@path` 原文 | 无人展开 | `@path` 字面量 | 文本本身 + 文件白名单 | 正常 |
| 2 | `❝引用` | `#q<id>` token | PiDeck `expandQuoteTokens` | `<quoted_context label message_id>` | 块自带 | 正常 |
| 3 | `&会话` | `&名称` | PiDeck `resolveSessionReferences` | `<referenced_session name>` | 块自带 | 正常 |
| 4 | `/skill:名` | 原样 | **pi** `_expandSkillCommand` | `<skill name location>` | 块自带 | 正常 |
| 5 | `/模板名`（自建） | 原样 | **PiDeck** `expandPromptTemplates` | `<prompt_template name>` | 块自带 | 正常 |
| 6 | `/模板名`（**包带**，如 `parallel-review`） | 原样 | **pi** `expandPromptTemplate` | **纯正文，名字丢失** | 无 | **缺陷** |
| 7 | 扩展注册命令（`/plan`、第三方） | 原样 | pi `_tryExecuteExtensionCommand` 执行后不写消息 | 无 | 无 | 临时气泡（可接受） |
| 8 | 桌面接管（`/new` `/login` `/hotkeys` `/reload` `/compact`） | — | PiDeck 拦截 | 无 | — | 正常 |

### 1.2 缺陷证据

**D1（现场问题）**：包带提示词模板在时间线「变脸」。

- 发送后乐观气泡存的是原始输入 `/parallel-review 去干活吧`；时间线 chip 白名单来自 `get_commands` 全集（含 `source: "prompt"` 的包模板），因此**出 chip**。
- 停止 / 重载后时间线改读会话文件，文件里是 pi 展开的 4591 字正文（无名字），**chip 消失、整段展开**。
- 已验证会话文件与模板正文逐字相同（`$@` 替换为参数），且消息条目只有 `role/content/timestamp`，无任何命令身份。

**D2（清单不同源）**：composer 的展开清单与时间线 chip 白名单来源不同。

- 展开清单：`prompts:list` / `prompts:listByProject` → 只扫 `~/.pi/agent/prompts` 与 `<项目>/.pi/prompts`（`src/main/prompts/PromptManager.ts`）。
- chip 白名单：`sessions:list-runtime-commands` → `get_commands` 全集（`src/main/sessions/SessionRuntimeCoordinator.ts`）。
- 后果：**时间线认识包带模板，展开器不认识**——于是交给 pi 展开，名字因此丢失。

**D3（展开越界，已复现）**：模板展开会作用到已展开块内部。

```text
输入：<quoted_context …>用户说：先跑 /commit 再发版</quoted_context>\n\n这个引用对吗？
结果：引用块内的 /commit 被替换成 <prompt_template name="commit">…</prompt_template>
```

根因：`useSessionSend` 里三个展开器顺序执行，后一个对整个文本做全局正则，不避让前一个已生成的块区间。同类风险也存在于 `resolveSessionReferences`（`&会话名` 在引用块内会被展开）。展示层靠 `parseExpandedRefBlocks` 的「跳过被外层覆盖的内层块」掩盖了部分症状，但**发给模型的文本已经被污染**——引用的原文被改写，这是语义错误。

**D4（结构问题）**：五个展开者、三种语义（有的写块、有的不写）、发送侧三处调用无统一管线；展示侧双解析器（块 + 裸 token）靠顺序共存。

---

## 2. 目标与非目标

**目标**

1. 一条契约：需要折叠成 chip 的结构，**落盘文本必须自带展示身份**（自包含块）。
2. 一条发送管线：三个 PiDeck 展开器收敛为一个入口，**前序块区间对后续展开器只读**。
3. 一个清单来源：提示词模板清单 = 离线目录 ∪ 运行时 `get_commands(source="prompt")`，正文按 pi 给出的路径读取。
4. 展示侧复用现有 `parseExpandedRefBlocks`，不为新类型新开解析路径。

**非目标（明确不做）**

- 不改 pi 的会话 JSONL 格式、不要求 pi 上游新增元数据字段（上游建议另记，不阻塞本计划）。
- 不给扩展命令（#7）伪造落盘消息；不为它做持久 chip。
- 不平铺 `@文件`（原文即身份，模型需要路径）。
- 不做「按正文指纹反查模板名」。
- 不动 DSH / ACP 的 transcript 语义（它们不经过 pi 会话文件）。
- 不做 §3.5 之外的展示层重写。

---

## 3. 目标架构

### 3.1 数据契约

块格式不变（`<quoted_context>` / `<referenced_session>` / `<skill>` / `<prompt_template>`），新增两条规则：

1. **保护区规则**：任何已生成的块区间（含块内正文）对后续展开器不可见。实现为共享纯函数 `computeProtectedRanges(text)`（复用 `parseExpandedRefBlocks` 的区间计算，抽出公共部分）。
2. **自包含规则**：块必须携带展示所需的最小元数据（`label` / `name` / `message_id`），不得依赖运行时 atom 或当前模板列表。

### 3.2 发送管线

新模块 `src/renderer/src/sending/expandOutgoingMessage.ts`（纯函数 + 一个 async 入口，可单测）：

```text
expandOutgoingMessage(rawDraft, ctx) -> { text, meta }
  1. quote tokens  → <quoted_context>        （现有 expandQuoteTokens）
  2. session refs  → <referenced_session>    （现有 resolveSessionReferences）
  3. templates     → <prompt_template>       （现有 expandPromptTemplates）
```

每一步只替换落在保护区之外的匹配。`useSessionSend` 改为单次调用，删除三处分散调用与 `prepareMessage` 的会话引用展开职责。

### 3.3 清单来源

渲染层新 hook `useSessionTemplates(sessionId)`：

- 来源 A（离线可用、带正文）：`prompts:list` + `prompts:listByProject`。
- 来源 B（运行时权威、只有名字与路径）：`listRuntimeCommands` 中 `source === "prompt"` 的条目。
- 合并：按 name 去重，**B 优先**（B 是 pi 去重后的最终视图）；B 的正文由新 IPC 一次性取回。
- 失败降级：B 取不到正文 → 丢弃该条（退回现状：交给 pi 展开），不阻断发送。

主进程新增能力：

- `AgentManager.listPromptTemplateBodies(agentId)`：过滤 `source === "prompt"` 的 `get_commands` 条目，按 `sourceInfo.path` 读文件，**每份 ≤256KB**，失败跳过；返回 `{ name, content }[]`。
- IPC `prompts:runtime-templates`（域为 prompts，语义是「读 pi 已登记的模板路径」），preload 白名单同步。
- 安全边界：只读 `get_commands` 报出的路径（provenance 白名单），再校验绝对路径、`.md` 后缀、文件存在、大小上限；不接受任意用户输入路径。

### 3.4 展示解析

`parseExpandedRefBlocks` 保持不变即可让 #6 复现为 chip（`prompt_template` 已映射为 `/名称` 视觉）。

可选 W4：把 `prompt_template` 从「伪装成 `kind:"skill"`」拆成独立 `kind:"template"`，让 `data-type` 与图标映射显式化。仅当确认无样式/测试依赖 `data-type="skill"` 时执行。

### 3.5 纯文本出口

保持现状：复制、队列预览、侧栏 preview、Web 端、子代理转录统一走 `replaceExpandedRefBlocksWithLabels`。本次只补测试，不改实现。

---

## 4. 分步实施（每步独立可回滚）

| Wave | 内容 | 主要文件 | 完成判据 |
|------|------|----------|----------|
| W1 | 保护区规则 + 发送管线收敛 | 新 `sending/expandOutgoingMessage.ts`、`utils/protectedRanges.ts`、`useSessionSend.ts`、`useSessionComposerController.ts` | D3 消失；五种既有 chip 行为零变化 |
| W2 | 主进程读运行时模板正文 | `AgentManager.ts`、`ipc/promptsIpc.ts`、`shared/ipc.ts`、`preload/index.ts`、`shared/types` | 单测覆盖过滤/上限/路径越界/读取失败降级 |
| W3 | 清单统一 hook | 新 `hooks/useSessionTemplates.ts`、`useSessionComposerController.ts` | 发 `/parallel-review` 落盘为 `<prompt_template>`，重载后仍出 chip |
| W4（可选） | 模板独立 `kind` | `shared/expandedRefBlocks.ts`、`SurfaceComponents.tsx`、`chips.ts` | 视觉与 `data-type` 语义一致，无回归 |
| W5 | 文档与门禁 | `docs/maintenance-domains.md`、e2e | e2e：发送 → chip → 重载 → 仍 chip |

**W1 是本计划的价值核心**：即使 W2/W3 延期，D3 也已修复。

---

## 5. 兼容与迁移

- **旧会话**：无块消息保持全文显示，不做反查（`replaceExpandedRefBlocksWithLabels` 原样返回）。
- **无 runtime 场景**（草稿会话、DSH、ACP、standby 未就绪）：来源 B 为空 → 退回来源 A → 行为与今天一致。
- **包被卸载 / 模板改名**：已落盘的块自包含，chip 仍可显示（比现状更稳）。
- **双份展开风险**：PiDeck 展开后的文本以 `<` 开头，pi 的 `expandPromptTemplate` 首行即 `startsWith("/")` 早退，不会二次展开（已核实）。
- **`prompts:list` 与 `get_commands` 的 enabled 状态差异**：来源 A 保留（兼容被设置禁用但仍可用的模板），B 优先不影响 A 的扩展性。

---

## 6. 测试矩阵

| 层 | 文件 | 断言要点 |
|----|------|----------|
| 发送管线 | 新 `tests/expandOutgoingMessage.test.mjs` | 引用块内 `/模板名` 与 `&会话名` 不被展开；块外正常展开；三步顺序无关；空模板不展开；替换串里的 `$&`/`` $` ``/`$'` 原样保留 |
| 保护区 | 同上 | 嵌套块（引用里有技能块）只保护外层区间 |
| 主进程读取 | 新 `tests/promptRuntimeTemplates.test.mjs` | 仅 `source="prompt"`；超限跳过；路径非绝对/非 `.md` 拒绝；读失败降级为空 |
| 清单合并 | `tests/templateCatalogMerge.test.mjs` | B 覆盖 A 的正文；A 的描述保留；B 独有条目追加（path 为空）；运行时为空时原样返回 |
| 队列分支 | 新 `tests/sendTemplateExpansion.test.mjs` | 忙碌 steer 在展开前 `await ensureTemplates`；补齐失败 fail-open 仍入队 |
| 既有回归 | `composerBehavior` / `expandedRefBlocks` / `quoteChip` | 全部原断言保持绿 |
| e2e | 新 `e2e/prompt-template-chip.spec.ts`（2 条） | ① 发送 `/e2e-template …` → **RPC 线上文本**是 `<prompt_template name>`（模板名 + 全文 + 用户参数齐全），气泡只显示 chip；② 预置一条已落盘的块消息 → 打开后气泡仍是 chip、`data-type="template"`、不铺正文（即「重载后不丢 chip」的磁盘侧断言） |

---

## 7. 风险

| 风险 | 影响 | 处置 |
|------|------|------|
| 保护区实现错误吞掉真实展开 | 模板不展开 | 只有落在已生成块区间内才保护；块外匹配不受影响 |
| 读正文拖慢会话切换 | 首屏变慢 | 每份 ≤256KB、失败即跳过；实测后按需加 mtime 缓存 |
| pi 改变 `get_commands` 形状 | 来源 B 失效 | 解析层容错，失败退回来源 A |
| 模板正文含 frontmatter | 元数据泄漏进消息 | 复用现有 `stripFrontmatter` |
| 包模板与自建模板重名 | chip 指向错的那个 | B 优先（pi 的最终视图就是 B 的选择） |

回滚：W1–W3 各自一个 commit；W3 失效时来源 B 自动退化为空集合，功能回到现状。

---

## 8. 待决

- 上游建议（pi 在会话条目上存 `template: { name }`）：会话条目的元数据位在 `SessionMessageEntry` 上（`type/message/id/parentId/timestamp`），消息体 `UserMessage` 只有 `role/content/timestamp`，所以正确位置是**条目级**而不是消息体（后者可能被 provider 请求序列化带走）。另开 issue，不阻塞本计划。
- ~~草稿转真实会话的首条消息没有 runtime target~~ **已解决**（2026-10-20，评审后补）：草稿会话改用 `sessions:draft-prompt-templates`（standby 池借用）拿同一份模板正文；e2e 已去掉预热步骤，直接在**新开会话的第一条消息**上断言展开。

## 9. 落地记录（2026-10-20）

| Wave | 落地物 | 验证 |
|------|--------|------|
| W1 | `utils/protectedText.ts`（保护区）、`sending/outgoingExpansion.ts`（会话引用展开下沉为纯函数）、`composerBehavior.expandPromptTemplates` 改为只改块外文本 | `tests/expandOutgoingMessage.test.mjs`（10 项，含引用内 `/模板名`、`&会话名` 不被展开、`$&` 不被当替换模式） |
| W2 | `main/prompts/runtimeTemplateBodies.ts` + IPC `sessions:runtime-prompt-templates` + `RuntimePromptTemplate` 类型 | `tests/runtimePromptTemplateBodies.test.mjs`（6 项：来源过滤/路径与大小守卫/读失败降级/重名/畸形输入） |
| W3 | `utils/templateCatalog.ts` 合并规则 + `useSessionComposerController` 加载来源 B + `getTemplates()` 发送期读取 + 未知 `/名称` 补拉 | `tests/templateCatalogMerge.test.mjs`（6 项）+ `e2e/prompt-template-chip.spec.ts` 两条（线上形态 / 磁盘还原） |
| W4 | `ExpandedRefBlock` 增加 `kind: "template"`（对齐 pi 的 skill / prompt 两种资源）；渲染层用 `visualKind` 映射复用技能视觉，`data-type` 保留真实类型 | `tests/expandedRefBlocks.test.mjs`（kind 序列断言）+ `tests/quoteChip.test.mjs` 同步 |
| W5 | `maintenance-domains.md` 新增常驻小节；本文件状态收敛 | — |

附带修复：`resolveSessionReferences` 的替换改用函数形式，会话正文里的 `$&`/`$'` 不再被当成替换模式（原来会吃掉内容）。

---

## 10. 谁在展开：chip 所有权矩阵（2026-10-21 调研）

**判据一句话**：chip 能不能还原，只看落盘的文本里有没有「自带名字的块」或「原始 token」。
**不是**「谁展开决定有没有 chip」——pi 展开技能会写 `<skill name location>`，照样有 chip；
pi 展开提示词模板只写正文（丢名字），才没有 chip。

| 类型 | pi 后端谁展开 | DSH 后端谁展开 | 落盘形态 | chip 依据 | PiDeck 的工作 |
|---|---|---|---|---|---|
| `@文件` | 无人展开 | 无人展开 | `@路径` 原文 | 文本 + 文件白名单 | 无（原文即身份） |
| `❝引用` | **PiDeck** | **PiDeck** | `<quoted_context label message_id>` | 块 | 展开 + 块格式 + 解析 |
| `&会话` | **PiDeck** | **PiDeck** | `<referenced_session name>` | 块 | 同上 |
| `/模板`（自建，来源 A） | **PiDeck** | **PiDeck** | `<prompt_template name>` | 块 | 同上 |
| `/模板`（包带，来源 B，如 `parallel-review`） | **PiDeck**（改造前是 pi → 丢名字） | 不存在（DSH 不加载 pi 包） | `<prompt_template name>` | 块 | 读正文 + 本地展开（本轮核心） |
| `/skill:名字` | **pi**（`_expandSkillCommand`） | 不支持（DSH 手势不认 `:`） | `<skill name location>` | 块 | 只解析展示 |
| `/技能裸名`（`/cv-writer`） | pi 不认（裸名属模板命名空间） | **DSH host**（`SKILL_GESTURE` 注入消息） | 用户消息原文 `/cv-writer` | 命令白名单 | 白名单（`getCommands` 别名的修复点） |
| `/plan` 等扩展命令 | pi 执行（不落消息） | DSH 执行（pre-step reject） | 无 | 无 | 只做拦截/让路 |
| 桌面命令（`/new` `/login` …） | **PiDeck** | **PiDeck** | 无（不进模型） | 无 | `classifyComposerSlashCommand` |
| 目标轮次消息 | — | DSH 注入 `<goal_round>`，`source.kind="goal"` | 投影器过滤，不进时间线 | 不显示 | 无 |

三条由此得出的结论：

1. **引用 / 会话引用 / 模板这三类只有 PiDeck 展开**——没有我们的工作，它们在重载后就是裸 XML。
2. **包带模板必须抢在 pi 前面展开**：pi 会展开但丢名字，这正是「运行中 chip、暂停后变全文」的根因。
3. **技能不需要我们展开**：pi 的块自带名字，DSH 的技能内容根本不进时间线（`source.kind="skill-invocation"` 被过滤）。

## 11. 与 pi / DSH 的对齐账本

### 已对齐（有代码与测试盯住）

| 项 | 对齐对象 | 落地位置 |
|---|---|---|
| 模板清单来源 | pi `get_commands`（`source="prompt"` + `sourceInfo.path`） | `main/prompts/runtimeTemplateBodies.ts` |
| 同名优先级 / 禁用不加载 | pi `resourcePrecedenceRank` + `dedupePrompts` 先到先得 | `utils/templateCatalog.assembleTemplates` |
| 参数替换 | pi `parseCommandArgs` / `substituteArgs` | `utils/templateArgs.ts` |
| frontmatter 剥离 | pi `extractFrontmatter` / `stripFrontmatter`（BOM / 换行归一 / `\n---` / trim） | `utils/frontmatter.ts` |
| 压缩 / fork / clone | pi 原生 RPC（`type:"compact"` / `"fork"` / `"clone"`） | `main/pi/AgentManager` |
| 编辑/删除消息 | pi `ContextEditEntry`（`targetId` + `replacement.content\|null`） | `main/pi/SessionFileEditor` |
| 技能调用语法 | pi `/skill:名字`；DSH 裸 `/名字`（`SKILL_GESTURE`） | `composerBehavior.toSkillInvocationToken` |

### 有意不同（不是漏学，写清理由）

| 差异 | pi 的行为 | 我们的选择 | 理由 |
|---|---|---|---|
| 命令位置 | 只认消息**开头**的 `/命令` | 任意空白后的 `/名称` 都认 | 输入框里常有多段并写；同时用保护区避免改写引用正文 |
| 无占位符的参数 | 直接丢弃用户输入 | 追加在块后 | 丢字比位置不完美更危险 |
| 模板展开结果 | 纯正文（名字丢失） | `<prompt_template name>` 块 | 否则重载后无法还原 chip |
| 命令让路 | 不需要（pi 的扩展命令先执行） | 保留集避免本地展开抢占后端命令 | DSH 的 slash 桥只认 `/` 开头，被换掉就永不执行 |
| 引用块内容 | pi 无此概念 | 块内只读（保护区） | 引用正文被改写 = 篡改历史 |

### 复核入口（下次对账直接看这几处）

```
pi:  dist/core/prompt-templates.js      # expandPromptTemplate / _expandSkillCommand / substituteArgs
     dist/core/resource-loader.js       # resourcePrecedenceRank / dedupePrompts / loadPromptTemplates
     dist/utils/frontmatter.js          # stripBom / extractFrontmatter / stripFrontmatter
     dist/modes/rpc/rpc-mode.js         # get_commands（只报 extension / prompt / skill，不报 builtin）
     dist/core/slash-commands.js        # BUILTIN_SLASH_COMMANDS（24 条，RPC 不执行）
DSH: src/main/dsh/hostEntry.ts          # 生成的 pideck-slash-bridge（agent/pre-step → commands.execute）
     packages/skill/tool-skill/src/index.ts   # SKILL_GESTURE 与 skill-invocation 注入
     packages/skill/skill/src/index.ts        # renderSkillContent（<skill_content>）
     packages/goal/command-goal/src/index.ts  # /goal 的命令文法（clear/edit/pause/resume）
     packages/goal/goal-round-driver/src/prompt.ts  # <goal_round> 每轮注入
```

## 12. 已知缺口台账（记录，不代表要修）

| # | 现象 | 影响 | 结论 / 入口 |
|---|---|---|---|
| 1 | DSH 技能可能被同名提示词模板抢走（`/cv-writer` 被展开成块 → DSH 看不到手势） | 技能静默不执行，无提示 | **暂不修**：PiDeck 技能清单与 DSH 不同源（DSH 有 `~/.dsh/skills`、项目 `.dsh/skills`），直接复用会既漏又误伤；要做先加 DSH 技能清单桥 |
| 2 | pi 内置命令手敲无反应（`thinking` `scoped-models` `import` `bug` `changelog` `trust` `quit` 等） | 被模型当问题回答 | **暂不修**：这些命令 RPC 根本不报，菜单里不可发现；只有手敲才踩。要做是「手敲到 pi 内置命令时提示桌面不支持」 |
| 3 | 技能「插入全文」只贴正文，不含 `<skill name location>` 与相对路径说明 | 模型拿不到技能名/位置/相对路径提示 | 属**主动选择**（按钮语义是"插入文字"）；可改文案或去掉入口 |
| 4 | DSH 命令执行后没有结果卡片（`command/run`、`command/done` 未投影） | 命令执行完时间线无反馈 | 纯展示层可补，未排期 |
| 5 | Web / 飞书发送不经过前端展开 | 那边的 `/模板名` 永远没有 chip | 既有架构（展开只在桌面渲染层），未排期 |
| 6 | `tests/composerPrewarmFocus.test.mjs` 红（缺 stub 模块） | 影响全量测试 | 基线 worktree 同样红，非本轮引入 |
| 7 | 含占位符的模板（如 `parallel-review` 结尾的 `$@`）会把用户参数**填进**模板正文 → 参数随正文一起折进 chip，气泡里看不到用户自己写的话 | 用户发完看不到自己的指令（2026-10-21 实测反馈） | **已修（选 B）**：正文原位替换（与 pi 等价）+ **块外始终再留一份可见副本**（`if (rest) expanded += "\n\n" + rest`）。代价是模型侧多一次重复（用户参数通常很短）。实测占位符只集中在包带模板（pi-subagents 6 个模板全是 `$@`），PiDeck 内置 13 个模板都不用占位符，所以日常 `/commit` `/review` 不受影响 |

