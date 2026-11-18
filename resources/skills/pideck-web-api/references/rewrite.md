# 改这个技能之前

## 只有一处算数

| 位置 | 谁写 | 能不能手改 |
|---|---|---|
| `<仓库>/resources/skills/pideck-web-api/` | 你 | 唯一真源 |
| `~/.pi/agent/pideck-skills/pideck-web-api/` | PiDeck 每次启动从安装包写过去 | 不能，改了下次启动被覆盖 |
| `~/.agents/skills/pideck-web-api/` | 副本，终端里直接起的 pi 读这处 | 是部署产物 |

改完打包发版，用户装上就是新版。不想等发版、要在本机先试：

```bash
mkdir -p "<userData>/skills-overlay"
cp -r <仓库>/resources/skills/* "<userData>/skills-overlay"/
```

**整包才生效。** overlay 必须自带 `skills-manifest.json`，清单里列的全部文件都在，且逐个哈希对得上。只放本技能那几个文件也能过本技能的校验，但其余技能在 overlay 里找不到，安装会被跳过。

`installTemplate`（`src/main/skills/SkillManager.ts`）每次启动无条件 `writeFile`，内容取自 overlay——条件不是「有目录」，而是「overlay 自带清单且逐文件哈希对得上」。任一不符就回落到打包的那份。

## 判据：四个脚本各管一段

在源码克隆根目录跑，rc 都得是 0。

```bash
node resources/skills/pideck-web-api/check-doc.mjs
node resources/skills/pideck-web-api/check-paths.mjs
node resources/skills/pideck-web-api/check-format.mjs
node resources/skills/pideck-web-api/check-fields.mjs
```

| 脚本 | 判什么 | 口径上限 |
|---|---|---|
| `check-doc` | 5.1 动作表与源码 `runtime/(...)` 集合一致；5.2 每条端点在源码里有完整路由且方法对；5.1 的 body 字段与源码 `switch` 里读的 `body.x` 一致；§5 标题里的「运行时 N 个、记录层 N 个」与两张表行数一致 | 抓不到模板串拼出来的路由；源码新增路由只提示不判红 |
| `check-paths` | 全文每条 `/api` 路径的每一段都在源码里 | 只按段比，抓不到段的顺序错 |
| `check-format` | 表格列数、加粗成对、代码块配对、`$` 变量、标题空行、**节号引用指得到真节** | 不判语义 |
| `check-fields` | 反引号里的标识符是否在源码出现 | 只判「出现过」，不判用对没对 |

前三个都扫 `SKILL.md` 加 `references/*.md` 全部。只扫主文件时，搬出去的长尾没有判据——2026-11-18 实测：`references` 里写错一个路径段，四条判据全绿。

**三个有自检**（`--selftest`）：`check-paths`、`check-format`、`check-fields`。装了 PiDeck 的机器上只有副本、没有源码，靠自检验「判据自己还对不对」。`check-doc` 没有自检：它每条判据都要真的路由表，传 `--selftest` 直接 rc=2 并打印原因——那是环境不全，不是判据失败。

改了源码里的路由之后要重写台账。**`--update-routes` 是写操作，不是判据**，它的 rc=0 只表示写成功：

```bash
node resources/skills/pideck-web-api/check-doc.mjs --update-routes
```

台账 `check-doc-routes.json` 是生成物，别手改。源码里少了一条台账里有的路由，它逐条打印并 rc=1，所以删路由必须连台账一起改、在提交信息里说明为什么。台账缺失也 rc=1，那是部署不全。

## 第六道闸在远端，不在你本机

**本地绿、CI 绿、能合，是三件事。** 本机那六条、`npm run check`、远端 CI 各跑各的，任何一组绿都不代表另外两组。

上游仓的 `Dev Guard` 工作流里有一步「Check skills manifest drift」：`resources/skills/skills-manifest.json` 记着每个技能文件的 sha256 与字节数，改了 `resources/skills/**` 下任何一个文件却没重生成，它就判红，PR 变成 `UNSTABLE`。

```bash
npm run generate:skills-manifest   # 写操作：改了任何技能文件之后跑一次
npm run check:skills-manifest      # 判据：rc 必须是 0
```

PR 的检查结果要主动取：`gh pr view <n> --json statusCheckRollup` 或 `gh run list --branch <分支>`；GitHub 返回的 mergeStateStatus 字段显示 UNSTABLE 就是有检查红了。

## 安装产物：判据看不见的那一层

上面六条判据比的是「仓库里的文件」与「副本里的文件」。**没有一条验「装出来的目录长什么样」**——那是 `SkillManager.installTemplate` 的活，判据在 `tests/skillManager.test.mjs`。

