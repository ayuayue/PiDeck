/**
 * 「跟随会话模型 / 指定固定模型」共享设置行的行为测试。
 *
 * 提示词增强与输入预测共用这套行，只有 settings 字段与 atom 写穿目标不同。这里锁定
 * 两件事：保存一定要落到各自的 settings 字段（不能串味），以及失败回滚/单飞/磁盘返回值
 * 语义——都是「界面选了、下一轮却用旧模型」这类线上问题的根因。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 只替换控件与 IPC，保留组件的真实状态机与保存逻辑。 */
function rowsHarness({ initial = {}, settingKey = "enhanceModel" } = {}) {
	const host = quickMessageHookHost();
	const notices = [];
	const patches = [];
	const savedValues = [];
	// 收藏态由 hooks/useFavoriteModels 自己负责（有独立单测），这里只记组件对它的调用。
	const favoriteCalls = { refreshes: 0, toggles: [], favorites: [] };
	let settings = { ...initial };
	let update = async (patch) => (settings = { ...settings, ...patch });
	const control = (name) => ({ [name]: () => null });
	const { FixedModelSettingRows } = loadTsCommonJs("src/renderer/src/components/app/settings/FixedModelSettingRows.tsx", {
		stubs: {
			react: { ...host.react, useId: () => "model-row" },
			"../../../i18n": { t: (key) => key },
			"../../../utils/notice": { showNotice: (message) => notices.push(message) },
			"../../../hooks/useFavoriteModels": {
				useFavoriteModels: () => ({
					favoriteModels: favoriteCalls.favorites,
					refreshFavoriteModels: async () => {
						favoriteCalls.refreshes += 1;
					},
					toggleFavorite: (provider, modelId) => favoriteCalls.toggles.push([provider, modelId]),
				}),
			},
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
			"./SettingRows": { ...control("SettingRow"), ...control("SettingsModelPickerControl") },
		},
	});
	const render = () =>
		host.render(() =>
			FixedModelSettingRows({
				settingKey,
				onSaved: (value) => savedValues.push(plain(value)),
				modeTitle: "mode-title",
				modeDesc: "mode-desc",
				savedNotice: "saved-notice",
				failedNotice: "failed-notice",
			}),
		);
	const nodes = (element) => (Array.isArray(element) ? element.flatMap(nodes) : element?.props ? [element, ...nodes(element.props.children)] : []);
	const find = (predicate) => nodes(render()).find((node) => predicate(node.props))?.props;
	const modeSelect = () => find((props) => typeof props.onValueChange === "function");
	return {
		render,
		find,
		modeSelect,
		patches,
		notices,
		savedValues,
		favoriteCalls,
		setFavorites: (next) => {
			favoriteCalls.favorites = next;
		},
		setUpdate: (fn) => {
			update = fn;
		},
	};
}

test("挂载后以磁盘设置为准：没有固定模型时选中跟随会话模型，也不渲染固定模型行", async () => {
	const h = rowsHarness();
	assert.equal(h.modeSelect().value, "session");
	assert.equal(h.modeSelect().disabled, true, "水合完成前不能保存");
	await flush();
	assert.equal(h.modeSelect().disabled, false);
	assert.equal(
		h.find((props) => typeof props.onOpen === "function"),
		undefined,
	);
});

test("已有固定模型时展示 provider/modelId，选中新模型只写 enhanceModel 并采用磁盘返回值", async () => {
	const h = rowsHarness({ initial: { enhanceModel: { provider: "pi-old", modelId: "old" } } });
	h.render();
	await flush();
	assert.equal(h.modeSelect().value, "custom");
	assert.equal(h.find((props) => typeof props.onOpen === "function").value, "pi-old/old");

	h.find((props) => typeof props.onOpen === "function").onOpen();
	await flush();
	const saved = { provider: "pi-new", modelId: "normalized" };
	h.setUpdate(async () => ({ enhanceModel: saved }));
	h.find((props) => typeof props.onPick === "function").onPick({ provider: "pi-new", id: "new" });
	await flush();

	assert.deepEqual(h.patches, [{ enhanceModel: { provider: "pi-new", modelId: "new" } }]);
	assert.deepEqual(h.savedValues, [saved]);
	assert.equal(h.find((props) => typeof props.onOpen === "function").value, "pi-new/normalized");
	assert.deepEqual(h.notices, ["saved-notice"]);
});

