/**
 * 记忆导出/导入二次弹窗的接线守卫。
 *
 * 这三件事一旦接错用户会丢数据，所以要钉住：
 * 1. 导出/导入都必须先弹窗，不能点一下就写盘（导入尤其：`previewBundle` 只读，`importBundle` 才写）；
 * 2. 导出的勾选一路传到主进程（`exportBundle(ids)`），导入的勾选与冲突策略也一路传下去；
 * 3. 弹窗用到的每条词典键在 zh-CN / en-US / zh-TW 里都存在——漏一条界面上就会露出裸键。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SETTINGS_DIR = "src/renderer/src/components/app/settings";
const I18N_DIR = "src/renderer/src/i18n";

function read(relativePath) {
	return readFileSync(relativePath, "utf8");
}

/** 记忆相关的全部设置组件（弹窗、分区、条目列表、文案模块）。 */
function memoryComponentSources() {
	return readdirSync(SETTINGS_DIR)
		.filter((name) => name.startsWith("AgentMemory") || name === "agentMemoryLabels.ts")
		.filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
		.map((name) => ({ name, source: read(join(SETTINGS_DIR, name)) }));
}

test("导出与导入都必须先经过弹窗，不能点一下就写盘", () => {
	const section = read(join(SETTINGS_DIR, "AgentMemorySettingsSection.tsx"));
	assert.match(section, /import \{ AgentMemoryExportDialog \} from "\.\/AgentMemoryExportDialog"/);
	assert.match(section, /import \{ AgentMemoryImportDialog \} from "\.\/AgentMemoryImportDialog"/);
	// 导入按钮只做预览；直接调 importBundle 会跳过「导入哪些条目」的选择
	assert.match(section, /desktopApi\.agentMemory\.previewBundle\(\)/);
	assert.doesNotMatch(section, /desktopApi\.agentMemory\.importBundle\(/, "导入必须由弹窗发起，分区里不能直接写盘");
	// 导出按钮只开弹窗
	assert.match(section, /onClick=\{\(\) => setExportOpen\(true\)\}/);
	assert.doesNotMatch(section, /desktopApi\.agentMemory\.exportBundle\(/, "导出必须由弹窗发起");
});

test("导出的勾选一路传到主进程，默认全选", () => {
	const dialog = read(join(SETTINGS_DIR, "AgentMemoryExportDialog.tsx"));
	assert.match(dialog, /desktopApi\.agentMemory\.list\(\)/, "导出弹窗自己要读条目，否则用户看不到可导出什么");
	assert.match(dialog, /desktopApi\.agentMemory\.exportBundle\(\[\.\.\.selected\]\)/);
	// 默认全选：进弹窗就先勾上所有条目，用户要做的是「取消几条」而不是「勾满」
	assert.match(dialog, /useState<Set<string>>\(new Set\(\)\)/);
	assert.match(dialog, /setSelected\(new Set\(/);
});

test("导入把勾选条目、冲突策略与墓碑开关都传给主进程", () => {
	const dialog = read(join(SETTINGS_DIR, "AgentMemoryImportDialog.tsx"));
	assert.match(dialog, /desktopApi\.agentMemory\.importBundle\(\{ filePath: props\.filePath, selection: \[\.\.\.selected\], conflictPolicy, applyTombstones \}\)/);
	// 两种冲突策略都必须可选，默认 append（不擅自覆盖用户已有的记忆）
	assert.match(dialog, /useState<"append" \| "overwrite">\("append"\)/);
	assert.match(dialog, /setConflictPolicy\("append"\)/);
	assert.match(dialog, /setConflictPolicy\("overwrite"\)/);
	// 墓碑同步默认开着（否则删掉的内容会被旧包复活），但要允许关掉
	assert.match(dialog, /useState\(true\)/);
	assert.match(dialog, /setApplyTombstones\(/);
});

test("导入只让 new 与 conflict 可选：已存在/已删/拒收的条目没有勾选框", () => {
	const dialog = read(join(SETTINGS_DIR, "AgentMemoryImportDialog.tsx"));
	assert.match(dialog, /entry\.status === "new" \|\| entry\.status === "conflict"/);
	// 默认勾选也走同一个判定，否则「全选」会把 duplicate 也送进主进程
	assert.match(dialog, /new Set\(preview\.entries\.filter\(selectable\)/);
	// 冲突项要并排给出本地版本，否则用户无法判断要不要覆盖
	assert.match(dialog, /entry\.status === "conflict" && entry\.localContent/);
});

test("导出排除设备作用域，并支持整组勾选与全选/全不选", () => {
	const dialog = read(join(SETTINGS_DIR, "AgentMemoryExportDialog.tsx"));
	assert.match(dialog, /group\.scope !== "device"/, "设备条目描述本机路径，不能进包");
	assert.match(dialog, /const toggleGroup = /);
	assert.match(dialog, /settings\.agentMemorySelectAll/);
	assert.match(dialog, /settings\.agentMemorySelectNone/);
});

test("记忆文案只有一份来源：条目列表不再自带 target/scope 标签", () => {
	const list = read(join(SETTINGS_DIR, "AgentMemoryEntryList.tsx"));
	assert.match(list, /from "\.\/agentMemoryLabels"/);
	assert.doesNotMatch(list, /function targetLabel/, "重复定义会让「记忆 / 长期」两种叫法并存");
	assert.doesNotMatch(list, /function scopeLabel/, "重复定义会让作用域叫法在弹窗与列表里不一致");
});

test("弹窗用到的每条词典键在三种语言里都存在", () => {
	const copies = {
		"zh-CN": read(join(I18N_DIR, "rendererCopy.zh-CN.ts")),
		"en-US": read(join(I18N_DIR, "rendererCopy.en-US.ts")),
		"zh-TW": read(join(I18N_DIR, "rendererCopy.zh-TW.ts")),
	};
	const keys = new Set();
	for (const { source } of memoryComponentSources()) {
		for (const match of source.matchAll(/t\("(settings\.agentMemory[A-Za-z]+)"/g)) keys.add(match[1]);
	}
	assert.ok(keys.size >= 20, `应该从组件里找出足够多的词典键，实际 ${keys.size}`);
	for (const [locale, source] of Object.entries(copies)) {
		const missing = [...keys].filter((key) => !source.includes(`"${key}":`));
		assert.deepEqual(missing, [], `${locale} 缺少这些词典键，界面会露出裸键：${missing.join(", ")}`);
	}
});
