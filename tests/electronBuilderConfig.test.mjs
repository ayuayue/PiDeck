// macOS Developer ID 签名/公证的配置装配守卫。
//
// 两个诉求在静态 package.json 里互斥：无证书必须显式 ad-hoc（#347），有证书必须去掉这条硬覆盖才会
// 用 Developer ID。scripts/electronBuilderConfig.js 在加载期按环境变量裁决，本文件钉住：
// 1. 裁决逻辑本身（空串 = 未配置、半套公证凭据不开 notarize、ad-hoc 时 notarize 显式 false）；
// 2. 入口文件只导出干净的配置对象（electron-builder 对根配置做 schema 校验）；
// 3. dev 通道（dist-dev.js）继承同一套裁决；
// 4. 接线：所有 mac 打包命令都带 --config（确保公证策略进入构建），CI 注入的是同一组 secrets。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElectronBuilderConfig, hasNotarizationCredentials, resolveMacSigning } from "../scripts/electronBuilderConfig.js";
import { buildDevConfig } from "../scripts/dist-dev.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const NOTARY_ENV = { APPLE_ID: "dev@example.com", APPLE_APP_SPECIFIC_PASSWORD: "xxxx-xxxx", APPLE_TEAM_ID: "ABCDE12345" };

test("正式发布要求签名与公证齐全，缺证书或缺任一公证凭据在打包前失败", () => {
	const strict = { PIDECK_MAC_REQUIRE_NOTARIZATION: "1", PIDECK_MAC_TEAM_ID: NOTARY_ENV.APPLE_TEAM_ID };
	assert.throws(() => resolveMacSigning(strict), /Developer ID/);
	assert.throws(() => resolveMacSigning({ ...strict, CSC_LINK: "cert" }), /公证/);
	for (const key of Object.keys(NOTARY_ENV)) {
		const env = { ...strict, CSC_LINK: "cert", ...NOTARY_ENV };
		delete env[key];
		assert.throws(() => resolveMacSigning(env), /公证/);
	}
	assert.equal(resolveMacSigning({ ...strict, CSC_LINK: "cert", ...NOTARY_ENV }).notarize, true);
});

test("公证发行在配置阶段拒绝缺失、非法及不匹配的固定 Team", () => {
	const env = { PIDECK_MAC_REQUIRE_NOTARIZATION: "1", CSC_LINK: "certificate", ...NOTARY_ENV };
	for (const team of [undefined, "", "invalid", "OTHERTEAM1"]) {
		assert.throws(() => resolveMacSigning({ ...env, PIDECK_MAC_TEAM_ID: team }), /Team|TEAM_ID/);
	}
});

test("配置装配保留显式禁用签名，让 mac 打包门禁拒绝发布", () => {
	const config = createElectronBuilderConfig({ env: { CSC_LINK: "certificate" }, overrides: { mac: { identity: null } } });
	assert.equal(config.mac.identity, null);
});

test("语言资源不单独签名，可执行文件和框架仍参与签名", () => {
	const config = createElectronBuilderConfig({ env: {} });
	const ignored = (file) => config.mac.signIgnore.some((pattern) => new RegExp(pattern).test(file));
	assert.equal(ignored("/PiDeck.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak"), true);
	assert.equal(ignored("/PiDeck.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"), false);
	assert.equal(ignored("/PiDeck.app/Contents/Resources/app.asar.unpacked/node_modules/pty.node"), false);
});

test("无证书（含 secrets 注入的空串）→ ad-hoc 且 notarize 显式 false", () => {
	for (const env of [{}, { CSC_LINK: "", CSC_NAME: "   " }, { CSC_LINK: "", ...NOTARY_ENV }]) {
		const signing = resolveMacSigning(env);
		assert.equal(signing.mode, "adhoc");
		assert.equal(signing.notarize, false);
		assert.deepEqual(signing.mac, { identity: "-", notarize: false });
	}
});

test("有 CSC_LINK 或 CSC_NAME → Developer ID：identity 置 undefined（删除键），公证只在凭据齐全时开", () => {
	const unnotarized = resolveMacSigning({ CSC_LINK: "base64..." });
	assert.equal(unnotarized.mode, "developer-id");
	assert.equal(unnotarized.notarize, false);
	assert.equal(unnotarized.mac.identity, undefined);
	assert.equal(unnotarized.mac.notarize, false);

	const notarized = resolveMacSigning({ CSC_NAME: "Example Co (ABCDE12345)", ...NOTARY_ENV });
	assert.equal(notarized.mode, "developer-id");
	assert.equal(notarized.notarize, true);
	assert.equal(notarized.mac.notarize, true);
});

test("公证凭据按 electron-builder 三条路径判齐全，半套不算", () => {
	assert.equal(hasNotarizationCredentials(NOTARY_ENV), true);
	assert.equal(hasNotarizationCredentials({ APPLE_ID: "a", APPLE_APP_SPECIFIC_PASSWORD: "b" }), false);
	assert.equal(hasNotarizationCredentials({ APPLE_API_KEY: "k", APPLE_API_KEY_ID: "id", APPLE_API_ISSUER: "iss" }), true);
	assert.equal(hasNotarizationCredentials({ APPLE_API_KEY: "k" }), false);
	assert.equal(hasNotarizationCredentials({ APPLE_KEYCHAIN_PROFILE: "pideck" }), true);
	assert.equal(hasNotarizationCredentials({ APPLE_ID: "", APPLE_APP_SPECIFIC_PASSWORD: "", APPLE_TEAM_ID: "" }), false);
});

