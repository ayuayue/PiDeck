import { execFile } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";
import type { AppSettings, PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiUpdateCheckResult } from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import { toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { BUILT_IN_EXTENSIONS } from "./builtInExtensions";

export { BUILT_IN_EXTENSIONS } from "./builtInExtensions";

/**
 * pi list 对「过滤式安装」包的 source 后缀：settings.json 里 packages 条目为对象形式
 * （选择性加载指定资源）时，pi 在 list 输出中追加此标记。解析时剥离该后缀，
 * 过滤状态存进 PiExtensionSummary.filtered，避免污染卸载/更新等以 source 为参数的命令。
 */
export const FILTERED_SUFFIX = " (filtered)";

type SettingsProvider = () => AppSettings;
type ExtensionCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

/**
 * 通过 pi CLI 管理已安装扩展，避免桌面端直接改写 pi settings 导致和 CLI 行为不一致。
 * 自动检测 pi 版本，条件性添加 --no-approve（仅 pi >= 0.79.0 支持），
 * 兼容老版本避免 unknown option 错误。
 */
export class ExtensionManager {
	private wslEnvironment: WslEnvironment | null = null;
	/** 扩展列表缓存：避免每次打开配置页都重新跑 pi list + npm view。 */
	private listCache: PiExtensionListResult | null = null;
	/** 缓存是否包含 npm 版本信息（仅 forceRefresh 路径会写入 true）。 */
	private listCacheHasVersionInfo = false;
	/** 进行中的列表请求，用于启动预热与并发去重。 */
	private listInflight: Promise<PiExtensionListResult> | null = null;
	/** 进行中请求是否为强制刷新（含版本信息）。 */
	private listInflightForce = false;
	/**
	 * 列表缓存代数：安装/卸载/开关后递增。
	 * 用于丢弃失效前已发出的 in-flight 结果，避免旧列表写回缓存导致 UI 不刷新。
	 */
	private listCacheGeneration = 0;
	/**
	 * 每次实际扫描递增。强制刷新可绕过轻量扫描；旧的轻量结果随后返回时，
	 * 不能覆盖已经拿到版本信息的强制刷新缓存。
	 */
	private listRequestSequence = 0;

	constructor(
		private readonly locator: PiLocator,
		private readonly getSettings: SettingsProvider,
		/** 获取 PiDeck 桌面设置（含 removedBuiltInExtensions） */
		private readonly getPiDeckSettings: () => AppSettings = getSettings,
		/** 保存 PiDeck 桌面设置的部分更新 */
		private readonly patchPiDeckSettings: (
			patch: Partial<AppSettings>,
		) => Promise<AppSettings> = async () => getSettings(),
		private readonly translate: ExtensionCopy = () => "Extension operation failed.",
	) {}

	/** 将扩展文件边界切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.wslEnvironment = environment;
		// 切换 WSL/本地 home 后旧缓存失效。
		this.invalidateListCache();
	}

	private get homeDir(): string {
		return this.wslEnvironment?.windowsHome ?? homedir();
	}

	/** 缓存的 pi 版本号，用于条件性传递 --no-approve。 */
	private piVersion: string | null = null;
	private piVersionPromise: Promise<string | null> | null = null;

	/**
	 * 安装/卸载/开关后主动清缓存。
	 * 同时递增 generation 并断开 inflight 复用，避免旧请求完成后把已删除/已变更的列表写回。
	 */
	invalidateListCache() {
		this.listCache = null;
		this.listCacheHasVersionInfo = false;
		this.listCacheGeneration += 1;
		// 允许下一次 list() 立刻发起新请求，而不是复用失效前的 inflight。
		this.listInflight = null;
		this.listInflightForce = false;
	}

	/**
	 * 列出扩展。
	 * - forceRefresh=false：优先返回内存缓存；无缓存时做一次轻量扫描（跳过 npm view）。
	 * - forceRefresh=true：强制重新 `pi list`，并补充 npm 版本信息。
	 */
	async list(forceRefresh = false): Promise<PiExtensionListResult> {
		// 有缓存且（非强制刷新，或缓存已含版本信息）时直接返回。
		if (this.listCache && (!forceRefresh || this.listCacheHasVersionInfo)) {
			return this.listCache;
		}
		// 已有同级或更强请求在飞时复用，避免并发打爆 pi/npm。
		if (this.listInflight && (!forceRefresh || this.listInflightForce)) {
			return this.listInflight;
		}

		// 捕获当前代数：若请求返回前发生 install/uninstall/toggle，丢弃结果并改走最新 list。
		const generation = this.listCacheGeneration;
		const requestSequence = ++this.listRequestSequence;
		this.listInflightForce = forceRefresh;
		const request = this.loadList(forceRefresh)
			.then((result) => {
				if (
					generation !== this.listCacheGeneration ||
					requestSequence !== this.listRequestSequence
				) {
					// 失效前或被更强刷新取代的调用方也必须拿到最新列表，
					// 否则慢到的轻量扫描会覆盖已包含版本信息的强制刷新缓存。
					return this.list(forceRefresh);
				}
				this.listCache = result;
				this.listCacheHasVersionInfo = forceRefresh;
				return result;
			})
			.finally(() => {
				// 仅清理自己：失效后新发起的请求可能已经接管 listInflight。
				if (this.listInflight === request) {
					this.listInflight = null;
					this.listInflightForce = false;
				}
			});
		this.listInflight = request;
		return request;
	}

	private async loadList(includeVersionInfo: boolean): Promise<PiExtensionListResult> {
		const raw = await this.runPi(["list"], 20_000);
		const parsed = this.parseListOutput(raw);
		// npm view 是扩展页变慢的主因；默认列表先跳过，只有手动刷新时再查更新。
		const piInstalled = includeVersionInfo
			? await Promise.all(parsed.map((extension) => this.enrichExtensionVersion(extension)))
			: parsed;

		// 扫描本地自动发现的扩展（~/.pi/agent/extensions/ 下的 .ts 文件和目录），
		// pi list 只列出通过 pi install 安装的包，不包含本地文件扩展。
		const localExtensions = await this.scanLocalExtensions();

		// 合并，已通过 pi 安装的优先保留原条目
		const installedPaths = new Set(piInstalled.map((ext) => ext.path));
		const merged = [...piInstalled];
		for (const local of localExtensions) {
			if (!local.path || !installedPaths.has(local.path)) {
				merged.push(local);
			}
		}

		// 补充：将已禁用/文件缺失的内置扩展也纳入列表，确保用户可在 UI 中重新启用。
		const existingSources = new Set(merged.map((ext) => ext.source));
		for (const builtIn of BUILT_IN_EXTENSIONS) {
			if (!existingSources.has(builtIn)) {
				merged.push({
					id: `local:${builtIn}`,
					source: builtIn,
					path: undefined,
					scope: "user",
					builtIn: true,
				});
			}
		}

		// 通过 PiDeck 桌面设置标记内置扩展移除状态（与 pi disabledExtensions 分离）。
		// 必须在冲突检测前初始化：后续逻辑会写回 removedBuiltInExtensions 并删磁盘文件。
		const removedBuiltIn = new Set(this.getPiDeckSettings().removedBuiltInExtensions ?? []);
		for (const ext of merged) {
			ext.enabled = !(ext.builtIn && removedBuiltIn.has(ext.source));
		}

		// 仅检测 todo / plan / ask 固定冲突：三方包名含对应关键词时自动禁用内置版。
		// nul-redirect-fix 等其它内置扩展暂不参与冲突检测，避免 mode 等通用词误伤。
		// 注意：此处不走 disableBuiltIn（会 invalidateListCache），避免 list 请求中途 generation
		// 变化导致结果被丢弃后反复重入。
		const conflicts: { builtIn: string; thirdParty: string }[] = [];
		let removedChanged = false;
		for (const [builtInName, keyword] of BUILT_IN_CONFLICT_KEYWORDS) {
			if (removedBuiltIn.has(builtInName)) continue; // 已移除的不重复检测
			const conflicting = merged.find(
				(ext) =>
					!ext.builtIn &&
					ext.enabled !== false &&
					extensionNameMatches(ext.source, keyword),
			);
			if (conflicting) {
				removedBuiltIn.add(builtInName);
				removedChanged = true;
				// 内置扩展已改走 -e；仍清理用户目录历史部署副本，避免与三方包双加载冲突。
				await this.removeBuiltInFile(builtInName).catch(() => undefined);
				conflicts.push({
					builtIn: builtInName,
					thirdParty: conflicting.source,
				});
				// 同步更新 enabled 状态
				for (const ext of merged) {
					if (ext.builtIn && ext.source === builtInName) {
						ext.enabled = false;
					}
				}
			}
		}
		if (removedChanged) {
			await this.saveRemovedBuiltIn([...removedBuiltIn]);
		}

		// 已标记移除但磁盘仍有残留时主动清掉，修复「UI 已禁用但仍冲突」的历史状态。
		for (const builtInName of removedBuiltIn) {
			if (!builtInName.startsWith("pi-deck-")) continue;
			await this.removeBuiltInFile(builtInName).catch(() => undefined);
		}

		return { extensions: merged, raw, conflicts: conflicts.length > 0 ? conflicts : undefined };
	}

	/**
	 * 扫描 ~/.pi/agent/extensions/ 目录，发现未被 pi list 列出的本地扩展。
	 * 单文件扩展（.ts 文件）和目录扩展（含 index.ts）都会被识别。
	 */
	private async scanLocalExtensions(): Promise<PiExtensionSummary[]> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const result: PiExtensionSummary[] = [];

		let entries: string[];
		try {
			entries = await readdir(extensionsDir);
		} catch {
			return result; // 目录不存在时静默跳过
		}

		for (const entry of entries) {
			if (entry.startsWith(".") || entry === "node_modules" || entry.endsWith(".d.ts")) continue;

			const fullPath = join(extensionsDir, entry);
			let name = entry;
			let source = entry;

			// 处理目录扩展（目录/index.ts）
			if (entry.endsWith(".ts")) {
				// 单文件扩展，去掉 .ts 后缀作为显示名
				name = entry.slice(0, -3);
				source = entry;
			} else {
				// 目录扩展，检查是否有 index.ts
				try {
					await readFile(join(fullPath, "index.ts"), "utf-8");
					name = entry;
					source = entry;
				} catch {
					continue; // 没有 index.ts，跳过
				}
			}

			const isBuiltIn = name.startsWith("pi-deck-");
			result.push({
				id: `local:${source}`,
				source,
				path: extensionsDir,
				scope: "user",
				builtIn: isBuiltIn,
			});
		}

		return result;
	}

	/**
	 * 判断是否为本地文件扩展（~/.pi/agent/extensions 下自动发现的 .ts/目录）。
	 * pi list 的包源都带 npm:/file:/github: 等协议前缀；裸文件名只能走文件系统删除。
	 */
	private isLocalFileExtension(source: string): boolean {
		return !/^(?:npm|file|github|git|https?):/i.test(source);
	}

	/**
	 * 删除本地扩展文件/目录。
	 * 只允许删除 extensions 目录下的单层 basename，防止路径穿越。
	 */
	private async removeLocalExtension(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		// source 必须等于 basename（如 orca-agent-status.ts），拒绝 ../ 或绝对路径穿越。
		if (!name || name !== trimmed || name === "." || name === "..") {
			throw new Error(this.translate("mainExtension.invalidPath"));
		}
		const targetPath = join(extensionsDir, name);
		// 本地扩展是用户安装的代码：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
		await trashPath(targetPath, { source: "extension:uninstall" });
	}

	/** 卸载后从 disabledExtensions 清掉对应项，避免残留无效禁用记录。 */
	private async clearDisabledEntry(source: string): Promise<void> {
		try {
			const settingsPath = join(this.homeDir, ".pi", "agent", "settings.json");
			const raw = await readFile(settingsPath, "utf8");
			const settings = JSON.parse(raw) as { disabledExtensions?: string[] };
			const disabled = settings.disabledExtensions ?? [];
			if (!disabled.includes(source)) return;
			settings.disabledExtensions = disabled.filter((item) => item !== source);
			await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
		} catch {
			// settings 不存在或解析失败时忽略；卸载主流程已成功
		}
	}

	/**
	 * 删除用户扩展目录中的内置扩展文件。
	 * 只允许 pi-deck-* 单层 basename，防止路径穿越。
	 * force: 文件本就不存在时静默成功（幂等，适合启动残留清理）。
	 */
	async removeBuiltInFile(source: string): Promise<void> {
		const extensionsDir = join(this.homeDir, ".pi", "agent", "extensions");
		const trimmed = source.trim();
		const name = basename(trimmed);
		if (!name || name !== trimmed || !name.startsWith("pi-deck-") || name === "." || name === "..") {
			throw new Error("非法内置扩展路径");
		}
		await rm(join(extensionsDir, name), { force: true });
		// 启动残留清理的硬删（非用户主动删除，仅限 pi-deck-* 内置白名单）：记日志便于审计。
		getAppLogger()?.info("extension", "Built-in extension file removed", { name, path: join(extensionsDir, name) });
	}

	private async saveRemovedBuiltIn(removedList: string[]): Promise<void> {
		await this.patchPiDeckSettings({ removedBuiltInExtensions: removedList });
	}

	/**
	 * 禁用内置扩展：记入 removedBuiltInExtensions（RPC 启动时跳过 -e），
	 * 并清理用户扩展目录中可能残留的历史部署副本。
	 */
	async disableBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		if (!normalized.startsWith("pi-deck-")) {
			throw new Error("只能操作内置扩展");
		}
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		if (!current.includes(normalized)) {
			await this.saveRemovedBuiltIn([...current, normalized]);
		}
		// 幂等清理旧部署；新路径不再依赖用户目录文件。
		await this.removeBuiltInFile(normalized).catch(() => undefined);
		this.invalidateListCache();
	}

	async removeBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		if (!normalized.startsWith("pi-deck-")) {
			throw new Error("只能操作内置扩展");
		}
		await this.disableBuiltIn(normalized);
	}

	/**
	 * 恢复内置扩展：仅从 removedBuiltInExtensions 移除标记。
	 * 下次 Agent 启动会重新通过 -e 从 app resources 加载，无需再写用户扩展目录。
	 */
	async restoreBuiltIn(source: string): Promise<void> {
		const normalized = source.trim();
		const current = this.getPiDeckSettings().removedBuiltInExtensions ?? [];
		const next = current.filter((s) => s !== normalized);
		if (next.length === current.length) return;
		await this.saveRemovedBuiltIn(next);
		// 若用户目录仍有旧副本，一并删掉，避免与 -e 双加载。
		await this.removeBuiltInFile(normalized).catch(() => undefined);
		this.invalidateListCache();
	}

	async uninstall(source: string, scope: PiExtensionSummary["scope"] = "user"): Promise<void> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.sourceRequired"));
		// 阻止卸载 PiDeck 内置扩展（如 pi-deck-file-capture）
		if (normalized.startsWith("pi-deck-")) {
			throw new Error(this.translate("mainExtension.builtInCannotUninstall"));
		}
		// 本地 .ts/目录扩展不在 pi package 列表里，pi remove 会报 No matching package；
		// 例如 orca-agent-status.ts 只能直接删文件。
		if (this.isLocalFileExtension(normalized)) {
			await this.removeLocalExtension(normalized);
		} else {
			await this.runPi([
				"remove",
				normalized,
				...(scope === "project" ? ["-l"] : []),
			], 30_000);
		}
		await this.clearDisabledEntry(normalized);
		// 列表已变，清缓存，避免 UI 继续读到旧安装态。
		this.invalidateListCache();
	}

	async install(source: string): Promise<string> {
		const normalized = source.trim();
		if (!normalized) throw new Error(this.translate("mainExtension.nameRequired"));
		const result = await this.runPi(["install", normalized], 60_000);
		this.invalidateListCache();
		return result;
	}

	async checkPiUpdate(): Promise<PiUpdateCheckResult> {
		try {
			const settings = this.getSettings();
			const status = await this.locator.check(
				settings.customPiPath,
				settings.wslEnabled,
				settings.wslDistro,
				settings.wslUser,
			);
			if (!status.installed) return { hasUpdate: false, error: this.translate("mainExtension.piNotInstalled") };
			const latestVersion = await this.npmViewVersion("@earendil-works/pi-coding-agent");
			return {
				currentVersion: status.version,
				latestVersion,
				hasUpdate: this.compareVersions(latestVersion, status.version ?? "0.0.0") > 0,
			};
		} catch (error) {
			console.error("[ExtensionManager] Pi update check failed", error);
			return { hasUpdate: false, error: this.translate("mainExtension.updateCheckFailed") };
		}
	}

	async updatePi(): Promise<PiCliUpdateResult> {
		const check = await this.checkPiUpdate();
		if (!check.hasUpdate) {
			return {
				command: "pi update pi",
				output: check.error ?? this.translate("mainExtension.noUpdate", {
					current: check.currentVersion ?? "unknown",
					latest: check.latestVersion ?? "unknown",
				}),
				updated: false,
			};
		}
		const output = await this.runPi(["update", "pi"], 120_000, { offline: false });
		return this.toUpdateResult("pi update pi", output, true);
	}

	async updateExtensions(): Promise<PiCliUpdateResult> {
		const output = await this.runPi(["update", "--extensions"], 120_000, { offline: false });
		// 更新后版本信息变化，强制下次 list 重新获取。
		this.invalidateListCache();
		return this.toUpdateResult("pi update --extensions", output, true);
	}

	/** 更新单个扩展：`pi update <source>`，source 与 list 输出一致（如 npm:context-mode）。 */
	async updateExtension(source: string): Promise<PiCliUpdateResult> {
		const output = await this.runPi(["update", source], 120_000, { offline: false });
		// 更新后版本信息变化，强制下次 list 重新获取。
		this.invalidateListCache();
		return this.toUpdateResult(`pi update ${source}`, output, true);
	}

	private async enrichExtensionVersion(extension: PiExtensionSummary): Promise<PiExtensionSummary> {
		if (!extension.source.toLowerCase().startsWith("npm:")) return extension;
		const packageName = extension.source.replace(/^npm:/i, "");
		try {
			const [currentVersion, latestVersion] = await Promise.all([
				this.readInstalledVersion(extension.path),
				this.npmViewVersion(packageName),
			]);
			return {
				...extension,
				currentVersion,
				latestVersion,
				hasUpdate: Boolean(currentVersion && latestVersion && this.compareVersions(latestVersion, currentVersion) > 0),
			};
		} catch (error) {
			console.error("[ExtensionManager] Extension version check failed", error);
			return { ...extension, updateError: this.translate("mainExtension.versionCheckFailed") };
		}
	}

	private async readInstalledVersion(path?: string) {
		if (!path) return undefined;
		const hostPath = this.wslEnvironment
			? toWindowsHostPath(path, this.wslEnvironment)
			: path;
		const raw = await readFile(join(hostPath, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { version?: string };
		return parsed.version;
	}

	private npmViewVersion(packageName: string) {
		const invocation = this.locator.createInvocation("npm", ["view", packageName, "version"]);
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: this.locator.createProcessEnv(this.getSettings(), invocation.pathPrefix),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 30_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						// Electron 启动环境经常缺少用户 shell PATH；通过 PiLocator 补齐 PATH 后仍失败时，把 stderr 透出给设置页。
						reject(new Error((stderr || error.message).trim()));
						return;
					}
					resolve(stdout.trim());
				},
			);
		});
	}

	private toUpdateResult(command: string, output: string, updated: boolean): PiCliUpdateResult {
		return { command, output: output.trim(), updated };
	}

	private compareVersions(a: string, b: string) {
		const left = a.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
		const right = b.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
		const len = Math.max(left.length, right.length);
		for (let index = 0; index < len; index += 1) {
			const diff = (left[index] ?? 0) - (right[index] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	}

	async setEnabled(source: string, enabled: boolean): Promise<void> {
		const settingsPath = join(this.homeDir, ".pi", "agent", "settings.json");
		let raw = "{}";
		try { raw = await readFile(settingsPath, "utf8"); } catch {}
		const settings = JSON.parse(raw);
		const disabled: string[] = settings.disabledExtensions ?? [];
		if (enabled) {
			settings.disabledExtensions = disabled.filter((s) => s !== source);
		} else {
			if (!disabled.includes(source)) {
				settings.disabledExtensions = [...disabled, source];
			}
		}
		await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
		// 开关状态变化后同步清缓存，避免 UI 显示旧 enabled。
		this.invalidateListCache();
	}

	private async getDisabledExtensions(): Promise<Set<string>> {
		const settingsPath = join(this.homeDir, ".pi", "agent", "settings.json");
		try {
			const raw = await readFile(settingsPath, "utf8");
			const settings = JSON.parse(raw);
			return new Set<string>(settings.disabledExtensions ?? []);
		} catch {
			return new Set<string>();
		}
	}

	/**
	 * --no-approve 标志在 pi 0.79.0 引入。检测本地安装的 pi 版本是否支持。
	 */
	private async noApproveSupported(): Promise<boolean> {
		const version = await this.getPiVersion();
		if (!version) return false;
		const match = version.match(/^(\d+)\.(\d+)/);
		if (!match) return false;
		const major = parseInt(match[1], 10);
		const minor = parseInt(match[2], 10);
		// pi >= 0.79.0 或 1.x+ 都支持 --no-approve
		return major > 0 || minor >= 79;
	}

	private async getPiVersion(): Promise<string | null> {
		if (this.piVersion) return this.piVersion;
		if (this.piVersionPromise) return this.piVersionPromise;
		this.piVersionPromise = this.detectPiVersion();
		return this.piVersionPromise;
	}

	private async detectPiVersion(): Promise<string | null> {
		try {
			const settings = this.getSettings();
			const status = await this.locator.check(
				settings.customPiPath,
				settings.wslEnabled,
				settings.wslDistro,
				settings.wslUser,
			);
			if (status.installed && status.version) {
				this.piVersion = status.version;
				return status.version;
			}
		} catch {
			// 版本检测失败时静默处理，后续调用方会 fallback 为不支持 --no-approve
		}
		return null;
	}

	private async runPi(args: string[], timeout: number, options: { offline?: boolean } = {}): Promise<string> {
		// --no-approve 在 pi 0.79+ 才支持，老版本需要跳过以避免 unknown option 错误。
		const finalArgs = [...args];
		if (await this.noApproveSupported()) {
			finalArgs.push("--no-approve");
		}
		const settings = this.getSettings();
		const command = this.locator.resolveCommand(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		const invocation = this.locator.createInvocation(command, finalArgs);
		const env = this.locator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl);
		// list/remove/install 使用离线模式避免配置页被网络和包管理器输出拖慢；update 必须允许联网，
		// 否则 pi 只会返回简化的 Updated packages，无法真正走 npm 更新流程。
		if (options.offline !== false) env.PI_OFFLINE = "1";
		return new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env,
					shell: invocation.shell,
					windowsHide: true,
					timeout,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						console.error("[ExtensionManager] pi command failed", {
							args: finalArgs,
							error: error.message,
							stderr: stderr.trim(),
						});
						reject(new Error(this.translate("mainExtension.commandFailed")));
						return;
					}
					resolve(stdout);
				},
			);
		});
	}

	private parseListOutput(raw: string): PiExtensionSummary[] {
		const result: PiExtensionSummary[] = [];
		let scope: PiExtensionSummary["scope"] = "unknown";
		let pending: PiExtensionSummary | null = null;

		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (/^User packages:/i.test(trimmed)) {
				scope = "user";
				pending = null;
				continue;
			}
			if (/^Project packages:/i.test(trimmed)) {
				scope = "project";
				pending = null;
				continue;
			}

			if (/^(?:npm|file|github|git|https?):/i.test(trimmed)) {
				// pi list 对「过滤式安装」的包在 source 后追加 " (filtered)" 标记
				// （settings.json 里 packages 条目是对象形式，只选择性加载列出的资源）。
				// source 必须剥离该后缀：卸载/更新/版本查询都以 source 为参数，
				// 带后缀时 pi remove / pi update / npm view 都找不到目标。
				const isFiltered = trimmed.endsWith(FILTERED_SUFFIX);
				const source = isFiltered
					? trimmed.slice(0, -FILTERED_SUFFIX.length)
					: trimmed;
				pending = {
					id: `${scope}:${source}`,
					source,
					scope,
					...(isFiltered ? { filtered: true } : {}),
				};
				result.push(pending);
				continue;
			}

			if (pending && !pending.path) {
				pending.path = trimmed;
			}
		}

		return result;
	}
}

/**
 * 当前参与冲突检测的内置扩展与关键词。
 * todo / plan / ask：三方包名含关键词即视为功能冲突；其它内置扩展暂不自动互斥。
 */
export const BUILT_IN_CONFLICT_KEYWORDS = [
	["pi-deck-todo.ts", "todo"],
	["pi-deck-plan-mode.ts", "plan"],
	["pi-deck-ask-question.ts", "ask"],
] as const;

/**
 * 固定关键词冲突匹配：清理协议/作用域后，包名是否包含指定关键词。
 * 例：rpiv-todo、my-plan-helper 命中；context-mode 不含 plan/todo 不命中。
 */
export function extensionNameMatches(source: string, keyword: string): boolean {
	const clean = source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "")
		.toLowerCase();
	return clean.includes(keyword.toLowerCase());
}
