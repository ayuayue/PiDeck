> 节号索引：§0–§2 `connect.md` · §3–§4 `read.md` · §5–§5.5、§8 `message.md` · §5.6、§9.1–§9.4 `collaboration.md` · §6 `restart.md` · §7 `actions.md` · §9–§10 `boundaries.md` · §11 `maintenance.md`

## 11 改这套文档之前

用技能的人：PiDeck 只用这一处 `~/.pi/agent/pideck-skills/pideck/`——每次启动从安装包写过去（`SKILL.md` 与整个 `references/`），装上就能用，不是给手改的地方（改了下次启动被覆盖）。

改文档的人：只有一处算数——`<仓库>/resources/skills/pideck/`。`SKILL.md` 是路由入口，正文按节拆在 `references/` 下。判据脚本在 `<仓库>/scripts/skills/pideck/`，不随技能分发。

不想等发版、要在本机先试：

```bash
mkdir -p "<userData>/skills-overlay"
cp -r <仓库>/resources/skills/* "<userData>/skills-overlay"/
```

**整包才生效。** overlay 必须自带 `skills-manifest.json`，清单里列的全部文件都在（含 `references/`），且逐个哈希对得上。只放本技能那几个文件也能过本技能的校验，但其余技能在 overlay 里找不到，安装会被跳过。

`installTemplate`（`src/main/skills/SkillManager.ts`，落盘实现在 `bundledSkillInstaller.ts`）每次启动无条件覆盖 `SKILL.md` 与 `references/`，内容取自 overlay——**条件不是「有目录」，而是「overlay 自带清单且逐文件哈希对得上」**，任一不符就回落到打包的那份。唯一例外：`SKILL.md` frontmatter 的 `disable-model-invocation: true` 会被记住并写回（见该方法的 `wasUserOnly` 分支）。

**本地绿、CI 绿、能合，是三件事。** 上游仓的 `Dev Guard` 工作流里还有一步「Check skills manifest drift」：`resources/skills/skills-manifest.json` 记着每个技能文件的 sha256 与字节数，你改了 `resources/skills/**` 下任何一个文件却没重生成，它就判红，PR 状态变成 `UNSTABLE`。2026-11-17 实测：连着推两次都红着，中间隔了十几轮回执，没人看过 PR 的检查结果——所有人核的都是本机那几条，全绿。

```bash
npm run generate:skills-manifest   # 改了任何技能文件之后跑一次（写操作）
npm run check:skills-manifest      # rc 必须是 0
```

PR 的检查结果要主动取：`gh pr view <n> --json statusCheckRollup`，或者 `gh run list --branch <分支>`；mergeStateStatus 显示 `UNSTABLE` 就是有检查红了。

**判据在源码克隆根目录跑，rc 都得是 0：**

```bash
npm run test:skills   # 一次跑完：动作/端点表、全文 /api 路径、每份 md 的格式、反引号标识符、自检
```

单个文件调试时直接传路径（不传就用脚本里的默认文件）：

```bash
node scripts/skills/pideck/check-doc.mjs                     # 默认查 references/web-api/actions.md 的 7.1 / 7.2
node scripts/skills/pideck/check-paths.mjs <md 文件>          # 每个 /api 路径逐段对源码
node scripts/skills/pideck/check-format.mjs <md 文件>         # 表格列数、加粗成对、代码块配对、$ 变量、节号引用
node scripts/skills/pideck/check-fields.mjs <md 文件>         # 反引号标识符逐词对源码
node scripts/skills/pideck/check-self-contained.mjs --selftest  # 判据自己；给文件参数时扫的是「离开文件的文字」
```

节号引用跨文件也要能落地：`check-format` 默认只认同文件标题，`run-skills-checks` 会把全部 web-api 文件的节号索引经 `--sections=` 传进来。单独跑某一份文件时，跨文件引用会被判红；要么带 `--sections=`，要么把引用改成同一份文件里能查到的标题。

