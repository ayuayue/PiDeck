import { execFile } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { AppSettings, PiUpdateCheckResult } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { PiLocator } from "./PiLocator";
import { PiProcess } from "./PiProcess";
import { getAppLogger } from "../logging/sharedLogger";
import { compareVersions } from "../utils/versionCompare";
import { parsePiVersion } from "../extensions/extensionVersionGate";
import { readConfiguredNpmCommand } from "../resourceWhitelist";
import { BUN_MIN_VERSION_FOR_RELEASE_AGE_FLAG, bunCommandCandidates, bunGlobalInstallArgs, isLocalAbsolutePath, npmGlobalInstallArgs, parseBunVersion, PI_OFFICIAL_REGISTRY, refineChannelForCustomBunRoot, resolvePiSelfUpdateChannel, type PiSelfUpdateChannel } from "./piSelfUpdateChannel";

/**
 * pi 自更新的**执行**链路：检查（pi.dev 版本接口）→ 通道分派 → 包管理器代跑 → 结果核验 → 失败提示。
 *
 * 为什么独立成模块：这段逻辑（约 280 行）与「扩展目录/安装」是两件事，混在 ExtensionManager 里既超文件红
 * 线、也让「更新失败提示与代跑参数」这类同源约束难以守住；拆分计划与门禁见 docs/pi-self-update-split-plan.md。
 *
 * 边界：纯判定与命令构造在 `piSelfUpdateChannel.ts`（零依赖纯函数），本模块只做 IO/子进程/错误改写；
 * 依赖全部经构造注入，**不反向 import ExtensionManager**——`runPi`（--no-approve 判定与 PATH/代理环境装配）、
 * 脱敏、版本探测缓存都属于管理器，以回调传入。
 */
export type SelfUpdateTranslate = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/** 更新结果（**未脱敏**）：由 ExtensionManager 的 toUpdateResult 统一做 home 掩码/截断后再交给 UI。 */
export type PiSelfUpdateRawResult = { command: string; output: string; updated: boolean };

export type PiSelfUpdateRunnerDeps = {
	locator: PiLocator;
	getSettings: () => AppSettings;
	translate: SelfUpdateTranslate;
	/** 失败输出脱敏（含 home 掩码）：扩展版本查询等多条链路共用同一实现，故留在管理器里注入。 */
	sanitizeCommandOutput: (value: string) => string;
	/** 复用管理器的 pi 调用：`--no-approve` 版本判定、PATH 补齐、代理与 WSL 处理都在那里。 */
	runPi: (args: string[], timeout: number, options?: { offline?: boolean; cwd?: string; projectInstall?: boolean; settings?: AppSettings; version?: string }) => Promise<string>;
	/** 清管理器的 pi 版本探测缓存（piVersion / piVersionPromise）；PiProcess 的全局缓存由本模块自己清。 */
	resetVersionProbeCache: () => void;
	/** pi settings.json 所在 home（读用户配置的 npmCommand；WSL 下是宿主 home）。 */
	homeDir: () => string;
};

/** pi 0.70.3 introduced self-update and the packages-only --extensions flag. */
export const MIN_PI_VERSION_FOR_SELF_UPDATE = "0.70.3";
const PI_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const PI_LATEST_VERSION_TIMEOUT_MS = 10_000;

/** pi 的 npm 包名。pi.dev 版本接口在包改名迁移期可返回不同 packageName，见 fetchLatestVersion。 */
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * 包管理器「目标源里没有这个版本」的错误特征。实测文案：
 * - bun 1.4.3：`No version matching "1.2.0" found for specifier "@earendil-works/pi-coding-agent" (but package exists)`；
 * - npm：code=ETARGET / notarget，文案 `No matching version found for …`。
 * 命中即说明失败原因是「源里查不到该版本」，而不是网络、权限或安装方式问题——
 * pi.dev 发布即宣布最新版，用户配置的镜像（npmmirror 等）同步滞后时必然出现这个组合。
 * （镜像连接失败是另一类：bun 报 `ConnectionClosed downloading package manifest`，不应命中本特征。）
 */
const PACKAGE_MISSING_VERSION_PATTERN = /\bETARGET\b|\bnotarget\b|No matching version found|No version matching/i;

/**
 * 发布年龄门：bun 的 minimumReleaseAge 与 npm 的 min-release-age 都会拒绝刚发布的版本。
 * 两者都命中 PACKAGE_MISSING_VERSION_PATTERN，必须优先识别，否则会把「版本已被发布但被年龄门拦下」
 * 误诊成镜像未同步。文案实测（bun 1.4.3）：
 * `error: No version matching "@earendil-works/pi-coding-agent" found for specifier "1.2.0" (blocked by minimum-release-age: 31536000 seconds)`；
 * npm 对应 `No matching version found for <pkg> with a date before <date>`（同样 ETARGET）。
 * 写法宽容到连字符/空格/驼峰，避免换个措辞就静默失效。
 */
