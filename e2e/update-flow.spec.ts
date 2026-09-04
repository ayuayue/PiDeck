import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { test, expect } from "./fixtures";

function readAppUnderTestVersion(): string {
	const packagePath = process.env.PIDEK_E2E_EXECUTABLE_PATH
		? join(process.cwd(), "package.json")
		: join(process.cwd(), "node_modules", "electron", "package.json");
	const packageJson: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
	if (
		typeof packageJson !== "object" ||
		packageJson === null ||
		!("version" in packageJson) ||
		typeof packageJson.version !== "string"
	) {
		throw new Error(`Unable to read the tested app version from ${packagePath}.`);
	}
	return packageJson.version;
}

function nextPatchVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) throw new Error(`Electron version is not semver-compatible: ${version}`);
	return `${match[1]}.${match[2]}.${Number.parseInt(match[3], 10) + 1}`;
}

// The default fixture starts Electron directly, whose app version is Electron's version.
// Packaged verification sets PIDEK_E2E_EXECUTABLE_PATH, so use PiDeck's package version instead.
// Generate a valid next patch at runtime for the local generic feed in both modes.
const CURRENT_APP_VERSION = readAppUnderTestVersion();
const UPDATE_VERSION = nextPatchVersion(CURRENT_APP_VERSION);
const UPDATE_FILE = `PiDeck-${UPDATE_VERSION}-setup.exe`;
const UPDATE_BYTES = Buffer.from("PiDeck electron-updater E2E fixture payload\n", "utf8");
const UPDATE_SHA512 = createHash("sha512").update(UPDATE_BYTES).digest("base64");

let feedServer: Server | null = null;
let feedUrl = "";
let previousFeedUrl: string | undefined;
const feedRequests: string[] = [];

function writeResponse(response: ServerResponse, status: number, body: Buffer | string, headers: Record<string, string>): void {
	response.writeHead(status, {
		"Cache-Control": "no-store",
		...headers,
	});
	response.end(body);
}

function serveArtifact(request: IncomingMessage, response: ServerResponse): void {
	const range = request.headers.range;
	if (!range) {
		writeResponse(response, 200, UPDATE_BYTES, {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(UPDATE_BYTES.length),
		});
		return;
	}
	const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
	if (!match) {
		writeResponse(response, 416, "", { "Content-Range": `bytes */${UPDATE_BYTES.length}` });
		return;
	}
	const start = Number.parseInt(match[1], 10);
	const requestedEnd = match[2] ? Number.parseInt(match[2], 10) : UPDATE_BYTES.length - 1;
	const end = Math.min(requestedEnd, UPDATE_BYTES.length - 1);
	if (start >= UPDATE_BYTES.length || start > end) {
		writeResponse(response, 416, "", { "Content-Range": `bytes */${UPDATE_BYTES.length}` });
		return;
	}
	const chunk = UPDATE_BYTES.subarray(start, end + 1);
	writeResponse(response, 206, chunk, {
		"Accept-Ranges": "bytes",
		"Content-Type": "application/octet-stream",
		"Content-Length": String(chunk.length),
		"Content-Range": `bytes ${start}-${end}/${UPDATE_BYTES.length}`,
	});
}

function createFeedServer(): Server {
	return createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		feedRequests.push(pathname);
		if (pathname === "/latest.yml") {
			const manifest = [
				`version: ${UPDATE_VERSION}`,
				"files:",
				`  - url: ${UPDATE_FILE}`,
				`    sha512: ${UPDATE_SHA512}`,
				`    size: ${UPDATE_BYTES.length}`,
				`path: ${UPDATE_FILE}`,
				`sha512: ${UPDATE_SHA512}`,
				`releaseDate: \"2026-09-04T00:00:00.000Z\"`,
				"",
			].join("\n");
			writeResponse(response, 200, manifest, { "Content-Type": "text/yaml; charset=utf-8" });
			return;
		}
		if (pathname === `/${UPDATE_FILE}`) {
			serveArtifact(request, response);
			return;
		}
		writeResponse(response, 404, "not found", { "Content-Type": "text/plain; charset=utf-8" });
	});
}

async function closeServer(server: Server): Promise<void> {
	server.close();
	await once(server, "close");
}

test.skip(process.platform !== "win32", "NSIS/electron-updater end-to-end path is exercised on Windows only.");
test.use({ seedSettings: { autoDownloadUpdates: true } });

test.beforeAll(async () => {
	feedServer = createFeedServer();
	await new Promise<void>((resolve, reject) => {
		feedServer?.once("error", reject);
		feedServer?.listen(0, "127.0.0.1", () => resolve());
	});
	const address = feedServer.address();
	if (!address || typeof address === "string") throw new Error("Update E2E feed did not bind a TCP port.");
	feedUrl = `http://127.0.0.1:${address.port}`;
	previousFeedUrl = process.env.PIDEK_UPDATE_FEED_URL;
	process.env.PIDEK_UPDATE_FEED_URL = feedUrl;
});

test.afterAll(async () => {
	if (previousFeedUrl === undefined) delete process.env.PIDEK_UPDATE_FEED_URL;
	else process.env.PIDEK_UPDATE_FEED_URL = previousFeedUrl;
	if (feedServer) await closeServer(feedServer);
	feedServer = null;
});

/**
 * app (development or win-unpacked) -> local generic feed -> electron-updater checksum
 * download -> UpdateService ready snapshot -> settings card. It deliberately does not call
 * installUpdate(), because that would terminate the Playwright application; the
 * main-process fake-updater test covers the one-shot quitAndInstall call.
 */
test("background update downloads a verified local installer and becomes ready", async ({ window }) => {
	feedRequests.length = 0;
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	const appInfo = await window.evaluate(async () => window.piDesktop.app.info());
	expect(appInfo.version).toBe(CURRENT_APP_VERSION);

	await window.evaluate(async () => {
		await window.piDesktop.app.checkUpdate();
	});

	await expect.poll(() => feedRequests.includes("/latest.yml"), { timeout: 10_000 }).toBe(true);
	await expect.poll(() => feedRequests.includes(`/${UPDATE_FILE}`), { timeout: 10_000 }).toBe(true);

	await expect.poll(
		async () =>
			window.evaluate(async () => {
				const snapshot = await window.piDesktop.app.getUpdateStatus();
				return snapshot?.app?.download.phase ?? null;
			}),
		{ timeout: 30_000 },
	).toBe("ready");

	const status = await window.evaluate(async () => window.piDesktop.app.getUpdateStatus());
	expect(status).toMatchObject({
		deliveryMode: "automatic",
		autoDownload: true,
		app: {
			latestVersion: UPDATE_VERSION,
			hasUpdate: true,
			download: {
				phase: "ready",
				version: UPDATE_VERSION,
				percent: 100,
			},
		},
	});

	const settingsButton = window.getByRole("button", { name: "设置（有新版本可用）" });
	await expect(settingsButton).toBeVisible();
	await settingsButton.click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByText("开发设置").click();
	await expect(modal.getByText(`v${UPDATE_VERSION} 已下载，可重启安装。`)).toBeVisible();
	await expect(modal.getByRole("button", { name: "重启并安装" })).toBeVisible();
});
