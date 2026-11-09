#!/usr/bin/env node
/** Real macOS signing/notarization/update rehearsal. Never publishes or changes production data. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createElectronBuilderConfig } = require("./electronBuilderConfig.js");
const { electronBuilderEnv } = require("./electronBuilderEnv.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUNDLE_ID = "cc.debugtools.pideck.upgrade-lab";
export const APP_NAME = "PiDeck Upgrade Lab";
export const FEED_URL = "http://127.0.0.1:18766";
export const DEFAULT_PROFILE = "PiDeck-Isolated-Notary";

export function labPaths(root = path.join(repoRoot, ".tmp-mac-upgrade-lab")) {
	root = path.resolve(root);
	return { root, source: path.join(root, "source"), evidence: path.join(root, "evidence"), userData: path.join(root, "user-data"), installedApp: path.join(root, "install", `${APP_NAME}.app`) };
}

export function buildLabConfig({ source, root = path.dirname(source), version, output, env }) {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Lab versions must be stable semver so the real latest-mac channel is exercised");
	const baseConfig = JSON.parse(require("node:fs").readFileSync(path.join(source, "package.json"), "utf8")).build;
	const config = createElectronBuilderConfig({
		baseConfig,
		env,
		overrides: {
			productName: APP_NAME,
			appId: BUNDLE_ID,
			protocols: [],
			forceCodeSigning: true,
			directories: { output },
			extraMetadata: { name: "pideck-upgrade-lab", productName: APP_NAME, version, main: "out/main/mac-upgrade-lab-bootstrap.cjs" },
			mac: {
				artifactName: "PiDeck-Upgrade-Lab-${version}-${arch}.${ext}",
				notarize: true,
			},
		},
	});
	// Provider options form a union: never retain GitHub owner/repo on the generic feed.
	config.publish = { provider: "generic", url: FEED_URL, channel: "latest" };
	const electronDir = path.join(repoRoot, "node_modules", "electron");
	const electronVersion = require(path.join(electronDir, "package.json")).version;
	const checksums = JSON.parse(require("node:fs").readFileSync(path.join(electronDir, "checksums.json"), "utf8"));
	if (!checksums[`electron-v${electronVersion}-darwin-x64.zip`]) throw new Error("Installed Electron package is missing its pinned macOS checksum");
	config.electronVersion = electronVersion;
	config.electronDownload = { ...(config.electronDownload ?? {}), cache: path.join(root, "electron-cache"), checksums };
	return config;
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		child.on("error", reject);
		child.on("exit", (code, signal) => (code === 0 ? resolve() : reject(new Error(`${command} failed (${code ?? signal})`))));
	});
}

async function prepare(paths) {
	await mkdir(paths.evidence, { recursive: true });
	const marker = path.join(paths.root, "mac-upgrade-lab-root.json");
	try {
		if (JSON.parse(await readFile(marker, "utf8")).bundleId !== BUNDLE_ID) throw new Error("Lab directory belongs to another application");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		await writeFile(marker, JSON.stringify({ bundleId: BUNDLE_ID, schemaVersion: 1 }), { flag: "wx" });
	}
	await mkdir(paths.source, { recursive: true });
	const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoRoot, encoding: "utf8" });
	if (listed.status !== 0) throw new Error("Could not snapshot workspace");
	for (const relative of new Set(listed.stdout.split("\0").filter(Boolean))) {
		if (relative.startsWith(".tmp") || relative.startsWith("node_modules/")) continue;
		const from = path.join(repoRoot, relative);
		try {
			if (!(await stat(from)).isFile()) continue;
		} catch {
			continue;
		}
		const to = path.join(paths.source, relative);
		await mkdir(path.dirname(to), { recursive: true });
		await copyFile(from, to);
	}
	try {
		await access(path.join(paths.source, "node_modules"));
	} catch {
		await symlink(path.join(repoRoot, "node_modules"), path.join(paths.source, "node_modules"));
	}
	await mkdir(paths.userData, { recursive: true });
	const settings = { autoDownloadUpdates: false, autoUpdateExtensions: false, standbyRuntimeEnabled: false, telemetryEnabled: false, catalogAutoUpdate: false, dshHomeDir: path.join(paths.root, "home", ".dsh"), dshAutoImportExternalSessions: false, closeToTray: false };
	try {
		await access(path.join(paths.userData, "settings.json"));
	} catch {
		await writeFile(path.join(paths.userData, "settings.json"), JSON.stringify(settings, null, 2), { flag: "wx" });
	}
	try {
		await access(path.join(paths.userData, "upgrade-survival.txt"));
	} catch {
		await writeFile(path.join(paths.userData, "upgrade-survival.txt"), "PiDeck isolated upgrade data must survive A -> B\n", { flag: "wx" });
	}
	console.log(`Prepared isolated snapshot: ${paths.source}`);
}

async function build(paths) {
	if (process.platform !== "darwin") throw new Error("The signing lab requires macOS");
	const option = (name) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? null : process.argv[index + 1];
	};
	const version = option("--version");
	const versions = version
		? [[option("--label") || "custom", version]]
		: [
				["A", "0.0.1"],
				["B", "0.0.2"],
			];
	for (const [label, value] of versions) if (!/^[A-Za-z0-9_-]+$/.test(label) || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error("Invalid lab label or version");
	let identity = process.env.CSC_NAME;
	if (!identity) {
		const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
		const matches = [...new Set([...result.stdout.matchAll(/"Developer ID Application: ([^"]+)"/g)].map((match) => match[1]))];
		if (matches.length !== 1) throw new Error("Set CSC_NAME to select exactly one installed Developer ID Application identity");
		identity = matches[0];
	}
	const env = electronBuilderEnv({ ...process.env, ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "", CSC_NAME: identity, APPLE_KEYCHAIN_PROFILE: process.env.APPLE_KEYCHAIN_PROFILE || DEFAULT_PROFILE, PIDECK_DEV_BUILD: "0" });
	for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "RELEASE_PAT", "ATOMGIT_TOKEN"]) delete env[key];
	await prepare(paths);
	if (!process.argv.includes("--skip-compile")) await run(path.join(repoRoot, "node_modules", ".bin", "electron-vite"), ["build"], { cwd: paths.source, env });
	await copyFile(path.join(repoRoot, "scripts", "mac-upgrade-lab-bootstrap.cjs"), path.join(paths.source, "out", "main", "mac-upgrade-lab-bootstrap.cjs"));
	await writeFile(path.join(paths.source, "out", "main", "mac-upgrade-lab.json"), JSON.stringify({ root: paths.root, bundleId: BUNDLE_ID, feedUrl: FEED_URL }));
	for (const [label, version] of versions) {
		const output = path.join(paths.root, "builds", label);
		const config = buildLabConfig({ ...paths, version, output, env });
		const configPath = path.join(paths.root, `builder-${label}.json`);
		await writeFile(configPath, JSON.stringify(config, null, 2));
		await run(path.join(repoRoot, "node_modules", ".bin", "electron-builder"), ["--mac", "zip", "--x64", "--publish", "never", "--config", configPath], { cwd: paths.source, env });
		await run(process.execPath, [path.join(repoRoot, "scripts", "verify-mac-signature.mjs"), "--release-dir", output, "--json"], { cwd: paths.source, env });
	}
}

export async function createLabFeed(directory, evidenceFile) {
	const files = new Map();
	for (const name of await require("node:fs/promises").readdir(directory)) {
		if (name === "latest-mac.yml" || name.endsWith(".zip") || name.endsWith(".blockmap")) files.set(`/${name}`, path.join(directory, name));
	}
	if (!files.has("/latest-mac.yml")) throw new Error("Real latest-mac.yml is missing");
	return createServer(async (request, response) => {
		const url = new URL(request.url, FEED_URL);
		const file = files.get(decodeURIComponent(url.pathname));
		if (evidenceFile) require("node:fs").appendFileSync(evidenceFile, `${JSON.stringify({ time: new Date().toISOString(), method: request.method, path: url.pathname, range: request.headers.range ?? null })}\n`);
		if (!file || !["GET", "HEAD"].includes(request.method)) {
			response.writeHead(404);
			response.end();
			return;
		}
		const size = (await stat(file)).size;
		let start = 0,
			end = size - 1;
		if (request.headers.range) {
			const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
			if (!match) {
				response.writeHead(416, { "Content-Range": `bytes */${size}` });
				response.end();
				return;
			}
			start = Number(match[1]);
			end = Math.min(match[2] ? Number(match[2]) : end, end);
			if (start > end || start >= size) {
				response.writeHead(416, { "Content-Range": `bytes */${size}` });
				response.end();
				return;
			}
		}
		const headers = { "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Type": file.endsWith(".yml") ? "text/yaml" : "application/zip" };
		if (request.headers.range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
		response.writeHead(request.headers.range ? 206 : 200, headers);
		if (request.method === "HEAD") response.end();
		else
			createReadStream(file, { start, end })
				.on("error", () => response.destroy())
				.pipe(response);
	});
}

async function main() {
	const paths = labPaths();
	const command = process.argv[2];
	if (command === "prepare") await prepare(paths);
	else if (command === "build") await build(paths);
	else if (command === "serve") {
		await mkdir(paths.evidence, { recursive: true });
		const labelIndex = process.argv.indexOf("--label");
		const label = labelIndex < 0 ? "B" : process.argv[labelIndex + 1];
		if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error("Invalid lab label");
		const server = await createLabFeed(path.join(paths.root, "builds", label), path.join(paths.evidence, "feed.jsonl"));
		server.listen(18766, "127.0.0.1", () => console.log(`Real update feed: ${FEED_URL}`));
	} else if (command === "install-a") {
		try {
			await access(paths.installedApp);
			throw new Error("Test app already exists; refusing to overwrite an installed version");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await mkdir(path.dirname(paths.installedApp), { recursive: true });
		await run("ditto", [path.join(paths.root, "builds", "A", "mac", `${APP_NAME}.app`), paths.installedApp]);
	} else if (command === "launch") {
		await run(path.join(paths.installedApp, "Contents", "MacOS", APP_NAME), [], { env: { ...process.env, PIDECK_E2E_WINDOW_MODE: "visible" }, cwd: paths.root });
	} else if (command === "status") {
		for (const file of ["runtime.jsonl", "feed.jsonl"]) {
			try {
				console.log(file, (await readFile(path.join(paths.evidence, file), "utf8")).trim().split("\n").slice(-12).join("\n"));
			} catch {
				console.log(file, "not yet created");
			}
		}
		const marker = await readFile(path.join(paths.userData, "upgrade-survival.txt"));
		console.log("Data marker SHA256:", createHash("sha256").update(marker).digest("hex"));
	} else throw new Error("Usage: node scripts/mac-upgrade-lab.mjs prepare|build|serve|install-a|launch|status");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