test("createElectronBuilderConfig：以 package.json build 为基底，只改 mac 签名字段，其余原样", () => {
	const pkg = JSON.parse(read("../package.json"));
	const adhoc = createElectronBuilderConfig({ env: {} });
	assert.equal(adhoc.mac.identity, "-");
	assert.equal(adhoc.mac.notarize, false);
	assert.equal(adhoc.mac.icon, pkg.build.mac.icon);
	assert.deepEqual(adhoc.mac.target, pkg.build.mac.target);
	assert.equal(adhoc.appId, pkg.build.appId);
	assert.deepEqual(adhoc.extraResources, pkg.build.extraResources);

	const signed = createElectronBuilderConfig({ env: { CSC_LINK: "x", ...NOTARY_ENV } });
	assert.equal("identity" in signed.mac, false, "有证书时必须删掉 identity 键，而不是留 undefined/null（null 在 electron-builder 里是「跳过签名」）");
	assert.equal(signed.mac.notarize, true);
	assert.equal(signed.mac.extendInfo.NSLocalNetworkUsageDescription, pkg.build.mac.extendInfo.NSLocalNetworkUsageDescription);
	// 不动 package.json 本身
	assert.equal(pkg.build.mac.identity, "-");
});

test("入口 scripts/electron-builder.config.js 只导出配置对象（无辅助函数泄漏到根配置）", async () => {
	const entry = await import("../scripts/electron-builder.config.js");
	const config = entry.default;
	assert.equal(typeof config, "object");
	assert.ok(config.mac, "缺少 mac 段");
	const helperKeys = Object.keys(config).filter((key) => typeof config[key] === "function");
	assert.deepEqual(helperKeys, [], "根配置里混入了函数导出，electron-builder schema 校验会拒绝");
});

test("dev 通道继承同一套签名裁决（dist-dev.js → createElectronBuilderConfig）", () => {
	const adhoc = buildDevConfig({});
	assert.equal(adhoc.productName, "PiDeck Dev");
	assert.equal(adhoc.mac.identity, "-");
	assert.equal(adhoc.mac.artifactName, "PiDeck-Dev-${version}-${arch}.${ext}");
	const signed = buildDevConfig({ CSC_LINK: "x", ...NOTARY_ENV });
	assert.equal("identity" in signed.mac, false);
	assert.equal(signed.mac.notarize, true);
	assert.equal(signed.appId, "com.ayuayue.pi-desktop-dev");
});

test("接线：所有直接调用 electron-builder 的 mac 打包命令都带 --config scripts/electron-builder.config.js", () => {
	const pkg = JSON.parse(read("../package.json"));
	assert.match(pkg.scripts["dist:mac"], /--config scripts\/electron-builder\.config\.js/);
	for (const file of ["release.yml", "build-macos.yml", "mac-test-build.yml"]) {
		const text = read(`../.github/workflows/${file}`);
		const macBuilderCommands = text.split("\n").filter((line) => /electron-builder --mac/.test(line));
		assert.ok(macBuilderCommands.length > 0, `${file} 没有 mac electron-builder 命令`);
		for (const line of macBuilderCommands) assert.match(line, /--config scripts\/electron-builder\.config\.js/, `${file}: ${line.trim()}`);
	}
});

test("build-macos.yml 默认构建当前触发分支（留空用 github.ref_name，不能写死 main）", () => {
	const text = read("../.github/workflows/build-macos.yml");
	// workflow_dispatch 的 default 不支持表达式；写死 main 会让「从 dev 触发」变成
	// 用 dev 的 workflow 文件构建 main 的代码（#515 合入前曾因此 ENOENT）。
	assert.match(text, /ref: \$\{\{ inputs\.ref \|\| github\.ref_name \}\}/);
	assert.doesNotMatch(text, /^\s+default: main\s*$/m);
});

test("接线：mac 打包 job 注入 Developer ID / 公证 secrets，且与门禁脚本看到同一组变量", () => {
	for (const file of ["release.yml", "build-dev.yml", "build-macos.yml", "mac-test-build.yml"]) {
		const text = read(`../.github/workflows/${file}`);
		for (const name of ["CSC_LINK: ${{ ", "CSC_KEY_PASSWORD: ${{ ", "APPLE_ID: ${{ ", "APPLE_APP_SPECIFIC_PASSWORD: ${{ ", "APPLE_TEAM_ID: ${{ "]) {
			assert.ok(text.includes(name), `${file} 缺少 ${name.trim()}`);
		}
		assert.ok(text.includes("secrets.MAC_CSC_LINK"), `${file} 应从 secrets.MAC_CSC_LINK 读证书`);
		// 门禁步骤也要拿到 CSC_LINK 才能判断「配了证书却产出 ad-hoc」。
		const verifyIndex = text.indexOf("scripts/verify-mac-signature.mjs");
		assert.ok(verifyIndex > 0, `${file} 缺少签名门禁`);
		assert.ok(text.slice(verifyIndex, verifyIndex + 600).includes("CSC_LINK: ${{ secrets.MAC_CSC_LINK }}"), `${file} 的签名门禁步骤没有注入 CSC_LINK`);
	}
	// 多平台矩阵里 CSC_LINK 只能给 mac job：泄到 Windows 会拿 mac 证书去签 exe。
	for (const file of ["release.yml", "build-dev.yml"]) {
		const text = read(`../.github/workflows/${file}`);
		assert.ok(text.includes("CSC_LINK: ${{ matrix.platform == 'macos' && secrets.MAC_CSC_LINK || '' }}"), `${file} 的 CSC_LINK 必须按 matrix.platform 门控`);
	}
});
