import { test, expect } from "./fixtures";

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
type RemoteAuthProvider = { provider: string; type: "api_key" | "oauth" | "unsupported"; configured: boolean };
type RemoteResourceFixture = {
	home: string;
	files: Array<{ root: "skills" | "agents-skills" | "prompts" | "extensions"; path: string; version: string; content: string }>;
	settings: Record<string, unknown>;
	settingsVersion: string;
	discovery: {
		projectResourcesAllowed: boolean;
		overrides: { disabledGlobalExtensions: string[]; disabledGlobalSkills: string[]; disabledGlobalPrompts: string[] };
		skills: Array<{ id: string; name: string; path: string; dir: string; sourceId: string; sourceLabel: string; description: string; enabled: boolean; managed: boolean }>;
		prompts: Array<{ name: string; path: string; sourceId: string; sourceLabel: string; description: string; enabled: boolean; managed: boolean }>;
		extensions: Array<{ source: string; path: string; sourceId: string; sourceLabel: string; physicalScope: "user" | "project"; enabled: boolean; managed: boolean }>;
	};
};
type RemoteFixtureState = {
	documents: Record<string, Record<string, Record<string, unknown>>>;
	versions: Record<string, number>;
	writes: Array<{ hostId: string; file: string; data: Record<string, unknown> }>;
	auth: Record<string, RemoteAuthProvider[]>;
	authVersions: Record<string, number>;
	authWrites: Array<{ hostId: string; expectedVersion: string; entries: Array<{ provider: string; apiKey?: string; retain?: true; source?: string }> }>;
	resources: Record<string, RemoteResourceFixture>;
	resourceRevision: number;
	resourceCalls: Array<{ hostId: string; input: Record<string, unknown> }>;
	probes: Array<{ hostId: string; force: boolean }>;
	failNext: boolean;
};

test.use({ seedPiAgent: { models: { providers: { localOnly: { baseUrl: "https://local.invalid", api: "openai-completions", models: [{ id: "local-model" }] } } }, settings: {}, auth: {} } });

