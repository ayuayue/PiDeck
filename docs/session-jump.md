# 会话跳转：点一条消息，一次到位

读者：改这块代码的人，以及想知道「为什么它以前老是跳不过去」的人。

## 结论

点击侧边查找面板里的一条消息，应该在**一次点击**内滚到那条消息本身。做不到时，界面必须说清是哪一环、凭什么。

```
点击（entryId）
 → 全量索引查条目（entries，含非活动分支与已压缩条目）      O(1)
 → 按字节偏移在活动分支里定位最接近的位置
 → 一次取页 readSessionDisplayTurnPage(before = pos + 1, 200 轮)
 → 页里没有目标？→ 按 offset 读单行 → 同一投影器转 ChatMessage → 插到页首
 → 立刻设锚点，窗口切到目标轮
 → 虚拟列表挂载 + settle 收敛
```

## 三个下标空间，混用就跳不过去

| 空间 | 单位 | 谁在用 |
| --- | --- | --- |
| 文件条目 | JSONL 的一行 | entries（含非活动分支） |
| 活动分支消息 | activeMessageEntries 的数组下标 | before 游标、pos |
| 渲染消息 id | `agentId-history-entryId` | DOM 的 data-message-id |

**把「文件序号」当「活动下标」用，会得到「第一页和最后一页能跳、中间全跳不了」**：文件上万条，活动分支几百条，夹一下就全落到末尾。

代价正确的那把尺子是**字节偏移**（entry.offset）：两个空间的条目都带它。

## 锚点匹配：三种形状都要认

渲染层没有统一的条目形状，childMatchesId 必须同时认：

```
① { id, meta: { entryId } }                   平铺 ChatMessage
② { id, message: { id, meta: { entryId } } }  包一层
③ { id, message: { id } }                     运行时消息，无 entryId
```

只认 ② 和 ③ 时，平铺形状的 meta 在顶层读不到 —— 锚点找不到，窗口不切，人就停在原处。

## 锚点没命中时，不许退到尾部

```ts
if (pinnedMessageId) {
  const i = findAgentRunIndexByItemId(items, pinnedMessageId);
  if (i >= 0) return sliceAround(items, i);
  return items as T[];        // 锚点在途：不裁剪，等它生效
}
return sliceLastAgentRuns(items, windowTurns);
```

退回 sliceLastAgentRuns 的表现是「点第一条，失败后画面自己滚到底部」。

## 跳转只取一次页，不等滚动补页

反例（2026-11 真机，722 轮）：

```
滚动引擎在飞 → isLoadingPage 恒为 true
 → tick 一直返回 wait
 → 补页只往前翻，目标在中间永远翻不到
 → 数据从 5617 长到 8393 却始终没有目标
 → 两次「没增长」后报 H4，而 loadPageAroundEntry 一次都没被调用
```

所以 pageRequested 为假时**立刻**按 entryId 定位取页，不看 isLoadingPage。

## 三态，不是 boolean

```ts
readPageAroundEntry(entryId): "exact" | "positioned" | "missing"

exact       目标就在这一页
positioned  定位到该时间段，但目标本身不可显示（空 content / system / 被 context_edit 移出）
missing     文件里没有这个 entryId
```

## 失败提示必须报本次结果

```
未能跳转（H4）：… [data=8393 target=0 page=idle]
                              ↑缓存条数 ↑目标在不在 ↑本次取页结果
```

page=idle 表示这条路根本没走。以前这里显示 [committed]，那是 loadMoreMessages 的残留值，与本次无关 —— 屏幕上写着「补页成功」，人却停在原处。

## 判据

| 位置 | 判据 |
| --- | --- |
| tests/jumpChainIntegrity.test.mjs | 锚点认三种形状、取页三态、失败提示带诊断 |
| tests/jumpReplay.history.test.mjs | **回灌**：拿真实历史会话逐位置验证定位与页覆盖 |
| tests/jumpWindowPolicy.test.mjs | 窗口策略、失败短路顺序 |

回灌是这一层唯一能发现真问题的判据：小样本单测全绿、真机 722 轮全红，发生过不止一次。

```bash
npx tsx --test tests/jumpReplay.history.test.mjs
# ✔ 回灌 12 个文件 / 96 处，最大会话 12739 条消息
```

没有历史会话目录时 skip（**不算通过**）：这台机器上这条判据没有被验证。

## 已知限制

