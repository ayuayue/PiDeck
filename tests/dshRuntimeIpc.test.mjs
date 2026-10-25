import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStore } from "jotai";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const mainEntry = readFileSync("src/main/index.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const browserApi = readFileSync("src/renderer/src/browserApi.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
const runtimeStatus = readFileSync("src/main/dsh/runtime/DshRuntimeStatus.ts", "utf8");

test("shared/ipc.ts 定义 dsh-runtime 通道（domain:action 命名）", () => {
	assert.match(ipc, /dshRuntimeGetStatus:\s*"dsh-runtime:get-status"/);
	assert.match(ipc, /dshRuntimeStatusChanged:\s*"dsh-runtime:status-changed"/);
});

test("sessionIpc 注册 dsh-runtime:get-status，未装配 dshBackend 时返回 notInstalled", () => {
	// 闭合括号的缩进/写法可能被 formatter 调整（分隔层由 \n 变为折叠）：用 \s* 容忍。
	const block = sessionIpc.match(/ipcMain\.handle\(\s*ipcChannels\.dshRuntimeGetStatus,[\s\S]*?\n[\t ]*\}?\s*\);/);
	assert.ok(block, "sessionIpc.ts 必须注册 dshRuntimeGetStatus handler");
	// 渲染层初值是 checking，主进程拿不到状态时必须给确定态，否则 UI 永远停在 checking。
	assert.match(block[0], /notInstalled/);
	assert.match(block[0], /getDshRuntimeStatus/);
});

test("new draft / anonymous 创建在 runtime 不可用时拒绝 dsh 后端", () => {
	for (const channel of ["sessionsCatalogCreateDraft", "sessionsCreateAnonymous"]) {
		const block = sessionIpc.match(new RegExp(`ipcMain\\.handle\\(\\s*ipcChannels\\.${channel},[\\s\\S]*?canCreateDshSession`));
		assert.ok(block, `${channel} 必须按 DSH runtime 安装态门控`);
	}
	// 门控必须只拦 dsh：pi 会话创建不受 runtime 状态影响。
	assert.equal((sessionIpc.match(/input\.backend === "dsh" && canCreateDshSession\?\.\(\) !== true/g) ?? []).length, 2, "两处创建入口都要有 dsh 专用门控");
});

test("runtime 状态服务与主进程装配不再按 dev 隐藏远程安装", () => {
	// dev 必须验证与正式版相同的 Release 下载/解压链路；只能禁用项目
	// node_modules 的 bundled 探测，不能再用 installEnabled=false 锁死安装入口。
	assert.match(runtimeStatus, /installEnabled: true/);
	assert.match(mainEntry, /\/\/ dev 不把项目 node_modules 当成「已安装 runtime」[\s\S]*?\(\) => false/);
});

