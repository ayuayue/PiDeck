/** Lab-only entry. Production packages never import this file. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");
const { app } = require("electron");

const labHome = process.env.PIDECK_UPGRADE_HOME;
if (!labHome || !path.isAbsolute(labHome)) throw new Error("Windows upgrade lab requires an absolute isolated home");
const home = fs.realpathSync(labHome);
const marker = JSON.parse(fs.readFileSync(path.join(home, "windows-upgrade-lab.json"), "utf8"));
if (marker.identity !== "cc.debugtools.pideck.windows-upgrade-lab" || path.resolve(marker.home) !== home) throw new Error("Windows upgrade lab home was not prepared");

const appData = path.join(home, "AppData", "Roaming");
const paths = { home, appData, userData: path.join(appData, "PiDeck"), sessionData: path.join(home, "chromium-session"), temp: path.join(home, "tmp") };
for (const [key, value] of Object.entries(paths)) {
	fs.mkdirSync(value, { recursive: true });
	app.setPath(key, value);
}
os.homedir = () => home;
syncBuiltinESMExports();
Object.assign(process.env, { USERPROFILE: home, HOME: home, APPDATA: appData, LOCALAPPDATA: path.join(home, "AppData", "Local"), TEMP: paths.temp, TMP: paths.temp, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), DSH_HOME: path.join(home, ".dsh"), PIDECK_E2E: "1", PIDECK_E2E_WINDOW_MODE: "quiet" });
for (const name of ["PIDECK_E2E_USER_DATA_DIR", "PIDECK_E2E_REGISTER_PROTOCOL", "PORTABLE_EXECUTABLE_DIR", "PORTABLE_EXECUTABLE_FILE", "PIDEK_UPDATE_FEED_URL"]) delete process.env[name];
app.setAsDefaultProtocolClient = () => false;
app.removeAsDefaultProtocolClient = () => false;
app.setLoginItemSettings = () => {};
app.whenReady().then(() => {
	for (const key of Object.keys(paths)) {
		const resolved = path.resolve(app.getPath(key));
		if (resolved !== home && !resolved.startsWith(`${home}${path.sep}`)) throw new Error(`Windows upgrade lab escaped ${key}`);
	}
	fs.appendFileSync(path.join(home, "windows-upgrade-runtime.jsonl"), `${JSON.stringify({ version: app.getVersion(), executable: process.execPath, ...Object.fromEntries(Object.keys(paths).map((key) => [key, app.getPath(key)])) })}\n`);
});
require("./index.js");
