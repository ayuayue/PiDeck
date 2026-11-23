# 社区 PR 合并门禁与回归复盘

> **Status: Current（2026-11-07 建立；规则以本文件和 `scripts/prGate.mjs` 为准）**


> 读它的时机：审查 / 合并任何社区 PR，或回答「这个 PR 能不能自动合并」。
> 背景：PiDeck 的社区 PR 由本机自动化（gh-agent）审查并给合并标记，人类只点批准。
> 人类不再逐行读 diff，所以**规则必须写成可判定的条目**，而不是"注意质量"。

## 1. 六条安全红线（命中即拒绝，不给合并标记）

前六条（R1–R6）都由 `scripts/prGate.mjs` 判定（R1–R5 只看**新增行**）；R7 由 `npm run check:package-json` 判定；实现不了的细节在表里注明「人工」。

| 编号 | 红线 | 判定 |
|---|---|---|
| R1 | 关闭 Electron 隔离：`webSecurity:false`、`contextIsolation:false`、`nodeIntegration:true` | 新增行即命中（含 `webPreferences.webSecurity = false;` 赋值式、`"nodeIntegration": true` 引号键）；**测试文件里**命中只算人工复核。`sandbox:false` 不算红线（主窗口当前就是 `sandbox:false`，见 `src/main/index.ts` 的 `createWindow`），只人工确认不是扩大范围 |
| R2 | 引入未审的远程代码或回传：新增第三方运行时依赖、`preinstall`/`postinstall`、向陌生域名发送会话/凭据 | 自动：`package.json` 新增依赖或 install 脚本；**人工**：新增非第一方外链/上传目标 |
| R3 | 破坏文件/协议边界：自定义协议直接拼接路径、CSP 放开 `allow-same-origin`、未做 realpath containment | 参照正面样例 `src/main/wallpaperEngine/wallpaperEngineLibrary.ts` 的 `resolveInsideItem` |
| R4 | 命令注入：`shell:true` 拼接用户输入、`eval`/`new Function`、把 PR 内容当命令执行 | 新增行命中即人工复核 |
| R5 | 会话/凭据：读写 pi 活跃 JSONL、把 key 写成字面量、新增 `.env`/私钥文件 | `src/main/` 里新增 `.jsonl` 写入且同行出现 `session`/`.pi/`/`piDir` → 人工；`apiKey/token/secret/password` 赋 16+ 字符字面量（非 `process.env`）→ 人工；新增凭据类文件 → 拒绝。参见 `AGENTS.md` 铁律 2 |
| R6 | 门禁自改：改 `scripts/prGate.mjs`、`scripts/check-*.mjs`、`scripts/testShapeBaseline.json`、`tests/prGate.test.mjs`、`.github/workflows/`、`biome*.jsonc` **同时**改 `src/`、`resources/`、`native/` | 拒绝。规则与基线都在被审的仓库里，不拦这条就能「改产品代码顺便放宽判自己的尺子」。维护者本人确有必要时加 `--allow-protected`；只改 CI/脚本/docs（无产品代码）只留提示。技能文档判据（`scripts/skills/*/check-*.{mjs,json}`）同带产品代码时**只判人工**（`SELF_CRITERIA_PATH`）：它只判文档内容、且技能文档本身在 `resources/skills/**`，正常文档 PR 天然两处一起改，硬拒会误伤；**人工必须确认改动是收紧而非放宽**（#576 实测：这条曾漏判） |
| R7 | 包清单结构破坏：package.json 顶层 `scripts`/`dependencies`/`devDependencies` 段被删、依赖名混进 `scripts`、版本值不是非空字符串 | **不由 `prGate.mjs` 判定**（它只看 diff 行，看不到「段头被吞但 JSON 仍合法」）：`npm run check:package-json` 在 ci.yml 与 dev-guard 都跑，rc=1 即拒绝。教训见 §5 的 2026-11-15 条目 |

判定命令（确定性首筛，退出码 1 = 命中红线）：

```bash
node scripts/prGate.mjs --pr <编号>            # 社区 PR
node scripts/prGate.mjs --pr <编号> --allow-protected   # 维护者本人改门禁/CI 时
```

注意 `SELF_CRITERIA_PATH` 只产生 manual/note（不进退出码），审查者不能因为它“没红”就跳过——口径被放宽的判据脚本与红线的杀伤力在长期，不在一行 diff 上。

## 2. 尺寸与证据阈值

| 规模 | 处理 |
|---|---|
| ≤ 400 行且 ≤ 20 文件 | 正常审查 |
| 400–1500 行或 20–60 文件 | PR 描述必须含复现步骤 + 测试证据 |
| > 1500 行或 > 60 文件 | **禁止自动合并**：要求分片，或人工逐段审 + 该域 e2e |
| > 5000 行或 > 300 文件 | 拒绝合并，要求拆成可独立验证的分片 |

证据规则（`--pr` 会自动检查）：

