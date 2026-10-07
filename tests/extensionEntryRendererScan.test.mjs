import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { clearExtensionEntryRendererScanCache, collectEntryRendererTypes, extractEntryRendererTypes } = loadTsCommonJs("src/main/pi/extensionEntryRendererScan.ts");

test("extractEntryRendererTypes 识别字面量、const 别名、泛型与 .call 形态", () => {
	const source = [
		'pi.registerEntryRenderer("inline-type", render);',
		"pi.registerEntryRenderer<'Gen'>(\"generic-type\", (entry) => entry);",
		'var ACP_NUDGE_CUSTOM_TYPE = "acp-nudge";', // esbuild 产物用 var 声明
		"pi.registerEntryRenderer(ACP_NUDGE_CUSTOM_TYPE, (entry, _options, theme) => theme);",
		'const SUPERVISOR_REPLY_ENTRY_TYPE = "subagents:supervisor-reply";',
		"const registerEntryRenderer = pi.registerEntryRenderer;",
		"registerEntryRenderer.call(pi, SUPERVISOR_REPLY_ENTRY_TYPE, renderSupervisorReply);",
	].join("\n");
	// vm 沙箱 realm 的数组与宿主原型不同，先展开成宿主数组再比较
	assert.deepEqual([...extractEntryRendererTypes(source)].sort(), ["acp-nudge", "generic-type", "inline-type", "subagents:supervisor-reply"]);
});

test("extractEntryRendererTypes 忽略模板插值、未知变量与普通 const 字符串", () => {
	const source = ["const dynamic = `card-${suffix}`;", "pi.registerEntryRenderer(dynamic, render);", 'const notACall = "plain-value";', "pi.registerEntryRenderer(unknownIdent, render);"].join("\n");
	assert.deepEqual([...extractEntryRendererTypes(source)], []);
});

test("collectEntryRendererTypes 按 mtime 缓存，文件变化后重扫", async () => {
	clearExtensionEntryRendererScanCache();
	const directory = await mkdtemp(join(tmpdir(), "pideck-entry-renderer-scan-"));
	const entryPath = join(directory, "ext.ts");
	try {
		await writeFile(entryPath, 'pi.registerEntryRenderer("v1-type", render);');
		assert.deepEqual([...collectEntryRendererTypes([entryPath])], ["v1-type"]);
		// 文件没变：读缓存
		assert.deepEqual([...collectEntryRendererTypes([entryPath])], ["v1-type"]);
		// 变更内容并强制 mtime 前移：重扫拿到新类型
		await writeFile(entryPath, 'pi.registerEntryRenderer("v2-type", render);');
		const future = new Date(Date.now() + 5000);
		await utimes(entryPath, future, future);
		assert.deepEqual([...collectEntryRendererTypes([entryPath])], ["v2-type"]);
	} finally {
		clearExtensionEntryRendererScanCache();
		await rm(directory, { recursive: true, force: true });
	}
});

test("collectEntryRendererTypes 沿相对 import 解析跨文件常量别名与兄弟模块注册", async () => {
	clearExtensionEntryRendererScanCache();
	const directory = await mkdtemp(join(tmpdir(), "pideck-entry-renderer-graph-"));
	try {
		await writeFile(join(directory, "entry.js"), ['import { renderReply } from "./ui.js";', 'import { REPLY_TYPE } from "./types.js";', "pi.registerEntryRenderer(REPLY_TYPE, renderReply);"].join("\n"));
		await writeFile(join(directory, "ui.js"), 'pi.registerEntryRenderer("ui-own-type", render);');
		await writeFile(join(directory, "types.js"), 'export const REPLY_TYPE = "graph-reply";');
		assert.deepEqual([...collectEntryRendererTypes([join(directory, "entry.js")])].sort(), ["graph-reply", "ui-own-type"]);
	} finally {
		clearExtensionEntryRendererScanCache();
		await rm(directory, { recursive: true, force: true });
	}
});

test("collectEntryRendererTypes 对缺失/不可读文件不抛错", () => {
	clearExtensionEntryRendererScanCache();
	assert.deepEqual([...collectEntryRendererTypes([join(tmpdir(), "pideck-not-exists-ext.ts")])], []);
});
