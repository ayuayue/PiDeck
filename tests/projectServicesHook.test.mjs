/**
 * useProjectServices 的可选项目重载（Phase B 为 App 接入本地文件树）。
 *
 * App 的 activeProject 可能不存在；hook 必须在不伪造服务、不建立 runtime 的前提下返回 null，
 * 有项目时才创建/启动 runtime，并在卸载时释放。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const LOCAL = { id: "p1", name: "p1", lastOpenedAt: 0, path: "C:/p1", environment: "windows" };
const REMOTE = { id: "p2", name: "p2", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p2" } };

function harness(snapshot) {
	const host = quickMessageHookHost();
	const created = [];
	let started = 0;
	let disposed = 0;
	const { useProjectServices } = loadTsCommonJs("src/renderer/src/hooks/useProjectServices.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi: {} },
			"../services/projectServiceRuntime": {
				createProjectServiceRuntime: (project) => {
					created.push(project);
					return {
						start: () => {
							started += 1;
							return () => {
								disposed += 1;
							};
						},
						getSnapshot: () => snapshot,
						subscribe: () => () => undefined,
					};
				},
			},
		},
	});
	let value;
	const render = (project) => (value = host.render(() => useProjectServices(project)));
	return { host, render, value: () => value, created, started: () => started, disposed: () => disposed };
}

test("activeProject 缺席：不创建 runtime、不启动、不订阅，返回 null", () => {
	const h = harness({ projectId: "none" });
	h.render(undefined);
	assert.equal(h.value(), null);
	assert.equal(h.created.length, 0);
	assert.equal(h.started(), 0);
	h.host.unmount();
});

test("有项目：返回 runtime 快照并在卸载时释放", () => {
	const snapshot = { projectId: "p1", kind: "local" };
	const h = harness(snapshot);
	h.render(LOCAL);
	assert.equal(h.value(), snapshot);
	assert.equal(h.created.length, 1);
	assert.equal(h.created[0].id, "p1");
	assert.equal(h.started(), 1);
	h.host.unmount();
	assert.equal(h.disposed(), 1);
});

test("远端项目：runtime 仍按 project 身份创建（hostId/remotePath 作为 memo 依赖）", () => {
	const snapshot = { projectId: "p2", kind: "remote" };
	const h = harness(snapshot);
	h.render(REMOTE);
	assert.equal(h.value(), snapshot);
	assert.equal(h.created[0].locator.hostId, "h1");
	h.host.unmount();
});