改了源码里的路由之后，还要重写台账。`--update-routes` 是**写操作，不是判据**——它的 rc=0 只表示写成功：

```bash
node scripts/skills/pideck/check-doc.mjs --update-routes   # 重写 check-doc-routes.json，并打印跳过几条残缺串
```

带 `--selftest` 的是 `check-paths`、`check-format`、`check-fields`、`check-self-contained`、`check-round-robin` 五个，能脱离源码单独验「判据自己还对不对」。`check-doc` 没有自检：传 `--selftest` 会直接 rc=2 并打印「check-doc 没有自检」，因为它的每条判据都要真的路由表，源码不在就报 rc=2——那是环境不全，不是判据失败。

`check-doc.mjs` 还要读同目录的 `check-doc-routes.json`：60 条路由的台账，生成物，别手改。源码里少了一条台账里有的路由，它逐条打印并判 rc=1，所以删路由必须连台账一起改、在提交信息里说明为什么。台账缺失也判 rc=1，那是部署不全不是环境缺失。源码新增路由只提示不判红，否则每改一次源码都会红，这条判据就没人用了。残缺串（裸 `/api`、通配 `/api/*`、带中文的注释片段）不进台账，`--update-routes` 会跳过并打印跳了几条。

口径上限写在各自文件头：`check-paths` 只按段比对、抓不到顺序错；`check-doc` 抓不到模板串拼出来的路由；`check-fields` 要读全量 src，克隆不完整时用 `--src=<完整 src 目录>` 指过去，别删它求绿；`check-self-contained` 只管「离开文件的文字」，本文件内部的节号引用是合法的。

拆分之后多一条口径：`check-doc` 只认 `actions.md` 里的 `### 7.1` / `### 7.2`，所以动作表与端点表必须留在同一份文件；把 7.1 或 7.2 挪到别的文件，它会判红而不是静默放过。

### 踩过的坑（都是实测，改这套文档时会再撞上）

**改了 `resources/skills/` 下任何文件（`SKILL.md`、`references/` 都算）必须重跑技能清单，否则 CI 红。** 仓库 CI 有一条 skills-manifest drift，清单记录的 sha256 与文件不一致就失败（2026-11-16 实测日志：`[content-manifest:skills] artifact is stale`）。

```bash
npm run generate:skills-manifest    # 写操作：重写 resources/skills/skills-manifest.json
npm run check:skills-manifest       # 判据：rc 必须是 0
```

**管道会吃掉退出码。** `node check-doc.mjs | tail -1` 之后取到的 rc 是 `tail` 的，不是判据的——2026-11-16 因此三次误判「判据红了」。要看真 rc，先重定向再取：

```bash
node scripts/skills/pideck/check-doc.mjs > /tmp/o 2>&1; rc=$?; tail -1 /tmp/o; echo "rc=$rc"
```

**`git push` 失败时也可能看到 rc=0**（同一条命令后面还跟着别的命令）。推完用远端复核，别只看自己的输出：

```bash
git ls-remote <remote> refs/heads/<branch>   # 与本地 git rev-parse HEAD 对齐才算推上
```

**门禁里「后续判据依赖的前置步骤」不能写成可能静默为假的条件。** 实测：版本检查依赖先拉 base commit，而那一步的 `if` 在 fork PR 上被判 skipped，下一步直接报 `fatal: path 'package.json' exists on disk, but not in '<sha>'`——错在上一行，红在这一行。写成总是执行、取不到时回落，并把回落结果用 GITHUB_ENV 显式传下去。

**插入位置在围栏内还是围栏外，比文字本身更容易错。** 2026-11-16 往代码块里插一段，围栏被破坏，判据红在「标题前缺空行」这种看不出原因的位置。改完任何一份 md，第一件事就是跑 `npm run test:skills`。

**拆文件后别丢节号。** 正文内部互相引用用的是「第 5.6 节」这种全局节号，拆到不同文件后仍然有效——前提是每份文件开头的节号索引同步更新。新增/移动一节时，先改索引，再改正文里指向它的句子。
