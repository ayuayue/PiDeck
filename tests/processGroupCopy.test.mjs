import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 用 import.meta.url 定位，测试不依赖 cwd（npm test / 绝对路径 --test 两种跑法都要成立）。
const ZH_PATH = fileURLToPath(new URL("../src/renderer/src/i18n/rendererCopy.zh-CN.ts", import.meta.url));
const EN_PATH = fileURLToPath(new URL("../src/renderer/src/i18n/rendererCopy.en-US.ts", import.meta.url));

/** 契约 §2：13 个工具活动类别（顺序即契约表格顺序）。 */
const CATEGORIES = ["read", "readImage", "search", "write", "edit", "commands", "code", "webSearch", "webFetch", "subagents", "plan", "questions", "tools"];

/** 契约 §2：组头拼装片段（分隔符 / 连接词 / 超限省略）。 */
const ASSEMBLY_KEYS = ["timeline.processGroup.analyzing", "timeline.processGroup.analyzed", "timeline.processGroup.separator", "timeline.processGroup.joinTwo", "timeline.processGroup.joinList", "timeline.processGroup.listSeparator", "timeline.processGroup.more"];

/** 契约 §2b：设置开关文案。 */
const SETTINGS_KEYS = ["settings.processGroupDisplay", "settings.processGroupDisplayDesc"];

const runningKeys = CATEGORIES.map((category) => `timeline.processGroup.running.${category}`);
const doneKeys = CATEGORIES.map((category) => `timeline.processGroup.done.${category}`);
const ALL_KEYS = [...runningKeys, ...doneKeys, ...ASSEMBLY_KEYS, ...SETTINGS_KEYS];

/**
 * 从 locale 源码抽过程组相关键名。按「行首引号 + `":`」锚点定位，
 * 避免值或注释里出现同名前缀时被误判（AGENTS.md：源码扫描必须带空白容忍锚点）。
 */
function extractProcessGroupKeys(source) {
	const keys = new Set();
	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith('"')) continue;
		if (!line.startsWith('"timeline.processGroup.') && !line.startsWith('"settings.processGroupDisplay')) continue;
		const end = line.indexOf('":');
		assert.ok(end > 0, `无法解析键名所在行: ${line}`);
		keys.add(line.slice(1, end));
	}
	return keys;
}

const zhKeys = extractProcessGroupKeys(readFileSync(ZH_PATH, "utf8"));
const enKeys = extractProcessGroupKeys(readFileSync(EN_PATH, "utf8"));

const { zhCN } = loadTsCommonJs(ZH_PATH);
const { enUS } = loadTsCommonJs(EN_PATH);

/** 契约 §2 / §2b 的冻结文案，逐字照抄，用于挡住「键在但值被改写」。 */
const EXPECTED_ZH = {
	"timeline.processGroup.running.read": "正在读取文件",
	"timeline.processGroup.running.readImage": "正在读取图片",
	"timeline.processGroup.running.search": "正在搜索代码",
	"timeline.processGroup.running.write": "正在写入文件",
	"timeline.processGroup.running.edit": "正在编辑文件",
	"timeline.processGroup.running.commands": "正在运行命令",
	"timeline.processGroup.running.code": "正在运行代码",
	"timeline.processGroup.running.webSearch": "正在搜索网页",
	"timeline.processGroup.running.webFetch": "正在访问网页",
	"timeline.processGroup.running.subagents": "正在协调子代理",
	"timeline.processGroup.running.plan": "正在更新计划",
	"timeline.processGroup.running.questions": "等待你的操作",
	"timeline.processGroup.running.tools": "正在调用工具",
	"timeline.processGroup.done.read": "已读取文件",
	"timeline.processGroup.done.readImage": "已读取图片",
	"timeline.processGroup.done.search": "已搜索代码",
	"timeline.processGroup.done.write": "已写入文件",
	"timeline.processGroup.done.edit": "修改了文件",
	"timeline.processGroup.done.commands": "执行了命令",
	"timeline.processGroup.done.code": "运行了代码",
	"timeline.processGroup.done.webSearch": "已搜索网页",
	"timeline.processGroup.done.webFetch": "已访问网页",
	"timeline.processGroup.done.subagents": "已协调子代理",
	"timeline.processGroup.done.plan": "更新了计划",
	"timeline.processGroup.done.questions": "向用户提出了问题",
	"timeline.processGroup.done.tools": "已调用工具",
	"timeline.processGroup.analyzing": "正在分析请求",
	"timeline.processGroup.analyzed": "已完成分析",
	"timeline.processGroup.separator": "·",
	"timeline.processGroup.joinTwo": "{first}并{second}",
	"timeline.processGroup.joinList": "{items}",
	"timeline.processGroup.listSeparator": "、",
	"timeline.processGroup.more": "{title} 等",
	"settings.processGroupDisplay": "过程组显示（实验）",
	"settings.processGroupDisplayDesc": "开启后，一轮里的连续思考与工具调用会合并成「过程组」，点开组头才展开明细；关闭则保持现在的平铺方式。",
};

