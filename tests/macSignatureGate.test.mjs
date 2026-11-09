// macOS 签名门禁的行为测试 + 接线守卫（issue #347 回归）。
//
// 被测对象是 scripts/verify-mac-signature.mjs：无 Apple 证书时 electron-builder 26.15+
// 不会自动回退 ad-hoc，签名被静默跳过，产出的 .app 在 Apple Silicon 上起不来而 CI 全绿。
// 门禁必须把这种产物判红，所以这里用临时 release 目录 + 注入的 codesign/plist 读取器覆盖判定分支，
// 不依赖 macOS 与真实 codesign。
//
// #347 后续评论补充了两个必须单独钉死的退化：签名 identifier 变成 `Electron`
// （丢掉用户给 com.ayuayue.pi-desktop 的本地网络授权 → 局域网模型服务 / SSH 报 No route to host）、
// Info.plist 未封印、嵌套 Helper 保留通用 `Electron Helper` 标识。这三条都直接断言。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { findMacApps, findNestedApps, hasHardenedRuntime, isDeveloperIdSigned, parseCodeSignDisplay, verifyMacSignature } from "../scripts/verify-mac-signature.mjs";
import { resolveMacIdentityPolicy } from "../scripts/mac-signing-policy.js";

// 门禁默认按环境变量推断期望的签名模式（与打包配置同源）；本地开发机若导出过 CSC_* 会把
// 下面的 ad-hoc 用例全部拉成 developer-id 期望。测试进程内清掉，developer-id 用例显式注入 signing。
for (const key of ["CSC_LINK", "CSC_NAME", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_KEYCHAIN_PROFILE"]) delete process.env[key];
const DEVELOPER_ID_NOTARIZED = { mode: "developer-id", notarize: true };
const DEVELOPER_ID_UNNOTARIZED = { mode: "developer-id", notarize: false };

// 0.9.0 官方 arm64 包上真实复现的 codesign 输出（缺资源封印时的报错原文）。
const UNSIGNED_OUTPUT = "code has no resources but signature indicates they must be present";

async function withTempRelease(run) {
	const root = await mkdtemp(join(tmpdir(), "pideck-mac-signature-"));
	try {
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function put(path, content = "content") {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

/** 构造 codesign -dv 的真实输出形态（封印与否的写法不同）。 */
function displayOutput({ identifier, infoPlist = "entries=33", sealedResources = "version=2 rules=13 files=417", signature = "adhoc", teamIdentifier = "not set", authorities = [], developerId = false, hardenedRuntime = developerId || signature !== "adhoc" }) {
	if (developerId) {
		signature = null;
		teamIdentifier = "ABCDE12345";
		authorities = ["Developer ID Application: Example Co (ABCDE12345)", "Developer ID Certification Authority", "Apple Root CA"];
	}
	return [
		"Executable=/tmp/PiDeck.app/Contents/MacOS/PiDeck",
		`Identifier=${identifier}`,
		"Format=app bundle with Mach-O universal (x86_64 arm64)",
		`CodeDirectory v=20400 size=1 flags=${hardenedRuntime ? "0x10000(runtime)" : signature === "adhoc" ? "0x2(adhoc)" : "0x0(none)"} hashes=1+0 location=embedded`,
		signature === null ? "Signature size=9000" : `Signature=${signature}`,
		...authorities.map((authority) => `Authority=${authority}`),
		infoPlist === "not bound" ? "Info.plist=not bound" : `Info.plist ${infoPlist}`,
		sealedResources === "none" ? "Sealed Resources=none" : `Sealed Resources ${sealedResources}`,
		`TeamIdentifier=${teamIdentifier}`,
		"",
	].join("\n");
}

/** spctl / stapler 替身：记录调用，按登记的失败返回非 0。 */
function makeTool(failure = null) {
	const calls = [];
	const run = async (args) => {
		calls.push(args);
		return failure ? { code: 3, output: failure } : { code: 0, output: "accepted" };
	};
	return { run, calls };
}

/**
 * 造一个 release 目录里的 .app（可带嵌套 Helper.app）。
 * 返回 app 路径、Info.plist 标识映射与 codesign 替身。
 */
async function createApp(releaseDir, outputDir, appName, { sealed = true, bundleId = "com.ayuayue.pi-desktop", helpers = [] } = {}) {
	const app = join(releaseDir, outputDir, appName);
	await put(join(app, "Contents", "MacOS", "PiDeck"), "binary");
	await put(join(app, "Contents", "Info.plist"), "plist");
	if (sealed) await put(join(app, "Contents", "_CodeSignature", "CodeResources"), "<plist/>");

	const infoPlistIds = new Map([[join(app, "Contents", "Info.plist"), bundleId]]);
	const displays = new Map();
	for (const helper of helpers) {
		const helperApp = join(app, "Contents", "Frameworks", helper.name);
		await put(join(helperApp, "Contents", "MacOS", helper.name.replace(/\.app$/, "")), "binary");
		await put(join(helperApp, "Contents", "Info.plist"), "plist");
		infoPlistIds.set(join(helperApp, "Contents", "Info.plist"), helper.bundleId ?? bundleId);
		displays.set(helperApp, { identifier: helper.identifier ?? helper.bundleId ?? bundleId });
	}
	displays.set(app, { identifier: bundleId });
	return { app, infoPlistIds, displays };
}

/** codesign 替身：-dv 读取 displays，--verify 只有显式登记失败才非 0。 */
function makeCodesign({ displays, verifyFailures = new Map() }) {
	const calls = [];
	const runCodesign = async (args) => {
		calls.push(args);
		const target = args[args.length - 1];
		if (args[0] === "-dv") {
			const config = displays.get(target);
			if (!config) return { code: 1, output: "code object is not signed at all" };
			return { code: 0, output: displayOutput({ sealedResources: "version=2 rules=7 files=12", ...config }) };
		}
		if (args[0] === "-d" && args[1] === "-r-") {
			const config = displays.get(target);
			return { code: config?.requirementExitCode ?? 0, output: `designated => ${config?.requirement ?? (config?.developerId ? `identifier "${config.identifier}" and anchor apple generic and certificate leaf[subject.OU] = ABCDE12345` : 'cdhash H"0123456789012345678901234567890123456789"')}` };
		}
		if (args.some((arg) => arg.startsWith("-R=")) && displays.get(target)?.untrustedCertificate) {
			return { code: 3, output: "test-requirement: code failed to satisfy specified code requirement(s)" };
		}
		const failure = verifyFailures.get(target);
		return failure ? { code: failure.code ?? 1, output: failure.output ?? "" } : { code: 0, output: "" };
	};
	return { runCodesign, calls };
}

function makeReadInfoPlist(infoPlistIds) {
	return async (plistPath) => {
		const value = infoPlistIds.get(plistPath);
		if (value === undefined) throw new Error(`No such file: ${plistPath}`);
		if (typeof value === "string") return { CFBundleIdentifier: value, NSLocalNetworkUsageDescription: "PiDeck connects to local services." };
		return value;
	};
}

/** 把一批 createApp 的产物合并成注入器。 */
function harness(apps) {
	const infoPlistIds = new Map();
	const displays = new Map();
	const verifyFailures = new Map();
	for (const item of apps) {
		for (const [key, value] of item.infoPlistIds) infoPlistIds.set(key, value);
		for (const [key, value] of item.displays) displays.set(key, value);
		for (const [key, value] of item.verifyFailures ?? []) verifyFailures.set(key, value);
	}
	const { runCodesign, calls } = makeCodesign({ displays, verifyFailures });
	return { runCodesign, readInfoPlist: makeReadInfoPlist(infoPlistIds), calls };
}

test("签名完整（封印 + identifier 对齐 + Helper 一致）的包通过，并对每个 .app 跑 --verify --deep --strict", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app", { helpers: [{ name: "PiDeck Helper.app", bundleId: "com.ayuayue.pi-desktop.helper" }] });
		const { runCodesign, readInfoPlist, calls } = harness([main]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.apps.length, 1);
		assert.equal(result.apps[0].sealed, true);
		assert.equal(result.apps[0].identifier, "com.ayuayue.pi-desktop");
		assert.equal(result.apps[0].nested.length, 1);
		assert.equal(result.apps[0].nested[0].identifier, "com.ayuayue.pi-desktop.helper");
		// 主包：先 --deep 校验，再 -dv；嵌套 Helper 只 -dv（--deep 已覆盖有效性）。
		assert.deepEqual(calls[0], ["--verify", "--deep", "--strict", "--verbose=2", main.app]);
		assert.deepEqual(calls[1], ["-dv", "--verbose=4", main.app]);
		assert.equal(calls.length, 3);
	});
});

test("Developer ID + 公证期望：正式签名、hardened runtime、stapler/spctl 通过时放行，且两条工具都真的跑了", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app", { helpers: [{ name: "PiDeck Helper.app", bundleId: "com.ayuayue.pi-desktop.helper" }] });
		for (const display of main.displays.values()) display.developerId = true;
		const { runCodesign, readInfoPlist } = harness([main]);
		const spctl = makeTool();
		const stapler = makeTool();
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist, runSpctl: spctl.run, runStapler: stapler.run, signing: DEVELOPER_ID_NOTARIZED });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.signing, "developer-id");
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(stapler.calls, [["validate", main.app]]);
		assert.deepEqual(spctl.calls, [["--assess", "--type", "execute", "--verbose=4", main.app]]);
		assert.match(result.apps[0].authorities[0], /^Developer ID Application:/);
	});
});