test("main entry 把 runtime 状态服务注入 sessionIpc", () => {
	assert.match(mainEntry, /getDshRuntimeStatus: \(\) => dshRuntimeStatus\.getStatus\(\)/);
	assert.match(mainEntry, /canCreateDshSession: \(\) => dshRuntimeStatus\.canCreateDshSession\(\)/);
	// runtime 不可用时不要白预热 host（约 200MB 的 utilityProcess）。
	// 预热门控收敛到 dshWarmupEnabled()：只要 runtime 可用且用户没手动停过就预热；
	// 刻意不再要求 defaultAgentBackend === "dsh"（装了 runtime 就是用户要用 DSH 的信号）。
	assert.match(mainEntry, /function dshWarmupEnabled\(\): boolean \{[\s\S]{0,200}?dshRuntimeStatus\.canCreateDshSession\(\)[\s\S]{0,120}?dshManualStopped !== true/);
	assert.doesNotMatch(mainEntry, /function dshWarmupEnabled\(\)[\s\S]{0,200}?defaultAgentBackend === "dsh"/, "预热不得再绑默认后端：否则装了 runtime 也不预热");
});

test("preload 暴露安装态查询与订阅，订阅返回退订函数", () => {
	assert.match(preload, /getDshRuntimeStatus: \(\) =>/);
	assert.match(preload, /onDshRuntimeStatusChanged: \(callback/);
	// 订阅 API 必须返回 unsubscribe（AGENTS.md：订阅 API 必须返回 unsubscribe）。
	assert.match(preload, /subscribe\(ipcChannels\.dshRuntimeStatusChanged, callback\)/);
});

test("浏览器/预览兜底 API 同步提供安装态方法（缺一则预览态崩溃）", () => {
	for (const [name, source] of [
		["browserApi", browserApi],
		["previewApi", previewApi],
	]) {
		assert.match(source, /getDshRuntimeStatus/, `${name} 缺少 getDshRuntimeStatus 兜底`);
		assert.match(source, /onDshRuntimeStatusChanged/, `${name} 缺少 onDshRuntimeStatusChanged 兜底`);
	}
});

test("本地导入拆成归档 / 目录两个通道（Windows 单框 openFile+openDirectory 选不到 .tgz）", () => {
	assert.match(ipc, /dshRuntimeInstallLocal:\s*"dsh-runtime:install-local"/);
	assert.match(ipc, /dshRuntimeInstallLocalDir:\s*"dsh-runtime:install-local-dir"/);

	const archiveBlock = sessionIpc.match(/ipcMain\.handle\(\s*ipcChannels\.dshRuntimeInstallLocal,[\s\S]*?\n[\t ]*\}\);/);
	assert.ok(archiveBlock, "sessionIpc.ts 必须注册归档导入 handler");
	assert.match(archiveBlock[0], /extensions:\s*\[\s*"tgz",\s*"gz"\s*\]/);
	assert.match(archiveBlock[0], /properties:\s*\[\s*"openFile"\s*\]/, "归档入口只能选文件");

	const dirBlock = sessionIpc.match(/ipcMain\.handle\(\s*ipcChannels\.dshRuntimeInstallLocalDir,[\s\S]*?\n[\t ]*\}\);/);
	assert.ok(dirBlock, "sessionIpc.ts 必须注册目录导入 handler");
	assert.match(dirBlock[0], /properties:\s*\[\s*"openDirectory"\s*\]/, "目录入口只能选目录");

	// 关键回归：两者合并成一次对话框就是用户报的「只让选目录」。
	assert.equal(/"openFile",\s*"openDirectory"/.test(sessionIpc), false, "不得再有 openFile+openDirectory 并存的导入对话框");
	assert.match(preload, /importDshRuntimeDir:/);
});

// ── 派生 atom 行为测试（渲染层门控的真相源）──
// 必须经 atoms/index 一次性加载：loadTsCommonJs 每次调用独立建缓存，
// 分两次加载会得到两个不同的 dshRuntimeStatusAtom 对象，派生 atom 读不到写入值。
const { defaultAgentBackendAtom, effectiveAgentBackendAtom, dshRuntimeStatusAtom } = loadTsCommonJs("src/renderer/src/atoms/index.ts");

test("effectiveAgentBackendAtom：runtime 不可用时把 dsh 钳成 pi，恢复后自动回到 dsh", () => {
	const store = createStore();
	store.set(defaultAgentBackendAtom, "dsh");

	// 首帧安装态未送达（checking）：钳成 pi，避免用未定状态建 dsh 会话。
	assert.equal(store.get(effectiveAgentBackendAtom), "pi");

	store.set(dshRuntimeStatusAtom, { state: "installed" });
	assert.equal(store.get(effectiveAgentBackendAtom), "dsh");

	// 阶段 2 卸载 runtime 后：设置里残留 dsh 也不能把新建会话打进不可用后端。
	store.set(dshRuntimeStatusAtom, { state: "notInstalled" });
	assert.equal(store.get(effectiveAgentBackendAtom), "pi");

	store.set(dshRuntimeStatusAtom, { state: "broken", runtimeVersion: "9.9.9" });
	assert.equal(store.get(effectiveAgentBackendAtom), "pi");
});

test("effectiveAgentBackendAtom：pi 设置值不受 DSH runtime 状态影响", () => {
	const store = createStore();
	store.set(defaultAgentBackendAtom, "pi");
	assert.equal(store.get(effectiveAgentBackendAtom), "pi");
	store.set(dshRuntimeStatusAtom, { state: "installed" });
	assert.equal(store.get(effectiveAgentBackendAtom), "pi");
});