const EXPECTED_EN = {
	"timeline.processGroup.running.read": "Reading files",
	"timeline.processGroup.running.readImage": "Reading images",
	"timeline.processGroup.running.search": "Searching the code",
	"timeline.processGroup.running.write": "Writing files",
	"timeline.processGroup.running.edit": "Editing files",
	"timeline.processGroup.running.commands": "Running commands",
	"timeline.processGroup.running.code": "Running code",
	"timeline.processGroup.running.webSearch": "Searching the web",
	"timeline.processGroup.running.webFetch": "Fetching pages",
	"timeline.processGroup.running.subagents": "Coordinating subagents",
	"timeline.processGroup.running.plan": "Updating the plan",
	"timeline.processGroup.running.questions": "Waiting for you",
	"timeline.processGroup.running.tools": "Calling tools",
	"timeline.processGroup.done.read": "Read files",
	"timeline.processGroup.done.readImage": "Read images",
	"timeline.processGroup.done.search": "Searched the code",
	"timeline.processGroup.done.write": "Wrote files",
	"timeline.processGroup.done.edit": "Edited files",
	"timeline.processGroup.done.commands": "Ran commands",
	"timeline.processGroup.done.code": "Ran code",
	"timeline.processGroup.done.webSearch": "Searched the web",
	"timeline.processGroup.done.webFetch": "Fetched pages",
	"timeline.processGroup.done.subagents": "Coordinated subagents",
	"timeline.processGroup.done.plan": "Updated the plan",
	"timeline.processGroup.done.questions": "Asked you a question",
	"timeline.processGroup.done.tools": "Called tools",
	"timeline.processGroup.analyzing": "Analyzing the request",
	"timeline.processGroup.analyzed": "Finished analyzing",
	"timeline.processGroup.separator": "·",
	"timeline.processGroup.joinTwo": "{first} and {second}",
	"timeline.processGroup.joinList": "{items}",
	"timeline.processGroup.listSeparator": ", ",
	"timeline.processGroup.more": "{title}, and more",
	"settings.processGroupDisplay": "Grouped process display (experimental)",
	"settings.processGroupDisplayDesc": "When on, consecutive reasoning and tool calls in a turn merge into process groups; expand a group header to see its details. Turn it off to keep the current flat layout.",
};

test("两个 locale 的过程组键集合完全一致（缺失 / 多出都报出具体键名）", () => {
	const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
	const extraInEn = [...enKeys].filter((key) => !zhKeys.has(key)).sort();
	assert.deepEqual(missingInEn, [], `en-US 缺少这些键：${missingInEn.join(", ")}`);
	assert.deepEqual(extraInEn, [], `en-US 多出这些键：${extraInEn.join(", ")}`);
	// 集合相同 ⇒ 数量必然相同；数量对但键名错位（少一个 A 多一个 B）由上面两条断言挡住。
	assert.equal(zhKeys.size, ALL_KEYS.length, `过程组键数量应为 ${ALL_KEYS.length}，实际 ${zhKeys.size}`);
});

test("13 个 running 键 + 13 个 done 键在两个 locale 里一个不少", () => {
	for (const [label, keys] of [
		["zh-CN", zhKeys],
		["en-US", enKeys],
	]) {
		const running = [...keys].filter((key) => key.startsWith("timeline.processGroup.running.")).sort();
		const done = [...keys].filter((key) => key.startsWith("timeline.processGroup.done.")).sort();
		assert.deepEqual(running, [...runningKeys].sort(), `${label} 的 running 类别键不完整`);
		assert.deepEqual(done, [...doneKeys].sort(), `${label} 的 done 类别键不完整`);
		assert.equal(running.length, 13, `${label} running 键应为 13 个`);
		assert.equal(done.length, 13, `${label} done 键应为 13 个`);
	}
});

test("组头拼装片段与设置开关文案在两个 locale 里都存在", () => {
	for (const [label, keys] of [
		["zh-CN", zhKeys],
		["en-US", enKeys],
	]) {
		for (const key of [...ASSEMBLY_KEYS, ...SETTINGS_KEYS]) {
			assert.ok(keys.has(key), `${label} 缺少 ${key}`);
		}
	}
});

test("两个 locale 都不含契约之外的过程组键（防止顺手加键漂移）", () => {
	for (const [label, keys] of [
		["zh-CN", zhKeys],
		["en-US", enKeys],
	]) {
		const unexpected = [...keys].filter((key) => !ALL_KEYS.includes(key)).sort();
		assert.deepEqual(unexpected, [], `${label} 出现契约外的过程组键：${unexpected.join(", ")}`);
	}
});

test("文案值与契约 §2 / §2b 冻结表格逐字一致", () => {
	assert.deepEqual(Object.keys(EXPECTED_ZH).sort(), [...ALL_KEYS].sort());
	assert.deepEqual(Object.keys(EXPECTED_EN).sort(), [...ALL_KEYS].sort());
	for (const key of ALL_KEYS) {
		assert.ok(Object.hasOwn(zhCN, key), `zh-CN 字典缺少 ${key}`);
		assert.ok(Object.hasOwn(enUS, key), `en-US 字典缺少 ${key}`);
		assert.equal(zhCN[key], EXPECTED_ZH[key], `zh-CN 文案被改写: ${key}`);
		assert.equal(enUS[key], EXPECTED_EN[key], `en-US 文案被改写: ${key}`);
	}
	for (const key of ["timeline.processGroup.joinTwo", "timeline.processGroup.more"]) {
		// 拼装键必须保留占位符，否则组头拼出来就是死文案
		for (const locale of [zhCN, enUS]) {
			assert.match(locale[key], /\{first\}|\{title\}/, `${key} 丢失占位符`);
		}
	}
});