const RELEASE_AGE_BLOCK_PATTERN = /minimum[-_ ]?release[-_ ]?age|with a date before/i;

/** Numbered prereleases at the introduction boundary must not enable a not-yet-stable CLI API. */
export function supportsPiSelfUpdate(version: string | undefined): boolean {
	const normalized = parsePiVersion(version);
	if (!normalized) return false;
	const [core] = normalized.split("-");
	const comparison = compareVersions(core ?? "", MIN_PI_VERSION_FOR_SELF_UPDATE);
	return comparison > 0 || (comparison === 0 && !normalized.includes("-"));
}

/** 主进程日志用的错误摘要：只取 message，不把堆栈和对象形态丢进日志 detail。 */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * pi 自更新执行器：一个实例绑定一份依赖；公共入口只有 check / update / fetchLatestVersion。
 *
 * 依赖按名存成独立字段（而不是一个 deps 对象）：测试按名替换 `runPi` / `locator` / 各代跑方法即可，
 * 不必摸进嵌套对象，和仓库其它协作者（AgentManager 的 messageEmit 等）的测试习惯一致。
 */
export class PiSelfUpdateRunner {
	private readonly locator: PiLocator;
	private readonly getSettings: () => AppSettings;
	private readonly translate: SelfUpdateTranslate;
	private readonly sanitizeCommandOutput: (value: string) => string;
	private readonly runPi: (args: string[], timeout: number, options?: { offline?: boolean; cwd?: string; projectInstall?: boolean; settings?: AppSettings; version?: string }) => Promise<string>;
	private readonly resetVersionProbeCache: () => void;
	private readonly homeDir: () => string;

	constructor(deps: PiSelfUpdateRunnerDeps) {
		this.locator = deps.locator;
		this.getSettings = deps.getSettings;
		this.translate = deps.translate;
		this.sanitizeCommandOutput = deps.sanitizeCommandOutput;
		this.runPi = deps.runPi;
		this.resetVersionProbeCache = deps.resetVersionProbeCache;
		this.homeDir = deps.homeDir;
	}

	/** 用固定设置快照检查更新：检查、执行、结果核验共用同一份快照，期间用户切运行时也不串味。 */
	async check(settings: AppSettings): Promise<PiUpdateCheckResult> {
		try {
			const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
			if (!status.installed) return { hasUpdate: false, error: this.translate("mainExtension.piNotInstalled") };
			// 与 `pi update --self` 使用同一个 pi.dev 版本接口，避免 npm latest 与 Pi 官方
			// 发布门槛短暂不同步时，PiDeck 显示的版本和 CLI 提示不一致。
			const release = await this.fetchLatestVersion(status.version ?? "0.0.0");
			return {
				currentVersion: status.version,
				latestVersion: release.version,
				hasUpdate: compareVersions(release.version, status.version ?? "0.0.0") > 0,
				// command / packageName 供 update() 的通道分派与包名 spec 使用。
				command: status.command,
				packageName: release.packageName,
			};
		} catch (error) {
			const detail = this.sanitizeCommandOutput(describeError(error));
			void getAppLogger()?.error("extensions", "Pi update check failed", { error: detail });
			return { hasUpdate: false, error: `${this.translate("mainExtension.updateCheckFailed")}\n${detail}` };
		}
	}

