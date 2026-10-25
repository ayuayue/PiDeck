// 项目外路径打开的分级策略（src/renderer/src/utils/externalPathAccessPolicy.ts）。
//
// 契约：安全等级决定「项目外链接」是直接打开 / 二次确认 / 拒绝。
// - denyDirs 是用户显式禁地 → 一律拒绝（不提供确认出口）；
// - 敏感文件（受保护时）与「等级限定目录但不在范围内」→ 二次确认；
// - 等级不限制目录（off / standard）或命中允许目录 → 直接打开；
// - 目录与「文件管理器定位」例外：只唤起系统文件管理器（不读内容、不执行），除 denyDirs 外一律直接打开；
// 两者由 targetKind（file / directory / reveal）区分，而不是靠路径位置。
// 主进程 evaluatePathAction 是工具调用的边界，本模块只是 UI 的用户意图门，两者规则同序。

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { evaluateExternalPathAccess, isExecutableLikePath, matchesSensitiveFilePath, resolveSessionSecurityLevel } = loadTsCommonJs("src/renderer/src/utils/externalPathAccessPolicy.ts");
const { createDefaultSecurityConfig } = loadTsCommonJs("src/shared/types/security.ts");

/** loadTsCommonJs 在独立 VM realm 执行：对象原型不同，deepStrictEqual 会报「same structure but not reference-equal」，统一用 JSON 比较。 */
const check = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

/** 构造等级配置：只写关心的字段，其余取保守默认（与内置等级字段集一致）。 */
function level(overrides) {
	return {
		id: "custom",
		name: "custom",
		description: "",
		toolActions: {},
		denyBashPatterns: [],
		pathPolicy: "unrestricted",
		customAllowDirs: [],
		denyDirs: [],
		protectSensitivePaths: false,
		defaultAction: "allow",
		...overrides,
	};
}

function config(levels, extra = {}) {
	return { enabled: true, defaultLevelId: levels[0].id, levels, sessionOverrides: {}, ...extra };
}

const PROJECT = "D:\\work\\app";
const OUTSIDE = "D:\\Documents\\netherlink\\AGENTS.md";

test("会话级覆盖优先于全局默认，未知 id 回退 standard", () => {
	const standard = level({ id: "standard" });
	const strict = level({ id: "strict", pathPolicy: "workspace" });
	const cfg = config([standard, strict], { defaultLevelId: "standard", sessionOverrides: { s1: "strict" } });
	assert.equal(resolveSessionSecurityLevel(cfg, "s1").id, "strict");
	assert.equal(resolveSessionSecurityLevel(cfg, "s2").id, "standard");
	const broken = config([strict]);
	broken.defaultLevelId = "ghost";
	assert.equal(resolveSessionSecurityLevel(broken, "s2").id, "strict");
	assert.equal(resolveSessionSecurityLevel({ enabled: true, defaultLevelId: "x", levels: [], sessionOverrides: {} }, "s1"), null);
});

test("敏感文件匹配覆盖 .env / .git / 密钥，普通文件不命中", () => {
	for (const path of ["D:\\work\\app\\.env", "D:\\work\\app\\.env.local", "D:\\work\\app\\.git\\config", "C:\\Users\\me\\.ssh\\id_rsa", "C:\\certs\\site.pem", "a\\b\\server.key"]) {
		assert.equal(matchesSensitiveFilePath(path), true, `${path} should be sensitive`);
	}
	for (const path of ["D:\\work\\app\\env.txt", "D:\\work\\app\\AGENTS.md", "D:\\work\\app\\main.ts", "D:\\work\\app\\gitignore.md", "C:\\certs\\site.pemx"]) {
		assert.equal(matchesSensitiveFilePath(path), false, `${path} should not be sensitive`);
	}
});

