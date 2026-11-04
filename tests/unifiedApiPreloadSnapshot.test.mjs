/**
 * F8 · preload 暴露面快照守卫（TEST-PLAN §F8，6 例=4 正+2 负）。
 *
 * 捕获 src/preload/index.ts 经 contextBridge 实际暴露的 piDesktop API，对
 * 82 命名空间清单与每命名空间方法清单做 sha256 快照（A10：暴露面零变化），
 * 并核对数量锚点（sessions 117 / config 53 / git 64 / app 32）与订阅形态。
 * 摘要来源：T7 只读探针实测（2026-10-14；2026-10-16 合并刷新随 dev 演进重算：
 * yaoPrompts 方法与 sessions.searchContent、skillHub.onInstallProgress 入场，命名空间数不变；
 * 2026-10-17 再刷新：files.searchContent（file-index 工作区文件内容检索）入场，命名空间/方法数锚点不变；
 * 2026-10-18 再刷新：sessions.searchInSession（会话内查找）入场，sessions 111→112，命名空间数不变；
 * 2026-10-19 再刷新：sessions.reloadResources（pi 热重载扩展/技能）入场，sessions 112→113；
 *   同版下线 GUI 扩展桥（sessions.sendBridgeEvent / requestBridgeResync）与插件开发支持
 *   （整份 pluginDev 命名空间 3 方法）：命名空间 70→69、sessions 113→111；
 * 2026-10-21 刷新：轨迹 S4（sessions.readOutline / readOutlineTitle 入场）+ 远端市场/划词/
 *   技能目录等改动合并：命名空间 69→73、sessions 111→114（config/git/app 不变）；
 * 2026-10-21：下线 readDshSystemPrompt 与 readOutlineTitle（轨迹事实/索引 preview 取代），114→112；
 *   同批合并 selectionTool.resize（划词浮窗折叠 / 展开高度上报）入场，命名空间数与数量锚点不变。
 * 2026-10-23 刷新：favorites 命名空间入场（收藏功能提交 f3075f08c 漏刷快照，73→74）；
 *   agentProfiles.reorder / favorites.reorder（智能体与收藏列表拖拽排序）各 +1 方法。
 * 2026-10-24 刷新：favorites.removeMany（收藏批量删除，一次 IPC 一次写盘）+1 方法；命名空间数不变。
 * 2026-10-24 合并刷新：并入上游 26de030fc 的 config.discoverExternalAgents / resolveExternalAgentKey
 *   （导入本机其他 Agent 供应商配置）；命名空间数与锚点数不变，仅方法清单摘要变化。
 * 2026-10-23：dialog.pickWallpaperEngineDir / listWallpaperEngine / selectWallpaperEngine
 *   （Wallpaper Engine 视频壁纸）各 +1 方法，命名空间数与数量锚点不变。
 * 2026-10-24 第四轮追赶 origin/dev（274 提交）：并入上游会话数据面/终端/文件管理器等改动，
 *   命名空间 77→78（新增上游域），sessions 118→116、config 48→50、git 59 不变。
 * 2026-10-31 刷新：git.refreshRemoteGitFacts（纯事实强刷：越过事实缓存，但不撤/不签授权令牌）入场，
 *   git 63→64；命名空间数与其他数量锚点不变。
 * 2026-11-01 刷新：hostPlugins.searchMarket（插件市场双源搜索，提交 3a64d7aeb）+1 方法；
 *   命名空间数与数量锚点不变，仅方法清单摘要变化。
 * 2026-11-02 合并刷新：远端 agentMemory 与本地 remoteHosts 两条并行命名空间同时入场，
 *   79→80；sessions 117 / config 52 / git 64 / app 32 不变。
 * 2026-11-02 SFTP-0 刷新：remoteTransfers（start/cancel/onEvent）入场，80→81；
 *   方法清单摘要随三方法变化，数量锚点不变。
 * 2026-11-03 刷新：codebuddySessions（CodeBuddy 会话导入，与 WorkBuddy 同一家族管线）入场，
 *   与 SFTP-0 的 remoteTransfers 并行合入后命名空间 80→82。
 *   同批把 config 锚点 52→53：上一提交 b383f3709 加了 config.getTokendancePriceTags
 *   却漏刷本快照，dev 上 F8-3 一直是红的；此处按实测暴露面刷新，未改动断言强度。
 * 2026-11-04 合并刷新（仅方法清单摘要）：dev 并入 main 后按实测暴露面重算 FULL_METHODS_SHA256。
 *   命名空间清单与数量锚点全部不变（82 / sessions 117 / config 53 / git 64 / app 32）；
 *   方法面变化来自 projects.listWslDirectory + projects.addWslPath 入场并下线 projects.addWsl
 *   （WSL 项目一览 Wave 0）、config.getTokendancePriceTags；codebuddySessions 与 remoteTransfers
 *   两个命名空间在 dev 侧快照刷新时已计入，本次摘要变化与它们无关。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NS_LIST_SHA256 = "ecf92dceedeea2d9b21c5625e42f3f30786c264a01fba4cb738834630948efee";
const FULL_METHODS_SHA256 = "8d5e92b1c0f3e86355b6a84048a094514712cf0f565ce8025a661cd9a35ac877";
const NAMESPACE_COUNT = 82;

/** 捕获 preload 暴露的 piDesktop；null/undefined/形态不符时显式红并给诊断（F8-6 共用）。 */
function assertValidCapture(capture) {
	if (capture === null || capture === undefined) {
		throw new Error(`preload 捕获失败: capture=${String(capture)}（electron stub 未收到 exposeInMainWorld 调用，preload 顶层可能已抛错或被跳过）`);
	}
	if (typeof capture !== "object" || capture.name !== "piDesktop" || typeof capture.api !== "object" || capture.api === null) {
		throw new Error(`preload 捕获失败: 捕获物形态不符（name=${String(capture?.name)}），应 exposeInMainWorld("piDesktop", api)`);
	}
	return capture;
}