	/** 只自更新当前选中的 pi 安装，并按版本核验结果（不信任退出码）。返回未脱敏结果，由调用方脱敏。 */
	async update(): Promise<PiSelfUpdateRawResult> {
		const settings = { ...this.getSettings() };
		const check = await this.check(settings);
		if (check.error) throw new Error(check.error);
		if (!check.hasUpdate) {
			return {
				command: "pi update --self",
				output: this.translate("mainExtension.noUpdate", {
					current: check.currentVersion ?? "unknown",
					latest: check.latestVersion ?? "unknown",
				}),
				updated: false,
			};
		}
		// Older versions have no self-update API: do not guess npm/pnpm/standalone ownership.
		if (!supportsPiSelfUpdate(check.currentVersion)) {
			throw new Error(this.translate("mainExtension.piSelfUpdateUnsupported", { version: check.currentVersion || "?", minimum: MIN_PI_VERSION_FOR_SELF_UPDATE }));
		}
		// 通道分派（bun 全局 / 旧引导前缀 → PiDeck 代跑包管理器；其余 → pi 自身）。
		// 判定依赖 check 返回的 command（选中的 pi 可执行路径形状），见 piSelfUpdateChannel；
		// 自定义 BUN_INSTALL 的 shim 形态（`<root>/bin/pi`）再按磁盘布局细化——不细化的话 Windows 上会落到
		// pi 自身的 gate（“Update pi manually”），代跑能力形同不存在。
		const channel = refineChannelForCustomBunRoot(resolvePiSelfUpdateChannel(check.command ?? ""), check.command ?? "", existsSync);
		// 展示用摘要：与代跑共用同一 argv 构造器（真实前缀路径掩码成 <pi-runtime>）；bun 的年龄门开关取决于
		// 版本探测结果，摘要里不体现，实际 argv 以 runBunGlobalUpdate 为准。
		const labelSpec = `${check.packageName ?? PI_PACKAGE_NAME}@${check.latestVersion}`;
		const channelLabel = channel.kind === "bun-global" ? `bun ${bunGlobalInstallArgs(labelSpec).join(" ")}` : channel.kind === "portable-prefix" ? `npm ${npmGlobalInstallArgs(labelSpec, { prefixDir: "<pi-runtime>" }).join(" ")}` : "pi update --self";
		let output: string;
		try {
			if (channel.kind === "bun-global") {
				output = await this.runBunGlobalUpdate(this.pickBunCommand(channel.bunCommand), check.latestVersion ?? "", check.packageName, channel.bunInstallRoot);
			} else if (channel.kind === "portable-prefix") {
				output = await this.runNpmPrefixUpdate(channel.prefixDir, check.latestVersion ?? "", check.packageName);
			} else {
				output = await this.runPi(["update", "--self"], 120_000, { offline: false, settings, version: check.currentVersion });
			}
		} catch (error) {
			throw this.withUpdateFailureHint(error, check, channel);
		} finally {
			// A failed updater may still have changed files; never reuse a pre-update version probe.
			this.resetVersionProbeCache();
			PiProcess.invalidateVersionCache();
		}
		const status = await this.locator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		if (!status.installed || !status.version || compareVersions(status.version, check.latestVersion ?? "0.0.0") < 0) {
			throw new Error(`${this.translate("mainExtension.piUpdateNotApplied", { current: status.version || "?", latest: check.latestVersion || "?" })}\n${this.sanitizeCommandOutput(output)}`);
		}
		return { command: channelLabel, output, updated: true };
	}