test("未启用安全管理或配置读不到时的兜底", () => {
	check(evaluateExternalPathAccess({ config: null, filePath: OUTSIDE }), { access: "ask", reason: "policy-unavailable" });
	// 出厂默认配置：enabled=true + 默认等级 off（内置 off 的 protectSensitivePaths=false）
	check(evaluateExternalPathAccess({ config: createDefaultSecurityConfig(), filePath: OUTSIDE }), { access: "allow", reason: "unrestricted" });
	check(evaluateExternalPathAccess({ config: { ...createDefaultSecurityConfig(), enabled: false }, filePath: OUTSIDE }), { access: "allow", reason: "security-disabled" });
});

test("等级不限目录（off）时项目外普通文件与敏感文件都直接放行", () => {
	const off = level({ id: "off", pathPolicy: "unrestricted", protectSensitivePaths: false });
	const cfg = config([off]);
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE }), { access: "allow", reason: "unrestricted" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: "D:\\work\\other\\.env" }), { access: "allow", reason: "unrestricted" });
});

test("标准等级：项目外普通文件直接打开，敏感文件二次确认", () => {
	const standard = level({ id: "standard", pathPolicy: "unrestricted", protectSensitivePaths: true });
	const cfg = config([standard]);
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE }), { access: "allow", reason: "unrestricted" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: "D:\\work\\other\\.env" }), { access: "ask", reason: "sensitive" });
});

test("denyDirs 黑名单优先于放行判定，且支持相对目录按工作目录展开", () => {
	const standard = level({ id: "standard", pathPolicy: "unrestricted", denyDirs: ["D:\\secrets", "private"] });
	const cfg = config([standard]);
	check(evaluateExternalPathAccess({ config: cfg, filePath: "D:\\secrets\\note.md" }), { access: "deny", reason: "deny-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: "d:/SECRETS/sub/note.md" }), { access: "deny", reason: "deny-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: `${PROJECT}\\private\\note.md`, cwd: PROJECT }), { access: "deny", reason: "deny-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE }), { access: "allow", reason: "unrestricted" });
});

test("严格等级：仅工作目录放行，项目外普通文件也要二次确认", () => {
	const strict = level({ id: "strict", pathPolicy: "workspace", protectSensitivePaths: true, defaultAction: "deny" });
	const cfg = config([strict]);
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE, cwd: PROJECT, projectRoot: PROJECT }), { access: "ask", reason: "outside-allowed-dirs" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: `${PROJECT}\\src\\a.ts`, cwd: PROJECT }), { access: "allow", reason: "allowed-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: `${PROJECT}\\src\\a.ts`, projectRoot: PROJECT }), { access: "allow", reason: "allowed-dir" });
});

test("custom 等级：命中 customAllowDirs 直接放行，否则二次确认", () => {
	const custom = level({ id: "custom", pathPolicy: "custom", customAllowDirs: ["D:\\shared", "scratch"] });
	const cfg = config([custom]);
	check(evaluateExternalPathAccess({ config: cfg, filePath: "D:\\shared\\a.md", cwd: PROJECT }), { access: "allow", reason: "allowed-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: "d:/shared/nested/b.md", cwd: PROJECT }), { access: "allow", reason: "allowed-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: `${PROJECT}\\scratch\\x.md`, cwd: PROJECT }), { access: "allow", reason: "allowed-dir" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE, cwd: PROJECT }), { access: "ask", reason: "outside-allowed-dirs" });
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE, cwd: PROJECT, projectRoot: PROJECT }), { access: "ask", reason: "outside-allowed-dirs" });
});

test("会话 override 决定分屏两栏各自的判定", () => {
	const off = level({ id: "off", pathPolicy: "unrestricted" });
	const strict = level({ id: "strict", pathPolicy: "workspace" });
	const cfg = config([off, strict], { defaultLevelId: "off", sessionOverrides: { "strict-session": "strict" } });
	check(evaluateExternalPathAccess({ config: cfg, sessionId: "off-session", filePath: OUTSIDE, cwd: PROJECT }), { access: "allow", reason: "unrestricted" });
	check(evaluateExternalPathAccess({ config: cfg, sessionId: "strict-session", filePath: OUTSIDE, cwd: PROJECT }), { access: "ask", reason: "outside-allowed-dirs" });
});

