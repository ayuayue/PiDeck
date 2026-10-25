/**
 * 设置页模型选择器收藏态（hooks/useFavoriteModels）的行为测试。
 *
 * 收藏是 settings.favoriteModels（"provider/modelId"，append 顺序即 Ctrl+M 循环顺序）：
 * 这里锁定三件事——打开选择器前从磁盘重读、切换当场落盘、失败回滚不留半截星标；
 * 另外连点不同模型必须基于最新值累加（闭包里的旧数组会丢掉前一次收藏）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function favoritesHarness({ favorites = [], failUpdate = false } = {}) {
	const host = quickMessageHookHost();
	const patches = [];
	const notices = [];
	let disk = favorites;
	let updateError = failUpdate;
	const api = {
		settings: {
			get: async () => ({ favoriteModels: disk }),
			update: async (patch) => {
				patches.push(plain(patch));
				if (updateError) throw new Error("disk full");
				disk = patch.favoriteModels;
				return patch;
			},
		},
	};
	const { useFavoriteModels } = loadTsCommonJs("src/renderer/src/hooks/useFavoriteModels.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi: api },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"../utils/preferenceCycle": { modelKey: (provider, id) => `${provider}/${id}` },
		},
	});
	const render = () => host.render(() => useFavoriteModels());
	return {
		render,
		patches,
		notices,
		setDisk: (next) => {
			disk = next;
		},
		setFailUpdate: (next) => {
			updateError = next;
		},
	};
}

test("打开选择器前 refresh 从磁盘重读收藏", async () => {
	const h = favoritesHarness({ favorites: ["pi-a/a"] });
	const api = h.render();
	await api.refreshFavoriteModels();
	assert.deepEqual(plain(h.render().favoriteModels), ["pi-a/a"]);

	h.setDisk(["pi-a/a", "pi-b/b"]);
	await h.render().refreshFavoriteModels();
	assert.deepEqual(plain(h.render().favoriteModels), ["pi-a/a", "pi-b/b"], "另一个选择器/会话改了收藏后要能看到");
});

test("切换收藏当场落盘，连点不同模型基于最新值累加", async () => {
	const h = favoritesHarness();
	const api = h.render();
	api.toggleFavorite("pi-a", "a");
	api.toggleFavorite("pi-b", "b");
	await flush();
	assert.deepEqual(h.patches, [{ favoriteModels: ["pi-a/a"] }, { favoriteModels: ["pi-a/a", "pi-b/b"] }]);
	assert.deepEqual(plain(h.render().favoriteModels), ["pi-a/a", "pi-b/b"]);

	h.render().toggleFavorite("pi-a", "a");
	await flush();
	assert.deepEqual(h.patches.at(-1), { favoriteModels: ["pi-b/b"] }, "再次点击同一模型是取消收藏");
});

test("写入失败回滚星标并提示错误信息", async () => {
	const h = favoritesHarness({ favorites: ["pi-a/a"], failUpdate: true });
	const api = h.render();
	await api.refreshFavoriteModels();
	h.render().toggleFavorite("pi-a", "a");
	await flush();
	assert.deepEqual(plain(h.render().favoriteModels), ["pi-a/a"], "失败不能留下半截收藏态");
	assert.deepEqual(h.notices, ["disk full"]);
});

test("读设置失败时沿用当前收藏，不把星标清空", async () => {
	const host = quickMessageHookHost();
	const { useFavoriteModels } = loadTsCommonJs("src/renderer/src/hooks/useFavoriteModels.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": {
				desktopApi: {
					settings: {
						get: async () => {
							throw new Error("ipc closed");
						},
						update: async (patch) => patch,
					},
				},
			},
			"../utils/notice": { showNotice: () => undefined },
			"../utils/preferenceCycle": { modelKey: (provider, id) => `${provider}/${id}` },
		},
	});
	host.render(() => useFavoriteModels());
	await host.render(() => useFavoriteModels()).refreshFavoriteModels();
	assert.deepEqual(plain(host.render(() => useFavoriteModels()).favoriteModels), []);
});
