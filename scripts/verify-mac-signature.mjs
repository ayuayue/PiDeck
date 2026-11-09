#!/usr/bin/env node

// macOS 包签名门禁（#347 回归守卫）。
//
// 背景：electron-builder 26.15 起，找不到签名证书时不再回退 ad-hoc——26.8.1 的
// macPackager.fallBackToAdhoc（arm64/universal 自动 `identity: "-"`）已被删除，
// app-builder-lib/scheme.json 的 identity 说明也写明「no automatic ad-hoc fallback」。
// 仓库没有任何 Apple 证书/密钥，于是签名被静默跳过、CI 依旧绿灯，产出的 PiDeck.app
// 只剩 Electron 上游的 linker 签章：没有 Contents/_CodeSignature、Info.plist 未封印
// （CodeDirectory identifier 仍是 Electron、nSpecialSlots=0），Apple Silicon 上启动即失败
// （进程停在 _dyld_start，也没有「仍要打开」入口）。修复是 package.json build.mac.identity: "-"
// 显式 ad-hoc，本脚本是它的产物级判定——配置改对了但打包被跳过时，这里必须红。
//
// 判定标准来自官方包实测（v0.8.0 arm64 dmg 全部通过；v0.9.0 arm64 zip 缺封印且
// codesign 报 "code has no resources but signature indicates they must be present"）：
//   1. release/mac*/.app 必须存在（没有 .app 说明打包链路已经出问题，直接判失败）；
//   2. <app>/Contents/_CodeSignature/CodeResources 必须存在且非空（bundle 资源封印）；
//   3. `codesign --verify --deep --strict` 退出码必须为 0（--deep 会一并校验
//      Frameworks 下的 Electron Framework 与 Helper.app，覆盖改名后未重签的情况）；
//   4. CodeDirectory 的 Identifier 必须等于 Info.plist 的 CFBundleIdentifier，且
//      `codesign -dv` 报告 Info.plist 已封印、Sealed Resources 不是 none。
//      0.9.0 的坏包在 3 上可能只是「资源缺失」，但真凶是 identifier 退化成 `Electron`：
//      macOS 本地网络权限按签名 identifier 记账，退化后会丢掉用户此前给
//      com.ayuayue.pi-desktop 的授权，表现为局域网模型服务 / 终端 SSH 报
//      "No route to host"（#347 后续评论）。这条断言把该退化单独钉死。
//   5. Contents/Frameworks/*.app（Helper）同样要求「签名 identifier == 自己的
//      CFBundleIdentifier」——0.9.0 的 Helper 保留了通用 `Electron Helper` 标识。
//   6. 配置 Developer ID 后还要验证 Apple 证书链、TeamIdentifier 与 designated requirement；
//      ad-hoc 的 cdhash 身份随更新变化，有效 bundle 签名不等于可以继承旧 TCC 授权。
// 只在 macOS 上运行：没有 codesign 的宿主直接判失败，不允许「跳过了还当通过」。

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hasDeveloperIdCertificate, hasNotarizationCredentials } from "./electronBuilderConfig.js";
import { resolveMacIdentityPolicy, validateMacIdentityPolicy } from "./mac-signing-policy.js";

const execFileAsync = promisify(execFile);

const RESOURCE_SEAL = join("Contents", "_CodeSignature", "CodeResources");
const INFO_PLIST = join("Contents", "Info.plist");
const FRAMEWORKS_DIR = join("Contents", "Frameworks");
// electron-builder 按架构分输出目录：mac（默认/universal 之外的单个 arch）、mac-arm64、mac-universal。
// .app 目录名随通道变化（PiDeck / PiDeck Dev），所以只拿 mac* 当锚点。
const MAC_OUTPUT_DIR = /^mac(-.*)?$/;
// Helper.app 只在 Frameworks 下平铺一层；留一点余量给嵌套结构，同时避免深遍历大目录。
const NESTED_APP_DEPTH = 3;
// Apple's Developer ID Application chain, rather than a forgeable certificate display name.
const DEVELOPER_ID_REQUIREMENT = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

async function isNonEmptyFile(path) {
	try {
		const info = await stat(path);
		return info.isFile() && info.size > 0;
	} catch {
		return false;
	}
}

