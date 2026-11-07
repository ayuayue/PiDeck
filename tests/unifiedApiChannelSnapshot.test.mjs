/**
 * F3 · IPC 通道快照守卫（TEST-PLAN §F3，6 例，锚定数字见 TEST-PLAN §0）。
 *
 * src/shared/ipc.ts 的 ipcChannels 常量表是全部 IPC 通道的唯一来源；本测试把它的
 * 规模与形状锚定为快照（TOTAL 通道 / PREFIX 前缀 / 排序摘要），同文件里另有 agentEventTags
 * （8 个 Agent 内部事件标签，**不是** IPC 通道）单独锚定。快照变更只允许显式发生
 * 且附领域正当理由——本轮（T4 契约层）任何快照红 = 违例。
 *
 * 2026-10-18 远端合并显式刷新（678 → 743，+65 通道，均附领域正当理由）：
 *   远端开发面 39 条 remote:*（SSH 主机/项目/文件/会话/信任/模型探测）；
 *   远端 Git 面 21 条 git:*（status/log/commit/refs/diff/compare/init/branch/recovery/fetch/push/pull/cancel-reads）；
 *   远端会话归档 3 条 sessions:*（unarchive/delete/answerDelete archived remote）；
 *   远端终端输出 ACK 1 条 terminal:acknowledge；
 *   以上 64 条为远端特性通道，另 1 条为 dev 并行演进通道（dev 已到 679）。
 * 2026-10-16 显式刷新（+4 通道，均附领域正当理由）：
 *   yaoPromptsDbState / yaoPromptsDbRetry（#2 提示词库 db 远程化：下载进度与重试）
 *   sessionsSearchContent（#3 跨会话正文全文搜索：session-index sidecar）
 *   skillHubInstallProgress（技能商店安装进度：spawn 流式解析推送）
 * 2026-10-17 显式刷新（+1 通道，附领域正当理由）：
 *   filesSearchContent（工作区文件内容检索：Go file-index sidecar；未就绪/不可用返回 null）
 * 2026-10-18 显式刷新（+1 通道，附领域正当理由）：
 *   sessionsSearchInSession（会话内查找：session-index sidecar 的 search-session）
 * 2026-10-19 显式刷新：hostPluginsInstallGitHub（从 GitHub 仓库安装宿主插件，并行改动）+1；
 *   下线 GUI 扩展桥与插件开发支持 −5（sessionsBridgeEvent / sessionsBridgeResync /
 *   pluginDevStatus / pluginDevWriteGuide / pluginDevCopyDemo），`plugin-dev` 前缀随之消失（84 → 83）。
 * 2026-10-21 合并刷新：selectionToolResize（划词浮窗折叠 / 展开高度上报）入场，同时下线
 *   sessionsCatalogReadOutlineTitle 与 sessionsCatalogReadDshSystemPrompt（轨迹索引 preview 与事实读取取代），净 −2 → 700。
 * 2026-10-23 刷新（+5）：favoritesList / favoritesAdd / favoritesRemove（收藏功能提交 f3075f08c 漏刷快照，
 *   favorites 前缀随入场 → 88）+ agentProfilesReorder / favoritesReorder（智能体与收藏列表拖拽排序，
 *   入参为完整 id 顺序，主进程剔除未知 id 后落盘）。
 * 2026-10-24 刷新（+1）：favoritesRemoveMany（收藏批量删除：一次 IPC、一次写盘，未知 id 忽略）→ 706，前缀数不变。
 * 2026-10-24 合并刷新：并入上游 26de030fc 的 configDiscoverExternalAgents / configResolveExternalAgentKey
 *   （导入本机其他 Agent 工具的供应商配置，origin 707）+ 本地 favoritesRemoveMany → 708，前缀数仍 88。
 * 2026-10-23 刷新（+3）：wallpaperEnginePickDir / wallpaperEngineList / wallpaperEngineSelect
 *   （Wallpaper Engine 视频壁纸：选工坊目录 / 列出视频条目 / 校验选中条目），新增 wallpaper-engine 前缀 → 711 / 89。
 * 2026-10-26 语义拆分（总数不变，仅换表）：agentsRuntimeState / agentsState / agentsMessage /
 *   agentsLog / agentsThinking / agentsTextStream / agentsNotice / agentsUiRequest 这 8 个从来不走 IPC，
 *   只作为 emitSessionRuntimeEvent 的 sourceChannel 标签（preload 里根本不存在）——
 *   它们会让「三处同步」失去机械可判定性，因此迁到 agentEventTags；ipcChannels 711 → 703，
 *   agents 前缀因 agentsRpcLog 仍在而保留（前缀数仍 89）。新增 npm run check:ipc-wiring 守两张表边界。
 * 刷新方式：entries.map(([k, v]) => `${k}=${v}`).sort().join("\n") 重算 sha256，写入 CHANNEL_DIGEST。
 * 2026-11-01 刷新（+1）：hostPluginsMarketSearch（插件市场双源搜索：官方收录 registry.json +
 *   GitHub topic:pideck-plugin 全网搜索，提交 3a64d7aeb），host-plugins 前缀早已存在，前缀数仍 91。
 * 2026-11-02 合并刷新（+12）：agentMemory 域入场，agent-memory 前缀同时进入清单；
 *   ipcChannels 796→808，前缀 91→92。通道总数仍与 check:ipc-wiring 一致。
 * 2026-11-02 SFTP-0 刷新（+3）：remoteProjectTransfer{Start,Cancel,Event} 入场；
 *   ipcChannels 808→811，remote 前缀已存在，前缀数仍 92。
 * 2026-11-03 合并刷新（+3）：codebuddySessions 的 start/answer/cancel 入场；
 *   ipcChannels 811→814，新增 codebuddy 前缀，前缀数 92→93。
 * 2026-11-03 SFTP-2 刷新（-3）：legacy remoteProjectTransfer{Start,Cancel,Event} 下线；
 *   ipcChannels 814→811，remote 前缀仍存在，前缀数仍 93。
 * 2026-11-04 本地 dev 集成刷新（+32）：CloudSyncManager 的 cloud-sync 域入场，
 *   ipcChannels 811→843，新增 cloud-sync 前缀，前缀数 93→94。
 * 2026-11-04 上游刷新（净 +1）：WSL 目录浏览（Wave 0，提交 0f91282e4）退役 projects:add-wsl，
 *   新增 projects:list-wsl-directory / projects:add-wsl-path → 815，projects 前缀已存在，前缀数仍 93。
 * 2026-11-07 合并刷新（+1）：上面两条并轨后 ipcChannels 843→844、前缀仍 94（无新增前缀）。
 * 2026-11-07 兼容壳下线（-3）：git:remote-repos / remote-log / remote-compare 删除，
 *   ipcChannels 844→842，git 前缀 62→59，前缀数仍 94。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CHANNEL_TOTAL = 842;
const PREFIX_COUNT = 94;
const CHANNEL_DIGEST = "bf642cf47d7eedad21f67094b31173e54d07ca6d20b150d57469ea51c5d5f915";
// agentEventTags：Agent 内部事件标签（emit 的 sourceChannel），不是 IPC 通道，不进 preload。
const EVENT_TAG_TOTAL = 8;
const EVENT_TAG_DIGEST = "aab959e88353903d214ac0276ccbdc0c90a31240dabc6469b6174a902c76d44b";

const shared = loadTsCommonJs("src/shared/ipc.ts");
const ipcChannels = shared.ipcChannels;
const agentEventTags = shared.agentEventTags;
const entries = Object.entries(ipcChannels);
const values = entries.map(([, value]) => value);
const tagEntries = Object.entries(agentEventTags);
const sortedDigest = (pairs) => {
	const serialized = pairs
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
	return createHash("sha256").update(serialized, "utf8").digest("hex");
};

test("F3-1 通道常量总数 === 842", () => {
	assert.equal(entries.length, CHANNEL_TOTAL);
});

test("F3-2 通道值唯一数 === 842（无重复通道字符串）", () => {
	assert.equal(new Set(values).size, CHANNEL_TOTAL);
});

test("F3-3 全部通道值匹配 domain:action 形态", () => {
	for (const [key, value] of entries) {
		assert.match(value, /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/, `通道 ${key}=${value} 形态非法`);
	}
});

test("F3-4 key=value 排序串联 sha256 与快照摘要一致", () => {
	assert.equal(sortedDigest(entries), CHANNEL_DIGEST);
});

test("F3-7 agentEventTags 单独锚定：8 个标签 + 摘要（与 ipcChannels 不重叠）", () => {
	assert.equal(tagEntries.length, EVENT_TAG_TOTAL);
	assert.equal(sortedDigest(tagEntries), EVENT_TAG_DIGEST);
	const channelValues = new Set(values);
	for (const [key, value] of tagEntries) assert.ok(!channelValues.has(value), `事件标签 ${key}=${value} 与 IPC 通道同名`);
});

test("F3-5 锚点抽查：appGetChannel=update:get-channel、sessionsRuntimeEvent=sessions:runtime-event、git=59、enhance=3", () => {
	assert.equal(ipcChannels.appGetChannel, "update:get-channel");
	assert.equal(ipcChannels.sessionsRuntimeEvent, "sessions:runtime-event");
	const countByPrefix = (prefix) => values.filter((value) => value.startsWith(`${prefix}:`)).length;
	assert.equal(countByPrefix("git"), 59);
	assert.equal(countByPrefix("enhance"), 3);
});

test("F3-6 通道域前缀种类 === 94", () => {
	const prefixes = new Set(values.map((value) => value.split(":")[0]));
	assert.equal(prefixes.size, PREFIX_COUNT);
});
