import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 本地图片字节读取（`local-image:read-bytes`）的拒绝原因。
 *
 * 回归来历（issue #535 第二段）：`readLocalImageBytes` 以前五条失败路径都返回 null，
 * 界面统一是「图片加载失败」，日志里一条都没有——用户报「相对路径图片不显示」时
 * 无法区分「路径拼错」「不在白名单」「文件不存在」「超过 32MiB」。判定本身没变，
 * 这里钉住的是「每种失败都能说出原因」，以及 IPC 侧真的把原因写进日志。
 */

const { readLocalImageBytes, readBoundedImageFile, readBoundedImageFileOutcome } = loadTsCommonJs("src/main/media/localImageRead.ts");

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 判定结果来自 vm 沙箱里的另一个 realm：跨 realm 对象 deepStrictEqual 会因原型不同而假红，只比字段。 */
const reasonOf = (result) => (result.ok ? "ok" : result.reason);
const MIB = 1024 * 1024;

async function writeSparse(path, bytes) {
	const handle = await open(path, "w");
	try {
		await handle.truncate(bytes);
	} finally {
		await handle.close();
	}
}

/** 一处白名单根 + 一处根外目录；用例共用，只读不写。 */
async function fixture(t) {
	// 白名单根按生产口径已是真实路径（CanonicalRootsProvider）；Windows 的 8.3 短名（RUNNER~1）在此展开，
	// 否则 readLocalImageBytes 的 realpath 结果与根字符串不一致，根内图片会被误判 outside-roots。
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pideck-local-image-reasons-")));
	const root = join(base, "project");
	const outside = join(base, "outside");
	mkdirSync(join(root, "dir.png"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "ok.png"), PNG_BYTES);
	writeFileSync(join(root, "note.txt"), "not an image\n");
	writeFileSync(join(outside, "outside.png"), PNG_BYTES);
	await writeSparse(join(root, "huge.png"), 33 * MIB);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const roots = async () => [root];
	return { root, outside, roots };
}

test("白名单内的图片照常读出字节与 mime", async (t) => {
	const { root, roots } = await fixture(t);
	const result = await readLocalImageBytes(join(root, "ok.png"), roots);
	assert.equal(result.ok, true);
	assert.equal(result.mimeType, "image/png");
	assert.deepEqual(Array.from(result.bytes), Array.from(PNG_BYTES));
});

test("形态闸与扩展名拒绝分开报：相对路径是 shape，非图片扩展名是 unsupported-type", async (t) => {
	const { root, roots } = await fixture(t);
	assert.equal(reasonOf(await readLocalImageBytes("ok.png", roots)), "shape");
	assert.equal(reasonOf(await readLocalImageBytes("", roots)), "shape");
	assert.equal(reasonOf(await readLocalImageBytes(join(root, "note.txt"), roots)), "unsupported-type");
});

test("文件不存在报 unresolvable，而不是笼统的 null", async (t) => {
	const { root, roots } = await fixture(t);
	assert.equal(reasonOf(await readLocalImageBytes(join(root, "missing.png"), roots)), "unresolvable");
});

test("根外图片报 outside-roots", async (t) => {
	const { outside, roots } = await fixture(t);
	assert.equal(reasonOf(await readLocalImageBytes(join(outside, "outside.png"), roots)), "outside-roots");
});

test("超过体积闸报 too-large（32MiB 之上只看 stat，不整读）", async (t) => {
	const { root, roots } = await fixture(t);
	assert.equal(reasonOf(await readLocalImageBytes(join(root, "huge.png"), roots)), "too-large");
});

test("不是普通文件报 unreadable", async (t) => {
	const { root, roots } = await fixture(t);
	assert.equal(reasonOf(await readLocalImageBytes(join(root, "dir.png"), roots)), "unreadable");
});

test("有界读取的 null 口径不变，诊断口径带回原因", async (t) => {
	const { root } = await fixture(t);
	const sized = join(root, "ok.png");
	assert.equal(await readBoundedImageFile(sized, 2), null, "协议侧仍按 null 判失败");
	assert.equal(reasonOf(await readBoundedImageFileOutcome(sized, 2)), "too-large");
	assert.equal(await readBoundedImageFile(join(root, "missing.png"), 8), null);
	assert.equal(reasonOf(await readBoundedImageFileOutcome(join(root, "missing.png"), 8)), "unreadable");
	const fits = await readBoundedImageFileOutcome(sized, PNG_BYTES.length);
	assert.equal(fits.ok, true);
	assert.deepEqual(Array.from(fits.bytes), Array.from(PNG_BYTES));
});

test("IPC 拒绝时把原因与请求路径写进 debug 日志，渲染层仍拿 null", async (t) => {
	const { root, outside, roots } = await fixture(t);
	const handlers = new Map();
	const debugCalls = [];
	const { registerLocalImageIpc } = loadTsCommonJs("src/main/ipc/localImageIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerLocalImageIpc({ resolveRoots: roots, appLogger: { debug: (scope, message, detail) => void debugCalls.push({ scope, message, detail }) } });
	const [channel, handler] = [...handlers][0];
	const requestPath = join(outside, "outside.png");
	assert.equal(await handler(null, requestPath), null);
	assert.equal(debugCalls.length, 1);
	assert.equal(debugCalls[0].scope, "local-image");
	assert.equal(debugCalls[0].detail.reason, "outside-roots");
	assert.equal(debugCalls[0].detail.path, requestPath);
	const invalid = await handler(null, 42);
	assert.equal(invalid, null);
	assert.equal(debugCalls[1].detail.reason, "invalid-input");
	assert.ok(typeof channel === "string" && channel.length > 0);
	const served = await handler(null, join(root, "ok.png"));
	assert.equal(served.mimeType, "image/png");
	assert.equal(Buffer.from(served.data, "base64").equals(PNG_BYTES), true);
	assert.equal(debugCalls.length, 2, "成功读取不写日志");
});
