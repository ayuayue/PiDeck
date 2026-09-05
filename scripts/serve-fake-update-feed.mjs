#!/usr/bin/env node
/**
 * 临时脚本：本地 fake update feed —— 手动冒烟 electron-updater 全链路，不发新版。
 *
 * 场景：临时把 package.json 版本改小（如 0.0.1）→ npm run pack → 本脚本起本地 feed，
 * 提供比当前版本大一个 patch 的 latest.yml + 假 setup.exe（真实 sha512、支持 Range 下载），
 * 然后设 PIDEK_UPDATE_FEED_URL + PIDECK_E2E=1 启动 release/win-unpacked/PiDeck.exe 即可触发更新。
 *
 * 用法：
 *   node scripts/serve-fake-update-feed.mjs [--port 18765] [--version 0.0.2] [--launch]
 *
 * 参数：
 *   --port     监听端口（默认 18765，0 = 随机并打印实际端口）
 *   --version  覆盖 feed 里的"新版本号"；缺省取 package.json 版本的下一个 patch
 *   --launch   自动带环境变量启动 release/win-unpacked/PiDeck.exe（推荐）——
 *              避免 PowerShell/cmd 里手设环境变量不生效的坑（PowerShell 的
 *              set 只是 Set-Variable 别名，不会传给子进程，导致 updater 报
 *              ENOENT app-update.yml）
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ---- 参数解析 ------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(name, fallback) {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const port = Number.parseInt(argValue("port", "18765"), 10);

// feed 版本：默认取 package.json 的下一个 patch（与 e2e/update-flow.spec.ts 的
// nextPatchVersion 一致），也可用 --version 覆盖。改小本地版本号后无需手动对齐。
const packageVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
function nextPatchVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) throw new Error(`版本号不是 semver 格式: ${version}`);
	return `${match[1]}.${match[2]}.${Number.parseInt(match[3], 10) + 1}`;
}
const UPDATE_VERSION = argValue("version", nextPatchVersion(packageVersion));
const UPDATE_FILE = `PiDeck-${UPDATE_VERSION}-setup.exe`;

// ---- 假安装包：固定内容 + 真实 sha512 -------------------------------------
// 内容不必是有效安装器——electron-updater 只校验 sha512 与 size；E2E 验证过
// 下载到 ready 不需要真实安装器（真正点「重启并安装」才会执行它，冒烟测到 ready 即止）。
const UPDATE_BYTES = Buffer.from(
	`PiDeck fake update payload for local smoke test\n${UPDATE_VERSION}\n` + "x".repeat(64 * 1024),
	"utf8",
);
const UPDATE_SHA512 = createHash("sha512").update(UPDATE_BYTES).digest("base64");

// ---- HTTP server（latest.yml + 带 Range 的安装包下载）---------------------
// Range 处理与 e2e/update-flow.spec.ts 的 serveArtifact 相同：electron-updater
// 下载时会发 bytes=start-end 分片请求，必须回 206 + Content-Range。
function writeResponse(response, status, body, headers) {
	response.writeHead(status, { "Cache-Control": "no-store", ...headers });
	response.end(body);
}

function serveArtifact(request, response) {
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

const server = createServer((request, response) => {
	const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	console.log(`[feed] ${request.method} ${pathname}`);
	if (pathname === "/latest.yml") {
		const manifest = [
			`version: ${UPDATE_VERSION}`,
			"files:",
			`  - url: ${UPDATE_FILE}`,
			`    sha512: ${UPDATE_SHA512}`,
			`    size: ${UPDATE_BYTES.length}`,
			`path: ${UPDATE_FILE}`,
			`sha512: ${UPDATE_SHA512}`,
			`releaseDate: "${new Date().toISOString()}"`,
			"",
		].join("\n");
		writeResponse(response, 200, manifest, { "Content-Type": "text/yaml; charset=utf-8" });
		return;
	}
	if (pathname === `/${UPDATE_FILE}`) {
		serveArtifact(request, response);
		return;
	}
	// electron-updater 的差分下载会尝试 .blockmap；本地冒烟设 PIDECK_E2E=1
	// 会关闭差分（disableDifferentialDownload），所以这里直接 404 即可。
	writeResponse(response, 404, "not found", { "Content-Type": "text/plain; charset=utf-8" });
});

server.listen(port, "127.0.0.1", () => {
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	console.log("================================================================");
	console.log(`本地 fake feed 已启动: http://127.0.0.1:${actualPort}`);
	console.log(`  feed 版本        : v${UPDATE_VERSION}（当前 package.json: v${packageVersion}）`);
	console.log(`  安装包          : ${UPDATE_FILE}（${UPDATE_BYTES.length} bytes，sha512 已生成）`);
	console.log("================================================================");
	console.log("用法（另开一个终端）：");
	console.log(`  set PIDEK_UPDATE_FEED_URL=http://127.0.0.1:${actualPort}`);
	console.log("  set PIDECK_E2E=1");
	console.log("  release/win-unpacked/PiDeck.exe   ← electron-builder 输出在 release/，不是 out/");
	console.log("---------------------------------------------------------------");
	console.log("然后设置页 → 开发设置 → 点「检测更新」，看到 v" + UPDATE_VERSION +
		" 已下载即可（不要点「重启并安装」，会真执行假安装器）。");
	console.log("---------------------------------------------------------------");
	console.log("更省事的方式：直接 `node scripts/serve-fake-update-feed.mjs --launch`——");
	console.log("脚本会带 PIDEK_UPDATE_FEED_URL + PIDECK_E2E=1 环境变量自动启动 exe，");
	console.log("不用手设环境变量（PowerShell 的 set 不会传环境变量给子进程，容易踩坑）。");
	console.log("Ctrl+C 停止本 feed。");

	// --launch：spawn 时显式注入 env，绕开 shell 环境变量传递差异（尤其 PowerShell）。
	// exe 读到 PIDEK_UPDATE_FEED_URL 后走 setFeedURL(generic)，不会再碰 app-update.yml。
	if (args.includes("--launch")) {
		const exePath = join(process.cwd(), "release", "win-unpacked", "PiDeck.exe");
		if (!existsSync(exePath)) {
			console.error(`[launch] 未找到 ${exePath}，请先 npm run pack`);
			process.exit(1);
		}
		const child = spawn(exePath, [], {
			stdio: "inherit",
			env: {
				...process.env,
				PIDEK_UPDATE_FEED_URL: `http://127.0.0.1:${actualPort}`,
				PIDECK_E2E: "1",
			},
		});
		child.on("error", (error) => console.error(`[launch] 启动失败: ${error.message}`));
		console.log(`[launch] 已启动 ${exePath}（PIDEK_UPDATE_FEED_URL + PIDECK_E2E=1 已注入）`);
	}
});

server.on("error", (error) => {
	console.error(`[feed] 启动失败: ${error.message}`);
	process.exit(1);
});
