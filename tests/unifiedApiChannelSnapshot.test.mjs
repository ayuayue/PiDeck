/**
 * F3 · IPC 通道快照守卫（TEST-PLAN §F3，6 例，锚定数字见 TEST-PLAN §0）。
 *
 * src/shared/ipc.ts 的 ipcChannels 常量表是全部 IPC 通道的唯一来源；本测试把它的
 * 规模与形状锚定为快照（711 通道 / 89 前缀 / 排序摘要）。快照变更只允许显式发生
 * 且附领域正当理由——本轮（T4 契约层）任何快照红 = 违例。
 *
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
 * 刷新方式：entries.map(([k, v]) => `${k}=${v}`).sort().join("\n") 重算 sha256，写入 CHANNEL_DIGEST。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const CHANNEL_TOTAL = 711;
const PREFIX_COUNT = 89;
const CHANNEL_DIGEST = "154e63a7ad3e884a7a25077a757723eb7f461d73f08f153bd122bf64ebc4301c";

const ipcChannels = loadTsCommonJs("src/shared/ipc.ts").ipcChannels;
const entries = Object.entries(ipcChannels);
const values = entries.map(([, value]) => value);

test("F3-1 通道常量总数 === 711", () => {
	assert.equal(entries.length, CHANNEL_TOTAL);
});

test("F3-2 通道值唯一数 === 711（无重复通道字符串）", () => {
	assert.equal(new Set(values).size, CHANNEL_TOTAL);
});

test("F3-3 全部通道值匹配 domain:action 形态", () => {
	for (const [key, value] of entries) {
		assert.match(value, /^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/, `通道 ${key}=${value} 形态非法`);
	}
});

test("F3-4 key=value 排序串联 sha256 与快照摘要一致", () => {
	const serialized = entries
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join("\n");
	const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
	assert.equal(digest, CHANNEL_DIGEST);
});

test("F3-5 锚点抽查：appGetChannel=update:get-channel、sessionsRuntimeEvent=sessions:runtime-event、git=38、enhance=3", () => {
	assert.equal(ipcChannels.appGetChannel, "update:get-channel");
	assert.equal(ipcChannels.sessionsRuntimeEvent, "sessions:runtime-event");
	const countByPrefix = (prefix) => values.filter((value) => value.startsWith(`${prefix}:`)).length;
	assert.equal(countByPrefix("git"), 38);
	assert.equal(countByPrefix("enhance"), 3);
});

test("F3-6 通道域前缀种类 === 89", () => {
	const prefixes = new Set(values.map((value) => value.split(":")[0]));
	assert.equal(prefixes.size, PREFIX_COUNT);
});
