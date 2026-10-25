// 抽屉宽度持久化（localStorage 首屏缓存 + settings durable fallback）：
// - readDrawerWidth/writeDrawerWidth 纯函数：默认值回退、越界 clamp、损坏数据容错
// - App 不再持有独立 drawerWidth useState，状态单一归属 useWorkspacePanels
// - AppShell 宽度上下限与持久化 clamp 范围同源（DRAWER_WIDTH_MIN/MAX 从 hook 导入）
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("typescript");

const hook = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
const settingsTypes = readFileSync("src/shared/types/settings.ts", "utf8");

async function loadPureExports(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(start, -1, `${startMarker} must exist`);
	assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
	const output = typescript.transpileModule(source.slice(start, end), {
		compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
	}).outputText;
	return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const widthState = await loadPureExports(hook, "export const DEFAULT_DRAWER_WIDTH", "export function useWorkspacePanels");

function memoryStorage(initial) {
	const map = new Map(Object.entries(initial ?? {}));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
	};
}

test("drawer width defaults to 320 when nothing is stored", () => {
	assert.equal(widthState.DEFAULT_DRAWER_WIDTH, 320);
	assert.equal(widthState.readDrawerWidth(null), 320);
	assert.equal(widthState.readDrawerWidth(memoryStorage()), 320);
	assert.equal(widthState.readDrawerWidth(memoryStorage({ other: "123" })), 320);
});

test("drawer width roundtrips through storage", () => {
	const storage = memoryStorage();
	widthState.writeDrawerWidth(storage, 480);
	assert.equal(storage.getItem(widthState.DRAWER_WIDTH_STORAGE_KEY), "480");
	assert.equal(widthState.readDrawerWidth(storage), 480);
});

test("stored drawer width is clamped into the min/max drag bounds", () => {
	const storage = memoryStorage({ [widthState.DRAWER_WIDTH_STORAGE_KEY]: "9999" });
	assert.equal(widthState.readDrawerWidth(storage), widthState.DRAWER_WIDTH_MAX);
	const low = memoryStorage({ [widthState.DRAWER_WIDTH_STORAGE_KEY]: "-50" });
	assert.equal(widthState.readDrawerWidth(low), widthState.DRAWER_WIDTH_MIN);
	// 下限 240：保证抽屉内容（Git 面板/文件树）在最小宽度下不被遮挡；pin 状态更宽
	assert.equal(widthState.DRAWER_WIDTH_MIN, 240);
	assert.equal(widthState.DRAWER_WIDTH_MIN_PINNED, 260);
	// 上限 880：抽屉里现在能整块跑会话渲染栈（侧边任务面板），560 会让消息区挤成竖条。
	assert.equal(widthState.DRAWER_WIDTH_MAX, 880);
});

test("corrupt stored drawer width falls back to the default", () => {
	const corrupt = memoryStorage({ [widthState.DRAWER_WIDTH_STORAGE_KEY]: "abc" });
	assert.equal(widthState.readDrawerWidth(corrupt), widthState.DEFAULT_DRAWER_WIDTH);
	const throwing = {
		getItem: () => {
			throw new Error("storage unavailable");
		},
		setItem: () => {
			throw new Error("storage unavailable");
		},
	};
	assert.equal(widthState.readDrawerWidth(throwing), widthState.DEFAULT_DRAWER_WIDTH);
	// 写失败不得抛出（存储是便利设施，布局功能必须继续可用）
	assert.doesNotThrow(() => widthState.writeDrawerWidth(throwing, 400));
});

test("drawer width is a global preference keyed without project id", () => {
	assert.equal(widthState.DRAWER_WIDTH_STORAGE_KEY, "pid:drawer-width");
	assert.doesNotMatch(widthState.DRAWER_WIDTH_STORAGE_KEY, /project/);
});

test("App defers drawer width state to useWorkspacePanels persistence", () => {
	assert.match(app, /const drawerWidth = workspace\.drawerWidth;/);
	assert.match(app, /const setDrawerWidth = workspace\.setDrawerWidth;/);
	// 不得再保留独立 useState（双份状态会漂移）
	assert.doesNotMatch(app, /const \[drawerWidth, setDrawerWidth\] = useState/);
});

test("hook hydrates and persists drawer width through its storage option", () => {
	assert.match(hook, /const \[drawerWidth, setDrawerWidth\] = useState\(\(\) => readDrawerWidth\(storageRef\.current\)\)/);
	assert.match(hook, /writeDrawerWidth\(storageRef\.current, drawerWidth\)/);
	assert.match(hook, /drawerWidth,\n\s+setDrawerWidth,/);
});

test("drawer width can hydrate from durable settings when the renderer origin changes", () => {
	assert.match(hook, /loadPersistedWidth\?: \(\) => Promise<unknown>/);
	assert.match(hook, /persistWidth\?: \(width: number\) => void \| Promise<unknown>/);
	assert.match(hook, /usePersistedPanelWidth\(\{/);
});

test("App supplies one durable settings fallback for both panel widths", () => {
	assert.match(app, /const getLayoutSettings = useCallback\(\(\) =>/);
	assert.match(app, /loadPersistedWidth: loadDrawerWidth/);
	assert.match(app, /persistWidth: persistDrawerWidth/);
	assert.match(app, /loadPersistedWidth: loadSidebarWidth/);
	assert.match(app, /persistWidth: persistSidebarWidth/);
	assert.match(settingsTypes, /sidebarWidth\?: number/);
	assert.match(settingsTypes, /drawerWidth\?: number/);
});

test("AppShell shares the drawer width bounds with the persistence clamp", () => {
	assert.match(appShell, /DRAWER_WIDTH_MIN,/);
	assert.match(appShell, /DRAWER_WIDTH_MIN_PINNED,/);
	assert.match(appShell, /DRAWER_WIDTH_MAX,/);
	// 常量不再在 AppShell 本地定义，防止与 hook 的 clamp 范围漂移
	assert.doesNotMatch(appShell, /const DRAWER_MIN = 180;/);
	assert.doesNotMatch(appShell, /const DRAWER_MAX = 560;/);
});