function tail(text, limit = 800) {
	const trimmed = String(text ?? "").trim();
	return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/** 默认 codesign 执行器：把退出码与输出交回门禁判定，自身不抛异常（缺 codesign 也走同一分支）。 */
async function defaultRunCodesign(args) {
	try {
		const { stdout, stderr } = await execFileAsync("codesign", args, { maxBuffer: 8 * 1024 * 1024 });
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (error) {
		const code = typeof error?.code === "number" ? error.code : 1;
		return { code, output: `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? ""}` };
	}
}

/** Public distribution additionally requires a stapled ticket and Gatekeeper acceptance. */
function createRunner(command) {
	return async (args) => {
		try {
			const { stdout, stderr } = await execFileAsync(command, args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
			return { code: 0, output: `${stdout}${stderr}` };
		} catch (error) {
			return { code: typeof error?.code === "number" ? error.code : 1, output: `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? ""}` };
		}
	};
}
const defaultRunSpctl = createRunner("spctl");
const defaultRunStapler = (args) => createRunner("xcrun")(["stapler", ...args]);

/** 默认 Info.plist 读取器：macOS 自带的 plutil 转 JSON（Info.plist 可能是二进制）。 */
async function defaultReadInfoPlist(plistPath) {
	const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plistPath], { maxBuffer: 4 * 1024 * 1024 });
	return JSON.parse(stdout);
}

/**
 * 解析 `codesign -dv --verbose=4` 的输出。
 * 正常 ad-hoc 包包含 `Identifier=…`、`Info.plist entries=…`、`Sealed Resources version=…`；
 * linker-signed 的坏包则是 `Identifier=Electron`、`Info.plist=not bound`、`Sealed Resources=none`。
 */
export function parseCodeSignDisplay(output) {
	const text = String(output ?? "");
	const pick = (key) => {
		const match = new RegExp(`^${key}=(.*)$`, "m").exec(text);
		return match ? match[1].trim() : null;
	};
	// 已封印时 codesign 打的是「Info.plist entries=N」（空格），未封印才是「Info.plist=not bound」。
	const boundEntries = /^Info\.plist entries=(\d+)$/m.exec(text);
	return {
		identifier: pick("Identifier"),
		infoPlist: pick("Info\\.plist") ?? (boundEntries ? `entries=${boundEntries[1]}` : null),
		sealedResources: pick("Sealed Resources") ?? /^Sealed Resources (version=.*)$/m.exec(text)?.[1]?.trim() ?? null,
		signature: pick("Signature"),
		teamIdentifier: pick("TeamIdentifier"),
		flags: /^CodeDirectory .*?flags=(\S+)/m.exec(text)?.[1] ?? null,
		authorities: [...text.matchAll(/^Authority=(.*)$/gm)].map((match) => match[1].trim()),
	};
}

/** Developer ID metadata and hardened-runtime flag checks complement certificate trust checks. */
export function isDeveloperIdSigned(parsed) {
	return Boolean(Array.isArray(parsed?.authorities) && parsed.authorities[0]?.startsWith("Developer ID Application:"));
}
export function hasHardenedRuntime(parsed) {
	return typeof parsed?.flags === "string" && /\(.*\bruntime\b.*\)/.test(parsed.flags);
}

/** Info.plist 的封印判据：`Info.plist entries=N` 才算封印，`Info.plist=not bound` 判失败。 */
function isInfoPlistBound(value) {
	return value !== null && /entries=/i.test(value);
}

/** 资源封印判据：`Sealed Resources version=2 …` 才算封印，`Sealed Resources=none` 判失败。 */
function hasSealedResources(value) {
	return value !== null && /^version=/i.test(value);
}

/**
 * 收集 release/mac* 目录下的 .app。
 * 导出是为让测试在不依赖 macOS 的前提下覆盖目录发现逻辑。
 */
export async function findMacApps(releaseDir) {
	let entries;
	try {
		entries = await readdir(releaseDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const apps = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !MAC_OUTPUT_DIR.test(entry.name)) continue;
		const dir = join(releaseDir, entry.name);
		for (const child of await readdir(dir, { withFileTypes: true })) {
			if (child.isDirectory() && child.name.endsWith(".app")) apps.push(join(dir, child.name));
		}
	}
	return apps.sort();
}

/** 收集 Contents/Frameworks 下嵌套的 Helper.app（签名 identifier 退化的高发点）。 */
export async function findNestedApps(appPath) {
	const found = [];
	async function walk(dir, depth) {
		if (depth > NESTED_APP_DEPTH) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = join(dir, entry.name);
			if (entry.name.endsWith(".app")) {
				found.push(full);
				continue; // .app 内部由 --deep 校验，不在这里重复展开
			}
			await walk(full, depth + 1);
		}
	}
	await walk(join(appPath, FRAMEWORKS_DIR), 0);
	return found.sort();
}

