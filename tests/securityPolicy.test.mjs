import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultSecurityConfig, createDefaultSecurityLevels } from "../src/shared/types/security.ts";
import { buildSnapshot, evaluatePathAction, evaluateUserReadAccess, isPathInsideRoot, matchBashDenyPatterns, matchesSensitivePath, resolveLevel, resolveLevelId, sanitizeLineList, validateSecurityConfig } from "../src/main/security/policy.ts";

/**
 * 安全策略纯函数测试：
 * - 等级解析（会话覆盖 > 全局默认 > 兜底）
 * - 危险 bash 命令匹配
 * - 文件访问边界（黑名单/敏感文件/目录边界）
 * - 配置校验与快照生成
 */

test("resolveLevelId: session override wins over global default", () => {
	const config = createDefaultSecurityConfig();
	config.defaultLevelId = "standard";
	config.sessionOverrides["/proj/session.md"] = "strict";
	assert.equal(resolveLevelId(config, "/proj/session.md"), "strict");
	assert.equal(resolveLevelId(config, "/other/session.md"), "standard");
	// 无会话身份（匿名会话）时走全局默认
	assert.equal(resolveLevelId(config, undefined), "standard");
});

test("resolveLevelId: unknown default falls back to standard", () => {
	const config = createDefaultSecurityConfig();
	config.defaultLevelId = "";
	assert.equal(resolveLevelId(config, undefined), "standard");
});

test("resolveLevel: missing level falls back to standard, then first level", () => {
	const config = createDefaultSecurityConfig();
	const standard = resolveLevel(config, "standard");
	assert.equal(standard.id, "standard");
	// 不存在的等级回退 standard
	assert.equal(resolveLevel(config, "no-such-level").id, "standard");
	// standard 也缺失时回退第一个等级
	const broken = { ...config, levels: [config.levels[0]] };
	assert.equal(resolveLevel(broken, "nope").id, config.levels[0].id);
});

test("matchBashDenyPatterns: detects dangerous commands per level", () => {
	const config = createDefaultSecurityConfig();
	const strict = resolveLevel(config, "strict");
	assert.ok(matchBashDenyPatterns(strict, "rm -rf /tmp/foo"));
	assert.ok(matchBashDenyPatterns(strict, "sudo apt install x"));
	assert.ok(matchBashDenyPatterns(strict, "git push origin main"));
	assert.ok(matchBashDenyPatterns(strict, "npm install lodash"));
	assert.ok(matchBashDenyPatterns(strict, "cat a.txt >> b.txt"));
	assert.equal(matchBashDenyPatterns(strict, "ls -la"), null);
	assert.equal(matchBashDenyPatterns(strict, "grep foo bar.txt"), null);
	// off 等级无危险模式
	const off = resolveLevel(config, "off");
	assert.equal(matchBashDenyPatterns(off, "rm -rf /"), null);
});

test("isPathInsideRoot: containment with Windows case-insensitivity", () => {
	assert.ok(isPathInsideRoot("C:/proj/src/a.ts", "C:/proj"));
	assert.ok(isPathInsideRoot("c:\\proj\\a.ts", "C:/proj"));
	assert.ok(isPathInsideRoot("C:/proj", "C:/proj"));
	assert.ok(!isPathInsideRoot("C:/proj2/a.ts", "C:/proj"));
	assert.ok(!isPathInsideRoot("D:/proj/a.ts", "C:/proj"));
	// 空 root 视为不限制
	assert.ok(isPathInsideRoot("anything", ""));
});

test("matchesSensitivePath: .env / .git / key files", () => {
	assert.ok(matchesSensitivePath("C:/proj/.env"));
	assert.ok(matchesSensitivePath("C:/proj/config/.env.local"));
	assert.ok(matchesSensitivePath("C:/proj/.git/config"));
	assert.ok(matchesSensitivePath("C:/proj/keys/id_rsa"));
	assert.ok(matchesSensitivePath("C:/proj/cert.pem"));
	assert.ok(!matchesSensitivePath("C:/proj/environment.js"));
	assert.ok(!matchesSensitivePath("C:/proj/src/App.tsx"));
});

test("evaluatePathAction: denyDirs blacklist wins", () => {
	const config = createDefaultSecurityConfig();
	const strict = resolveLevel(config, "strict");
	strict.denyDirs = ["C:/proj/node_modules"];
	assert.equal(evaluatePathAction(strict, "C:/proj/node_modules/x.js", "C:/proj"), "deny");
});

test("evaluatePathAction: workspace boundary denies outside reads", () => {
	const config = createDefaultSecurityConfig();
	const strict = resolveLevel(config, "strict");
	// strict 默认 pathPolicy=workspace
	assert.equal(evaluatePathAction(strict, "C:/proj/src/a.ts", "C:/proj"), null);
	assert.equal(evaluatePathAction(strict, "C:/other/b.ts", "C:/proj"), "deny");
});

