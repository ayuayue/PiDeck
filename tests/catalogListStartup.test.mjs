import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const scanner = readFileSync("src/main/sessions/SessionScanner.ts", "utf8");
const projectSync = readFileSync("src/renderer/src/hooks/useProjectSync.ts", "utf8");

test("first catalog list returns disk cache instead of awaiting a full scan", () => {
	// 打包正式 userData 里历史 JSONL 远多于 dev。首次 listCatalog 若 await
	// runScanAndMerge()，侧栏「正在加载历史会话」会卡住整窗（主进程扫盘 + 大 IPC）。
	const handler = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogList"), sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"));
	assert.match(handler, /if \(options\?\.scan === false\) return cachedRecords;/);
	// 有磁盘 catalog 或空列表都先回缓存，扫描只走 coordinator 后台。
	assert.doesNotMatch(handler, /if \(!scannedProjects\.has\(projectId\)\) \{[\s\S]*return runScanAndMerge\(\);/);
	assert.match(handler, /catalogScanCoordinator\.schedule\(projectId,/);
	assert.match(handler, /return cachedRecords;/);
});

test("cached catalog branch is sorted by recency and filters dead file links", () => {
	// 2027-02 小窗 ENOENT 事故：缓存分支乱序返回，小窗项目切换取 sessions[0]
	// 拿到 8 月陈旧子代理死链记录（文件已删、清理闸未跑到）→ 小窗报
	// ENOENT + 「选择了别的项目却建到 Chat」。缓存分支必须与 mergeScanned
	// 同口径排序（updatedAt desc），并在返回前滤掉文件已消失的非 WSL/dsh 记录。
	const handler = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogList"), sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"));
	assert.match(handler, /\.sort\(\s*\(left,\s*right\)\s*=>\s*right\.updatedAt\s*-\s*left\.updatedAt\s*\)/);
	assert.match(handler, /record\.backend\s*===\s*"dsh"/);
	assert.match(handler, /existsSync\(record\.filePath\)/);
	assert.match(handler, /startsWith\("\\\\\\\\"\)/);
});

test("dead file link filter exempts sessions with a live runtime", () => {
	// 2026-10-06 事故：standby 预分配的 sessionPath 在 pi 首条消息前不落盘，
	// 已认领预热进程的聚焦草稿被死链过滤剔出列表 → 渲染层
	// replaceProjectSessionsAtom 清空焦点 → 闪回引导页、输入丢失、引导页重发
	// 另建会话留下孤儿空闲 Agent。与 mergeScanned 的 liveness 豁免同口径：
	// hasLiveRuntime 命中的记录必须保留，且判定顺序在 existsSync 之前。
	const handler = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogList"), sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"));
	assert.match(handler, /if\s*\(\s*sessionRuntimeCoordinator\.hasLiveRuntime\(record\.id\)\s*\)\s*return true;\s*return existsSync\(record\.filePath\);/);
});

test("dead file link filter exempts wsl sessions whose filePath is a Linux path", () => {
	// 2026-10-07 升级 0.7.9 反馈：WSL 会话在 catalog 里存的是 Linux 侧路径
	// （/home/...），宿主 Windows 的 existsSync 恒 false；豁免条件只认 \\\\ 开头
	// 的 UNC 形态时，WSL 用户的全部会话会被整组滤掉（58 条全在 catalog，列表全空）。
	// 必须按 record.environment === "wsl" 豁免，且判定顺序在 existsSync 之前，
	// 与 mergeScanned 清理闸（environment=wsl 跳过）同口径。
	const handler = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogList"), sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"));
	assert.match(handler, /if\s*\(\s*record\.environment\s*===\s*"wsl"\s*\)\s*return true;/);
	const filterBlock = handler.slice(handler.indexOf(".filter((record) => {"), handler.indexOf("if (options?.scan === false)"));
	assert.match(filterBlock, /environment\s*===\s*"wsl"[\s\S]*return\s+existsSync\(record\.filePath\)/, "wsl 豁免必须在 existsSync 判定之前，否则恒 false 的宿主探测仍会滤掉 WSL 会话");
});

test("catalog list scan does not parse JSONL bodies", () => {
	// 侧栏 list() 只 stat + 路径推断；正文留给点击后的 readRecordMessagePage。
	const listBlock = scanner.slice(scanner.indexOf("private async listUnqueued"), scanner.indexOf("private async resolveScanRoots"));
	assert.match(listBlock, /listPathSummary/);
	assert.doesNotMatch(listBlock, /this\.readSummary\(/);
	assert.doesNotMatch(listBlock, /isParentSessionForProject/);
	assert.match(scanner, /listQueue/);
	assert.match(scanner, /mapLimited/);
	assert.match(scanner, /SUMMARY_READ_CONCURRENCY = 4/);
});

test("startup catalog refresh keeps the loading spinner until a scan fills an empty cache", () => {
	// 空缓存立即回 [] 时不能立刻 set ready，否则加载动画闪一下后侧栏空白很久。
	assert.match(projectSync, /if \(records\.length > 0\) \{[\s\S]*status: "ready"/);
	assert.match(projectSync, /onCatalogRefreshed/);
});