positioned 表示「落在那段时间附近，但目标本身没有可显示的内容」。实测 102 个位置里 27 处是这样（26%），成因是空 content: []、role: system（0.86 不计槽位）、以及被 context_edit 移出的条目 —— 查找面板能搜到，渲染层没有对应的消息。
## 变异测试的两个坑（都真发生过）

**坑一：变异没生效，跑出 PASS，被当成「判据不红」。**

用 `node -e` 改文件时忘了传 `process.argv[1]`，`readFileSync(undefined)` 报错、文件没改，
测试照旧全绿。看起来像判据失效，其实是变异根本没发生。
没法子省：改完先 `grep` 一下变异串在不在文件里，再跑测试。

**坑二：两个人在同一份工作区并发，读到对方的变异中间态。**

真发生过（2026-11-24）：一方在 `turnRenderWindow.ts` 上做变异（改成 `items.slice(1)`），
另一方同一秒读这个文件做 vm 对比，读出 199 轮并据此报「vm 与真模块行为不同」——
那是采样时刻的中间态，不是实现的属性。

`git status --porcelain` 为空**不足以**排除这件事：它只证明「动手前那一秒没有未提交改动」，
证明不了「读文件那一秒没有别人在改」。两个动作隔了几十毫秒，那几十毫秒正是变异存活的时间。

规矩两条，都便宜：

1. **变异在副本上做**：`cp` 到临时目录，改副本，跑完删掉。仓库文件一个字节不动，谁读都不受影响。
   要测试指向副本时，改用环境变量或参数传路径，不要为了一次变异去改测试里的硬编码路径。
2. 做不到副本时，消息里写**变异窗口**：起止时刻、哪个文件、改成了什么。
   `变异窗口 16:48:10–16:48:40 turnRenderWindow.ts sliceLastAgentRuns → items.slice(1)`
   读的一方在读数前先看有没有活跃窗口。

顺带一条：读文件时记下 `mtime`，与自己的动作时刻比。mtime 比预期新，说明读到的可能不是 HEAD。
**坑三：变异生效了，判据也没红，因为用例没走到变异点。**

形状：改坏一条只在特定分支才执行的行，而样本里那条分支从不进。测试照绿，
读成「判据不红」，其实是「变异点没被执行」。与坑一都是绿，原因完全不同：
坑一是文件没改，坑三是改的那行没跑到。

判据（最便宜）：变异点里塞一句 `throw new Error("HIT")`，跑一次。看到了说明点可达，
再判红绿；没看到说明这条用例根本没走进去，绿不算数。

**坑四：红了，但红在别的断言上。**

`fail 1` 就算数、不读是哪一条，会得出「新断言有效」的错误结论——实际可能是更早的一条先红，
新断言从没被走到。

判据：红的时候读三样——用例名、断言内容、`actual` 与 `expected`。三样里有一项与变异点对不上，
就不算抓到。

**坑五：变异被缓存吃掉。**

改了文件，跑测试仍是旧结果。三种来源都真实：`tsc` 增量（tsbuildinfo）、
同进程内 `require`/`vm` 已编译的模块对象、构建层缓存。

判据：变异之后、跑判据之前，先断言被测的那份代码里含变异串：

```js
assert.ok(String(pickJumpAnchorEntryId).includes("slice(1)"), "测的这份代码里没有变异");
```

这一句同时挡住坑一、坑三、坑五的前半：证明「跑的是变异过的那份」。
剩下只是「那行有没有被执行」（坑三）与「红在哪一条」（坑四）。

### 报数的口径：按 sha，不按路径

路径 `src/…/turnRenderWindow.ts` 在不同时刻是不同内容；**sha256 是内容本身**。
报数时报「我读的那份字节的 sha」，别人拿它一比就知道数基于哪份内容。

这样并发的变异、缓存、副本混用都会被 sha 挡住。比「带 mtime 与时刻」更硬：
mtime 可以被拷贝改掉，sha 不会。
## 给另一个会话发消息时，两件事必须核

**一、消息文件必须带归属。**

真发生过（2026-11-25）：消息写在 `%TEMP%/r16.txt`，另一个会话在同一目录用了同名文件，
覆盖了我的内容。派单脚本照发，对方的收件箱里出现的是**别的会话的正文**。

派单脚本打印了首行（`[计划] 正文 · 2812B · 首行 "…"`），我看了一眼没比对——
**打印出来不等于核对**。止损只能再发一条纠正，对方的记录里永远留着那一条。

规矩两条：

