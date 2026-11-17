import { test, expect } from "./fixtures";

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
type RemoteFixtureState = {
	documents: Record<string, Record<string, Record<string, unknown>>>;
	versions: Record<string, number>;
	writes: Array<{ hostId: string; file: string; data: Record<string, unknown> }>;
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
				probes: [],
				failNext: false,
			};
			Object.assign(globalThis, { remoteConfigFixture: state });
			const version = (id: string, file: string) => (state.versions[id + file] ?? 1).toString(16).padStart(64, "0");
			const snapshot = (id: string, file: string) => {
				const data = structuredClone(state.documents[id][file]);
				const secrets: Array<{ path: string; status: "configured" }> = [];
				if (file === "models.json") for (const name of Object.keys(Reflect.get(data, "providers"))) secrets.push({ path: `providers.${name}.apiKey`, status: "configured" });
				return { kind: "remote", hostId: id, file: file.replace(".json", ""), version: version(id, file), sha256: version(id, file), data, secrets };
			};
			for (const channel of ["remote:hosts-list", "remote:connect", "config:get-raw", "config:save-raw", "remote:pi-models"]) ipcMain.removeHandler(channel);
			ipcMain.handle("remote:hosts-list", () => ({ ok: true, status: "ready", hosts: [host, other].map((id, index) => ({ id, label: `SSH fixture ${index + 1}`, sshHost: "example.invalid", verified: true, disabled: false })), states: { [host]: "ready", [other]: "ready" } }));
			ipcMain.handle("remote:connect", () => ({ ok: true, status: "ready" }));
			ipcMain.handle("config:get-raw", (_event, file: string, options: { target: { kind: string; hostId: string } }) => {
				if (options?.target?.kind !== "ssh") throw new Error("fixture only supports SSH raw reads");
				const id = options.target.hostId;
				if (file === "auth.json") return { raw: "", remoteAuth: { kind: "remote-auth", hostId: id, version: "a".repeat(64), sha256: "a".repeat(64), providers: [] } };
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
			ipcMain.handle("remote:pi-models", (_event, id: string, force: boolean) => {
				state.probes.push({ hostId: id, force });
				const provider = id === host ? "remote1" : "remote2";
				const models = Array.from({ length: 160 }, (_, index) => ({ provider, id: `remote-model-${index}`, name: `SSH model ${index}`, contextWindow: 32000, maxTokens: 4096 }));
				return { ok: true, hostId: id, models, providers: [provider], count: models.length, at: Date.now() };
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
	await expect(catalog.getByTestId("remote-model-entry").first()).toContainText("SSH model");
	const catalogScroll = await catalog.evaluate((node) => {
		const outer = node.closest(".config-content");
		if (!(outer instanceof HTMLElement)) throw new Error("missing config scroll owner");
		const nestedScrollers = Array.from(node.querySelectorAll("*")).filter((child) => /^(auto|scroll)$/.test(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1);
		return { top: outer.scrollTop, overflowing: outer.scrollHeight > outer.clientHeight, nested: nestedScrollers.length };
	});
	expect(catalogScroll.overflowing).toBe(true);
	expect(catalogScroll.nested).toBe(0);
	await catalog.getByTestId("remote-model-entry").first().hover();
	await window.mouse.wheel(0, 400);
	await expect.poll(() => catalog.evaluate((node) => node.closest(".config-content")?.scrollTop ?? 0)).toBeGreaterThan(catalogScroll.top + 100);
	await window.screenshot({ path: testInfo.outputPath("ssh-model-catalog-scroll.png") });
	await catalog.getByTestId("remote-model-probe-summary").click();
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
	await expect(window.getByRole("option", { name: "auth.json", exact: true })).toHaveCount(0);
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
	expect(state.probes.some((probe) => probe.hostId === HOST && probe.force)).toBe(true);
	expect(errors).toEqual([]);
});
