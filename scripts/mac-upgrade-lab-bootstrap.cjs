/** Only packaged by mac-upgrade-lab.mjs; production entry points never import this file. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");
const { app } = require("electron");
const config = require("./mac-upgrade-lab.json");

if (config.bundleId !== "cc.debugtools.pideck.upgrade-lab" || !path.isAbsolute(config.root)) throw new Error("Invalid upgrade lab configuration");
const feed = new URL(config.feedUrl);
if (feed.protocol !== "http:" || feed.hostname !== "127.0.0.1") throw new Error("Upgrade lab requires a loopback feed");
const root = path.resolve(config.root);
const marker = JSON.parse(fs.readFileSync(path.join(root, "mac-upgrade-lab-root.json"), "utf8"));
if (marker.bundleId !== config.bundleId || fs.realpathSync(root) !== root) throw new Error("Upgrade lab root was not prepared or is a symlink");
const home = path.join(root, "home");
const userData = path.join(root, "user-data");
for (const dir of [home, userData, "app-data", "session-data", "tmp", "evidence"].map((dir) => (path.isAbsolute(dir) ? dir : path.join(root, dir)))) fs.mkdirSync(dir, { recursive: true });

// Isolate homedir consumers without changing HOME or any real account directory.
os.homedir = () => home;
syncBuiltinESMExports();
for (const [key, value] of Object.entries({ home, appData: path.join(root, "app-data"), userData, sessionData: path.join(root, "session-data"), temp: path.join(root, "tmp") })) app.setPath(key, value);
app.commandLine.appendSwitch("user-data-dir", userData);
process.env.PIDECK_E2E = "1";
process.env.PIDECK_E2E_USER_DATA_DIR = userData;
process.env.PIDEK_UPDATE_FEED_URL = config.feedUrl;
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
process.env.DSH_HOME = path.join(home, ".dsh");
// Test installations must not register production deep links or login items.
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};

function record(event, details = {}) {
	fs.appendFileSync(path.join(root, "evidence", "runtime.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), event, version: app.getVersion(), pid: process.pid, ...details })}\n`);
}
const { autoUpdater } = require("electron-updater");
for (const event of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"]) {
	autoUpdater.on(event, (value) => record(event, value instanceof Error ? { message: value.message } : { info: value }));
}
app.on("before-quit", () => record("before-quit"));
app.whenReady().then(() => {
	for (const key of ["home", "appData", "userData", "sessionData", "temp"]) {
		const value = path.resolve(app.getPath(key));
		if (!value.startsWith(`${root}${path.sep}`)) throw new Error(`Upgrade lab escaped its ${key} directory`);
	}
	record("ready", { execPath: process.execPath, home: os.homedir(), userData: app.getPath("userData"), appData: app.getPath("appData"), feedUrl: config.feedUrl });
});
record("bootstrap", { root, feedUrl: config.feedUrl });
require("./index.js");