// 目录例外：打开目录 = `files:open` → `shell.openPath` 唤起系统文件管理器，内容不进 PiDeck、
// 也没有执行语义，所以不该为「打开文件夹」弹确认框；只有用户显式列进 denyDirs 的禁地仍拒绝。
test("项目外目录：不参与项目边界与敏感模式，除 denyDirs 外一律直接打开", () => {
	const strict = level({ id: "strict", pathPolicy: "workspace", protectSensitivePaths: true, defaultAction: "deny" });
	const cfg = config([strict]);
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE, cwd: PROJECT, projectRoot: PROJECT, targetKind: "directory" }), { access: "allow", reason: "directory" });
	// 目录名带 .ssh / .git 也只算目录：敏感模式判的是文件内容，对目录不适用
	check(evaluateExternalPathAccess({ config: cfg, filePath: "C:\\Users\\me\\.ssh", targetKind: "directory" }), { access: "allow", reason: "directory" });
	// 不传 targetKind 时默认按文件（旧行为），因此敏感目录名不会被当成目录放行
	check(evaluateExternalPathAccess({ config: cfg, filePath: "C:\\Users\\me\\.ssh\\id_rsa" }), { access: "ask", reason: "sensitive" });
	// 配置读不到 / 安全管理关闭时同样直接打开（没有可依据的黑名单，且动作本身无风险）
	check(evaluateExternalPathAccess({ config: null, filePath: OUTSIDE, targetKind: "directory" }), { access: "allow", reason: "directory" });
	check(evaluateExternalPathAccess({ config: { ...createDefaultSecurityConfig(), enabled: false }, filePath: OUTSIDE, targetKind: "directory" }), { access: "allow", reason: "directory" });
	// denyDirs 对目录也生效：用户显式列为禁地的目录不提供「打开文件夹」出口
	const denied = level({ id: "standard", pathPolicy: "unrestricted", denyDirs: ["D:\\secrets"] });
	check(evaluateExternalPathAccess({ config: config([denied]), filePath: "D:\\secrets\\sub", targetKind: "directory" }), { access: "deny", reason: "deny-dir" });
	// reveal（在文件管理器里定位）与 directory 同为无风险量级：任何档位都不弹确认，只受 denyDirs 约束
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE, cwd: PROJECT, projectRoot: PROJECT, targetKind: "reveal" }), { access: "allow", reason: "reveal" });
	check(evaluateExternalPathAccess({ config: config([denied]), filePath: "D:\\secrets\\leak.txt", targetKind: "reveal" }), { access: "deny", reason: "deny-dir" });
	// 可执行 / 脚本后缀：右键菜单「默认方式打开」的入口判定（shell.openPath 对这些后缀等于执行）
	for (const execPath of ["D:\\tmp\\payload.exe", "D:\\tmp\\setup.MSI", "C:\\Users\\me\\run.ps1", "/tmp/build.sh", "/Applications/Evil.app", "D:\\tmp\\x.lnk"]) {
		assert.equal(isExecutableLikePath(execPath), true, `${execPath} 应判为可执行/脚本`);
	}
	for (const plainPath of ["D:\\tmp\\notes.md", "D:\\proj\\.env", "D:\\proj\\.gitignore", "/tmp/archive.tar.gz", "D:\\tmp\\noext"]) {
		assert.equal(isExecutableLikePath(plainPath), false, `${plainPath} 不应判为可执行/脚本`);
	}
	// 同一条路径作文件时仍按原规则（确认），证明例外只挂在 targetKind 上
	check(evaluateExternalPathAccess({ config: cfg, filePath: OUTSIDE, cwd: PROJECT, projectRoot: PROJECT }), { access: "ask", reason: "outside-allowed-dirs" });
});