1. 改了 `src/` 非测试文件却**零测试变更** → 人工复核（纯 `docs/`、纯样式、i18n 文案除外）。
2. 删除测试 → 必须说明对应功能确实被移除；只删测试不删功能 = 拒绝。按**净减少**计（删旧加新的改写是正常动作，实测占已合并 PR 的 46%）。
3. 新增 `tests/*.test.mjs` 只读生产源码再正则断言 → 拒绝。判定口径只在 `npm run check:test-shape`（含运行时加载豁免），`prGate.mjs` 不重复实现。**已知局限**：基线 `scripts/testShapeBaseline.json` 按文件名 grandfather，已入库文件仍可追加源码断言；`--update` 只能由维护者在合并后刷，且需一并提交。
4. 改 `rendererCopy.zh-CN.ts` 却没改 `zh-TW.ts` → 人工复核。真正的同步门禁是 `tests/zhTwCopy.test.mjs` 的 source-sha256 断言（`genZhTwCopy.mjs --check` 无 opencc-js 时会直接跳过，不能当门禁）；修法 `node scripts/genZhTwCopy.mjs`。
5. 同一作者 48 小时内对同一文件连开 ≥ 3 个 PR → 要求合并成一个 PR。**未自动化**（要调 GitHub 时间线），由审查者人工看 `gh pr list --author`。
6. 新增 `e2e/*.spec.ts` **自己在 spec 里 launch Electron**（不走 `e2e/fixtures` 等共享 helper）→ 人工确认 `USERPROFILE`/`HOME` 已重定向（#502 教训）。走共享 helper 的新用例只提示。

## 3. 合并后观察期

- **72 小时**：同文件出现 `fix:` 提交 → 记录到下方复盘；该 PR 的审查漏项写进"教训"。
- **同文件的口径**：按**模块目录**判，并排除汇聚文件（`src/main/index.ts`、`src/preload/index.ts`、`src/shared/ipc.ts`、`src/main/pi/AgentManager.ts`、`src/renderer/src/i18n/*`）。2026-11-17 实测：直算同文件时，46 个文件的 #509 在 72 小时内「命中」19 条无关 `fix:`——任何域改这些汇聚文件都会被算到它头上。
- **7 天**：出现 revert 或同一症状再次被修 → 作者降一级（见 §4），并要求后续 PR 补 e2e。
- 观察期结论只写**事实**（PR 号、commit、症状），不写对人的评价。

## 4. 贡献者分级（名单不入库）

公开仓库只放规则，具体名单在本机私有文件（gh-agent 配置目录），避免公开点名。

| 级别 | 含义 | 执行 |
|---|---|---|
| A | 正常 | 按 §1–§2 审查 |
| B | 曾出现合并后回归 | 必须附复现步骤 + 回归测试；否则不给合并标记 |
| C | 反复低质量 / 巨型重写 / 挤牙膏 | 只接受 ≤ 200 行且有测试的 PR；**永远不给自动合并标记**，必须人工逐行审 |

升级：连续 3 个 PR 过 72h 观察期无回归。降级：命中 §3 任一条件。

## 5. 回归复盘（只增不改，日期倒序）

- **2026-11-22 · `prGate.mjs` 读的是 format-patch，不是净 diff**：`fetchPull` 调 `gh pr diff <n> --patch`，gh 2.87.3 的 `--patch` 吐 git format-patch（按 commit 分段，含后来被 revert 扫回的文件）。#594 净 diff 里没有 `src/`，首筛却因某笔早先提交的 `src/shared/types/session.ts` 报 `SELF_PROTECTED_PATH` 阻塞（30 个 diff 段 vs 真实 20 文件）。**教训**：门禁的输入形态本身就是判据——现在 `fetchPull` 不带 `--patch`，拿到 format-patch 由 `assertNetDiff` 当场失败，`tests/prGate.test.mjs` 覆盖这两件事。

