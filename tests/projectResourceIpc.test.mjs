import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const entry = readFileSync("src/main/index.ts", "utf8");
const projectsIpc = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
const projectResourceIpc = readFileSync("src/main/ipc/projectResourceIpc.ts", "utf8");

test("project resource IPC is registered through one-way dependencies", () => {
	assert.match(projectsIpc, /registerProjectResourceIpc\(\{[\s\S]*appLogger,[\s\S]*projectResourceManager,[\s\S]*\}\)/);
	assert.doesNotMatch(projectsIpc, /ipcChannels\.projectResources/);
	assert.doesNotMatch(projectResourceIpc, /from\s+["']\.\.\/index["']/);
});

test("project resource IPC retains all handlers and manager-owned path checks", () => {
	for (const channel of ["projectResourcesList", "projectResourcesOpenDirectory", "projectResourcesCreateSkill", "projectResourcesDeleteSkill", "projectResourcesDeleteExtension", "projectResourcesToggleSkill", "projectResourcesToggleExtension", "projectResourcesRenameSkill"]) {
		assert.match(projectResourceIpc, new RegExp(`ipcChannels\\.${channel}`));
	}
	assert.match(projectResourceIpc, /projectResourceManager\.ensureResourceDirectory\(projectId\.trim\(\), kind\)/);
	assert.match(projectResourceIpc, /projectResourceManager\.deleteSkill\(projectId\.trim\(\), skillPath\)/);
	assert.match(projectResourceIpc, /projectResourceManager\.deleteExtension\(projectId\.trim\(\), extensionPath\)/);
	assert.match(projectResourceIpc, /rechecks project ownership/);
});

test("project resource IPC rejects malformed renderer input before calling the manager", async () => {
	const handlers = new Map();
	let managerCalls = 0;
	const failIfCalled = () => {
		managerCalls += 1;
		throw new Error("manager should not be called");
	};
	const electron = {
		ipcMain: {
			handle(channel, handler) {
				handlers.set(channel, handler);
			},
		},
		shell: { openPath: failIfCalled },
	};
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const { registerProjectResourceIpc } = loadTsCommonJs("src/main/ipc/projectResourceIpc.ts", { stubs: { electron } });
	registerProjectResourceIpc({
		appLogger: { info: async () => {} },
		projectResourceManager: {
			list: failIfCalled,
			ensureResourceDirectory: failIfCalled,
			deleteSkill: failIfCalled,
			deleteExtension: failIfCalled,
			toggleSkill: failIfCalled,
			toggleExtension: failIfCalled,
			toggleInheritedResource: failIfCalled,
			renameSkill: failIfCalled,
			createSkill: failIfCalled,
			discovery: failIfCalled,
		},
	});

	await assert.rejects(handlers.get(ipcChannels.projectResourcesList)({}, 42), /Invalid project id/);
	await assert.rejects(handlers.get(ipcChannels.projectResourcesDiscovery)({}, 42), /Invalid project id/);
	await assert.rejects(handlers.get(ipcChannels.projectResourcesOpenDirectory)({}, "p", "outside"), /Invalid project resource directory input/);
	await assert.rejects(handlers.get(ipcChannels.projectResourcesCreateSkill)({}, { projectId: "p", name: "x" }), /Invalid project skill input/);
	await assert.rejects(handlers.get(ipcChannels.projectResourcesCreateSkill)({}, { projectId: "p", name: "x", description: "desc", locationId: "pi-global" }), /Invalid project skill input/);
	await assert.rejects(handlers.get(ipcChannels.projectResourcesToggleSkill)({}, "p", "path", "yes"), /Invalid project skill toggle input/);
	await assert.rejects(handlers.get(ipcChannels.projectResourcesToggleInherited)({}, { projectId: "p", kind: "skill", key: "", enabled: false }), /Invalid project inherited resource toggle input/);
	assert.equal(managerCalls, 0);
});