test("配了证书却产出 ad-hoc 包时判红（证书导入失败被 electron-builder 静默跳过的形态）", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app");
		const { runCodesign, readInfoPlist } = harness([main]);
		const spctl = makeTool();
		const stapler = makeTool();
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist, runSpctl: spctl.run, runStapler: stapler.run, signing: DEVELOPER_ID_NOTARIZED });
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.some((error) => /Developer ID Application/.test(error) && /ad-hoc/.test(error)),
			result.errors.join("\n"),
		);
	});
});

test("Developer ID 签了但没开 hardened runtime 时判红（公证必挂）", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app");
		main.displays.set(main.app, { identifier: "com.ayuayue.pi-desktop", developerId: true, hardenedRuntime: false });
		const { runCodesign, readInfoPlist } = harness([main]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist, runSpctl: makeTool().run, runStapler: makeTool().run, signing: DEVELOPER_ID_UNNOTARIZED });
		assert.equal(result.ok, false);
		assert.ok(
			result.errors.some((error) => /hardened runtime/.test(error)),
			result.errors.join("\n"),
		);
	});
});

test("公证凭据缺失：Developer ID 签名合格即放行，但给出未公证警告，不调 stapler/spctl", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app");
		main.displays.set(main.app, { identifier: "com.ayuayue.pi-desktop", developerId: true });
		const { runCodesign, readInfoPlist } = harness([main]);
		const spctl = makeTool();
		const stapler = makeTool();
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist, runSpctl: spctl.run, runStapler: stapler.run, signing: DEVELOPER_ID_UNNOTARIZED });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.warnings.length, 1);
		assert.match(result.warnings[0], /未公证/);
		assert.equal(spctl.calls.length, 0);
		assert.equal(stapler.calls.length, 0);
	});
});