	async fetchLatestVersion(currentVersion: string, timeoutMs: number = PI_LATEST_VERSION_TIMEOUT_MS): Promise<{ version: string; packageName?: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// 必须走 Electron net.fetch（Chromium 网络栈）：系统代理与 PiDeck 桌面代理
			//（defaultSession.setProxy）才会生效。裸全局 fetch 是 undici 实现，不读任何
			// 代理配置，代理网络下直连 pi.dev 十秒必超时（v0.7.9 起的回归，报错只有
			// 含糊的 AbortError "This operation was aborted"）。动态 import 保持可单测
			//（沙箱注入 electron 桩），与 tokendanceCatalog 等主进程联网点同模式。
			const { net } = await import("electron");
			const response = await net.fetch(PI_LATEST_VERSION_URL, {
				headers: { accept: "application/json", "user-agent": `pi-deck/${currentVersion}` },
				signal: controller.signal,
			});
			if (!response.ok) throw new Error(`pi version check returned HTTP ${response.status}`);
			const payload: unknown = await response.json();
			if (typeof payload !== "object" || payload === null || !("version" in payload) || typeof payload.version !== "string" || !payload.version.trim()) {
				throw new Error("pi version check returned an invalid version");
			}
			// packageName 可选：pi.dev 在包改名迁移期返回与默认包名不同的目标（pi 自身的
			// getSelfUpdatePlan 同样处理），代跑更新时用它拼 <pkg>@<ver>，否则用默认包名。
			const rawPackageName = "packageName" in payload && typeof payload.packageName === "string" ? payload.packageName.trim() : "";
			return { version: payload.version.trim(), ...(rawPackageName ? { packageName: rawPackageName } : {}) };
		} catch (error) {
			// abort() 不带 reason 时上游只会给 "This operation was aborted"，用户无从判断；
			// 命中本方法自己的超时信号时统一转成明确超时文案，真实网络错误原样透传。
			if (controller.signal.aborted) {
				throw new Error(`pi.dev version check timed out after ${Math.round(timeoutMs / 1000)}s (network unreachable or proxy required)`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * 更新失败时补一条可执行提示（只改写三类可判定的根因，其余错误原样抛出）：
	 * - 发布年龄门：给「放宽年龄门」的提示。前提是代跑会带 0 开关；探测不到 bun 版本（bun < 1.3 或包装
	 *   命令输出不可解析）时代跑不带，而能走到这里的正是 bun 自身的年龄门报错，让用户去改配置仍然正确；
	 * - 源里没有该版本：PiDeck 代跑的通道给与代跑同源的官方源命令，pi-self 通道只给「把 registry 指向
	 *   官方源」的建议（npm/pnpm/yarn/brew/managed 都在这档，写死 npm 会在 pnpm/yarn 机器上又装一个 pi）；
	 * - 其余（网络、权限、`ConnectionClosed` 等）不猜、不改写。
	 * 为什么要做这些判断：pi 与 PiDeck 的「最新版」都来自 pi.dev（发布即生效），而安装走用户配置的
	 * 包源；原始输出只有裸包管理器报错，用户会误以为是 PiDeck/pi 的 bug 而反复重试。
	 */
	private withUpdateFailureHint(error: unknown, check: PiUpdateCheckResult, channel: PiSelfUpdateChannel): Error {
		const detail = describeError(error);
		const version = check.latestVersion ?? "?";
		// 年龄门优先：它的文案也含「No version matching」，不先判会给反的镜像提示（实测：配了年龄门时
		// 镜像重试命令会再次被拦下，用户就困在原地）。
		if (RELEASE_AGE_BLOCK_PATTERN.test(detail)) return new Error(`${detail}\n${this.translate("mainExtension.piUpdateReleaseAgeHint", { version })}`);
		if (!PACKAGE_MISSING_VERSION_PATTERN.test(detail)) return error instanceof Error ? error : new Error(detail);
		const spec = `${check.packageName ?? PI_PACKAGE_NAME}@${check.latestVersion ?? ""}`;
		// 这里刻意不做 sanitizeCommandOutput 的 home 掩码：提示里的命令要能直接粘贴执行，掩码后的 `<user>` 在
		// shell/CMD 里都不是路径（channelLabel 那个 `<pi-runtime>` 只是展示标签）。路径属于 PiDeck 自己的
		// userData/pi-runtime 目录，回显给同一用户无外泄；与「失败输出脱敏」的差别记入 docs/pi-install-detection.md。
		// 前缀通道代跑用的是用户配置的 npmCommand（可能是绝对路径/包装命令），提示必须同源，否则粘了跑不通；
		// bun 通道用自带本体（绝对路径优先）即可。
		const command = channel.kind === "bun-global" ? `bun ${bunGlobalInstallArgs(spec, { registry: true }).join(" ")}` : channel.kind === "portable-prefix" ? `${this.configuredNpmCommand().join(" ")} ${npmGlobalInstallArgs(spec, { prefixDir: `"${channel.prefixDir}"`, registry: true }).join(" ")}` : "";
		const hint = command ? this.translate("mainExtension.piUpdateRegistryLagHint", { version, command }) : this.translate("mainExtension.piUpdateRegistryLagHintManual", { version, registry: PI_OFFICIAL_REGISTRY });
		return new Error(`${detail}\n${hint}`);
	}

	/** 代跑包管理器安装（bun/npm 全局自更新）：复用 locator 的 PATH 补齐与 shell 决策（与 npmViewVersion 同模式）。 */
	private runPackageInstall(commandPath: string, args: string[], timeoutMs: number, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
		const invocation = this.locator.createInvocation(commandPath, args);
		return new Promise((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: { ...this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix), ...extraEnv },
					shell: invocation.shell,
					windowsHide: true,
					timeout: timeoutMs,
					maxBuffer: 4 * 1024 * 1024,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(new Error(this.sanitizeCommandOutput(`${stdout}\n${stderr}`) || String(error)));
						return;
					}
					resolve(`${stdout}\n${stderr}`.trim());
				},
			);
		});
	}

	/**
	 * bun 本体定位：从 pi 入口推导出的绝对路径优先（GUI 启动 PATH 不全时最可靠），它不存在也不等于没装
	 * bun——Homebrew/scoop 装的 bun 本体在各自目录，而全局 shim 仍写在 `~/.bun/bin`（bun 用户报
	 * 「更新不了」的就是这一类），所以只有「本地绝对路径」才允许退回裸 `bun`，交给 createProcessEnv
	 * 组装出的 PATH（含登录 shell 目录、`~/.bun/bin`、brew 目录）解析。
	 *
	 * 非本地路径形态（裸命令名、或 WSL 这类包装命令串）一律原样返回：把包装命令串退回裸 `bun` 等于拿
	 * **宿主**的 bun 去装 pi、装错机器。这种形态本应在 resolvePiSelfUpdateChannel 就被拦下，这里是第二道
	 * 防线——宁可让 execFile 报 ENOENT（响亮失败），也不静默换目标。
	 */
	private pickBunCommand(derived: string): string {
		if (!isLocalAbsolutePath(derived)) return derived;
		if (existsSync(derived)) return derived;
		// Homebrew/nix 装的 bun 本体不在 `$BUN_INSTALL/bin`（那里只有 shim）：按已知位置逐个探一次，
		// 命中就用绝对路径；都不命中才回退裸 `bun` 赌 PATH（Linux 的 linuxbrew/nix 目录不在 PiLocator
		// 的硬编码目录里，那时裸 `bun` 会 ENOENT——用户报的「bun 更新不了」的剩余形态）。
		for (const candidate of bunCommandCandidates(this.homeDir(), basename(derived))) {
			if (existsSync(candidate)) return candidate;
		}
		return "bun";
	}

	/**
	 * bun 全局安装代跑：参数与 pi 自身的 bun 分支对齐（pi `getSelfUpdateCommandForMethod` 的 "bun" 分支：
	 * `install -g --ignore-scripts --minimum-release-age=0 <spec>`）——`--ignore-scripts` 与 npm 途径同等；
	 * `--minimum-release-age=0` 是因为 pi.dev 发布即宣布，用户 bunfig 里配了发布年龄门时新版本会被 bun
	 * 自行拦下（bun 报 `blocked by minimum-release-age`）。
	 *
	 * `installRoot` 来自通道判定（`<root>/bin` 与 `<root>/install/global` 的共同根），作为 BUN_INSTALL 传给
	 * bun：GUI 启动的 PiDeck 读不到用户 shell rc 里的 BUN_INSTALL，不传的话自定义根目录的机器会把包装进
	 * 默认 `~/.bun`，选中的安装原地不动（表现为「更新完版本没变」）。
	 */
	private async runBunGlobalUpdate(bunCommand: string, version: string, packageName?: string, installRoot?: string): Promise<string> {
		const env = installRoot ? { BUN_INSTALL: installRoot } : undefined;
		const releaseAgeFlag = await this.bunSupportsReleaseAgeFlag(bunCommand, env);
		return this.runPackageInstall(bunCommand, bunGlobalInstallArgs(`${packageName ?? PI_PACKAGE_NAME}@${version}`, { releaseAgeFlag }), 180_000, env);
	}

	/**
	 * 年龄门开关只在 bun ≥ 1.3 才存在（Bun 1.3 引入 minimumReleaseAge）：更老的 bun 会把它当未知参数
	 * 拒绝，反而让本来能成功的安装失败。探测失败按「不支持」处理——不阻塞安装主流程，真正的失败仍由
	 * 安装命令自己报出来（与 pi 先探测版本再追加 `--no-approve` 同一套取舍）。
	 */
	private async bunSupportsReleaseAgeFlag(bunCommand: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
		try {
			const parsed = parseBunVersion(await this.runPackageInstall(bunCommand, ["--version"], 15_000, env));
			return parsed !== undefined && compareVersions(parsed, BUN_MIN_VERSION_FOR_RELEASE_AGE_FLAG) >= 0;
		} catch {
			return false;
		}
	}

	/** 用户配置的 npm 命令（与包资源安装同源）：裸 npm 在 GUI PATH 里找不到时，配置的包装命令同样生效。 */
	private configuredNpmCommand(): string[] {
		return readConfiguredNpmCommand(join(this.homeDir(), ".pi", "agent", "settings.json"));
	}

	/**
	 * 旧引导前缀代跑：npm 落回用户全局目录时前缀副本永远停旧，必须显式 --prefix。
	 * 参数与 pi 自身的 npm 分支（`getSelfUpdateCommandForMethod` 的 "npm" 分支）一致：`--ignore-scripts`
	 * 是安装脚本隔离，`--min-release-age=0` 是因为 pi.dev 发布即宣布、用户 .npmrc 里配了 npm 的发布年龄门
	 * 时新版本会被拦下。
	 */
	private async runNpmPrefixUpdate(prefixDir: string, version: string, packageName?: string): Promise<string> {
		const configured = this.configuredNpmCommand();
		return this.runPackageInstall(configured[0], [...configured.slice(1), ...npmGlobalInstallArgs(`${packageName ?? PI_PACKAGE_NAME}@${version}`, { prefixDir })], 300_000);
	}
}