test("evaluatePathAction: custom allows extra dirs", () => {
	const config = createDefaultSecurityConfig();
	const custom = resolveLevel(config, "strict");
	custom.pathPolicy = "custom";
	custom.customAllowDirs = ["C:/shared-data"];
	assert.equal(evaluatePathAction(custom, "C:/shared-data/x.json", "C:/proj"), null);
	assert.equal(evaluatePathAction(custom, "C:/elsewhere/y.json", "C:/proj"), "deny");
	// unrestricted 不限制
	custom.pathPolicy = "unrestricted";
	assert.equal(evaluatePathAction(custom, "C:/elsewhere/y.json", "C:/proj"), null);
});

test("evaluatePathAction: sensitive protection when enabled", () => {
	const config = createDefaultSecurityConfig();
	const standard = resolveLevel(config, "standard");
	// standard 默认 protectSensitivePaths=true
	assert.equal(evaluatePathAction(standard, "C:/proj/.env", "C:/proj"), "deny");
	assert.equal(evaluatePathAction(standard, "C:/proj/src/a.ts", "C:/proj"), null);
	// 关闭保护后放行
	standard.protectSensitivePaths = false;
	assert.equal(evaluatePathAction(standard, "C:/proj/.env", "C:/proj"), null);
});

test("evaluateUserReadAccess: 项目外预览的用户意图门（Web 端）", () => {
	const config = createDefaultSecurityConfig();
	// 安全总开关关闭 → 一律放行（与桌面端点开项目外链接一致）
	const disabled = { ...config, enabled: false };
	assert.deepEqual(evaluateUserReadAccess(disabled, { filePath: "C:/anywhere/a.ts", cwd: "C:/proj" }), { access: "allow", reason: "security-disabled" });

	// 读不到配置 → 问一次（不静默放行、不静默拒绝）
	assert.deepEqual(evaluateUserReadAccess(null, { filePath: "C:/anywhere/a.ts", cwd: "C:/proj" }), { access: "ask", reason: "policy-unavailable" });

	// standard（unrestricted）→ 项目外也直接放行
	config.defaultLevelId = "standard";
	assert.deepEqual(evaluateUserReadAccess(config, { filePath: "C:/anywhere/a.ts", cwd: "C:/proj" }), { access: "allow", reason: "unrestricted" });

	// strict（workspace）→ 项目内放行、项目外问一次
	config.defaultLevelId = "strict";
	assert.deepEqual(evaluateUserReadAccess(config, { filePath: "C:/proj/src/a.ts", cwd: "C:/proj" }), { access: "allow", reason: "allowed-dir" });
	assert.deepEqual(evaluateUserReadAccess(config, { filePath: "C:/other/b.ts", cwd: "C:/proj" }), { access: "ask", reason: "outside-allowed-dirs" });
	// 只给了 projectRoot（无 cwd）时同样算项目内
	assert.deepEqual(evaluateUserReadAccess(config, { filePath: "C:/proj/src/a.ts", projectRoot: "C:/proj" }), { access: "allow", reason: "allowed-dir" });

	// custom → 自定义目录放行，配置里的相对目录按工作目录展开
	const custom = { ...config, defaultLevelId: "strict", levels: config.levels.map((level) => (level.id === "strict" ? { ...level, pathPolicy: "custom", customAllowDirs: ["C:/shared-data", "vendor"] } : level)) };
	assert.deepEqual(evaluateUserReadAccess(custom, { filePath: "C:/shared-data/x.json", cwd: "C:/proj" }), { access: "allow", reason: "allowed-dir" });
	assert.deepEqual(evaluateUserReadAccess(custom, { filePath: "C:/proj/vendor/lib.ts", cwd: "C:/proj" }), { access: "allow", reason: "allowed-dir" });
	assert.deepEqual(evaluateUserReadAccess(custom, { filePath: "C:/elsewhere/y.json", cwd: "C:/proj" }), { access: "ask", reason: "outside-allowed-dirs" });

	// denyDirs 黑名单优先于一切 allow（哪怕等级是 unrestricted、路径在项目内）
	const withDeny = { ...config, enabled: true, defaultLevelId: "standard", levels: config.levels.map((level) => (level.id === "standard" ? { ...level, denyDirs: ["C:/proj/secret"] } : level)) };
	assert.deepEqual(evaluateUserReadAccess(withDeny, { filePath: "C:/proj/secret/key.txt", cwd: "C:/proj" }), { access: "deny", reason: "deny-dir" });

	// 敏感文件保护开启 → 问一次（不是直接拒）
	const standard = createDefaultSecurityConfig();
	standard.defaultLevelId = "standard";
	assert.deepEqual(evaluateUserReadAccess(standard, { filePath: "C:/proj/.env", cwd: "C:/proj" }), { access: "ask", reason: "sensitive" });

	// 会话级覆盖优先于全局默认
	const override = createDefaultSecurityConfig();
	override.defaultLevelId = "standard";
	override.sessionOverrides["s1"] = "strict";
	assert.deepEqual(evaluateUserReadAccess(override, { filePath: "C:/other/b.ts", cwd: "C:/proj", sessionId: "s1" }), { access: "ask", reason: "outside-allowed-dirs" });
	assert.deepEqual(evaluateUserReadAccess(override, { filePath: "C:/other/b.ts", cwd: "C:/proj", sessionId: "s2" }), { access: "allow", reason: "unrestricted" });
});