test("公证期望下 stapler 或 spctl 任一失败即判红", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app");
		main.displays.set(main.app, { identifier: "com.ayuayue.pi-desktop", developerId: true });
		const { runCodesign, readInfoPlist } = harness([main]);
		const stapleFailed = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist, runSpctl: makeTool().run, runStapler: makeTool("does not have a ticket stapled").run, signing: DEVELOPER_ID_NOTARIZED });
		assert.equal(stapleFailed.ok, false);
		assert.ok(
			stapleFailed.errors.some((error) => /stapler validate/.test(error)),
			stapleFailed.errors.join("\n"),
		);
		const assessFailed = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist, runSpctl: makeTool("rejected (Unnotarized Developer ID)").run, runStapler: makeTool().run, signing: DEVELOPER_ID_NOTARIZED });
		assert.equal(assessFailed.ok, false);
		assert.ok(
			assessFailed.errors.some((error) => /Gatekeeper/.test(error)),
			assessFailed.errors.join("\n"),
		);
	});
});

test("parseCodeSignDisplay 提取 Authority 链与 runtime 标志；ad-hoc 输出两者都判否", () => {
	const signed = parseCodeSignDisplay(displayOutput({ identifier: "com.ayuayue.pi-desktop", developerId: true }));
	assert.equal(signed.authorities.length, 3);
	assert.equal(isDeveloperIdSigned(signed), true);
	assert.equal(hasHardenedRuntime(signed), true);
	const adhoc = parseCodeSignDisplay(displayOutput({ identifier: "com.ayuayue.pi-desktop" }));
	assert.deepEqual(adhoc.authorities, []);
	assert.equal(isDeveloperIdSigned(adhoc), false);
	assert.equal(hasHardenedRuntime(adhoc), false);
});

