import { expect, test } from "./fixtures";

const HOST = "11111111-1111-4111-8111-111111111111";
test.use({ seedPiAgent: { settings: {}, models: { providers: {} }, auth: {} } });

test("SSH 扩展更新按钮和内置开关使用正确的作用域", async ({ app, window }) => {
	test.setTimeout(120_000);
	await app.evaluate(({ ipcMain }, host) => {
		const state: { extensions: string[]; version: number; calls: Array<Record<string, unknown>> } = { extensions: [], version: 1, calls: [] };
		Reflect.set(globalThis, "remoteExtensionFixture", state);
		for (const channel of ["remote:hosts-list", "remote:connect", "remote:pi-resources", "config:get-raw", "remote:pi-mcp", "remote:pi-models"]) ipcMain.removeHandler(channel);
		ipcMain.handle("remote:hosts-list", () => ({ ok: true, status: "ready", hosts: [{ id: host, label: "SSH fixture", sshHost: "example.invalid", verified: true, disabled: false }], states: { [host]: "ready" } }));
		ipcMain.handle("remote:connect", () => ({ ok: true, status: "ready" }));
		ipcMain.handle("config:get-raw", (_event, file: string) => {
			const data = file === "models.json" ? { providers: {} } : {};
			const version = "a".repeat(64);
			return { raw: JSON.stringify(data), remote: { kind: "remote", hostId: host, file: file.replace(".json", ""), version, sha256: version, data, secrets: [] } };
		});
		ipcMain.handle("remote:pi-models", () => ({ ok: true, hostId: host, models: [], providers: [], count: 0, at: Date.now() }));
		ipcMain.handle("remote:pi-mcp", () => ({ action: "facts", home: "/home/ssh-fixture", piVersion: "1.6.0" }));
		ipcMain.handle("remote:pi-resources", (_event, target: string, input: Record<string, unknown>) => {
			if (target !== host) throw new Error("wrong host");
			state.calls.push(structuredClone(input));
			if (input.action === "packages") return { output: "", extensions: [{ id: "user:npm:up-to-date", source: "npm:up-to-date", scope: "user", enabled: true, currentVersion: "1.0.0", latestVersion: "1.0.0", hasUpdate: false }] };
			if (input.action === "builtin") {
				const name = `builtin:${String(input.name)}`;
				state.extensions = [...state.extensions.filter((entry) => entry !== `+${name}` && entry !== `-${name}`), `${input.enabled ? "+" : "-"}${name}`];
				state.version++;
				return { applied: true };
			}
			if (input.action !== "list") throw new Error("unexpected action");
			return {
				home: "/home/ssh-fixture",
				scope: "global",
				projectRoot: null,
				files: [],
				settings: { extensions: [...state.extensions] },
				settingsVersion: state.version.toString(16).padStart(64, "0"),
				discovery: { projectResourcesAllowed: false, overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] }, skills: [], prompts: [], extensions: [] },
			};
		});
	}, HOST);

	await expect(window.getByRole("button", { name: "设置", exact: true })).toBeVisible({ timeout: 30_000 });
	await window.evaluate(() => {
		localStorage.setItem("pideck-config-last-tab", "config:extensions");
		localStorage.setItem("pideck-config-backend-pane", "pi");
		localStorage.setItem("pideck:command-palette-onboarding", "1");
		localStorage.removeItem("pideck-config-last-target");
	});
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("button", { name: "设置", exact: true }).click();
	const settings = window.locator(".settings-modal");
	await settings.getByRole("tab", { name: "配置管理", exact: true }).click();
	await settings.getByTestId("config-env-trigger").click();
	await window.getByTestId(`config-env-ssh-${HOST}`).click();
	await expect(settings.getByTestId("config-environment-status")).toHaveAttribute("data-kind", "ssh");
	const layout = settings.locator(".config-layout");
	await layout.getByRole("tab", { name: "扩展", exact: true }).click();
	const packageRow = layout.getByRole("row").filter({ hasText: "npm:up-to-date" });
	await expect(packageRow).toBeVisible();
	await expect(packageRow.getByRole("button", { name: "更新", exact: true })).toHaveCount(0);
	const builtInRow = layout.getByRole("row").filter({ hasText: "pi-deck-todo.ts" });
	await expect(builtInRow).toBeVisible();
	const builtInSwitch = builtInRow.getByRole("switch");
	await expect(builtInSwitch).toBeChecked();
	await builtInSwitch.click();
	await expect(builtInSwitch).not.toBeChecked();
	await expect.poll(() => window.evaluate(async () => (await window.piDesktop.settings.get()).removedBuiltInExtensions?.includes("pi-deck-todo.ts"))).toBe(true);
	const nativeSwitch = layout.getByRole("switch", { name: "mcp", exact: true });
	await expect(nativeSwitch).toBeChecked();
	await nativeSwitch.click();
	await expect(nativeSwitch).not.toBeChecked();
	await expect.poll(() => app.evaluate(() => (Reflect.get(globalThis, "remoteExtensionFixture") as { extensions: string[] }).extensions)).toContain("-builtin:mcp");
});