test("SSH 共享表单、模型目录、源文件保存及主机隔离", async ({ app, window }, testInfo) => {
	test.setTimeout(150_000);
	const errors: string[] = [];
	window.on("pageerror", (error) => errors.push(error.message));
	// Replace only SSH IPC in the isolated Electron main process. No SSH socket or real profile is used.
	await app.evaluate(
		({ ipcMain }, { host, other }) => {
			const resourceVersion = (value: number) => value.toString(16).padStart(64, "0");
			const resources = Object.fromEntries(
				[host, other].map((id, index) => [
					id,
					{
						home: `/home/ssh-fixture-${index + 1}`,
						files: [
							{
								root: "skills",
								path: "remote-skill/SKILL.md",
								version: resourceVersion(1),
								content: '---\nname: remote-skill\ndescription: "Editable remote skill"\n---\n\nOriginal skill body\n',
							},
							{
								root: "prompts",
								path: "remote-prompt.md",
								version: resourceVersion(2),
								content: '---\ndescription: "Editable remote prompt"\n---\n\nOriginal prompt body\n',
							},
							{ root: "extensions", path: "remote-extension.ts", version: resourceVersion(3), content: "export const original = true;\n" },
						],
						settings: {},
						settingsVersion: resourceVersion(4),
						discovery: {
							projectResourcesAllowed: false,
							overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] },
							skills: [],
							prompts: [],
							extensions: [],
						},
					},
				]),
			) as Record<string, RemoteResourceFixture>;
			const state: RemoteFixtureState = {
				documents: Object.fromEntries(
					[host, other].map((id, index) => [
						id,
						{
							"models.json": { providers: { [`remote${index + 1}`]: { baseUrl: `https://remote${index + 1}.invalid/v1`, api: "openai-completions", apiKey: "configured", models: [{ id: "remote-model", contextWindow: 32000, maxTokens: 4096 }] } }, unknownTop: { keep: true } },
							"settings.json": { defaultProvider: `remote${index + 1}`, defaultModel: "remote-model", compaction: { enabled: true }, retry: { maxRetries: 3 } },
							"trust.json": { "/srv/remote": true },
							"mcp.json": { mcpServers: { docs: { url: "https://remote.invalid/mcp" } } },
						},
					]),
				),
				versions: {},
				writes: [],
				auth: Object.fromEntries([host, other].map((id, index) => [id, [{ provider: `remote${index + 1}`, type: "api_key", configured: true }]])),
				authVersions: {},
				authWrites: [],
				resources,
				resourceRevision: 10,
				resourceCalls: [],
				probes: [],
				failNext: false,
			};
			Object.assign(globalThis, { remoteConfigFixture: state });
			const version = (id: string, file: string) => (state.versions[id + file] ?? 1).toString(16).padStart(64, "0");
			const authVersion = (id: string) => (state.authVersions[id] ?? 1).toString(16).padStart(64, "0");
			const authSnapshot = (id: string) => ({ kind: "remote-auth", hostId: id, version: authVersion(id), sha256: authVersion(id), providers: structuredClone(state.auth[id]) });
			const snapshot = (id: string, file: string) => {
				const data = structuredClone(state.documents[id][file]);
				const secrets: Array<{ path: string; status: "configured" }> = [];
				if (file === "models.json") for (const name of Object.keys(Reflect.get(data, "providers"))) secrets.push({ path: `providers.${name}.apiKey`, status: "configured" });
				return { kind: "remote", hostId: id, file: file.replace(".json", ""), version: version(id, file), sha256: version(id, file), data, secrets };
			};
			for (const channel of ["remote:hosts-list", "remote:connect", "config:get-raw", "config:save-raw", "config:replace-remote-auth", "remote:pi-resources", "remote:pi-models"]) ipcMain.removeHandler(channel);
			ipcMain.handle("remote:hosts-list", () => ({ ok: true, status: "ready", hosts: [host, other].map((id, index) => ({ id, label: `SSH fixture ${index + 1}`, sshHost: "example.invalid", verified: true, disabled: false })), states: { [host]: "ready", [other]: "ready" } }));
			ipcMain.handle("remote:connect", () => ({ ok: true, status: "ready" }));
			ipcMain.handle("config:get-raw", (_event, file: string, options: { target: { kind: string; hostId: string } }) => {
				if (options?.target?.kind !== "ssh") throw new Error("fixture only supports SSH raw reads");
				const id = options.target.hostId;
				if (file === "auth.json") return { raw: "", remoteAuth: authSnapshot(id) };
				const remote = snapshot(id, file);
				return { raw: JSON.stringify(remote.data, null, 2), remote };
			});
			ipcMain.handle("config:save-raw", (_event, file: string, _raw: string, options: { target: { kind: string; hostId: string }; expectedVersion: string; document: { data: Record<string, unknown>; secretSources: unknown[] } }) => {
				const id = options.target.hostId;
				if (options.target.kind !== "ssh" || !state.documents[id]?.[file]) throw new Error("REMOTE_CONFIG_TARGET_INVALID");
				if (state.failNext) {
					state.failNext = false;
					throw new Error("REMOTE_CONFIG_VERSION_CONFLICT");
				}
				if (options.expectedVersion !== version(id, file)) throw new Error("REMOTE_CONFIG_VERSION_CONFLICT");
				state.documents[id][file] = structuredClone(options.document.data);
				state.writes.push({ hostId: id, file, data: structuredClone(options.document.data) });
				state.versions[id + file] = (state.versions[id + file] ?? 1) + 1;
				const remote = snapshot(id, file);
				return { valid: true, remote: { kind: "remote", hostId: id, file: remote.file, version: remote.version, sha256: remote.sha256 } };
			});
			ipcMain.handle("config:replace-remote-auth", (_event, input: { hostId: string; expectedVersion: string; entries: Array<{ provider: string; apiKey?: string; retain?: true; source?: string }> }) => {
				if (!state.auth[input.hostId]) throw new Error("REMOTE_CONFIG_TARGET_INVALID");
				if (input.expectedVersion !== authVersion(input.hostId)) throw new Error("REMOTE_CONFIG_VERSION_CONFLICT");
				state.authWrites.push(structuredClone(input));
				state.auth[input.hostId] = input.entries.map((entry) => ({ provider: entry.provider, type: "api_key", configured: true }));
				state.authVersions[input.hostId] = (state.authVersions[input.hostId] ?? 1) + 1;
				return { valid: true, remoteAuth: authSnapshot(input.hostId) };
			});
			ipcMain.handle("remote:pi-resources", (_event, hostId: string, input: Record<string, unknown>) => {
				const fixture = state.resources[hostId];
				if (!fixture) throw new Error("PI_RESOURCE_TARGET_INVALID");
				state.resourceCalls.push({ hostId, input: structuredClone(input) });
				const nextVersion = () => resourceVersion(++state.resourceRevision);
				const ref = input.ref as { root: string; path: string } | undefined;
				const find = () => fixture.files.find((file) => file.root === ref?.root && file.path === ref.path);
				if (input.action === "list") return structuredClone(fixture);
				if (input.action === "read") {
					const file = find();
					if (!file) throw new Error("PI_RESOURCE_NOT_FOUND");
					return structuredClone(file);
				}
				if (input.action === "write") {
					const file = find();
					if (!file || file.version !== input.expectedVersion) throw new Error("PI_RESOURCE_VERSION_CONFLICT");
					file.content = String(input.content ?? "");
					file.version = nextVersion();
					return structuredClone(file);
				}
				if (input.action === "delete") {
					const index = fixture.files.findIndex((file) => file.root === ref?.root && file.path === ref.path);
					if (index < 0) throw new Error("PI_RESOURCE_NOT_FOUND");
					fixture.files.splice(index, 1);
					return { applied: true };
				}
				if (input.action === "toggle" || input.action === "togglePackage" || input.action === "builtin") {
					fixture.settingsVersion = nextVersion();
					return { applied: true };
				}
				if (input.action === "packages") {
					const extensions = [{ id: "user:npm:remote-package", source: "npm:remote-package", scope: "user", enabled: true }];
					return { output: "", extensions };
				}
				throw new Error("PI_RESOURCE_FILE_INVALID");
			});
			ipcMain.handle("remote:pi-models", (_event, id: string, force: boolean) => {
				state.probes.push({ hostId: id, force });
				const provider = id === host ? "remote1" : "remote2";
				return { ok: true, hostId: id, models: [{ provider, id: "remote-model", name: "SSH model", contextWindow: 32000, maxTokens: 4096 }], providers: [provider], count: 1, at: Date.now() };
			});
		},
		{ host: HOST, other: OTHER },
	);
	await expect(window.getByRole("button", { name: "设置", exact: true })).toBeVisible({ timeout: 30_000 });
	await window.evaluate(() => {
		localStorage.setItem("pideck-config-last-tab", "config:models");
		localStorage.setItem("pideck-config-backend-pane", "pi");
		localStorage.setItem("pideck:command-palette-onboarding", "1");
		localStorage.removeItem("pideck-config-last-target");
	});
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("button", { name: "设置", exact: true }).click();
	const settings = window.locator(".settings-modal");
	await settings.getByRole("tab", { name: "配置管理", exact: true }).click();
	const layout = settings.locator(".config-layout");
	await settings.getByTestId("config-env-trigger").click();
	await window.getByTestId(`config-env-ssh-${HOST}`).click();
	await expect(window.getByTestId("config-env-menu")).toBeHidden();
	await expect(settings.getByTestId("config-environment-status")).toHaveAttribute("data-kind", "ssh");
	await expect(layout.locator("[data-provider-head]").filter({ hasText: "remote1" })).toBeVisible();
	const catalog = layout.getByTestId("remote-model-catalog");
	await expect(catalog).toHaveAttribute("data-phase", "ready");
	await catalog.getByTestId("remote-model-probe-summary").click();
	await expect(catalog.getByTestId("remote-model-entry")).toContainText("SSH model");
	await catalog.getByTestId("remote-model-probe").click();
	await expect(catalog).toHaveAttribute("data-phase", "ready");

	// Provider page stays mounted across tab navigation and participates in normal dirty/save-all handling.
	await layout.locator("[data-provider-head]").filter({ hasText: "remote1" }).getByTitle("编辑供应商配置", { exact: true }).click();
	const providerPage = layout.locator(".provider-add-page");
	const url = providerPage.getByRole("textbox", { name: "Base URL", exact: true });
	await url.fill("https://edited.remote.invalid/v1");
	await layout.getByRole("tab", { name: "设置", exact: true }).click();
	await expect(layout.locator(".config-settings-tab")).toBeVisible();
	await layout.getByRole("tab", { name: "模型", exact: true }).click();
	await expect(url).toHaveValue("https://edited.remote.invalid/v1");
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect(providerPage).toHaveCount(0);
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").writes.length)).toBe(1);
	await layout.getByRole("tab", { name: "源文件", exact: true }).click();
	const raw = layout.locator(".config-raw-tab:visible");
	await expect(raw.locator(".cm-content")).toContainText("edited.remote.invalid");
	await raw.getByRole("combobox").click();
	await expect(window.getByRole("option", { name: "auth.json", exact: true })).toHaveCount(1);
	await window.getByRole("option", { name: "models.json", exact: true }).click();
	const draft = { providers: { remote1: { baseUrl: "https://source.remote.invalid", api: "openai-completions", apiKey: "configured", models: [{ id: "remote-model" }] } }, unknownTop: { keep: true }, explicitNull: null };
	await raw.locator(".cm-content").click();
	await window.keyboard.press("ControlOrMeta+A");
	await window.keyboard.insertText(JSON.stringify(draft, null, 2));
	await app.evaluate(() => {
		Reflect.get(globalThis, "remoteConfigFixture").failNext = true;
	});
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect(layout.getByRole("alert")).toBeVisible();
	await expect(raw.locator(".cm-content")).toContainText("source.remote.invalid");
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").writes.length)).toBe(1);
	await layout.getByRole("button", { name: "重新读取", exact: true }).click();
	const confirm = window.getByRole("alertdialog");
	await expect(confirm).toContainText("未保存更改");
	await confirm.getByRole("button", { name: "取消", exact: true }).click();
	await expect(raw.locator(".cm-content")).toContainText("source.remote.invalid");
	await layout.getByRole("button", { name: "重新读取", exact: true }).click();
	await window.getByRole("alertdialog").getByRole("button", { name: "重新读取", exact: true }).click();
	await expect(raw.locator(".cm-content")).toContainText("edited.remote.invalid");
	await raw.locator(".cm-content").click();
	await window.keyboard.press("ControlOrMeta+A");
	await window.keyboard.insertText(JSON.stringify(draft, null, 2));
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").writes.length)).toBe(2);
	await expect(layout.getByRole("alert")).toHaveCount(0);
	await window.screenshot({ path: testInfo.outputPath("ssh-source-editor.png") });
	await layout.getByRole("tab", { name: "模型", exact: true }).click();
	await expect(layout.locator("[data-provider-head]").filter({ hasText: "remote1" })).toBeVisible();
	await window.screenshot({ path: testInfo.outputPath("ssh-model-editor.png") });

	// The same save button routes settings, trust and the MCP file to the selected host.
	await layout.getByRole("tab", { name: "设置", exact: true }).click();
	await layout.locator('.config-settings-tab input[type="number"][max="50"]').fill("7");
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").writes.length)).toBe(3);
	await layout.getByRole("tab", { name: "信任", exact: true }).click();
	const trust = layout.locator(".config-trust-tab");
	await trust.getByRole("textbox").fill("/srv/added-from-ui");
	await trust.getByRole("button", { name: "添加目录", exact: true }).click();
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").writes.length)).toBe(4);
	await layout.getByRole("tab", { name: "MCP", exact: true }).click();
	const mcp = layout.locator(".config-raw-tab:visible .cm-content");
	await expect(mcp).toContainText("mcpServers");
	await mcp.click();
	await window.keyboard.press("ControlOrMeta+A");
	await window.keyboard.insertText(JSON.stringify({ mcpServers: { docs: { url: "https://changed.remote.invalid/mcp" } } }, null, 2));
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").writes.length)).toBe(5);

	// Authentication uses the same form as local, but every mutation is bound to this host.
	await layout.getByRole("tab", { name: "认证", exact: true }).click();
	await expect(layout.getByText("remote1", { exact: true })).toBeVisible();
	let providerHead = layout.getByText("remote1", { exact: true }).locator("..");
	await providerHead.click();
	const authCard = providerHead.locator("..");
	await authCard.locator('input[type="password"]').fill("new-remote-secret");
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").authWrites.length)).toBe(1);
	providerHead = layout.getByText("remote1", { exact: true }).locator("..");
	await providerHead.getByTitle("复制", { exact: true }).click();
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").authWrites.length)).toBe(2);
	providerHead = layout.getByText("remote1-copy", { exact: true }).locator("..");
	await providerHead.getByTitle("删除", { exact: true }).click();
	await window.getByRole("alertdialog").getByRole("button", { name: "删除", exact: true }).click();
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").authWrites.length)).toBe(3);
	await expect(layout.getByText("remote1-copy", { exact: true })).toHaveCount(0);

	// Skill and prompt editors write their full source through the host-bound resource facade.
	await layout.getByRole("tab", { name: "技能", exact: true }).click();
	await expect(layout.getByText("remote-skill", { exact: true })).toBeVisible();
	let resourceRow = layout.locator("tbody tr").filter({ hasText: "remote-skill" }).first();
	await resourceRow.getByTitle("编辑", { exact: true }).click();
	let editor = layout.locator(".prompts-editor-modal");
	await expect(editor.locator(".cm-content")).toContainText("Original skill body");
	await editor.locator(".cm-content").click();
	await window.keyboard.press("ControlOrMeta+A");
	await window.keyboard.insertText('---\nname: remote-skill\ndescription: "Editable remote skill"\n---\n\nEdited remote skill body\n');
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").resourceCalls.some((call: { input: { action: string; content?: string } }) => call.input.action === "write" && call.input.content?.includes("Edited remote skill body")))).toBe(true);
	await editor.getByTitle("关闭", { exact: true }).click();

	await layout.getByRole("tab", { name: "提示词模板", exact: true }).click();
	resourceRow = layout.locator("tbody tr").filter({ hasText: "remote-prompt" }).first();
	await expect(resourceRow).toBeVisible();
	await resourceRow.getByRole("button", { name: "编辑", exact: true }).click();
	editor = layout.locator(".prompts-editor-modal");
	await expect(editor.locator(".cm-content")).toContainText("Original prompt body");
	await editor.locator(".cm-content").click();
	await window.keyboard.press("ControlOrMeta+A");
	await window.keyboard.insertText("Edited remote prompt body\n");
	await settings.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").resourceCalls.some((call: { input: { action: string; content?: string } }) => call.input.action === "write" && call.input.content === "Edited remote prompt body\n"))).toBe(true);
	await expect(editor).toBeHidden();

	// A fixed-root extension opens the same source editor; package rows remain a separate Pi CLI operation.
	await layout.getByRole("tab", { name: "扩展", exact: true }).click();
	await expect(layout.getByText("remote-extension.ts", { exact: true }).first()).toBeVisible();
	await expect(layout.getByText("remote-package", { exact: true })).toBeVisible();
	await layout.getByTitle("编辑扩展源文件", { exact: true }).click();
	const sourceDialog = window.getByRole("dialog").filter({ hasText: "编辑扩展源文件" });
	await expect(sourceDialog.locator(".cm-content")).toContainText("original = true");
	await sourceDialog.locator(".cm-content").click();
	await window.keyboard.press("ControlOrMeta+A");
	await window.keyboard.insertText("export const remoteEdited = true;\n");
	await sourceDialog.getByRole("button", { name: "保存", exact: true }).click();
	await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture").resourceCalls.some((call: { input: { action: string; content?: string } }) => call.input.action === "write" && call.input.content?.includes("remoteEdited")))).toBe(true);
	await sourceDialog.locator("button").filter({ hasText: "关闭" }).first().click();

	await layout.getByRole("tab", { name: "模型", exact: true }).click();
	await settings.getByTestId("config-env-trigger").click();
	await window.getByTestId(`config-env-ssh-${OTHER}`).click();
	await expect(window.getByTestId("config-env-menu")).toBeHidden();
	await expect(layout.locator("[data-provider-head]").filter({ hasText: "remote2" })).toBeVisible();
	await expect(layout.locator("[data-provider-head]").filter({ hasText: "remote1" })).toHaveCount(0);
	await layout.locator("[data-provider-head]").filter({ hasText: "remote2" }).getByTitle("编辑供应商配置", { exact: true }).click();
	await providerPage.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://second-host.edited.invalid");
	await settings.getByTestId("config-env-trigger").click();
	await expect(window.getByTestId("config-env-menu")).toBeVisible();
	await window.getByTestId("config-env-local").click();
	await expect(window.getByTestId("config-env-switch-confirm")).toBeVisible();
	await window.getByTestId("config-env-switch-save").click();
	await expect(layout.locator("[data-provider-head]").filter({ hasText: "localOnly" })).toBeVisible();
	const state = await app.evaluate(() => Reflect.get(globalThis, "remoteConfigFixture") as RemoteFixtureState);
	expect(state.writes.map((write) => [write.hostId, write.file])).toEqual([
		[HOST, "models.json"],
		[HOST, "models.json"],
		[HOST, "settings.json"],
		[HOST, "trust.json"],
		[HOST, "mcp.json"],
		[OTHER, "models.json"],
	]);
	expect(state.writes[1].data.explicitNull).toBeNull();
	expect(state.writes[2].data.retry).toMatchObject({ maxRetries: 7 });
	expect(state.writes[3].data["/srv/added-from-ui"]).toBe(true);
	expect(state.writes[4].data.mcpServers).toEqual({ docs: { url: "https://changed.remote.invalid/mcp" } });
	expect(state.authWrites.map((write) => write.hostId)).toEqual([HOST, HOST, HOST]);
	expect(state.authWrites[0].entries).toHaveLength(1);
	expect(state.authWrites[0].entries[0]).toMatchObject({ provider: "remote1" });
	expect(typeof state.authWrites[0].entries[0].apiKey).toBe("string");
	expect(state.authWrites[1].entries).toContainEqual({ provider: "remote1-copy", retain: true, source: "remote1" });
	expect(state.authWrites[2].entries).toEqual([{ provider: "remote1", retain: true, source: "remote1" }]);
	expect(state.resourceCalls.every((call) => call.hostId === HOST)).toBe(true);
	expect(state.resourceCalls.some((call) => call.input.action === "write" && String(call.input.content).includes("Edited remote skill body"))).toBe(true);
	expect(state.probes.some((probe) => probe.hostId === HOST && probe.force)).toBe(true);
	expect(errors).toEqual([]);
});