test("0.9.0 那种包被判红：缺封印 + codesign 失败 + identifier 退化成 Electron", async () => {
	await withTempRelease(async (release) => {
		const bad = await createApp(release, "mac-arm64", "PiDeck.app", { sealed: false, bundleId: "com.ayuayue.pi-desktop" });
		// 签名 identifier 是 Electron —— 0.9.0 官方包的真实形态
		bad.displays.set(bad.app, { identifier: "Electron", infoPlist: "not bound", sealedResources: "none" });
		const { runCodesign, readInfoPlist } = harness([bad]);
		const failing = async (args) => {
			if (args[0] === "-dv") return runCodesign(args);
			return { code: 1, output: UNSIGNED_OUTPUT };
		};
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign: failing, readInfoPlist });
		const text = result.errors.join("\n");
		assert.equal(result.ok, false);
		assert.match(text, /_CodeSignature[/\\]CodeResources/);
		assert.match(text, /no resources but signature indicates they must be present/);
		assert.match(text, /Identifier=Electron 与 Info.plist CFBundleIdentifier=com\.ayuayue\.pi-desktop 不一致/);
		assert.match(text, /Info\.plist 未封印/);
		assert.match(text, /Sealed Resources=none/);
	});
});

test("资源封印存在但 codesign 判失败时仍然判红（封印可能存在而签名无效）", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac", "PiDeck.app");
		const { runCodesign, readInfoPlist } = harness([app]);
		const failing = async (args) => (args[0] === "-dv" ? runCodesign(args) : { code: 1, output: "code object is not signed at all" });
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign: failing, readInfoPlist });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /codesign .* 失败（rc=1）/);
		assert.match(result.errors.join("\n"), /not signed at all/);
	});
});

test("签名 identifier 与 Info.plist 不一致时判红（本地网络授权会整片失效）", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app");
		app.displays.set(app.app, { identifier: "Electron" });
		const { runCodesign, readInfoPlist } = harness([app]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Identifier=Electron .*CFBundleIdentifier=com\.ayuayue\.pi-desktop/);
		assert.match(result.errors.join("\n"), /本地网络权限/);
	});
});

test("嵌套 Helper 保留通用 Electron Helper 标识时判红（0.9.0 的另一处退化）", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app", {
			helpers: [{ name: "PiDeck Helper (GPU).app", bundleId: "com.ayuayue.pi-desktop.helper.gpu", identifier: "Electron Helper (GPU)" }],
		});
		const { runCodesign, readInfoPlist } = harness([main]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist });
		assert.equal(result.ok, false);
		const text = result.errors.join("\n");
		assert.match(text, /PiDeck Helper \(GPU\)\.app/);
		assert.match(text, /Identifier=Electron Helper \(GPU\) .*CFBundleIdentifier=com\.ayuayue\.pi-desktop\.helper\.gpu/);
	});
});

