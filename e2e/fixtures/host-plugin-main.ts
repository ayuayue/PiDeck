/** Isolated Electron host for plugin tests: no PiDeck boot, pi runtime, network or real user data. */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { join } from "node:path";
import { HostPluginManager } from "../../src/main/plugins/HostPluginManager";
import { HostPluginBroker } from "../../src/main/plugins/HostPluginBroker";
import { HostPluginStorage } from "../../src/main/plugins/HostPluginStorage";
import { HostPluginSessions } from "../../src/main/plugins/HostPluginSessions";
import { HostPluginViewHost } from "../../src/main/plugins/HostPluginViewHost";
import { preparePreloadPath } from "../../src/main/preloadPath";
import { ipcChannels } from "../../src/shared/ipc";
import type { HostPluginContext } from "../../src/shared/types/hostPlugin";

const root = process.argv[2];
const sourcePreload = process.argv[3];
app.setPath("userData", root);
app.commandLine.appendSwitch("no-sandbox");
protocol.registerSchemesAsPrivileged([{ scheme: "pideck-plugin", privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: false } }]);

void app
	.whenReady()
	.then(async () => {
		const window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
		await window.loadURL("data:text/html,<title>Isolated plugin host</title><p>No pi runtime</p>");
		const manager = new HostPluginManager(root);
		await manager.load();
		const entry = { id: "history", projectId: "project-a", title: "Saved history", filePath: join(root, "session.jsonl"), environment: "native", createdAt: 1700000000000, updatedAt: 1700000000000 };
		const sessions = new HostPluginSessions({ listEntries: () => [entry], get: (id) => (id === entry.id ? entry : undefined) });
		const broker = new HostPluginBroker(manager, sessions, new HostPluginStorage(join(root, "host-plugin-storage")));
		const preload = await preparePreloadPath(sourcePreload, "host-plugin-preload.js");
		const views = new HostPluginViewHost(manager, broker, sessions, preload);
		ipcMain.handle(ipcChannels.hostPluginRequest, (event, request: unknown) => broker.request(event.sender.id, event.senderFrame === event.sender.mainFrame, request));
		const context: HostPluginContext = { projectId: "project-a", sessionId: "history", locale: "zh-CN", theme: "dark" };
		let instanceId: string | undefined;
		Object.assign(globalThis, {
			hostPluginFixture: {
				async mount() {
					const plugin = manager.catalog().plugins[0];
					if (!plugin) throw new Error("Fixture plugin missing");
					await manager.setEnabled(plugin.manifest.id, true, plugin.fingerprint);
					const result = await views.mount(window, { pluginId: plugin.manifest.id, panelId: plugin.manifest.contributes.panels[0].id, context, bounds: { x: 0, y: 0, width: 1000, height: 800 } });
					instanceId = result.instanceId;
				},
				update(projectId: string, sessionId?: string) {
					if (instanceId) views.update(instanceId, window, { ...context, projectId, sessionId }, { x: 0, y: 0, width: 1000, height: 800 }, true);
				},
				async disable() {
					const plugin = manager.catalog().plugins[0];
					await manager.setEnabled(plugin.manifest.id, false, plugin.fingerprint);
				},
				unmount() {
					if (instanceId) views.unmount(instanceId);
				},
			},
		});
		app.once("before-quit", () => {
			views.dispose();
			broker.dispose();
			manager.dispose();
		});
	})
	.catch((error: unknown) => {
		process.stderr.write(`${String(error)}\n`);
		app.exit(1);
	});