test("validateSecurityConfig: rejects duplicate ids / missing default / bad regex", () => {
	const config = createDefaultSecurityConfig();
	assert.deepEqual(validateSecurityConfig(config), []);
	// 重复 id
	const dup = createDefaultSecurityConfig();
	dup.levels[1].id = "off";
	assert.ok(validateSecurityConfig(dup).some((e) => e.includes("重复")));
	// 默认等级不存在
	const missingDefault = createDefaultSecurityConfig();
	missingDefault.defaultLevelId = "ghost";
	assert.ok(validateSecurityConfig(missingDefault).some((e) => e.includes("默认等级不存在")));
	// 非法正则
	const badRegex = createDefaultSecurityConfig();
	badRegex.levels[1].denyBashPatterns = ["([unclosed"];
	assert.ok(validateSecurityConfig(badRegex).some((e) => e.includes("无法编译")));
	// 未知工具
	const badTool = createDefaultSecurityConfig();
	badTool.levels[1].toolActions = { web_search: "allow" };
	assert.ok(validateSecurityConfig(badTool).some((e) => e.includes("未知工具")));
});

test("buildSnapshot: exposes exactly the fields the extension reads", () => {
	const config = createDefaultSecurityConfig();
	config.sessionOverrides["/s.md"] = "strict";
	const snapshot = buildSnapshot(config);
	assert.equal(snapshot.schemaVersion, 1);
	assert.equal(snapshot.enabled, true);
	assert.equal(snapshot.defaultLevelId, "off");
	assert.equal(snapshot.sessionLevels["/s.md"], "strict");
	// 扩展读取的字段必须齐全
	for (const level of snapshot.levels) {
		assert.equal(typeof level.id, "string");
		assert.equal(typeof level.name, "string");
		assert.equal(typeof level.pathPolicy, "string");
		assert.ok(Array.isArray(level.denyBashPatterns));
		assert.ok(Array.isArray(level.customAllowDirs));
		assert.ok(Array.isArray(level.denyDirs));
		assert.equal(typeof level.protectSensitivePaths, "boolean");
		assert.ok(["allow", "ask", "deny"].includes(level.defaultAction));
		assert.equal(typeof level.toolActions, "object");
	}
});

test("sanitizeLineList: trims each line and drops empty lines", () => {
	assert.deepEqual(sanitizeLineList(["  C:\foo  ", "", "   ", "D:\bar"]), ["C:\foo", "D:\bar"]);
});

test("sanitizeLineList: non-array input yields empty array", () => {
	assert.deepEqual(sanitizeLineList(undefined), []);
	// 类型擦除场景：配置被外部写坏时不能抛错、不能把整档策略炸掉
	assert.deepEqual(sanitizeLineList("nope"), []);
});

test("built-in levels satisfy the strict->standard->off severity order", () => {
	const levels = createDefaultSecurityLevels();
	const off = levels.find((l) => l.id === "off");
	const standard = levels.find((l) => l.id === "standard");
	const strict = levels.find((l) => l.id === "strict");
	assert.ok(off && standard && strict, "内置三档等级必须齐全");
	// 关闭：全部放行、无保护
	assert.equal(off.defaultAction, "allow");
	assert.equal(off.protectSensitivePaths, false);
	assert.deepEqual(off.denyBashPatterns, []);
	// 标准：默认放行 + 危险命令确认 + 敏感保护
	assert.equal(standard.defaultAction, "allow");
	assert.equal(standard.toolActions.bash, "ask");
	assert.equal(standard.protectSensitivePaths, true);
	assert.ok(standard.denyBashPatterns.length > 0);
	// 严格：默认拒绝 + 工作目录边界
	assert.equal(strict.defaultAction, "deny");
	assert.equal(strict.pathPolicy, "workspace");
	assert.equal(strict.protectSensitivePaths, true);
});