test("Info.plist 缺 NSLocalNetworkUsageDescription 时判红（本地网络授权弹窗靠它）", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app");
		app.infoPlistIds.set(join(app.app, "Contents", "Info.plist"), { CFBundleIdentifier: "com.ayuayue.pi-desktop" });
		const { runCodesign, readInfoPlist } = harness([app]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /NSLocalNetworkUsageDescription/);
	});
});

test("Helper 本身没有常规资源封印时不算失败（codesign 报 none 仍合法）", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app", {
			helpers: [{ name: "PiDeck Helper.app", bundleId: "com.ayuayue.pi-desktop.helper", sealedResources: "none" }],
		});
		main.displays.get(join(main.app, "Contents", "Frameworks", "PiDeck Helper.app")).sealedResources = "none";
		const { runCodesign, readInfoPlist } = harness([main]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist });
		assert.equal(result.ok, true, result.errors.join("\n"));
	});
});

test("release 下没有 .app 时判红（打包链路没产出可验对象，不能当通过）", async () => {
	await withTempRelease(async (release) => {
		await mkdir(join(release, "mac-arm64"), { recursive: true });
		await put(join(release, "PiDeck-0.9.0-arm64.dmg"), "dmg");
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign: async () => ({ code: 0, output: "" }), readInfoPlist: async () => ({}) });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /没找到任何 \.app/);
	});
});

test("非 macOS 宿主直接判红，不假装通过", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app");
		const { runCodesign, readInfoPlist } = harness([app]);
		let called = false;
		const result = await verifyMacSignature({
			releaseDir: release,
			platform: "linux",
			runCodesign: async (args) => {
				called = true;
				return runCodesign(args);
			},
			readInfoPlist,
		});
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /只能在 macOS 上运行/);
		assert.equal(called, false);
	});
});

test("多架构产物逐个检查：arm64 合格、x64 未签名时整体判红", async () => {
	await withTempRelease(async (release) => {
		const arm64 = await createApp(release, "mac-arm64", "PiDeck.app");
		const x64 = await createApp(release, "mac", "PiDeck Dev.app", { sealed: false });
		x64.verifyFailures = new Map([[x64.app, { code: 1, output: UNSIGNED_OUTPUT }]]);
		const { runCodesign, readInfoPlist } = harness([arm64, x64]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", runCodesign, readInfoPlist });
		assert.equal(result.ok, false);
		assert.equal(result.apps.length, 2);
		assert.equal(result.apps.filter((app) => app.sealed).length, 1);
	});
});

test("目录发现只认 mac* 输出目录：win/linux 产物目录被忽略", async () => {
	await withTempRelease(async (release) => {
		await createApp(release, "mac-universal", "PiDeck.app");
		await createApp(release, "win-unpacked", "PiDeck.exe"); // 非 mac 目录，忽略
		await createApp(release, "linux-unpacked", "PiDeck.app"); // 名字像 app 但目录不是 mac*
		const apps = await findMacApps(release);
		// 用 relative 剥前缀并归一为 /：Windows 上 join 产出反斜杠，硬编码 `${release}/` 剥不掉（2026-10 Windows 全量红）
		assert.deepEqual(
			apps.map((app) => relative(release, app).split("\\").join("/")),
			["mac-universal/PiDeck.app"],
		);
	});
});

test("findNestedApps 只收 Frameworks 下的 .app，不重复展开 .app 内部", async () => {
	await withTempRelease(async (release) => {
		const main = await createApp(release, "mac-arm64", "PiDeck.app", {
			helpers: [
				{ name: "PiDeck Helper.app", bundleId: "com.ayuayue.pi-desktop.helper" },
				{ name: "PiDeck Helper (Renderer).app", bundleId: "com.ayuayue.pi-desktop.helper.renderer" },
			],
		});
		// 框架目录（非 .app）里的二进制不该被当成 Helper
		await put(join(main.app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework"), "binary");
		const nested = await findNestedApps(main.app);
		assert.deepEqual(
			nested.map((path) => relative(main.app, path).split("\\").join("/")),
			["Contents/Frameworks/PiDeck Helper (Renderer).app", "Contents/Frameworks/PiDeck Helper.app"],
		);
	});
});

test("parseCodeSignDisplay 区分已封印与 linker-signed 两种输出", () => {
	const good = parseCodeSignDisplay(displayOutput({ identifier: "com.ayuayue.pi-desktop" }));
	assert.equal(good.identifier, "com.ayuayue.pi-desktop");
	assert.equal(good.infoPlist, "entries=33");
	assert.equal(good.sealedResources, "version=2 rules=13 files=417");
	assert.equal(good.signature, "adhoc");

	const bad = parseCodeSignDisplay(displayOutput({ identifier: "Electron", infoPlist: "not bound", sealedResources: "none" }));
	assert.equal(bad.identifier, "Electron");
	assert.equal(bad.infoPlist, "not bound");
	assert.equal(bad.sealedResources, "none");
});

/** Certificate metadata is not sufficient: the gate must also test the Apple chain requirement. */
function useDeveloperId(app) {
	for (const [path, display] of app.displays) {
		app.displays.set(path, {
			...display,
			signature: null,
			teamIdentifier: "A1B2C3D4E5",
			authorities: ["Developer ID Application: PiDeck Publisher (A1B2C3D4E5)", "Developer ID Certification Authority", "Apple Root CA"],
			requirement: `identifier "${display.identifier}" and anchor apple generic and certificate leaf[subject.OU] = A1B2C3D4E5`,
		});
	}
}

test("release verification requires a fixed Team even for a valid Developer ID signature", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac", "PiDeck.app");
		useDeveloperId(app);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", ...harness([app]), identityPolicy: resolveMacIdentityPolicy({ PIDECK_RELEASE_BUILD: "1", PIDECK_MAC_REQUIRE_DEVELOPER_ID: "false" }) });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /TEAM_ID/);
	});
});

