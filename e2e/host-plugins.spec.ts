import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { resolveConfig } from "electron-vite";
import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Build only the plugin host and real preload targets into temporary output, never the entire app. */
let root: string;
let app: ElectronApplication;
let guest: Page;

test.beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pideck-plugin-electron-"));
	const resolved = await resolveConfig({ configFile: "electron.vite.main.mjs", envFile: false }, "build");
	if (!resolved.config?.preload) throw new Error("Missing production preload config");
	await viteBuild({ ...resolved.config.preload, configFile: false, envFile: false, logLevel: "error", build: { ...resolved.config.preload.build, outDir: join(root, "preload"), emptyOutDir: true } });
	await esbuild({ entryPoints: ["e2e/fixtures/host-plugin-main.ts"], bundle: true, platform: "node", format: "cjs", outfile: join(root, "main.cjs"), external: ["electron"], define: { __PIDECK_DEV_BUILD__: "false" }, logLevel: "error" });
	const directory = join(root, "host-plugins", "fixture");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "pideck-plugin.json"), JSON.stringify({ schemaVersion: 1, apiVersion: 1, id: "fixture.viewer", name: "Fixture", version: "1.0.0", permissions: ["sessions.read"], contributes: { panels: [{ id: "viewer", title: "Viewer", entry: "app.html" }], commands: [] } }));
	await writeFile(join(directory, "app.html"), '<!doctype html><html><body><pre id="result">starting</pre><script type="module" src="app.mjs"></script></body></html>');
	await writeFile(join(directory, "app.mjs"), `try {
		const host = window.pideck;
		const context = await host.context.get();
		const sessions = await host.sessions.list();
		const history = await host.sessions.entries(context.sessionId);
		const worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
		const value = await new Promise((resolve) => { worker.onmessage = ({ data }) => resolve(data); worker.postMessage("hello"); });
		worker.terminate();
		document.getElementById("result").textContent = JSON.stringify({ context, sessions, history, value, node: typeof window.require, desktop: typeof window.piDesktop });
	} catch (error) { document.getElementById("result").textContent = "failed:" + error.message; }`);
	await writeFile(join(directory, "worker.mjs"), 'self.onmessage = ({ data }) => self.postMessage("worker:" + data);');
	await writeFile(join(root, "session.jsonl"), [
		{ type: "session", id: "header", timestamp: "2026-01-01T00:00:00Z" },
		{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "Saved, no pi runtime" } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_RENDERER_URL;
	app = await electron.launch({ args: [join(root, "main.cjs"), root, join(root, "preload", "hostPlugin.js")], env, timeout: 15_000 });
	await expect.poll(() => app.evaluate(() => "hostPluginFixture" in globalThis)).toBe(true);
	const created = new Promise<Page>((done) => app.on("window", (window) => { if (window.url().startsWith("pideck-plugin:")) done(window); }));
	await app.evaluate(async () => { await Reflect.get(globalThis, "hostPluginFixture").mount(); });
	guest = await created;
});

test.afterAll(async () => { await app?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test("real sandbox preload reads saved history and supports module Workers without exposing Node", async () => {
	await expect(guest.locator("#result")).toContainText("worker:hello");
	const result = JSON.parse(await guest.locator("#result").innerText());
	expect(result.context.projectId).toBe("project-a");
	expect(result.sessions.sessions[0].id).toBe("history");
	expect(result.history.entries[0].message.content).toBe("Saved, no pi runtime");
	expect(result.node).toBe("undefined");
	expect(result.desktop).toBe("undefined");
});

test("guest network, external navigation, popups and cross-project reads are denied", async () => {
	const before = guest.url();
	const result = await guest.evaluate(async () => {
		let network = false;
		try { await fetch("https://example.invalid/"); network = true; } catch { /* denied */ }
		return { network, popup: window.open("https://example.invalid/") === null };
	});
	expect(result).toEqual({ network: false, popup: true });
	await guest.evaluate(() => { location.href = "https://example.invalid/"; });
	await expect.poll(() => guest.url()).toBe(before);
	await app.evaluate(() => { Reflect.get(globalThis, "hostPluginFixture").update("project-b"); });
	const denial = await guest.evaluate(async () => {
		const api = Reflect.get(window, "pideck");
		try { await api.sessions.entries("history"); return "allowed"; } catch (error) { return error instanceof Error ? error.message : "error"; }
	});
	expect(denial).toBe("session-not-authorized");
});

test("disabling an approved package destroys its guest and leaves the host running", async () => {
	await app.evaluate(async () => { await Reflect.get(globalThis, "hostPluginFixture").disable(); });
	await expect.poll(() => guest.isClosed()).toBe(true);
	expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
