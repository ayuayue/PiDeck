import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { load } from "js-yaml";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readUserPatchRows, isUserPluginEntry, classifyStaticPlugins, removeUserPatchRow, normalizeModuleName, resolveManagedPluginDir, withArrayDocumentFallback, dropEmptyArrayMarker, ensureUserPatchLayerIsArrayDocument, USER_PATCH_FILENAME } = loadTsCommonJs("src/main/dsh/dshUserPlugins.ts");

const SAMPLE_PATCH = [
	"# PiDeck / DSH 用户补丁层",
	"# 注释必须原样保留",
	"",
	"- insert:",
	"    - id: model-proxy/host",
	"      name: file:///C:/Users/x/AppData/Roaming/pi-desktop/dsh-plugins/dsh-plugin-model-proxy/lib/host/index.js",
	"      config: {}",
	"",
	"- insert:",
	"    - id: second-plugin/host",
	"      name: dsh-plugin-second",
	"      config: {}",
	"",
].join("\n");

test("USER_PATCH_FILENAME：官方 home 补丁层文件名", () => {
	assert.equal(USER_PATCH_FILENAME, "cordis.patch.yml");
});

test("readUserPatchRows：解析 insert 行的 id/name；文件缺失 = 空名单", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-userpatch-"));
	try {
		const patchPath = join(dir, "cordis.patch.yml");
		// 跨 realm 对象逐字段断言（deepStrictEqual 会因原型不同误报）
		const missing = readUserPatchRows(patchPath);
		assert.equal(missing.exists, false);
		assert.equal(missing.rows.length, 0);

		writeFileSync(patchPath, SAMPLE_PATCH, "utf8");
		const result = readUserPatchRows(patchPath);
		// 跨 realm（vm 加载 TS）对象原型不同，逐字段断言而不是 deepStrictEqual
		assert.equal(result.exists, true);
		assert.equal(result.error, undefined);
		assert.equal(result.rows.length, 2);
		assert.equal(result.rows[0].id, "model-proxy/host");
		assert.ok(result.rows[0].name.startsWith("file:///C:/"));
		assert.equal(result.rows[1].name, "dsh-plugin-second");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readUserPatchRows：解析失败返回 error 与空名单（宁可判 builtin 不误标）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-userpatch-"));
	try {
		const patchPath = join(dir, "cordis.patch.yml");
		writeFileSync(patchPath, "\t- broken: [unclosed", "utf8");
		const result = readUserPatchRows(patchPath);
		assert.equal(result.exists, true);
		assert.equal(result.rows.length, 0);
		assert.ok(typeof result.error === "string" && result.error.length > 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isUserPluginEntry：id 命中（含 include: 前缀）与 name 归一化命中", () => {
	const rows = [
		{ id: "model-proxy/host", name: "file:///C:/x/pi-desktop/dsh-plugins/dsh-plugin-model-proxy/lib/host/index.js" },
		{ id: "second-plugin/host", name: "dsh-plugin-second" },
	];
	assert.equal(isUserPluginEntry({ entryId: "include:model-proxy/host", moduleName: "file:///C:/x/pi-desktop/dsh-plugins/dsh-plugin-model-proxy/lib/host/index.js" }, rows), true, "entryId 剥 include: 前缀后按 id 命中");
	assert.equal(isUserPluginEntry({ entryId: "include:second-plugin/host", moduleName: "dsh-plugin-second" }, rows), true, "name 精确命中");
	assert.equal(isUserPluginEntry({ entryId: "include:tool-bash", moduleName: "@deepseek-ai/dsh-tool-bash" }, rows), false);
	// Windows 反斜杠路径归一化后命中
	assert.equal(isUserPluginEntry({ entryId: "other", moduleName: "C:\\x\\pi-desktop\\dsh-plugins\\dsh-plugin-model-proxy\\lib\\host\\index.js" }, [{ name: "C:/x/pi-desktop/dsh-plugins/dsh-plugin-model-proxy/lib/host/index.js" }]), true);
});

test("classifyStaticPlugins：命中用户行为 user，其余 builtin", () => {
	const rows = [{ id: "model-proxy/host" }];
	const views = [
		{ entryId: "include:tool-bash", moduleName: "@deepseek-ai/dsh-tool-bash", enabled: true, fiberPhase: "active" },
		{ entryId: "include:model-proxy/host", moduleName: "dsh-plugin-model-proxy", enabled: true, fiberPhase: "active" },
	];
	const classified = classifyStaticPlugins(views, rows);
	assert.equal(classified[0].origin, "builtin");
	assert.equal(classified[1].origin, "user");
});

test("removeUserPatchRow：只移除目标行组，其余内容（含注释）逐字节保留", () => {
	const result = removeUserPatchRow(SAMPLE_PATCH, { id: "model-proxy/host" });
	assert.equal(result.removed, true);
	assert.ok(!result.text.includes("model-proxy"), "目标行组整组移除");
	assert.ok(result.text.includes("# 注释必须原样保留"), "注释保留");
	assert.ok(result.text.includes("second-plugin/host"), "其余 insert 块保留");
	assert.ok(result.text.includes("- insert:"), "仍有其余 insert 块头");
	// 移除后再次移除同一行 → not found
	const again = removeUserPatchRow(result.text, { id: "model-proxy/host" });
	assert.equal(again.removed, false);
	assert.ok(typeof again.reason === "string");
});

test("removeUserPatchRow：块内最后一行移除后，空的 - insert: 头一并删除", () => {
	const single = ["- insert:", "    - id: only-one/host", "      name: dsh-plugin-only", "      config: {}", ""].join("\n");
	const result = removeUserPatchRow(single, { id: "only-one/host" });
	assert.equal(result.removed, true);
	assert.ok(!result.text.includes("- insert:"), "空块头删除");
	assert.ok(!result.text.includes("only-one"), "行内容删除");
});

test("removeUserPatchRow：按 moduleName 归一化匹配也能移除", () => {
	const result = removeUserPatchRow(SAMPLE_PATCH, {
		entryId: "include:model-proxy/host",
		moduleName: "file:///C:/Users/x/AppData/Roaming/pi-desktop/dsh-plugins/dsh-plugin-model-proxy/lib/host/index.js",
	});
	assert.equal(result.removed, true);
	assert.ok(!result.text.includes("model-proxy"));
});

test("removeUserPatchRow：未命中返回 removed=false 且原文不变", () => {
	const result = removeUserPatchRow(SAMPLE_PATCH, { id: "not-exist/host" });
	assert.equal(result.removed, false);
	assert.equal(result.text, SAMPLE_PATCH);
});

test("resolveManagedPluginDir：仅 PiDeck 管理目录内的路径返回插件根", () => {
	// 插件根必须真实存在 package.json（函数靠 existsSync 向上找插件根）
	const root = mkdtempSync(join(tmpdir(), "pideck-managed-"));
	try {
		const managedRoot = join(root, "dsh-plugins");
		const pluginDir = join(managedRoot, "dsh-plugin-model-proxy");
		mkdirSync(join(pluginDir, "lib", "host"), { recursive: true });
		writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "dsh-plugin-model-proxy" }), "utf8");
		const entry = join(pluginDir, "lib", "host", "index.js");

		const dir = resolveManagedPluginDir(entry, managedRoot);
		assert.ok(dir !== undefined, "管理目录内的入口文件 → 插件根");
		assert.equal(dir.endsWith("dsh-plugin-model-proxy"), true);
		// file URL 形式同样命中
		const dirFromUrl = resolveManagedPluginDir("file:///" + entry.replace(/\\/g, "/"), managedRoot);
		assert.ok(dirFromUrl !== undefined && dirFromUrl.endsWith("dsh-plugin-model-proxy"), "file URL 前缀也支持");

		assert.equal(resolveManagedPluginDir("dsh-plugin-model-proxy", managedRoot), undefined, "裸包名不是路径");
		assert.equal(resolveManagedPluginDir(join(root, "elsewhere", "pkg", "index.js"), managedRoot), undefined, "管理目录之外不删");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("normalizeModuleName：剥 file:// 前缀并统一斜杠", () => {
	assert.equal(normalizeModuleName("file:///C:/a/b.js"), "C:/a/b.js");
	assert.equal(normalizeModuleName("C:\\a\\b.js"), "C:/a/b.js");
	assert.equal(normalizeModuleName("dsh-plugin-x"), "dsh-plugin-x");
});

test("readUserPatchRows：真实读文件（集成路径，保证 readFileSync 走通）", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-userpatch-"));
	try {
		const patchPath = join(dir, USER_PATCH_FILENAME);
		writeFileSync(patchPath, SAMPLE_PATCH, "utf8");
		assert.ok(existsSync(patchPath));
		assert.equal(readUserPatchRows(patchPath).rows.length, 2);
		assert.equal(readFileSync(patchPath, "utf8"), SAMPLE_PATCH);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// dsh 0.2.0-rc.2 起 loadOptionalPatches 硬性要求补丁文件是顶层 YAML 数组：
// 只有注释的文件解析成 null → host 直接起不来（用户可见报错 must be a top-level YAML array）。
const COMMENT_ONLY_HEADER = ["# PiDeck / DSH 用户补丁层", "# 注释", "", ""].join("\n");

test("withArrayDocumentFallback：只有注释的空文档补一行 []，注释原样保留", () => {
	const healed = withArrayDocumentFallback(COMMENT_ONLY_HEADER);
	assert.match(healed, /# PiDeck \/ DSH 用户补丁层/);
	assert.deepEqual(load(healed), [], "补完必须是可解析的空数组");
});

test("withArrayDocumentFallback：合法数组/可疑形状原样返回（不猜用户意图）", () => {
	assert.equal(withArrayDocumentFallback(SAMPLE_PATCH), SAMPLE_PATCH, "已是数组不动");
	assert.equal(withArrayDocumentFallback("- insert:\n    - id: x/host\n"), "- insert:\n    - id: x/host\n");
	assert.equal(withArrayDocumentFallback("id: scalar-top\n"), "id: scalar-top\n", "顶层是映射不猜");
	assert.equal(withArrayDocumentFallback("name: [unterminated\n"), "name: [unterminated\n", "解析失败的形状不改写");
});

test("removeUserPatchRow 删掉最后一行后只剩注释 → 补 [] 仍是合法补丁层（卸载链路）", () => {
	const single = [COMMENT_ONLY_HEADER, "- insert:", "    - id: only-one/host", "      name: dsh-plugin-only", "      config: {}", ""].join("\n");
	const afterUninstall = removeUserPatchRow(single, { id: "only-one/host" });
	assert.equal(afterUninstall.removed, true);
	assert.ok(!afterUninstall.text.includes("- insert:"));
	assert.equal(classifyEmpty(afterUninstall.text), true, "删完确实是空文档（正是必须出手的场景）");
	const healed = withArrayDocumentFallback(afterUninstall.text);
	assert.equal(readUserPatchRowsFromString(healed), 0, "补完 host 能起、且没有用户插件");
});

test("dropEmptyArrayMarker：摘掉占位后追加 insert 块仍是合法数组文档（install-dsh-plugin 追加链路）", () => {
	const healed = withArrayDocumentFallback(COMMENT_ONLY_HEADER);
	const stripped = dropEmptyArrayMarker(healed);
	assert.ok(!stripped.includes("[]"), "占位行已摘");
	const appended = `${stripped.endsWith("\n") ? "" : "\n"}- insert:\n    - id: new-plugin/host\n      name: dsh-plugin-new\n      config: {}\n`;
	const document = `${stripped}${appended}`;
	const parsed = load(document);
	assert.equal(Array.isArray(parsed), true, "[] 与块式序列不能并存：追加前必须去占位");
	assert.deepEqual(parsed[0].insert[0].id, "new-plugin/host");
	// 缩进位置的字面 []（config 里的空数组值）不得被误删
	assert.equal(dropEmptyArrayMarker("- insert:\n    - id: x/host\n      config: []\n"), "- insert:\n    - id: x/host\n      config: []\n");
});

test("ensureUserPatchLayerIsArrayDocument：就地修复注释-only 文件；缺失/已合法不写盘", () => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-heal-"));
	try {
		const missing = join(dir, "absent.yml");
		assert.equal(ensureUserPatchLayerIsArrayDocument(missing), false, "文件缺失是合法状态");

		const patchPath = join(dir, USER_PATCH_FILENAME);
		writeFileSync(patchPath, COMMENT_ONLY_HEADER, "utf8");
		assert.equal(ensureUserPatchLayerIsArrayDocument(patchPath), true);
		const healed = readFileSync(patchPath, "utf8");
		assert.match(healed, /# 注释/);
		assert.deepEqual(load(healed), []);
		assert.equal(ensureUserPatchLayerIsArrayDocument(patchPath), false, "已合法不再重复写");

		writeFileSync(patchPath, SAMPLE_PATCH, "utf8");
		assert.equal(ensureUserPatchLayerIsArrayDocument(patchPath), false, "有内容的补丁层不碰");
		assert.equal(readFileSync(patchPath, "utf8"), SAMPLE_PATCH);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("DshHost 接线：启动前自愈补丁层，卸载写盘也走 [] 兜底", () => {
	const source = readFileSync("src/main/dsh/DshHost.ts", "utf8");
	assert.match(source, /ensureUserPatchLayerIsArrayDocument\(join\([\s\S]{0,80}?USER_PATCH_FILENAME\)\)/);
	assert.match(source, /writeFileSync\(\s*patchPath,\s*withArrayDocumentFallback\(removed\.text\)/);
	// 自愈必须发生在 host fork 之前（acquireHostLock 同段之前），否则补丁错误照旧致命。
	const startIndex = source.search(/private async start\(\)/);
	const healIndex = source.indexOf("ensureUserPatchLayerIsArrayDocument", startIndex);
	const lockIndex = source.indexOf("this.acquireHostLock()", healIndex);
	assert.ok(startIndex !== -1 && healIndex !== -1 && lockIndex !== -1 && healIndex < lockIndex);
});

test("install-dsh-plugin 登记前摘掉 [] 占位（与自愈写入格式兼容）", () => {
	const script = readFileSync("scripts/install-dsh-plugin.mjs", "utf8");
	// 与 dshUserPlugins.dropEmptyArrayMarker 同一判据（脚本不能 import TS，允许各留一份，由本测试把关）。
	const stripIndex = script.indexOf(String.raw`/^\s*\[\s*\]\s*$/`);
	const writeIndex = script.indexOf("writeFileSync(patchPath, `${current}");
	assert.ok(stripIndex !== -1 && writeIndex !== -1 && stripIndex < writeIndex, "过滤发生在追加 Loader 行之前");
});

/** 判断是否空文档（与生产代码同一判据，测试里只做断言用）。 */
function classifyEmpty(text) {
	try {
		return load(text) === null;
	} catch {
		return false;
	}
}

function readUserPatchRowsFromString(text) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-rows-"));
	try {
		const path = join(dir, USER_PATCH_FILENAME);
		writeFileSync(path, text, "utf8");
		// 只回长度：沙箱里构造的数组与主 realm 的 Array 原型不同，断言整体结构会假失败。
		return readUserPatchRows(path).rows.length;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