test("stable/dev release verification pins the Team and forces notarization despite optional overrides", async () => {
	await withTempRelease(async (release) => {
		const stable = await createApp(release, "mac", "PiDeck.app");
		const dev = await createApp(release, "mac-arm64", "PiDeck Dev.app", { bundleId: "com.ayuayue.pi-desktop-dev", helpers: [{ name: "Helper.app", bundleId: "com.ayuayue.pi-desktop-dev.helper" }] });
		for (const app of [stable, dev]) useDeveloperId(app);
		const identityPolicy = resolveMacIdentityPolicy({ PIDECK_RELEASE_BUILD: "1", PIDECK_MAC_TEAM_ID: "A1B2C3D4E5", PIDECK_MAC_REQUIRE_DEVELOPER_ID: "false" });
		const spctl = makeTool(),
			stapler = makeTool();
		const options = { releaseDir: release, platform: "darwin", ...harness([stable, dev]), identityPolicy, requireDeveloperId: false, signing: { mode: "adhoc", notarize: false }, runSpctl: spctl.run, runStapler: stapler.run };
		const result = await verifyMacSignature(options);
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(stapler.calls.length, 2);
		assert.equal(spctl.calls.length, 2);
		const wrongTeam = await verifyMacSignature({ ...options, identityPolicy: resolveMacIdentityPolicy({ PIDECK_RELEASE_BUILD: "1", PIDECK_MAC_TEAM_ID: "OTHERTEAM1" }) });
		assert.equal(wrongTeam.ok, false);
		assert.match(wrongTeam.errors.join("\n"), /TeamIdentifier/);
		const override = await verifyMacSignature({ ...options, expectedTeamId: "OTHERTEAM1" });
		assert.equal(override.ok, false);
		assert.match(override.errors.join("\n"), /不能覆盖/);
	});
});

test("valid ad-hoc bundles warn that TCC grants cannot be retained across updates", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app");
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", ...harness([app]) });
		assert.equal(result.ok, true);
		assert.match(result.warnings?.join("\n") ?? "", /ad-hoc.*TCC/);
	});
});

test("certificate-required packaging rejects an otherwise valid ad-hoc bundle", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app");
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", ...harness([app]), requireDeveloperId: true });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /Developer ID/);
	});
});