2026-11-18 实测：把本技能拆成 `SKILL.md` + `references/` 三份之后，六条判据全绿、`skill-copies` 61 个文件一致、overlay 清单 15 个文件逐哈希对得上——而 `installTemplate` 当时只 `writeFile` 了 `SKILL.md` 一个文件，装到用户机器上正文里的指针全部落空。发现它靠的是顺着「还有谁引用这个技能」找到 `autoInstallBundledSkills.ts`，不是靠任何一条判据。

所以：**加一个文件、改一次目录结构，跑一次**

```bash
node --test tests/skillManager.test.mjs
```

它断言的是 `~/.pi/agent/pideck-skills/pideck-web-api/references/endpoints.md` 存在且内容对。改回单文件写入，这条立刻红（已做变异验证）。

## 副本同步：find 不跟链接

**判据是两条路的并集。** 先把已知候选逐个 md5sum 一遍，再用 `find` 扫一遍，两边差出来的就是 junction/symlink 指向的位置：

```bash
find ~ -name SKILL.md -path "*pideck-web-api*" -not -path "*/node_modules/*" |
  while read f; do md5sum "$f"; done | sort | uniq -c
```

输出只有一行才算同步完。只贴一条路的输出，按未同步算——`find` 默认不跟链接，少算的方向正好是「以为同步完了，实际还有一份」。

## git 纪律

判据只有一条：`git log` 能指到这笔改动，工作区干净。

1. 改完立刻提交，不攒——攒着的改动会被下一次改动污染。
2. 提交信息写为什么，不写「update」「fix」。
3. 有远端就推，推完用 `git ls-remote <remote> refs/heads/<branch>` 与本地 `git rev-parse HEAD` 比对，别只看自己的输出。
4. 动手前跑 `git status`：有别人的脏文件就先停，别把两件事混进一笔。

**行数不是判据。** 判「追加还是替换」要看 diff 里的 `-` 行：

```bash
git diff --numstat <旧> <新> -- <文件> | awk '{a+=$1; d+=$2} END{printf "%d %d\n", a+0, d+0}'
```

加 > 0 且减 = 0 才是纯追加。三个坑：`grep -c "^-"` 被 `--- a/file` 表头喂成恒 1；两版相同时 `--numstat` 一行都不打；只聚第二列分不出纯追加与无改动。

例外只有两条：会变的值（令牌、时间戳、机器相关路径）不进仓；大二进制不进仓，留个生成脚本。

## 四个会重复撞上的坑

**管道会吃掉退出码。** `node check-doc.mjs | tail -1` 之后取到的 rc 是 `tail` 的，不是判据的。要真 rc，先重定向：

```bash
node check-doc.mjs > /tmp/o 2>&1; rc=$?; tail -1 /tmp/o; echo "rc=$rc"
```

**`git push` 失败时也可能看到 rc=0**，因为后面还跟着别的命令。推完用远端复核。

**门禁里「后续判据依赖的前置步骤」不能写成可能静默为假的条件。** 实测：版本检查依赖先拉 base commit，而那一步的 `if` 在 fork PR 上被判 skipped，下一步直接报 `fatal: path 'package.json' exists on disk, but not in '<sha>'`——错在上一行，红在这一行。写成总是执行、取不到时回落，并把回落结果用 GitHub 的 GITHUB_ENV 显式传下去。

**插入位置在围栏内还是围栏外，比文字本身更容易错。** 往代码块里插一段会把围栏弄坏，判据红在「标题前缺空行」这种看不出原因的位置。改完 SKILL.md 第一件事就是跑 `check-format`。

## 加判据之前先答一问

**这个形态会自然出现在谁的回执里？** 答不出来就别写，把它记进口径上限。防「刻意构造的绕法」的判据没人会用到，而改动本身会插坏文件。

三个停止信号，出现任意两个就停：

- 改坏的次数超过抓住的次数。
- 构造的形态答不出「会出现在谁的回执里」。零宽字符有真实来源（从网页或 PDF 复制模板会带不可见字符，字段名静默失配），该修到底；全角引号包裹没有来源，记进上限。
- PR 的 diff 比缺陷大。为拦一个笔误铺开五个文件，会让人宁可不合。

判别标准是「会不会有人在正常做事时撞上它」，不是「我能不能构造出来」。技能的每一行是给人读的，判据的每一行是给机器跑的，所以出错代价不同：多一行规则只多一次误读机会，多一行代码多一次插坏机会。

**整份文件改写要用不截断的读法。** 编辑器工具可能返回片段而不报错，把片段写回去等于删掉没读到的部分。用 `cat` 或 `node -e "require('fs').readFileSync(p,'utf8')"`；写完用 `wc -l` 与 `wc -c` 对一次，行数少了就是被截断过。
