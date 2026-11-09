import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PATCH_MARKER, applyElectronBuilderKeychainPasswordPatch, patchMacCodeSignKeychainPassword } from "../scripts/patch-electron-builder-keychain-password.js";

// 回归测试：electron-builder 26.15.x 把 `.p12` 导入密码当成临时 keychain 密码传给
// `security set-key-partition-list -k`，在 macOS 26（Darwin 25）runner 上任何 CSC_LINK 签名
// 都会失败（Build macOS arm64，2026-11-09）。见 scripts/patch-electron-builder-keychain-password.js
// 头注释（上游 electron-builder#10066 / #10101，26.17.0 起正式修复）。

const SYNTHETIC_SOURCE = `"use strict";
async function createKeychain({ cscKeyPassword }) {
    const keychainPassword = "random-keychain-password";
    const cscPasswords = [cscKeyPassword];
    return await importCerts(keychainFile, certPaths, cscPasswords);
}
async function importCerts(keychainFile, paths, keyPasswords) {
    var _a;
    for (let i = 0; i < paths.length; i++) {
        const password = (_a = keyPasswords[i]) !== null && _a !== void 0 ? _a : "";
        await (0, builder_util_1.exec)("/usr/bin/security", ["import", paths[i], "-k", keychainFile, "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild", "-P", password]);
        await (0, builder_util_1.exec)("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);
    }
    return {
        keychainFile,
    };
}
`;

test("patchMacCodeSignKeychainPassword 把临时 keychain 密码传给 importCerts 与 set-key-partition-list", () => {
	const patched = patchMacCodeSignKeychainPassword(SYNTHETIC_SOURCE);
	assert.ok(patched.includes(PATCH_MARKER), "补丁标记用于幂等判断");
	assert.equal((patched.match(/importCerts\(keychainFile, certPaths, cscPasswords, keychainPassword\);/g) ?? []).length, 1, "调用点必须透传 keychainPassword");
	assert.equal((patched.match(/importCerts\(keychainFile, certPaths, cscPasswords\);/g) ?? []).length, 0, "旧调用点必须消失");
	assert.equal((patched.match(/async function importCerts\(keychainFile, paths, keyPasswords, keychainPassword\) \{/g) ?? []).length, 1, "函数声明必须接收 keychainPassword");
	assert.equal((patched.match(/"-k", keychainPassword, keychainFile/g) ?? []).length, 1, "set-key-partition-list 的 -k 必须是 keychain 密码");
	assert.equal((patched.match(/"-k", password, keychainFile/g) ?? []).length, 0, "不能再用 .p12 密码解锁 keychain");
	// `security import -P` 仍然是 .p12 自己的密码，不能被一起改掉。
	assert.equal((patched.match(/"-P", password\]/g) ?? []).length, 1, "p12 导入仍使用 p12 密码");
	assert.doesNotThrow(() => new Function(patched), "补丁后的源码必须仍是合法 JS");
});

test("patchMacCodeSignKeychainPassword 幂等：已打过补丁的内容不再变换", () => {
	const once = patchMacCodeSignKeychainPassword(SYNTHETIC_SOURCE);
	assert.equal(patchMacCodeSignKeychainPassword(once), once);
});

test("patchMacCodeSignKeychainPassword 对结构不符抛错（防止 app-builder-lib 升级后补丁静默失效）", () => {
	const withoutAnchor = `"use strict";
async function importCerts(keychainFile, paths, keyPasswords) {
    await exec("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]);
}
`;
	assert.throws(() => patchMacCodeSignKeychainPassword(withoutAnchor), /结构与补丁预期不符.*importCerts 调用点 锚点数量 0/);
	const duplicated = `${SYNTHETIC_SOURCE}\nasync function other(keychainFile) {\n    await exec("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]);\n}\n`;
	assert.throws(() => patchMacCodeSignKeychainPassword(duplicated), /set-key-partition-list 调用 锚点数量 2/);
});

test("已安装的 app-builder-lib 可被补丁（结构变化必须红灯而不是静默失效）", (t) => {
	const entry = new URL("../node_modules/app-builder-lib/out/codeSign/macCodeSign.js", import.meta.url);
	if (!fs.existsSync(entry)) {
		t.skip("node_modules 缺少 app-builder-lib（生产安装）");
		return;
	}
	const original = fs.readFileSync(entry, "utf8");
	// 幂等：无论 node_modules 是否已经被 postinstall 打过补丁，结果都必须满足修复后的形状。
	const patched = patchMacCodeSignKeychainPassword(original);
	assert.equal((patched.match(/"-k", password, keychainFile/g) ?? []).length, 0, "安装包里的 set-key-partition-list 仍使用错误密码");
	assert.equal((patched.match(/"-k", keychainPassword, keychainFile/g) ?? []).length, 1);
	assert.equal((patched.match(/"-P", password\]/g) ?? []).length, 1, "p12 导入密码必须保持原样");
});

test("applyElectronBuilderKeychainPasswordPatch 对临时副本：首跑 patched，再跑 already-patched", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pideck-keychain-password-"));
	const entry = path.join(dir, "macCodeSign.js");
	try {
		fs.writeFileSync(entry, SYNTHETIC_SOURCE);
		const log = { log: () => {}, warn: () => {} };
		const first = applyElectronBuilderKeychainPasswordPatch({ entry, log });
		assert.equal(first.status, "patched");
		assert.equal(first.file, entry);
		const onDisk = fs.readFileSync(entry, "utf8");
		assert.match(onDisk, /"-k", keychainPassword, keychainFile/);
		assert.equal(applyElectronBuilderKeychainPasswordPatch({ entry, log }).status, "already-patched");
		assert.equal(fs.readFileSync(entry, "utf8"), onDisk, "幂等调用不得再次改写文件");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyElectronBuilderKeychainPasswordPatch 模块缺失时只警告不抛错（安装期不得中断 npm install）", () => {
	const warnings = [];
	const result = applyElectronBuilderKeychainPasswordPatch({
		modulePath: "pideck-not-installed-xyz/out/codeSign/macCodeSign.js",
		log: { log: () => {}, warn: (message) => warnings.push(message) },
	});
	assert.equal(result.status, "module-missing");
	assert.equal(warnings.length, 1);
});
