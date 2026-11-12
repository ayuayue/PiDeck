import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";

const sessionIpc = sessionIpcSource;
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
	// 2027-02 起死链判定走 TTL 缓存（sessionFileExistsCached，见 sessionFileLiveness.ts）：
	// 几百条记录逐条同步 stat 是每次 5-30ms 的固定税，存在性 2s 陈旧无害。
	assert.match(handler, /sessionFileExistsCached\(record\.filePath\)/);
	assert.match(handler, /startsWith\("\\\\\\\\"\)/);
});

test("dead file link filter exempts sessions with a live runtime", () => {
	// 2026-10-06 事故：standby 预分配的 sessionPath 在 pi 首条消息前不落盘，
	// 已认领预热进程的聚焦草稿被死链过滤剔出列表 → 渲染层
	// replaceProjectSessionsAtom 清空焦点 → 闪回引导页、输入丢失、引导页重发
	// 另建会话留下孤儿空闲 Agent。与 mergeScanned 的 liveness 豁免同口径：
	// hasLiveRuntime 命中的记录必须保留，且判定顺序在 existsSync 之前。
	const handler = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogList"), sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"));
	// 空白容忍：hasLiveRuntime 与存在性判定之间允许注释（2027-02 加缓存说明）
	assert.match(handler, /if\s*\(\s*sessionRuntimeCoordinator\.hasLiveRuntime\(record\.id\)\s*\)\s*return true;[\s\S]*?return sessionFileExistsCached\(record\.filePath\);/);
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
	assert.match(filterBlock, /environment\s*===\s*"wsl"[\s\S]*return\s+sessionFileExistsCached\(record\.filePath\)/, "wsl 豁免必须在存在性判定之前，否则恒 false 的宿主探测仍会滤掉 WSL 会话");
});

test("native projects hide sessions recorded under the wsl execution context", () => {
	// 2026-11-05 反馈：从 WSL 切回本机后，同一个项目下成片出现「点开永远空」的会话——
	// catalog 里存着上一轮 WSL 扫描写下的 /mnt/... 记录，上面那条 wsl 豁免把它们放进
	// 本机项目的列表，而本机读它们必然 ENOENT。豁免必须按项目环境收窄：本机项目
	// （projectWsl undefined）里 environment=wsl 的记录直接不返回，且判定在最前，
	// 连无 filePath 的 wsl 草稿一并挡住。翻回 WSL 后原样复现，所以这里只隐藏、不删记录。
	const handler = sessionIpc.slice(sessionIpc.indexOf("ipcChannels.sessionsCatalogList"), sessionIpc.indexOf("ipcChannels.sessionsCatalogCreateDraft"));
	const filterBlock = handler.slice(handler.indexOf(".filter((record) => {"), handler.indexOf("if (options?.scan === false)"));
	assert.match(filterBlock, /if\s*\(\s*record\.environment\s*===\s*"wsl"\s*&&\s*projectWsl\s*===\s*undefined\s*\)\s*return false;/);
	const crossEnvIndex = filterBlock.indexOf('record.environment === "wsl" && projectWsl === undefined');
	const wslExemptIndex = filterBlock.indexOf('environment === "wsl") return true');
	const existsIndex = filterBlock.indexOf("sessionFileExistsCached(record.filePath)");
	assert.ok(crossEnvIndex >= 0 && crossEnvIndex < wslExemptIndex, "跨环境隐藏必须排在 wsl 豁免之前");
	assert.ok(wslExemptIndex < existsIndex, "wsl 豁免必须排在存在性判定之前");
	// 反向不隐藏：WSL 项目里的本机记录本机能读，判据里不能出现对称的 native 分支。
	assert.doesNotMatch(filterBlock, /record\.environment\s*===\s*"native"\s*&&/);
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