function capturePreloadApi() {
	let captured = null;
	const electronStub = {
		contextBridge: {
			exposeInMainWorld: (name, api) => (captured = { name, api }),
		},
		ipcRenderer: {
			invoke: () => Promise.resolve(undefined),
			on: () => () => {},
			once: () => {},
			removeListener: () => {},
			send: () => {},
			sendSync: () => ({}),
		},
		webUtils: { getPathForFile: () => "" },
	};
	const preloadMod = loadTsCommonJs("src/preload/index.ts", {
		stubs: { electron: electronStub },
	});
	captured = preloadMod.__pideckPreloadCapture ?? captured;
	return assertValidCapture(captured).api;
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const sortedKeys = (obj) => Object.keys(obj).sort();

const api = capturePreloadApi();
const namespaces = sortedKeys(api);
const methodLines = namespaces.map((ns) => `${ns}=${sortedKeys(api[ns]).join(",")}`);

test("F8-1 preload 顶层命名空间数 === 82 且排序清单摘要零漂移", () => {
	assert.equal(namespaces.length, NAMESPACE_COUNT, `命名空间数 ${namespaces.length} ≠ ${NAMESPACE_COUNT}`);
	assert.equal(sha256(namespaces.join(",")), NS_LIST_SHA256, "命名空间清单摘要漂移：preload 暴露面发生变化（A10 红线）");
});

test("F8-2 每命名空间排序方法清单摘要零漂移", () => {
	assert.equal(sha256(methodLines.join(";")), FULL_METHODS_SHA256, "方法清单摘要漂移：任一命名空间的方法暴露面发生变化（A10 红线）");
});

test("F8-3 数量锚点：sessions 117 / config 53 / git 64 / app 32", () => {
	assert.equal(Object.keys(api.sessions).length, 117, "sessions 方法数漂移");
	assert.equal(Object.keys(api.config).length, 53, "config 方法数漂移");
	assert.equal(Object.keys(api.git).length, 64, "git 方法数漂移");
	assert.equal(Object.keys(api.app).length, 32, "app 方法数漂移");
});

test("F8-4 订阅形态：全部 on* 方法调用返回退订函数", () => {
	const subscriptionNames = [];
	for (const ns of namespaces) {
		for (const method of Object.keys(api[ns])) {
			// 只认 on* 前缀：watch* 里 git.watchRefs 是返回 Promise<string> 的 watch 句柄请求（配对 unwatchRefs），不是事件订阅。
			if (/^on[A-Z]/.test(method)) subscriptionNames.push(`${ns}.${method}`);
		}
	}
	assert.ok(subscriptionNames.length >= 40, `订阅方法数 ${subscriptionNames.length} 异常缩水`);
	for (const qualified of subscriptionNames) {
		const [ns, method] = qualified.split(".");
		const unsubscribe = api[ns][method](() => {});
		assert.equal(typeof unsubscribe, "function", `${qualified} 必须返回退订函数`);
	}
});

test("F8-5[负] 摘要灵敏度：任一命名空间/方法变动必破 F8-1/F8-2 摘要", () => {
	const droppedNs = namespaces.slice(1);
	assert.notEqual(sha256(droppedNs.join(",")), NS_LIST_SHA256, "删任一命名空间后摘要必须变化");
	const tampered = methodLines.slice();
	tampered[0] = tampered[0].split("=")[0] + "=" + sortedKeys(api[namespaces[0]]).slice(1).join(",");
	assert.notEqual(sha256(tampered.join(";")), FULL_METHODS_SHA256, "删任一方法后摘要必须变化");
	const renamed = methodLines.map((line, index) => (index === 0 ? line.replace("=", "=rogueExtra,") : line));
	assert.notEqual(sha256(renamed.join(";")), FULL_METHODS_SHA256, "增任一方法后摘要必须变化");
});

test("F8-6[负] 捕获物 null/undefined/形态不符 → 显式红并诊断", () => {
	assert.throws(() => assertValidCapture(null), /preload 捕获失败: capture=null/);
	assert.throws(() => assertValidCapture(undefined), /preload 捕获失败: capture=undefined/);
	assert.throws(() => assertValidCapture({ name: "other", api: {} }), /preload 捕获失败: 捕获物形态不符/);
	assert.throws(() => assertValidCapture({ name: "piDesktop" }), /preload 捕获失败: 捕获物形态不符/);
	assert.equal(assertValidCapture({ name: "piDesktop", api: { a: {} } }).name, "piDesktop");
});
