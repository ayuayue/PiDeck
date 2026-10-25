import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PATCH_MARKER, RENAME_RETRY_HELPER_SOURCE, applyElectronBuilderRenameRetryPatch, patchElectronGetRename } from "../scripts/patch-electron-builder-rename-retry.js";

// 回归测试：Windows 上解压 electron dist 后 `<dir>.tmp` → `<dir>` 的 rename 被外部进程
// （杀软/索引器）短暂占用报 EPERM，导致 npm run dist:win 直接失败。
// 见 scripts/patch-electron-builder-rename-retry.js 头注释（实测数据与触发条件）。

const SYNTHETIC_SOURCE = `"use strict";
const fs = require("fs/promises");
async function extractArchive(file, dir) {
    const tmpDir = dir + ".tmp";
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmpDir, dir);
}
`;

/** 用注入后的 helper 源码构造可单测的 renameWithRetry（fs / logger 可控） */
function createRenameWithRetry(renameImpl, warnLog) {
	const factory = new Function("fs", "builder_util_1", `${RENAME_RETRY_HELPER_SOURCE}\nreturn renameWithRetry;`);
	return factory({ rename: renameImpl }, { log: { warn: warnLog } });
}

function epermError() {
	return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

test("patchElectronGetRename 把 rename 调用换成 renameWithRetry 并在其前注入实现", () => {
	const patched = patchElectronGetRename(SYNTHETIC_SOURCE);
	assert.equal((patched.match(/await renameWithRetry\(tmpDir, dir\);/g) ?? []).length, 1, "调用点应改为 renameWithRetry");
	assert.equal((patched.match(/await fs\.rename\(tmpDir, dir\);/g) ?? []).length, 1, "原始 rename 应只剩重试实现内部那一次");
	assert.ok(patched.includes(PATCH_MARKER), "补丁标记用于幂等判断");
	assert.ok(patched.indexOf("async function renameWithRetry(") < patched.indexOf("async function extractArchive("), "重试实现必须注入在调用点之前");
});

test("patchElectronGetRename 幂等：已打过补丁的内容不再变换", () => {
	const once = patchElectronGetRename(SYNTHETIC_SOURCE);
	assert.equal(patchElectronGetRename(once), once);
});

test("patchElectronGetRename 对结构不符抛错（防止 app-builder-lib 升级后补丁静默失效）", () => {
	const withoutAnchor = `"use strict";
async function extractArchive(file, dir) {
    await fs.rename(dir, dir + ".bak");
}
`;
	assert.throws(() => patchElectronGetRename(withoutAnchor), /结构与补丁预期不符.*锚点数量 0/);
	const duplicated = `${SYNTHETIC_SOURCE}\nasync function other() {\n    await fs.rename(tmpDir, dir);\n}\n`;
	assert.throws(() => patchElectronGetRename(duplicated), /锚点数量 2/);
});

test("renameWithRetry 在瞬时 EPERM 后重试成功", async () => {
	const codes = ["EPERM", "EPERM", "EACCES"];
	const warnings = [];
	let calls = 0;
	const renameWithRetry = createRenameWithRetry(
		async (tmpDir, dir) => {
			calls += 1;
			assert.equal(tmpDir, "out.tmp");
			assert.equal(dir, "out");
			if (codes.length > 0) {
				throw Object.assign(new Error("rename blocked"), { code: codes.shift() });
			}
			return undefined;
		},
		(...args) => warnings.push(args),
	);
	await renameWithRetry("out.tmp", "out", { delayMs: 0 });
	assert.equal(calls, 4, "3 次瞬时失败后第 4 次应成功");
	assert.equal(warnings.length, 3, "每次重试都应记录一次 warn");
	assert.match(warnings[0][0].code, /EPERM/);
});

test("renameWithRetry 不重试非瞬时错误（如 ENOTEMPTY）", async () => {
	let calls = 0;
	const renameWithRetry = createRenameWithRetry(
		async () => {
			calls += 1;
			throw Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
		},
		() => {},
	);
	await assert.rejects(renameWithRetry("out.tmp", "out", { delayMs: 0 }), /directory not empty/);
	assert.equal(calls, 1, "非瞬时错误必须立刻抛出");
});

test("renameWithRetry 重试耗尽后抛原始 EPERM（不吞真实失败）", async () => {
	let calls = 0;
	const renameWithRetry = createRenameWithRetry(
		async () => {
			calls += 1;
			throw epermError();
		},
		() => {},
	);
	await assert.rejects(renameWithRetry("out.tmp", "out", { delayMs: 0, maxAttempts: 3 }), { code: "EPERM" });
	assert.equal(calls, 3);
});

test("已安装的 app-builder-lib 可被补丁（结构变化必须红灯而不是静默失效）", (t) => {
	const entry = new URL("../node_modules/app-builder-lib/out/util/electronGet.js", import.meta.url);
	if (!fs.existsSync(entry)) {
		t.skip("node_modules 缺少 app-builder-lib（生产安装）");
		return;
	}
	const original = fs.readFileSync(entry, "utf8");
	const patched = patchElectronGetRename(original);
	assert.equal((patched.match(/await renameWithRetry\(tmpDir, dir\);/g) ?? []).length, 1);
	assert.equal((patched.match(/await fs\.rename\(tmpDir, dir\);/g) ?? []).length, 1);
});

test("applyElectronBuilderRenameRetryPatch 对临时副本：首跑 patched，再跑 already-patched", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-rename-retry-"));
	const entry = path.join(dir, "electronGet.js");
	try {
		fs.writeFileSync(entry, SYNTHETIC_SOURCE);
		const log = { log: () => {}, warn: () => {} };
		const first = applyElectronBuilderRenameRetryPatch({ entry, log });
		assert.equal(first.status, "patched");
		assert.equal(first.file, entry);
		const onDisk = fs.readFileSync(entry, "utf8");
		assert.match(onDisk, /await renameWithRetry\(tmpDir, dir\);/);
		assert.equal(applyElectronBuilderRenameRetryPatch({ entry, log }).status, "already-patched");
		assert.equal(fs.readFileSync(entry, "utf8"), onDisk, "幂等调用不得再次改写文件");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyElectronBuilderRenameRetryPatch 模块缺失时只警告不抛错（安装期不得中断 npm install）", () => {
	const warnings = [];
	const result = applyElectronBuilderRenameRetryPatch({
		modulePath: "pideck-not-installed-xyz/out/util/electronGet.js",
		log: { log: () => {}, warn: (message) => warnings.push(message) },
	});
	assert.equal(result.status, "module-missing");
	assert.equal(warnings.length, 1);
});
