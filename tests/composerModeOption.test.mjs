// 模式选择器可见性纯函数测试（useComposerModeAvailability 抽出的 computeVisibleModes；
// 选择器已常驻底栏，2026-10 外移自「+」菜单）：生图不是可切模式（imagegen 是独立后端）；
// imagegen 会话或 legacy 含生图消息的 pi 会话（isImageGen=true）选择器为空，走专用生图底栏；
// plan/goal 受扩展开关控制。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadHookModule() {
	const source = readFileSync("src/renderer/src/hooks/useComposerModeAvailability.ts", "utf8");
	// 只对纯函数求值：hook 的 React/desktopApi 是外部依赖，mock 掉副作用路径，
	// 仅转译后取 computeVisibleModes 导出做断言（行为不依赖真实扩展列表）。
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id.includes("react")) return { useCallback: () => {}, useEffect: () => {}, useState: () => [] };
			if (id.includes("desktopApi")) return {};
			throw new Error(`unexpected require: ${id}`);
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "useComposerModeAvailability.ts" });
	return sandbox.exports;
}

const { computeVisibleModes } = loadHookModule();

// 底栏触发器 ghost 外观（2026-10 用户反馈）：shadcn SelectTrigger 基底自带 bg-bg-input，
// 底栏按钮一旦不显式 bg-transparent 就会被染成实心块，与同排「+」等 ghost 按钮不齐；
// 模式选择器还自带一个 chevron（图标+箭头并排 → 图标偏左、视觉多一个小按钮）。
const COMPOSER_TRIGGER_FILES = ["src/renderer/src/components/session/ComposerComponents.tsx", "src/renderer/src/components/session/ComposerImageGenOptions.tsx"];

function composerSelectTriggerClassNames() {
	const result = [];
	for (const file of COMPOSER_TRIGGER_FILES) {
		const source = readFileSync(file, "utf8");
		// 空白容忍：[^>]* 跨行匹配属性，避免行序/缩进变化让断言失效。
		for (const match of source.matchAll(/<SelectTrigger\b[^>]*className="([^"]*)"/g)) {
			if (match[1].includes("composer-bar-btn")) result.push([file, match[1]]);
		}
	}
	return result;
}

test("底栏 SelectTrigger 保持 ghost 透明底（不被 shadcn 基底的实心底染色）", () => {
	const triggers = composerSelectTriggerClassNames();
	assert.ok(triggers.length >= 3, `应扫到底栏触发器（mode/backend/imagegen），实际 ${triggers.length}`);
	for (const [file, className] of triggers) {
		assert.ok(className.includes("bg-transparent"), `${file} 的底栏 SelectTrigger 必须显式 bg-transparent：${className}`);
	}
});

test("模式入口已收回「+」菜单：底栏不再有模式 Select，菜单项带稳定定位属性", () => {
	const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	// 2026-10 产品决定：常驻底栏下拉换成「+」菜单分组 + 特殊模式 chip（见 ComposerModeChip），
	// 普通模式不作为菜单项；底栏保留的 Select 只有后端/ACP 配置，不再有 mode。
	assert.doesNotMatch(composer, /composer-bar-btn\s+mode/, "底栏模式 Select 触发器已移除");
	assert.match(composer, /app\.composerAddMode/, "「+」菜单模式分组标题复用 composerAddMode");
	assert.match(composer, /data-picker-value=\{mode\}/, "模式项带 data-picker-value 供 e2e 定位");
	assert.match(composer, /data-testid="composer-add-menu"/, "「+」触发器带稳定 testid（e2e 先点这里再选模式）");
});