- **2026-11-17 · 窗口内 5 个超尺寸 PR 仍被合并**：#509（+3309/−49，46 文件）、#515（+1836/−109，40 文件）、#526（+2568/−92，9 文件）、#552（+1810/−94，27 文件）、#528（+1931，15 文件）。§2 的「>1500 行禁止自动合并」对它们全部失效——其中 #509/#515 合并后都出了同模块修复（见下两条）。**教训**：阈值没有执行点就等于没有阈值；审查回复里必须写清「本 PR 命中 SIZE_LARGE，需分片」，不能因为有测试就放行。
- **2026-11-16 · dev 累积 350 个提交后 9 条单测红（`48c73ffd7`）**：dev-guard 刻意不跑全量单测，红只在 main CI / 合并 dev 时暴露。根因全非产品行为、而是「契约变了锚点没跟」：#546 加 `gtd:state-get`/`gtd:state-patch` 未更新统一接口快照（ipcChannels 851→853）、#560 加 `modelCallMetrics` 未更新 ACP 握手声明、#555 给 `ComposerArea` 加 import 未补模块 stub（整组 9 条 TypeError）。**教训**：改 shared 契约（IPC 通道 / 后端能力声明）或给高频 stub 的组件加 import 的 PR，必须跑对应快照测试组；「接口加了实现」不等于「契约同步了」。
- **2026-11-15 · 直推 dev 的 `e6d7eb3ba` 把 package.json 的 dependencies 段吞进 scripts**：编辑 `test:skills` 时删掉 `},` 与 `"dependencies": {`，JSON 仍合法、`npm ci` 不报错（只是不装），`15229db5e`/`5649d8984`/`906217e77` 三笔 CI 连续红在 `ERR_MODULE_NOT_FOUND: Cannot find package 'electron-updater'`（首个撞上的受害者，不是根因），`caf7b87a8` 修。**教训**：JSON.parse 通过不是结构完整的证据；现在有 `npm run check:package-json`（ci.yml + dev-guard，§1 R7），改包清单后先跑它再分析任何运行时缺失。
- **2026-11-15/16 · #552（+1810/−94）与 #566 的技能判据返工 8 次**：`37ef7bcc`/`000ce422d` 修「恒绿判据」（判据永远为真、没有分辨力），`2af47e179` 补路由台账，`58621c640` revert 夹带的三篇无关技能。**教训**：判据类 PR 必须附「坏样本 → 红、还原 → 绿」的证据，否则等于没写；技能/文档 PR 也按代码 PR 审，不因非 src 就免检。
- **2026-11-14 · #509 关联会话的跨重启回归（`fab3b5feb`）**：#509（+3309/−49，46 文件）合并 6 天后才暴露「重启后子会话挂着等待中」——症状只在重启/恢复后出现，72 小时窗口抓不到。**教训**：带持久化状态或跟重启语义相关的功能，观察期按 7 天算，并要求 PR 附「重启/恢复后的行为」证据。
- **2026-11-09 · #515 macOS 签名链路合并当天补修（`30cb9d5bd`）**：#515（+1836/−109，40 文件）合并当天由维护者修 arm64 keychain 与 dev 发布写者。**教训**：签名/发布类改动必须附本机实测记录（keychain × 架构组合），阈值再大也挡不住「只在一台机器上验过」。

- **2026-11-03 / 11-06 · PR #473**（+3699/−681，189 文件）重做时间线翻页，合并次日 `2db1d5b48` 修"加载更多在第一条消息常驻且点击无反应"，11-06 `d628ab468` 再修空页回退与放置竞态；而同一症状已在合并前的 #465、#467 修过。**教训**：大 PR 重写必须附该域 e2e；审查时先查"同一症状近 30 天是否修过"，把旧修复点列成 checklist。
- **2026-11-02 · PR #479**（+34390/−3620，523 文件）集成分支整体合并。**教训**：超过 5000 行的 PR 不可审，直接要求拆。
- **2026-10 · PR #460**（+7946/−1177，217 文件）标"纯格式"。**教训**：格式化不与逻辑混；全量格式化会打破 404 个对源码做正则断言的测试。
- **2026-11-06 · PR #502**（+108/−1）新增 e2e 直接写真实用户 profile，合并 12 分钟后 `7d90aa7f7` 补隔离。**教训**：e2e 必须用 fixtures 并重定向 `USERPROFILE`/`HOME`；新增 e2e 一律检查是否碰真实用户目录。
- **2026-10 · PR #409/#421/#422** 同一文件 48 小时内连开 3 个 PR。**教训**：挤牙膏式 PR 要求合并，降低互相覆盖风险。

正面样例（新 PR 照此对照）：#383 HTML 预览（自定义协议 + CSP + iframe sandbox 不含 `allow-same-origin`）、#405 壁纸引擎（realpath containment + 白名单 + 体积上限）、#489 文件重载（沿用 `ProjectFileAccessScope` + dirty 二次确认）、#456（抽模块 + 168 行运行时测试）。

## 6. 执行点

1. **gh-agent**：PR 审查时按本文件判定；私有分级文件可选。命中 §1 或 §2 的"禁止自动合并"就在回复里写阻塞项，**不输出合并标记**。
2. **人工**：桌面壳永远人工点批准；批准前只看回复里的"阻塞项"与证据。
3. **脚本**：`node scripts/prGate.mjs --pr <n>` 给出确定性首筛，避免每次口径漂移。
4. **定期清理**：走 skill `pideck-pr-hygiene`（在本机全局技能目录 `~/.pi/agent/skills/`，**不入库**）→ 采集 / 首筛 / 复盘 / 恶意扫描 / 有界清理 → 写回本文档 §5。
5. **包清单**：`npm run check:package-json` 是 §1 R7 的执行点（ci.yml 的机械不变式链 + dev-guard），改 package.json 后本地先跑一次。

## 7. 维护

- 每次定期清理只追加 §5 一行事实；规则改动必须同时改 `scripts/prGate.mjs` 与 `tests/prGate.test.mjs`。
- 本文档不写作者评价、不写私密路径；分级名单只存在本机。
- 死代码：`node scripts/find-dead-code.mjs` 的结果要区分「计划中的 seam（只有测试在引用）」与真僵尸；删零引用组件时**连孤儿词典键一起删**并跑 `node scripts/genZhTwCopy.mjs`（2026-11-17 实测：W1 目标路由重构后 `WindowsOnlyConfigNotice.tsx` 与 `config.windowsOnly.*` 残留 21 行代码 + 6 行文案，对应测试还在断言已无人渲染的 copy）。
