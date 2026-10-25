/**
 * 提示词增强设置区（设置 → 通用）的保存语义测试。
 *
 * 模型策略行已抽到 FixedModelSettingRows（见 fixedModelSettingRows.test.mjs），这里只锁定
 * 本 section 独有的「增强时携带会话上下文」开关：默认关闭、保存成功才写穿输入框状态、
 * 失败不启用、同一帧只发一次请求。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 保留设置组件的真实状态与保存逻辑，只替换控件和 IPC；不读写用户设置。 */
function settingsHarness(initial = {}) {
	const host = quickMessageHookHost();
	const modelAtom = {};
	const contextAtom = {};
	const values = new Map([
		[modelAtom, initial.enhanceModel ?? null],
		[contextAtom, initial.enhanceIncludeContext === true],
	]);
	const notices = [];
	const patches = [];
	let settings = { ...initial };
	let update = async (patch) => (settings = { ...settings, ...patch });
	const control = (name) => ({ [name]: () => null });
	const { PromptEnhanceSettingsSection } = loadTsCommonJs("src/renderer/src/components/app/settings/PromptEnhanceSettingsSection.tsx", {
		stubs: {
			react: { ...host.react, useId: () => "context-switch", useMemo: (compute) => compute() },
			jotai: { useSetAtom: (atom) => (value) => values.set(atom, value) },
			"../../../atoms/composer-atoms": { enhanceModelAtom: modelAtom, enhanceIncludeContextAtom: contextAtom },
			"../../../i18n": { t: (key) => key },
			"../../../utils/notice": { showNotice: (message) => notices.push(message) },
			"../../../desktopApi": {
				desktopApi: {
					settings: {
						get: async () => settings,
						update: async (patch) => {
							patches.push(plain(patch));
							return update(patch);
						},
					},
					projects: { listModelsReport: async () => ({ models: [] }) },
				},
			},
			"../../session/ComposerComponents": control("ModelPicker"),
			"../../ui-shadcn/select": Object.assign({}, ...["Select", "SelectContent", "SelectGroup", "SelectItem", "SelectTrigger", "SelectValue"].map(control)),
			"../../ui-shadcn/switch": control("Switch"),
			"./FixedModelSettingRows": control("FixedModelSettingRows"),
			"./SettingsStorageTab": control("SettingsSection"),
			"./SettingRows": { ...control("SettingRow"), ...control("SettingsModelPickerControl") },
		},
	});
	const render = () => host.render(PromptEnhanceSettingsSection);
	const nodes = (element) => (Array.isArray(element) ? element.flatMap(nodes) : element?.props ? [element, ...nodes(element.props.children)] : []);
	const find = (predicate) => nodes(render()).find((node) => predicate(node.props))?.props;
	return {
		render,
		find,
		patches,
		notices,
		context: () => values.get(contextAtom),
		setUpdate: (fn) => {
			update = fn;
		},
	};
}

test("模型策略行交给共享组件，且明确指向增强模型字段", () => {
	const h = settingsHarness();
	const rows = h.find((props) => "settingKey" in props);
	assert.equal(rows.settingKey, "enhanceModel");
	assert.equal(typeof rows.onSaved, "function");
});

test("旧设置上下文默认关闭，开关保存成功才同步到输入框，保存提示无需重开会话", async () => {
	const h = settingsHarness();
	assert.equal(h.find((props) => props.id === "context-switch").disabled, true);
	await flush();
	const toggle = h.find((props) => props.id === "context-switch");
	assert.equal(toggle.checked, false);
	assert.equal(h.context(), false);
	let finish;
	h.setUpdate(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	toggle.onCheckedChange(true);
	assert.equal(h.context(), false, "保存未确认前不得携带正文");
	assert.equal(h.find((props) => props.id === "context-switch").disabled, true);
	finish({ enhanceIncludeContext: true });
	await flush();
	assert.equal(h.context(), true);
	assert.equal(h.find((props) => props.id === "context-switch").checked, true);
	assert.deepEqual(h.patches, [{ enhanceIncludeContext: true }]);
	assert.deepEqual(h.notices, ["settings.enhance.saved"]);
});

test("保存失败不启用上下文，并保留可读提示", async () => {
	const h = settingsHarness();
	h.render();
	await flush();
	h.setUpdate(async () => {
		throw new Error("disk full");
	});
	h.find((props) => props.id === "context-switch").onCheckedChange(true);
	await flush();
	assert.equal(h.context(), false);
	assert.equal(h.find((props) => props.id === "context-switch").checked, false);
	assert.deepEqual(h.notices, ["settings.enhance.saveFailed"]);
});

test("同一帧重复操作只能发一次保存，避免旧响应覆盖新配置", async () => {
	const h = settingsHarness();
	h.render();
	await flush();
	const toggle = h.find((props) => props.id === "context-switch");
	let finish;
	h.setUpdate(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	toggle.onCheckedChange(true);
	toggle.onCheckedChange(false);
	assert.deepEqual(h.patches, [{ enhanceIncludeContext: true }]);
	finish({ enhanceIncludeContext: true });
	await flush();
	assert.equal(h.context(), true);
});
