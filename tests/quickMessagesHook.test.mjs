import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 快照 atom 与 IPC 替身保持独立，断言 refresh 的返回值而非 React 重渲染时机。 */
function hookHarness() {
	const host = quickMessageHookHost();
	let snapshot = { items: ["个人"], defaults: ["旧内置"], defaultsAvailable: true, filePath: "quick-messages.json", seeded: false };
	let response = { ...snapshot, defaults: ["最新内置"] };
	const setSnapshot = (next) => {
		snapshot = next;
	};
	const { useQuickMessages } = loadTsCommonJs("src/renderer/src/hooks/useQuickMessages.ts", {
		stubs: {
			react: host.react,
			jotai: { useAtom: () => [snapshot, setSnapshot] },
			"../atoms/app-ui-atoms": { quickMessagesSnapshotAtom: {} },
			"../desktopApi": {
				desktopApi: {
					quickMessages: {
						get: async () => {
							if (response instanceof Error) throw response;
							return response;
						},
					},
				},
			},
		},
	});
	return {
		render: () => host.render(useQuickMessages),
		setResponse: (next) => {
			response = next;
		},
	};
}

test("refresh 返回本次最新快照，合并操作不必等待 React 闭包更新", async () => {
	const h = hookHarness();
	const result = await h.render().refresh();
	assert.ok(result);
	assert.deepEqual(result.defaults, ["最新内置"]);
	assert.deepEqual(h.render().defaults, ["最新内置"]);
});

test("refresh 失败返回 null 并暴露错误，不伪装成功返回缓存清单", async () => {
	const h = hookHarness();
	await h.render().refresh();
	h.setResponse(new Error("读取失败"));
	const result = await h.render().refresh();
	assert.equal(result, null);
	assert.match(h.render().error, /读取失败/);
	assert.deepEqual(h.render().defaults, ["最新内置"]);
});
