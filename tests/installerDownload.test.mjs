/**
 * 安装包流式下载器：落盘内容、digest 校验、失败清理与文件名边界。
 * 这是 ChannelSwitchService 与手动应用更新共用的数据完整性底线。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const { downloadInstallerAsset } = createTsSandbox()("src/main/update/installerDownload.ts");

const CHUNKS = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
const EXPECTED = Buffer.concat(CHUNKS.map((chunk) => Buffer.from(chunk)));

function makeBody(chunks) {
	let index = 0;
	return {
		getReader() {
			return {
				read: async () => (index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }),
			};
		},
	};
}

function makeDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pideck-installer-download-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("streams to a part file, verifies digest, atomically renames, and reports monotonic progress", async (t) => {
	const dir = makeDir(t);
	const digest = `sha256:${createHash("sha256").update(EXPECTED).digest("hex")}`;
	const percents = [];
	const filePath = await downloadInstallerAsset({
		assetName: "PiDeck-1.2.3-arm64.dmg",
		assetUrl: "https://example.com/PiDeck-1.2.3-arm64.dmg",
		digestSha256: digest,
		targetDir: dir,
		netFetch: async () => ({ ok: true, status: 200, headers: { get: () => String(EXPECTED.length) }, body: makeBody(CHUNKS) }),
		onProgress: (progress) => percents.push(progress.percent),
	});

	assert.equal(filePath, join(dir, "PiDeck-1.2.3-arm64.dmg"));
	assert.deepEqual(readFileSync(filePath), EXPECTED);
	// 失败/成功都不留 part 文件：目录里只有最终安装包。
	assert.deepEqual(readdirSync(dir), ["PiDeck-1.2.3-arm64.dmg"]);
	assert.equal(percents.at(-1), 100);
	for (let index = 1; index < percents.length; index += 1) {
		assert.ok(percents[index] >= percents[index - 1], `percent 应单调：${percents}`);
	}
});

test("digest mismatch removes the part file and leaves no final installer", async (t) => {
	const dir = makeDir(t);
	await assert.rejects(
		() =>
			downloadInstallerAsset({
				assetName: "PiDeck-1.2.3-setup.exe",
				assetUrl: "https://example.com/PiDeck-1.2.3-setup.exe",
				digestSha256: "sha256:0000",
				targetDir: dir,
				netFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody(CHUNKS) }),
			}),
		/digest mismatch/,
	);
	assert.deepEqual(readdirSync(dir), []);
	assert.equal(existsSync(join(dir, "PiDeck-1.2.3-setup.exe")), false);
});

test("network failure and unsafe names/URLs never leave partial files", async (t) => {
	const dir = makeDir(t);
	await assert.rejects(
		() =>
			downloadInstallerAsset({
				assetName: "PiDeck-1.2.3.deb",
				assetUrl: "https://example.com/PiDeck-1.2.3.deb",
				targetDir: dir,
				netFetch: async () => {
					throw new Error("socket hang up");
				},
			}),
		/socket hang up/,
	);
	assert.deepEqual(readdirSync(dir), []);

	await assert.rejects(
		() =>
			downloadInstallerAsset({
				assetName: "../evil.exe",
				assetUrl: "https://example.com/evil.exe",
				targetDir: dir,
				netFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody(CHUNKS) }),
			}),
		/非法安装包文件名/,
	);
	await assert.rejects(
		() =>
			downloadInstallerAsset({
				assetName: "PiDeck-1.2.3.dmg",
				assetUrl: "http://example.com/PiDeck-1.2.3.dmg",
				targetDir: dir,
				netFetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: makeBody(CHUNKS) }),
			}),
		/非法下载地址/,
	);
	assert.deepEqual(readdirSync(dir), []);
});
