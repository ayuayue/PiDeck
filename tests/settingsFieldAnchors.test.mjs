import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 加载设置项锚点清单（真实依赖图：settingsFieldAnchors → settingsSectionAnchors）。
 * 两个模块在运行期只有 `import type` 与被聚合的数组常量，无 React/Electron 依赖，
 * 因此能直接在 node --test 里跑；用官方 helper 而不是手写 vm 沙箱 —— 手写的
 * `require(specifier)` 会以 tests/ 为基准解析相对导入，生产代码新增一个本地 import
 * 就整片 MODULE_NOT_FOUND。
 */
function loadAnchors() {
	return loadTsCommonJs("src/renderer/src/utils/settingsFieldAnchors.ts").SETTINGS_FIELD_ANCHORS;
}

const SETTINGS_DIR = "src/renderer/src/components/app/settings";

/**
 * 设置页全部源码。
 * 不按 tab 精确映射文件：锚点可能落在 tab 主文件、也可能落在被它引用的子组件
 * （如 dev tab 的 dsh-runner-node 在 DshRunnerNodeRow.tsx），逐个维护映射只会引入
 * 与代码结构无关的脆弱耦合。这里只确认「锚点确实写在了设置页的某个文件里」。
 */
function settingsSources() {
	const files = readdirSync(SETTINGS_DIR)
		.filter((name) => name.endsWith(".tsx"))
		.map((name) => path.join(SETTINGS_DIR, name));
	files.push("src/renderer/src/components/app/SettingsModal.tsx");
	return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

test("锚点 slug 唯一", () => {
	const anchors = loadAnchors();
	const slugs = anchors.map((anchor) => anchor.slug);
	assert.equal(new Set(slugs).size, slugs.length, "slug 重复会让命令面板两条目的 id 相同");
});

/**
 * 本轮最重要的一条：索引里写了、源码里没写锚点 → 用户搜到后点进去
 * `getElementById` 返回 null，**页面毫无反应且不报错**，是最难自查的失效模式。
 */
test("每个锚点在设置页源码里真实渲染（防「搜到却跳不动」）", () => {
	const anchors = loadAnchors();
	const sources = settingsSources();
	const missing = [];
	for (const anchor of anchors) {
		const fullId = `settings-section-${anchor.slug}`;
		const hit = sources.some(
			({ text }) =>
				// SettingRow / SettingSwitchRow / SettingTextarea 的 anchor prop
				text.includes(`anchor="${anchor.slug}"`) ||
				// SettingsSection 直接写完整 id
				text.includes(`"${fullId}"`),
		);
		if (!hit) missing.push(`settings-section-${anchor.slug} (${anchor.tab})`);
	}
	assert.deepEqual(missing, [], `以下锚点在设置页源码里找不到，命令面板点进去会静默无反应：\n  ${missing.join("\n  ")}`);
});

test("每条锚点都带标题 key 与搜索别名", () => {
	const anchors = loadAnchors();
	assert.ok(anchors.length > 0, "锚点清单不应为空");
	for (const anchor of anchors) {
		// 不限定 `settings.` 前缀：设置页文案分散在多个命名空间（voice.settings.title、
		// usageStats.*、environment.clearCheckFlag），前缀断言只会拦住合法 key。
		// 「key 真实存在」由下面那份中英文案测试兜底，比前缀检查严格。
		assert.ok(typeof anchor.labelKey === "string" && anchor.labelKey.includes("."), `labelKey 应形如「命名空间.键名」: ${anchor.slug} → ${anchor.labelKey}`);
		assert.ok(Array.isArray(anchor.keywords) && anchor.keywords.length > 0, `缺少搜索别名会让「中文标题搜不到」的场景失效: ${anchor.slug}`);
	}
});

/**
 * 允许「页面上有锚点、索引里没登记」的例外：小节标题与它所在 tab 的名字完全相同。
 * tab 级入口（command.groupSettings 那组）已经能把用户带到同一页，再放一条同名结果
 * 只会让搜索结果里出现两条一模一样的标题。
 */
const SECTION_ID_EXEMPTIONS = new Set(["settings-section-git", "settings-section-backup-config"]);

/**
 * 反向覆盖：设置页里**已经渲染**的小节锚点必须都能被搜到。
 *
 * 为什么需要反向断言：只做「索引 → 源码」的单向检查时，新增一个小节可以「页面上有、
 * 搜索里没有」——用户搜不到就只能一层层点进 tab 自己翻，而这类缺口不会报错也不会红灯。
 * 设置项（SettingRow 的 anchor prop）同理：写了 anchor 却不登记，同样搜不到。
 */
test("设置页里的小节与设置项锚点都登记进了索引（防「页面有、搜索没有」）", () => {
	const anchors = loadAnchors();
	const registeredSlugs = new Set(anchors.map((anchor) => anchor.slug));
	const registeredSectionIds = new Set(anchors.map((anchor) => `settings-section-${anchor.slug}`));
	const missing = [];
	for (const { file, text } of settingsSources()) {
		// 小节：SettingsSection 的完整 id
		for (const match of text.matchAll(/"(settings-section-[a-z0-9-]+)"/g)) {
			const id = match[1];
			if (SECTION_ID_EXEMPTIONS.has(id) || registeredSectionIds.has(id)) continue;
			const entry = `${id} (${path.basename(file)})`;
			if (!missing.includes(entry)) missing.push(entry);
		}
		// 设置项：SettingRow / SettingSwitchRow / SettingTextarea 的 anchor prop
		for (const match of text.matchAll(/anchor="([a-z0-9-]+)"/g)) {
			const slug = match[1];
			if (registeredSlugs.has(slug)) continue;
			const entry = `anchor="${slug}" (${path.basename(file)})`;
			if (!missing.includes(entry)) missing.push(entry);
		}
	}
	assert.deepEqual(missing, [], `以下锚点已渲染在设置页里但**没登记进 command palette 索引**，用户搜不到（要跳转就补 settingsFieldAnchors.ts，标题与 tab 同名的加进 SECTION_ID_EXEMPTIONS）：\n  ${missing.join("\n  ")}`);
});

test("锚点标题的 i18n key 在中英两份文案里都存在", () => {
	const anchors = loadAnchors();
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const missing = [];
	for (const anchor of anchors) {
		const marker = `"${anchor.labelKey}":`;
		if (!zh.includes(marker)) missing.push(`zh-CN 缺 ${anchor.labelKey} (${anchor.slug})`);
		if (!en.includes(marker)) missing.push(`en-US 缺 ${anchor.labelKey} (${anchor.slug})`);
	}
	assert.deepEqual(missing, [], `\n  ${missing.join("\n  ")}`);
});