/** Verify the signing identity used to carry TCC grants between releases. */
async function inspectDeveloperId({ appPath, label, parsed, expectedTeamId, runCodesign, errors }) {
	if (parsed.signature === "adhoc" || !parsed.authorities[0]?.startsWith("Developer ID Application:")) {
		errors.push(`${label} 必须使用 Developer ID Application 证书签名，不能回退 ad-hoc：否则更新后 TCC 授权仍可能失效`);
		return null;
	}
	if (!parsed.teamIdentifier || parsed.teamIdentifier === "not set" || (expectedTeamId && parsed.teamIdentifier !== expectedTeamId)) {
		errors.push(`${label} 的 TeamIdentifier=${parsed.teamIdentifier ?? "缺失"} 与预期开发者身份 ${expectedTeamId ?? "有效 Developer ID Team"} 不一致`);
	}
	const trusted = await runCodesign(["--verify", "--strict", `-R=${DEVELOPER_ID_REQUIREMENT}`, appPath]);
	if (trusted.code !== 0) errors.push(`${label} 未满足 Apple Developer ID 证书链要求（rc=${trusted.code}）：${tail(trusted.output)}`);
	const displayed = await runCodesign(["-d", "-r-", appPath]);
	const requirement = /^(?:#\s*)?designated\s*=>\s*(.+)$/m.exec(displayed.output)?.[1]?.trim() ?? null;
	if (displayed.code !== 0 || !requirement) errors.push(`${label} 无法读取 designated requirement（rc=${displayed.code}）`);
	else if (/\bcdhash\b/i.test(requirement)) errors.push(`${label} 的 designated requirement 绑定 cdhash，二进制更新后身份会改变，不能继承旧 TCC 授权`);
	else {
		const team = /certificate\s+leaf\s*\[\s*subject\.OU\s*\]\s*=\s*"?([A-Z0-9]{10})"?/.exec(requirement)?.[1];
		if (!/\banchor\s+apple\s+generic\b/.test(requirement) || team !== parsed.teamIdentifier || /\b(?:or|not)\b/.test(requirement)) {
			errors.push(`${label} 的 designated requirement 缺少明确的 Apple / Team 身份约束；不要用仅含 identifier 的自定义要求保留权限`);
		}
	}
	return requirement;
}

/**
 * 校验单个 bundle（主 .app 或嵌套 Helper.app）。
 * `deepVerify` 只在主 .app 上跑：--deep 一次就把 Frameworks 下的二进制全查了。
 */
async function inspectBundle({ appPath, label, deepVerify, runCodesign, readInfoPlist, errors, warnings, requireDeveloperId, expectedTeamId, signing, runSpctl, runStapler }) {
	const sealPath = join(appPath, RESOURCE_SEAL);
	const sealed = await isNonEmptyFile(sealPath);
	if (!sealed && deepVerify) errors.push(`缺少资源封印 ${sealPath}：bundle 未做代码签名（签名被跳过时就是这个状态）`);

	let codesignExitCode = null;
	if (deepVerify) {
		const verifyArgs = ["--verify", "--deep", "--strict", "--verbose=2", appPath];
		const verify = await runCodesign(verifyArgs);
		codesignExitCode = verify.code;
		if (verify.code !== 0) errors.push(`codesign ${verifyArgs.slice(0, 4).join(" ")} 失败（rc=${verify.code}）：${tail(verify.output)}`);
	}

	const display = await runCodesign(["-dv", "--verbose=4", appPath]);
	const parsed = parseCodeSignDisplay(display.output);
	let expectedIdentifier = null;
	let plist = null;
	if (display.code !== 0) {
		errors.push(`codesign -dv ${label} 失败（rc=${display.code}）：${tail(display.output)}`);
		return { path: appPath, label, resourceSeal: deepVerify ? sealPath : null, sealed, codesignExitCode, ...parsed, expectedIdentifier, displayExitCode: display.code };
	}

	try {
		plist = await readInfoPlist(join(appPath, INFO_PLIST));
		expectedIdentifier = typeof plist?.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : null;
	} catch (error) {
		errors.push(`无法读取 ${join(appPath, INFO_PLIST)}：${error instanceof Error ? error.message : String(error)}`);
	}

	// macOS 的「本地网络」授权弹窗靠这条声明；缺了它系统不弹窗、局域网访问可能被默默拒绝。
	if (deepVerify) {
		const description = plist?.NSLocalNetworkUsageDescription;
		if (typeof description !== "string" || description.trim() === "") {
			errors.push(`${label} 的 Info.plist 缺少 NSLocalNetworkUsageDescription：macOS 不会为本地网络访问弹授权说明（build.mac.extendInfo 里要保留这条）`);
		}
	}

	if (!expectedIdentifier) errors.push(`${label} 的 Info.plist 缺少 CFBundleIdentifier，无法核对签名标识`);
	else if (!parsed.identifier) errors.push(`${label} 的签名没有 Identifier（CodeDirectory 未绑定 bundle id）`);
	else if (parsed.identifier !== expectedIdentifier) {
		errors.push(`${label} 的签名 Identifier=${parsed.identifier} 与 Info.plist CFBundleIdentifier=${expectedIdentifier} 不一致：macOS 按签名 identifier 记账（本地网络权限、TCC），退化后旧授权全部失效`);
	}
	if (!isInfoPlistBound(parsed.infoPlist)) errors.push(`${label} 的 Info.plist 未封印（codesign 报告 Info.plist=${parsed.infoPlist ?? "缺失"}）`);
	// 主 .app 一定有资源封印；Helper.app 可能本身没有常规资源文件（codesign 报 none 仍合法），
	// 只在主包上断言，避免把合法签名误判成失败。
	if (deepVerify && !hasSealedResources(parsed.sealedResources)) errors.push(`${label} 的资源未封印（codesign 报告 Sealed Resources=${parsed.sealedResources ?? "缺失"}）`);

	let designatedRequirement = null;
	if (requireDeveloperId) {
		designatedRequirement = await inspectDeveloperId({ appPath, label, parsed, expectedTeamId, runCodesign, errors });
		if (!hasHardenedRuntime(parsed)) errors.push(`${label} 未启用 hardened runtime（CodeDirectory flags=${parsed.flags ?? "?"}）`);
	} else if (deepVerify && parsed.signature === "adhoc") warnings.push(`${label} 使用 ad-hoc 签名：TCC 权限按二进制 cdhash 记账，更新或本地重签后可能需要重新授权；保留授权需持续使用同一 Developer ID 身份。`);
	if (deepVerify && requireDeveloperId) {
		if (signing.notarize) {
			const staple = await runStapler(["validate", appPath]);
			if (staple.code !== 0) errors.push(`${label} 没有装订公证票据（stapler validate rc=${staple.code}）：${tail(staple.output)}`);
			const assess = await runSpctl(["--assess", "--type", "execute", "--verbose=4", appPath]);
			if (assess.code !== 0) errors.push(`${label} 未通过 Gatekeeper 评估（spctl rc=${assess.code}）：${tail(assess.output)}`);
		} else {
			warnings.push(`${label} 已用 Developer ID 签名但未公证；公开分发需要完整 APPLE_* 公证凭据`);
		}
	}

	return { path: appPath, label, resourceSeal: deepVerify ? sealPath : null, sealed, codesignExitCode, ...parsed, designatedRequirement, expectedIdentifier, displayExitCode: display.code };
}

/**
 * 校验 release 目录下每个 mac 产物的代码签名。
 * `platform`/`runCodesign`/`readInfoPlist` 可注入，测试因此在 Linux/Windows 上也能覆盖全部判定分支。
 */
export async function verifyMacSignature({
	releaseDir = join(process.cwd(), "release"),
	platform = process.platform,
	runCodesign = defaultRunCodesign,
	readInfoPlist = defaultReadInfoPlist,
	identityPolicy = resolveMacIdentityPolicy(process.env),
	requireDeveloperId = false,
	expectedTeamId = identityPolicy.teamId,
	signing = { mode: identityPolicy.requireCertificate || hasDeveloperIdCertificate(process.env) ? "developer-id" : "adhoc", notarize: identityPolicy.requireNotarization || hasNotarizationCredentials(process.env) },
	runSpctl = defaultRunSpctl,
	runStapler = defaultRunStapler,
} = {}) {
	const root = resolve(releaseDir);
	const errors = [];
	const warnings = [];
	const apps = [];
	requireDeveloperId ||= identityPolicy.requireCertificate || Boolean(expectedTeamId) || signing.mode === "developer-id";
	// Injected or optional settings must not lower mandatory release requirements.
	signing = { ...signing, mode: requireDeveloperId ? "developer-id" : signing.mode, notarize: identityPolicy.requireNotarization || signing.notarize };
	try {
		validateMacIdentityPolicy({ ...identityPolicy, teamId: expectedTeamId });
		if (identityPolicy.teamId && identityPolicy.teamId !== expectedTeamId) throw new Error("expectedTeamId 不能覆盖已固定的 PIDECK_MAC_TEAM_ID");
	} catch (error) {
		return { ok: false, releaseDir: root, signing: signing.mode, apps, warnings, errors: [error instanceof Error ? error.message : String(error)] };
	}
	if (platform !== "darwin") {
		return { ok: false, releaseDir: root, signing: signing.mode, apps, warnings, errors: [`macOS 签名门禁需要 codesign，只能在 macOS 上运行（当前宿主：${platform}）`] };
	}

	const appPaths = await findMacApps(root);
	if (appPaths.length === 0) {
		return { ok: false, releaseDir: root, signing: signing.mode, apps, warnings, errors: [`在 ${root} 下没找到任何 .app（期望 release/mac*/*.app），无法验证签名`] };
	}

	for (const appPath of appPaths) {
		const main = await inspectBundle({ appPath, label: relative(root, appPath), deepVerify: true, runCodesign, readInfoPlist, errors, warnings, requireDeveloperId, expectedTeamId, signing, runSpctl, runStapler });
		const nested = [];
		for (const nestedPath of await findNestedApps(appPath)) {
			nested.push(await inspectBundle({ appPath: nestedPath, label: relative(root, nestedPath), deepVerify: false, runCodesign, readInfoPlist, errors, warnings, requireDeveloperId, expectedTeamId: expectedTeamId ?? main.teamIdentifier, signing, runSpctl, runStapler }));
		}
		apps.push({ ...main, nested });
	}

	return { ok: errors.length === 0, releaseDir: root, signing: signing.mode, apps, errors, warnings };
}

function parseArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--require-developer-id") options.requireDeveloperId = true;
		else if (arg === "--release-dir" || arg === "--team-id") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
			options[arg === "--release-dir" ? "releaseDir" : "expectedTeamId"] = value;
			index += 1;
		} else if (arg === "--help") options.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options.help) {
			console.log("Usage: node scripts/verify-mac-signature.mjs [--release-dir <path>] [--json] [--require-developer-id] [--team-id <id>]");
		} else {
			const result = await verifyMacSignature(options);
			if (!options.json) for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
			if (options.json) console.log(JSON.stringify(result, null, 2));
			else if (result.ok) {
				// 把 identifier 与 Helper 数量打出来：下一轮 #347 类事故时，日志本身就能证明门禁查到了什么，
				// 不用再回头翻构建产物。
				const detail = result.apps.map((app) => `${app.path} (identifier=${app.identifier ?? "?"}, helpers=${app.nested?.length ?? 0})`);
				console.log(`macOS bundles signed (${result.apps.length}): ${detail.join(", ")}`);
			} else {
				console.error(`macOS signature verification failed (${result.errors.length}):`);
				for (const error of result.errors) console.error(`- ${error}`);
				console.error("提示：无证书构建保留显式 ad-hoc 兜底；配置证书后必须通过 Developer ID / TeamIdentifier 校验，见 docs/release-process.md 的 macOS 签名策略。");
			}
			if (!result.ok) process.exitCode = 1;
		}
	} catch (error) {
		console.error(`macOS signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