```bash
# 1 文件名带自己的 sessionId
echo "$MSG" > "$TEMP/msg-$PIDECK_SESSION_ID-r16.txt"
# 2 发之前核首行是不是自己写的
head -1 "$TEMP/msg-$PIDECK_SESSION_ID-r16.txt" | grep -q '^\[<自己> →'
```

**二、`%TEMP%` 是共享的。** 不只跨会话，也跨进程。任何写进去的文件都可能在两次读之间被换掉——
这与「变异测试读到并发中间态」是同一条：**路径不标识内容**。
## 三个根因（2026-11-25，用户报「中间那些 100/200/300 都跳不过去」）

看起来是「跳转坏了」，实际是三处叠在一起，前两处不在跳转这一层。

**根因一：列表只给 100 条。**

`SESSION_FIND_MAX_MATCHES = 100`，而面板显示的是 `hitCount`（全量命中）。
用户搜一个高频词看到「共 724 条」，列表实际只有 100 条——
他要点的第 200 / 600 条，在列表里根本不存在。
已改 10000（10000 条 × 约 200B ≈ 2MB，比一次 rescan 便宜）。

这条最值得记：判据一直验的是「给定 messageId 能不能跳到位」，
从没验「用户能不能拿到那个 messageId」。入口在判据前面一步。

**根因二：搜索交出来的是投影 id，主进程当条目 id 去查。**

```
搜索给的   _viewer-history-731cee61
索引 key   731cee61
entries.has("_viewer-history-731cee61") = false
```

`resolveEntryPosition` 拿它查索引必然 miss，于是报「这条不在本会话」。
第 1 条能跳是因为它已加载，渲染层按 `meta.entryId` 匹配，绕过了这一层；
中间那些必须走主进程取页，全断在这里。

已加 `normalizeEntryId`：`lastIndexOf("-history-")` 之后那段就是条目 id。
三种形态（条目 id / `_viewer-history-` / `<agentId>-history-`）都定位到同一 pos。

**根因三：跳转借用滚动预取的 200 轮页。**

`pageSize` 的单位是轮不是条。200 轮 × 约 28 条/轮 = 5565 条，
每次跳转都要投影 5565 条再合并——这是「点了要等很久」。
已加 `HISTORY_JUMP_TURN_PAGE_SIZE = 5`：锚点窗口只挂 1 前 3 后共 5 轮，约 140 条。

## 两个不是 bug 的现象（别再当 bug 修）

`activeMessageEntries[0]` 常是 `role: "system"`——投影器不为 system 产生 ChatMessage，
页里 0 条是正确投影。同理 `content: []` 的 assistant 条目投影出 0 条也正确。
这两类本来就不可显示，状态机报 `positioned`，不是取页坏了。

实测：12754 条 activeMessageEntries 里可投影的只有 5590 条。

## 三方验证的分工

| 谁 | 能验什么 | 验不了什么 |
| --- | --- | --- |
| 主进程侧探针 | 定位、取页、三态、锚点、搜索命中数 | 界面渲染 |
| 渲染层单测 | 四路 id 匹配、窗口切片、页大小 | 真实点击 |
| 用户 | 点一下，看滚不滚过去 | — |

最后一行不能省：前两层全绿只证明「数据对」，不证明「点得动」。

## 落位停在空白处（2026-11-26，694 轮会话，搜索面板第 500 条）

日志：

```
jump/entry  {requested: f3934e1f, foundIndex: -1, messages: 139}
jump/merge  {pageMessages: 55, merged: 142, visibleBefore: 139, pageHasTarget: true}
jump/page   {outcome: exact}
jump/settle {rectTop: 897, rectHeight: 197, clientHeight: 828}
jump/row-found {frames: 0}
jump/settle-end {kind: settled}   ×2
```

页取到了、目标进了数组（139→142）、行挂上了、两次判 settled —— 用户看到的是一片空白。

成因：扩窗刚把这一轮挂进来，轮容器先占位（所以量得出 rectHeight），内容随后才由
`VirtualRunList` 填。收手判据只看「高度 > 0」。

改法：`isSettleRowReady(rect, textLength)` 要求有高度**也有文字**；空白期给独立宽限
`JUMP_SETTLE_EMPTY_GRACE_FRAMES = 12`，期间继续 reveal 并等帧，超时按原逻辑走。
新增日志 `jump/row-empty {rectHeight}`，下次第一帧就能区分「空白占位」与「没找到」。

判据：`tests/jumpSettleBidirectional.test.mjs` 两例（就绪判据 / 宽限有界），
变异「只看高度」与「宽限 200 帧」各红一条。
