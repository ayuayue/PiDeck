// 侧栏宽度持久化（localStorage 首屏缓存 + settings durable fallback）：
// - readListWidth/writeListWidth 纯函数：默认值回退、越界 clamp
// - 防呆重点：即使存储了 0（折叠态）或极小值，恢复宽度也至少是
//   LIST_WIDTH_MIN——绝不出现“重启后侧栏窄到拖不动”的情况
// - AppShell 宽度上下限与持久化 clamp 范围同源（从 useResize 导入）
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("typescript");

const hook = readFileSync("src/renderer/src/hooks/useResize.ts", "utf8");
const appShell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");

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

const widthState = await loadPureExports(hook, "export const DEFAULT_LIST_WIDTH", "export function useResize");

function memoryStorage(initial) {
	const map = new Map(Object.entries(initial ?? {}));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
	};
}

test("list width defaults to 221 when nothing is stored", () => {
	assert.equal(widthState.DEFAULT_LIST_WIDTH, 221);
	assert.equal(widthState.readListWidth(undefined), 221);
	assert.equal(widthState.readListWidth(memoryStorage()), 221);
	assert.equal(widthState.readListWidth(memoryStorage({ other: "123" })), 221);
});

test("list width roundtrips through storage", () => {
	const storage = memoryStorage();
	widthState.writeListWidth(storage, 360);
	assert.equal(storage.getItem(widthState.LIST_WIDTH_STORAGE_KEY), "360");
	assert.equal(widthState.readListWidth(storage), 360);
});

test("stored list width is clamped into the draggable min/max bounds", () => {
	// 下限 208：保证三个分段 tab（活动/聊天/项目）在最小宽度下仍完整显示
	assert.equal(widthState.LIST_WIDTH_MIN, 208);
	assert.equal(widthState.LIST_WIDTH_MAX, 440);
	const high = memoryStorage({ [widthState.LIST_WIDTH_STORAGE_KEY]: "9999" });
	assert.equal(widthState.readListWidth(high), widthState.LIST_WIDTH_MAX);
	const low = memoryStorage({ [widthState.LIST_WIDTH_STORAGE_KEY]: "50" });
	assert.equal(widthState.readListWidth(low), widthState.LIST_WIDTH_MIN);
});

test("a persisted collapsed width (0) recovers to the minimum draggable width", () => {
	// 防呆回归：折叠态宽度（0）或极小值若被写入存储，重启后必须恢复到可拖动宽度，
	// 否则侧栏会窄到分隔条不可见、无法再拖开。
	const collapsed = memoryStorage({ [widthState.LIST_WIDTH_STORAGE_KEY]: "0" });
	assert.equal(widthState.readListWidth(collapsed), widthState.LIST_WIDTH_MIN);
	const negative = memoryStorage({ [widthState.LIST_WIDTH_STORAGE_KEY]: "-20" });
	assert.equal(widthState.readListWidth(negative), widthState.LIST_WIDTH_MIN);
});

test("corrupt stored list width falls back to the default", () => {
	const corrupt = memoryStorage({ [widthState.LIST_WIDTH_STORAGE_KEY]: "abc" });
	assert.equal(widthState.readListWidth(corrupt), widthState.DEFAULT_LIST_WIDTH);
	const throwing = {
		getItem: () => {
			throw new Error("storage unavailable");
		},
		setItem: () => {
			throw new Error("storage unavailable");
		},
	};
	assert.equal(widthState.readListWidth(throwing), widthState.DEFAULT_LIST_WIDTH);
	assert.doesNotThrow(() => widthState.writeListWidth(throwing, 300));
});

test("list width is a global preference keyed without project id", () => {
	assert.equal(widthState.LIST_WIDTH_STORAGE_KEY, "pid:list-width");
	assert.doesNotMatch(widthState.LIST_WIDTH_STORAGE_KEY, /project/);
});

test("hook hydrates and persists list width, but never the collapsed state", () => {
	assert.match(hook, /const \[listWidth, setListWidth\] = useState\(\(\) => readListWidth\(storageRef\.current\)\)/);
	assert.match(hook, /writeListWidth\(storageRef\.current, listWidth\)/);
	// 折叠状态不持久化：重启后侧栏总是展开，不存在“折叠成 0 找不到侧栏”
	assert.doesNotMatch(hook, /writeListWidth[^;]*listCollapsed/);
	assert.match(hook, /const \[listCollapsed, setListCollapsed\] = useState\(false\)/);
});

test("reopening the collapsed sidebar keeps the last expanded width", () => {
	// 展开不能再把用户宽度重置为默认值；否则一次折叠/展开就会覆盖持久化值。
	assert.doesNotMatch(hook, /if \(!nextCollapsed\) setListWidth\(DEFAULT_LIST_WIDTH\)/);
});

test("sidebar width can hydrate from durable settings when the renderer origin changes", () => {
	assert.match(hook, /loadPersistedWidth\?: \(\) => Promise<unknown>/);
	assert.match(hook, /persistWidth\?: \(width: number\) => void \| Promise<unknown>/);
	assert.match(hook, /usePersistedPanelWidth\(\{/);
});

test("AppShell shares the list width bounds with the persistence clamp", () => {
	assert.match(appShell, /LIST_WIDTH_MIN/);
	assert.match(appShell, /LIST_WIDTH_MAX/);
	assert.doesNotMatch(appShell, /const LIST_MIN = 100;/);
	assert.doesNotMatch(appShell, /const LIST_MAX = 440;/);
});