test("Developer ID signing checks the Apple certificate chain, team and non-hash-pinned requirement for app and helpers", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app", { helpers: [{ name: "PiDeck Helper.app", bundleId: "com.ayuayue.pi-desktop.helper" }] });
		useDeveloperId(app);
		const injected = harness([app]);
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", ...injected, requireDeveloperId: true, expectedTeamId: "A1B2C3D4E5" });
		assert.equal(result.ok, true, result.errors.join("\n"));
		assert.equal(result.apps[0].teamIdentifier, "A1B2C3D4E5");
		const requirements = injected.calls.filter((args) => args.some((arg) => arg.startsWith("-R=")));
		assert.equal(requirements.length, 2, "verify certificate trust on both the main app and its helper");
		for (const args of requirements) {
			assert.ok(
				args.some((arg) => arg.includes("anchor apple generic") && arg.includes("1.2.840.113635.100.6.1.13")),
				"metadata names must not stand in for an Apple-trusted Developer ID certificate",
			);
		}
	});
});

for (const [label, patch, message] of [
	["an untrusted certificate with convincing display metadata", { untrustedCertificate: true }, /Apple.*Developer ID/],
	["a different developer team", { teamIdentifier: "OTHERTEAM1" }, /TeamIdentifier/],
	["a certificate-signed bundle with a cdhash-pinned requirement", { requirement: 'cdhash H"0123456789012345678901234567890123456789"' }, /cdhash/],
	["a weakened identifier-only designated requirement", { requirement: 'identifier "com.ayuayue.pi-desktop"' }, /Apple.*Team/],
	["an unreadable designated requirement", { requirementExitCode: 1 }, /designated requirement/],
]) {
	test(`certificate-required signing rejects ${label}`, async () => {
		await withTempRelease(async (release) => {
			const app = await createApp(release, "mac-arm64", "PiDeck.app");
			useDeveloperId(app);
			Object.assign(app.displays.get(app.app), patch);
			const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", ...harness([app]), requireDeveloperId: true, expectedTeamId: "A1B2C3D4E5" });
			assert.equal(result.ok, false);
			assert.match(result.errors.join("\n"), message);
		});
	});
}

test("a team id alone requires certificate signing, including for nested helpers", async () => {
	await withTempRelease(async (release) => {
		const app = await createApp(release, "mac-arm64", "PiDeck.app", { helpers: [{ name: "PiDeck Helper.app", bundleId: "com.ayuayue.pi-desktop.helper" }] });
		useDeveloperId(app);
		app.displays.get(join(app.app, "Contents", "Frameworks", "PiDeck Helper.app")).teamIdentifier = "OTHERTEAM1";
		const result = await verifyMacSignature({ releaseDir: release, platform: "darwin", ...harness([app]), expectedTeamId: "A1B2C3D4E5" });
		assert.equal(result.ok, false);
		assert.match(result.errors.join("\n"), /PiDeck Helper\.app.*TeamIdentifier/);
	});
});

// 接线守卫：门禁脚本必须挂在真正打包 mac 产物的 workflow 上，否则改了脚本也没人跑。
// 正则空白容忍（AGENTS.md：格式调整不得让契约测试假红）。
// build-dev.yml 同样在 macOS runner 上出包并上传 prerelease——dev 通道只靠 dist-dev.js 浅合并
// 继承 identity，配置回归时若无门禁会再次静默发坏包（#347 同形态）。
test("四个 mac 打包 workflow 都调用签名门禁脚本", async () => {
	for (const file of ["release.yml", "build-macos.yml", "mac-test-build.yml", "build-dev.yml"]) {
		const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
		assert.match(workflow, /node\s+scripts\/verify-mac-signature\.mjs/, `${file} 未接入 scripts/verify-mac-signature.mjs`);
	}
});

test("release.yml 的 mac 签名门禁只跑在 macos job（其它平台没有 .app，跑了必然假红）", async () => {
	const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	const step = workflow.slice(workflow.indexOf("Verify macOS bundle signature"));
	assert.match(step, /if:\s*matrix\.platform\s*==\s*'macos'/);
});
