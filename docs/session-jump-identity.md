# 会话跳转与消息身份

跳转先按文件条目ID定位，再读取目标所属的完整回合。运行时消息、离线投影、搜索命中、折叠组和页面节点共用 `shared/sessionJumpAnchor.ts` 的身份规则。

| 能力 | 实现边界 | 回归 |
| --- | --- | --- |
| 投影ID与文件ID互认 | `resolveJumpMessageIndex` / `jumpEntryKey` | `sessionJumpIntegrity.test.mjs`、`mergeHistoryWindow.test.mjs` |
| 分支内定位和完整回合取页 | `SessionDisplayPaging.readSessionDisplayJumpPage` 在一个索引快照内定位、计算边界、读取正文 | `sessionJumpPaging.test.mjs` |
| 不相邻的页面按历史顺序合并 | 跳转页携带同快照 `entryOrder`，只含ID；缓存按它排序 | `sessionJumpIntegrity.test.mjs` |
| 实时输出不被迟到读页覆盖 | `mergeSessionJumpPageAtom` 在提交时读取最新缓存，保留运行时窗口及来源 | `sessionJumpIntegrity.test.mjs` |
| 新点击立即取消旧跳转 | 点击序号独立于重试次数，点击时同步递增；切会话、回底、卸载均取消旧结果 | `timelineJumpTransaction.test.mjs` |
| 目标页超预算仍保留目标 | 减少后续回合；单个超长回合保持完整 | `sessionJumpPaging.test.mjs` |

`entryOrder` 是按需跳转响应里的只读索引，不是第二份可写历史。全文件索引顺序只用于跨页排序，不得作为活动分支的分页下标。正文仍按回合有界读取，DOM仍由轮次窗口限制。

修复对应的反例：全文件索引混入废弃分支后坐标错位；固定补24条截断长工具回合；不相邻页按点击顺序追加；缺少meta时同条消息重复；旧页覆盖流式缓存；新点击至React重绘之间旧请求仍可提交。

检查命令：

```sh
node --test tests/sessionJumpIntegrity.test.mjs tests/sessionJumpPaging.test.mjs tests/timelineJumpTransaction.test.mjs tests/mergeHistoryWindow.test.mjs
node --test tests/jumpReplay.history.test.mjs
npm run typecheck
npm run check:file-size
npm run check:test-shape
```

原有按源码位置查找分页边界的断言随领域迁移同步调整；完整回合、分支与ID行为由真实JSONL夹具覆盖，未降低为仅检查源码字符串。