test("输入预测走独立字段：只写 promptSuggestionModel，恢复跟随会话写 null", async () => {
	const h = rowsHarness({ initial: { promptSuggestionModel: { provider: "pi-old", modelId: "old" } }, settingKey: "promptSuggestionModel" });
	h.render();
	await flush();
	h.find((props) => typeof props.onOpen === "function").onOpen();
	await flush();
	const saved = { provider: "pi-suggest", modelId: "suggest" };
	h.setUpdate(async () => ({ promptSuggestionModel: saved }));
	h.find((props) => typeof props.onPick === "function").onPick({ provider: "pi-suggest", id: "suggest" });
	await flush();
	assert.deepEqual(h.patches, [{ promptSuggestionModel: { provider: "pi-suggest", modelId: "suggest" } }]);
	assert.deepEqual(h.savedValues, [saved]);
	assert.equal("enhanceModel" in h.patches[0], false, "预测模型不得改写提示词增强的字段");

	h.setUpdate(async (patch) => patch);
	h.modeSelect().onValueChange("session");
	await flush();
	assert.deepEqual(h.patches.at(-1), { promptSuggestionModel: null });
	assert.deepEqual(h.savedValues.at(-1), null);
	assert.equal(h.modeSelect().value, "session");
});

test("保存失败回滚到原固定模型并提示，不把半截状态写穿", async () => {
	const original = { provider: "pi-old", modelId: "old" };
	const h = rowsHarness({ initial: { enhanceModel: original } });
	h.render();
	await flush();
	h.setUpdate(async () => {
		throw new Error("disk full");
	});
	h.modeSelect().onValueChange("session");
	await flush();
	assert.equal(h.modeSelect().value, "custom");
	assert.equal(h.find((props) => typeof props.onOpen === "function").value, "pi-old/old");
	assert.deepEqual(h.savedValues, []);
	assert.deepEqual(h.notices, ["failed-notice"]);
});

test("同一帧重复操作只能发一次保存，避免旧响应覆盖新配置", async () => {
	const h = rowsHarness({ initial: { enhanceModel: { provider: "pi-old", modelId: "old" } } });
	h.render();
	await flush();
	let finish;
	h.setUpdate(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const select = h.modeSelect();
	select.onValueChange("session");
	select.onValueChange("custom");
	assert.equal(h.patches.length, 1);
	finish({ enhanceModel: null });
	await flush();
	assert.deepEqual(h.savedValues, [null]);
	assert.equal(h.modeSelect().value, "session");
});

test("磁盘返回值缺字段时归为跟随会话模型，不保留旧值", async () => {
	const h = rowsHarness({ initial: { enhanceModel: { provider: "pi-old", modelId: "old" } } });
	h.render();
	await flush();
	h.setUpdate(async () => ({}));
	h.modeSelect().onValueChange("session");
	await flush();
	assert.equal(h.modeSelect().value, "session");
	assert.deepEqual(h.savedValues, [null]);
	assert.equal(
		h.find((props) => typeof props.onOpen === "function"),
		undefined,
	);
});

/** 打开模型选择器（模式下拉选「指定固定模型」），返回取 ModelPicker props 的 getter。 */
async function openPicker(h) {
	h.modeSelect().onValueChange("custom");
	await flush();
	return () => h.find((props) => typeof props.onPick === "function");
}

test("打开选择器时刷新并透传收藏，切换收藏交给 useFavoriteModels", async () => {
	const h = rowsHarness();
	h.setFavorites(["pi-a/a"]);
	h.render();
	await flush();
	const picker = await openPicker(h);
	assert.equal(h.favoriteCalls.refreshes, 1, "打开前要以磁盘为准重读收藏");
	assert.deepEqual(plain(picker().favoriteModels), ["pi-a/a"], "收藏要显示在设置页的模型选择器里");

	picker().onToggleFavorite("pi-a", "a");
	assert.deepEqual(h.favoriteCalls.toggles, [["pi-a", "a"]], "星标点击要真正走到收藏开关，不能是空实现");
});

test("每次打开都重读收藏，两个设置区块不会各缓存一份", async () => {
	const h = rowsHarness();
	h.render();
	await flush();
	const picker = await openPicker(h);
	assert.equal(h.favoriteCalls.refreshes, 1);
	picker().onClose();
	await openPicker(h);
	assert.equal(h.favoriteCalls.refreshes, 2, "再次打开要重新读磁盘（另一个选择器可能刚改过）");
});
