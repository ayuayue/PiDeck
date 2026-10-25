import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { collectSdkClosure } from "../scripts/pack-feishu-sdk.mjs";

/**
 * 飞书 SDK 打包链路守卫（体积优化，2026-10）。
 *
 * 事实来源三处必须一致：
 * 1. `package.json` 的 build.files 排除掉 SDK 及其独占依赖（否则 tar.gz 白打，asar 仍占 7.2MB）；
 * 2. `resources/feishu-sdk/manifest.json` 的 sha256 与 tar.gz 实体一致（运行时校验会拒绝不一致）；
 * 3. manifest.packages 必须等于 package-lock 算出的闭包（SDK 升级后忘了重打 = 解压出缺依赖的包）。
 *
 * 共性依赖（qs/mime-db/mime-types/call-bind 链）不能排除：它们还被 MCP SDK 等使用。
 */

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const manifest = JSON.parse(readFileSync("resources/feishu-sdk/manifest.json", "utf8"));
const archivePath = `resources/feishu-sdk/${manifest.archive}`;

function rootClosure() {
	const seen = new Set();
	const walk = (name) => {
		if (seen.has(name)) return;
		const entry = lock.packages[`node_modules/${name}`];
		if (!entry) return;
		seen.add(name);
		for (const dep of Object.keys(entry.dependencies ?? {})) walk(dep);
	};
	const root = lock.packages[""];
	for (const name of [...Object.keys(root.dependencies ?? {}), ...Object.keys(root.optionalDependencies ?? {})]) {
		if (name !== "@larksuiteoapi/node-sdk") walk(name);
	}
	return seen;
}

test("飞书 SDK 与其独占依赖已从 app.asar 排除", () => {
	const files = pkg.build.files;
	const exclusive = [...collectSdkClosure(lock)].filter((name) => !rootClosure().has(name));
	assert.ok(exclusive.length > 20, `独占包数量异常：${exclusive.length}`);
	for (const name of exclusive) {
		const scope = name.startsWith("@") ? name.split("/")[0] : name;
		assert.ok(
			files.some((pattern) => pattern === `!node_modules/${name}/**` || pattern === `!node_modules/${scope}/**`),
			`build.files 缺少排除项：${name}（否则 SDK 仍会占 asar 体积）`,
		);
	}
});

test("共用依赖没有被误排除（qs/mime-db 等仍被 MCP 使用）", () => {
	const files = pkg.build.files;
	for (const shared of ["qs", "mime-db", "mime-types"]) {
		assert.ok(!files.includes(`!node_modules/${shared}/**`), `${shared} 被其他运行时包共用，不能排除`);
	}
});

test("压缩包随包分发，且 sha256 与 manifest 一致", () => {
	assert.ok(existsSync(archivePath), `缺少飞书 SDK 产物：${archivePath}（跑 npm run build:feishu-sdk）`);
	const bytes = readFileSync(archivePath);
	assert.equal(bytes.length, manifest.bytes);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.sha256);
	assert.ok(bytes.length < 4 * 1024 * 1024, "压缩包体积异常，压缩链路可能失效");
});

test("压缩包条目不含墙钟元数据（mtime 归零，换机/重装 npm ci 后 sha256 不抖动）", () => {
	// tar 7 的 portable 只对目录条目置 noMtime，文件条目默认嵌入 stat.mtime（Windows/Linux
	// 各自一份），于是同一份 node_modules 内容在不同机器/重装后打包出不同 sha256。
	// 跨 OS 的 mode 归一化仍依赖平台，所以 CI 不重打包比对，只锁死这一条：头里不许有 mtime。
	const tar = gunzipSync(readFileSync(archivePath));
	const mtimes = new Set();
	let offset = 0;
	let entries = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break; // 归档结束的零块
		mtimes.add(header.subarray(136, 148).toString("latin1"));
		const size = Number.parseInt(header.subarray(124, 136).toString("latin1").trim() || "0", 8);
		offset += 512 + Math.ceil(size / 512) * 512;
		entries += 1;
	}
	assert.equal(entries, manifest.files, "tar 条目数与 manifest.files 不一致（目录 + 文件）");
	assert.deepEqual([...mtimes], ["\0".repeat(12)], "tar 头里嵌入 mtime：产物跟着 node_modules 安装时间变，sha256 不可复现");
});

test("manifest 的包清单与 package-lock 闭包一致（SDK 升级未重打会被抓住）", () => {
	assert.deepEqual([...manifest.packages].sort(), [...collectSdkClosure(lock)].sort());
	assert.equal(manifest.version, lock.packages["node_modules/@larksuiteoapi/node-sdk"].version);
});

test("构建链与 extraResources 已接线", () => {
	assert.match(pkg.scripts.build, /build:feishu-sdk/);
	assert.equal(pkg.scripts["build:feishu-sdk"], "node scripts/pack-feishu-sdk.mjs");
	const entry = pkg.build.extraResources.find((item) => item.to === "feishu-sdk");
	assert.ok(entry, "extraResources 缺少 feishu-sdk");
	assert.equal(entry.from, "resources/feishu-sdk");
	assert.deepEqual([...entry.filter].sort(), ["*.tar.gz", "manifest.json"]);
});