test("pi 全扩展可用：菜单只有 普通/目标/规划，不再出现生图", () => {
	const result = [...computeVisibleModes({ isImageGen: false, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, ["normal", "goal", "plan"]);
});

test("pi 关闭 plan/goal 扩展：对应模式从菜单消失，仅保留普通", () => {
	const result = [...computeVisibleModes({ isImageGen: false, planModeAvailable: false, goalModeAvailable: false })];
	assert.deepEqual(result, ["normal"]);
});

test("imagegen 会话（backend=imagegen）：模式菜单为空，不走 LLM 模式", () => {
	const result = [...computeVisibleModes({ isImageGen: true, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, []);
});

test("legacy 含生图消息的 pi 会话（isImageGen=true）：同样锁定为空菜单（防误切回 LLM）", () => {
	const result = [...computeVisibleModes({ isImageGen: true, planModeAvailable: true, goalModeAvailable: true })];
	assert.deepEqual(result, []);
});

// 2026-10 收尾：模式入口不再挂「输入框功能显示」开关（用户反馈该行多余）。
// 契约：入口只受可用性控制；atom / 设置行 / 可关清单 / 文案键全部移除；旧数据由 SettingsStore 清理。
test("模式入口不挂显示开关：没有隐藏 gating，也没有残留 atom 与设置行", () => {
	const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	// 入口条件：至少一个可切换的特殊模式（plan/goal）；只剩 normal 时整个分组不渲染
	// （ACP 会话无 pi 扩展 / plan+goal 都被关，ACP 模式等价物走 configOptions）
	assert.match(composer, /const specialModes = visibleModes\.filter\(\(mode\) => mode === "plan" \|\| mode === "goal"\)/);
	assert.match(composer, /modeSectionVisible = specialModes\.length > 0;/, "入口只受可用性控制");
	assert.doesNotMatch(composer, /composerModesHiddenAtom|modesHidden/, "渲染层不再读取已删除的隐藏开关");
	assert.doesNotMatch(composer, /modeSwitcherVisible/, "旧常驻下拉条件已删除");
	// chip 的渲染条件只排除「点了也退不出去」的两种后端
	assert.match(composer, /const chipMode: "plan" \| "goal" \| null/);

	const atoms = readFileSync("src/renderer/src/atoms/app-ui-atoms.ts", "utf8");
	assert.doesNotMatch(atoms, /composerModesHiddenAtom/, "atom 已删除");
	const composerFeatures = readFileSync("src/renderer/src/components/app/settings/ComposerFeaturesSection.tsx", "utf8");
	assert.doesNotMatch(composerFeatures, /composerModes/, "设置页不再列出模式开关");
	const sharedFeatures = readFileSync("src/shared/composerFeatures.ts", "utf8");
	assert.doesNotMatch(sharedFeatures, /composerModes/, "可关清单移除 composerModes");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	assert.doesNotMatch(zh, /settings\.composer\.modes/, "设置文案键一并删除");
	// 旧 settings.json 里的残留 id（hiddenModules / hiddenComposerFeatures 两处）由迁移清理
	const store = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	assert.match(store, /migrateRemovedComposerModesToggle\(\)/, "存在旧 id 清理迁移");
	const modules = readFileSync("src/renderer/src/components/app/settings/ModuleVisibilitySection.tsx", "utf8");
	assert.doesNotMatch(modules, /composerModes/, "功能模块设置页也不得出现该开关");
});

// m01733：ACP 会话的模式选择器依赖 plan/goal 可用性回落到只剩 normal 才隐藏；
// 但初始 useState(true) + 仅在下拉打开时刷新，会让 ACP 会话首帧就渲染出选择器。
// 契约：挂载/后端切换（refreshAvailability 身份变化）时必须同步一次可用性。
test("模式可用性在挂载与后端切换时同步（ACP 会话首帧不得显示模式选择器，m01733）", () => {
	const hook = readFileSync("src/renderer/src/hooks/useComposerModeAvailability.ts", "utf8");
	assert.match(hook, /useEffect\(\(\) => \{\s*void refreshAvailability\(\);\s*\}, \[refreshAvailability\]\)/, "需存在挂载/身份变化时刷新可用性的 effect");
	// ACP 分支在 refreshAvailability 内同步置 false（不查 pi 扩展列表）
	assert.match(hook, /if \(isAcp\) \{\s*setPlanModeAvailable\(false\);\s*setGoalModeAvailable\(false\);\s*return;\s*\}/);
});
