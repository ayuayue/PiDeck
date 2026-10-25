/** Isolated, bounded Node carrier for the real utilityProcess entry (no Electron app restart). */
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/** Compile only the DSH entries touched by this gate, outside out/main and the running app. */
export async function buildDshHarness(directory) {
	const outdir = join(directory, "app");
	await build({
		entryPoints: ["hostEntry", "runnerConsolePreload", "pideckPluginBridge", "pideckCommandsBridge", "pideckSessionBridge", "DshApiClient", "dshRemoteClient", "dshSessionPath"].map((name) => resolve("src/main/dsh", `${name}.ts`)),
		outdir,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
		external: ["@deepseek-ai/*", "electron"],
		logLevel: "warning",
	});
	const wrapper = join(outdir, "carrier.cjs");
	writeFileSync(wrapper, ['const { EventEmitter } = require("node:events");', "process.parentPort = new EventEmitter();", "process.parentPort.postMessage = (message) => process.send?.(message);", 'process.on("message", (data) => process.parentPort.emit("message", { data }));', 'require("./hostEntry.js");'].join("\n"));
	return { outdir, wrapper };
}

/** Start actual hostEntry against an explicit runtime and empty test HOME; never inherit credentials. */
export async function startDshHarness({ build, home, runtimeRoot, timeoutMs = 60_000 }) {
	const config = join(home, ".pideck", "config");
	mkdirSync(config, { recursive: true });
	const env = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home };
	for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR", "PATHEXT"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	const child = fork(build.wrapper, ["--dsh-home", home, "--dsh-config", config, "--dsh-node-modules", pathToFileURL(join(runtimeRoot, "node_modules") + "/").href], { env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
	let logs = "";
	const append = (chunk) => {
		logs = (logs + chunk.toString()).slice(-24_000);
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	const exit = once(child, "exit");
	let client;
	async function stop() {
		client?.dispose();
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await exit;
	}
	try {
		await new Promise((resolveReady, reject) => {
			const timer = setTimeout(() => finish(new Error(`DSH boot timeout (${timeoutMs}ms)`)), timeoutMs);
			function finish(error) {
				clearTimeout(timer);
				child.off("message", message);
				child.off("exit", exited);
				child.off("error", finish);
				if (error) reject(error);
				else resolveReady();
			}
			function message(value) {
				if (value?.type === "host-ready") finish();
				if (value?.type === "host-error") finish(new Error(value.message));
			}
			function exited(code, signal) {
				finish(new Error(`DSH host exited ${code ?? signal}`));
			}
			child.on("message", message);
			child.once("exit", exited);
			child.once("error", finish);
		});
		const require = createRequire(join(build.outdir, "package.json"));
		const { DshApiClient } = require("./DshApiClient.js");
		const { DshRemoteClient } = require("./dshRemoteClient.js");
		client = new DshApiClient({
			timeoutMs: 15_000,
			transport: {
				send(message) {
					if (child.connected) child.send(message);
				},
				onMessage(listener) {
					child.on("message", listener);
					return () => child.off("message", listener);
				},
				dispose() {},
			},
		});
		return { rpc: client, client: new DshRemoteClient(client), stop, logs: () => logs };
	} catch (error) {
		await stop();
		throw new Error(`${error instanceof Error ? error.stack : error}\n${logs}`);
	}
}
