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
import { findMacApps, findNestedApps, parseCodeSignDisplay, verifyMacSignature } from "../scripts/verify-mac-signature.mjs";

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
function displayOutput({ identifier, infoPlist = "entries=33", sealedResources = "version=2 rules=13 files=417" }) {
	return [
		"Executable=/tmp/PiDeck.app/Contents/MacOS/PiDeck",
		`Identifier=${identifier}`,
		"Format=app bundle with Mach-O universal (x86_64 arm64)",
		"CodeDirectory v=20400 size=1 flags=0x2(adhoc) hashes=1+0 location=embedded",
		"Signature=adhoc",
		infoPlist === "not bound" ? "Info.plist=not bound" : `Info.plist ${infoPlist}`,
		sealedResources === "none" ? "Sealed Resources=none" : `Sealed Resources ${sealedResources}`,
		"TeamIdentifier=not set",
		"",
	].join("\n");
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
