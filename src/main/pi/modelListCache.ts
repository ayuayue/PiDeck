/**
 * pi --list-models 全局缓存模块。
 *
 * 数据源：优先 pi --list-models（pi 内部处理 auth.json/models.json/内置目录）。
 * 加速参数：--offline --no-skills --no-themes（新版 pi 实测更快）。
 *
 * 扩展策略（issue #181）：第一档【带扩展】优先——扩展通过 pi.registerProvider
 * 贡献的模型必须出现在选择器里（与 CLI 一致）；但坏扩展/慢扩展可能让 CLI 失败或挂起，
 * 所以失败后降级到【不带扩展】的加速档，进一步失败再降级到【兼容档】。
 * 老版本不认识这些旗标会直接 unknown option / 非 0 退出；会话页 IPC 再把失败
 * 吞成 []，表现为「设置页默认模型正常、会话选择器空」。因此：
 * - 第一档任何失败都降级（可能是扩展问题，不是配置问题）；
 * - 后续档位仅 unknown-option 降级（保留配置损坏等真实错误，供失败分类用）；
 * - CLI 仍空/失败时回退读本地 models.json（与设置页同源）。
 *
 * 刷新策略：
 * - 启动时异步预加载（应用 ready 后后台 fork 一次）；
 * - 界面保存 models.json/auth.json 后失效并后台重取；
 * - 每次启动 Agent 时强制重取（防用户直接改文件不生效）。
 *
 * 目录缓存（models-store.json）刷新：
 * PiDeck 的 RPC 进程一律带 --offline，pi 启动时的自动目录网络刷新（非 offline 时
 * main() 会异步 modelRuntime.refresh 并写 models-store.json）被跳过，目录只能靠 TUI
 * 更新 → 长期滞后会让选择器显示「目录有但运行中 Agent 快照没有」的模型（如官方
 * provider 的新模型）。冷启动时用 pi update --models（唯一显式刷新入口，内置 15s
 * 超时）主动刷一次，节流由 models-store.json 的 mtime 判断（见 MODEL_CATALOG_STALE_MS）。
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { AvailableModel, ModelListFailReason, ModelListReport } from "../../shared/types";
import type { PiLocator } from "./PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";

/** 本地 models.json 读取面：只依赖 parsed（+解析诊断），避免反向依赖 ConfigManager 实现。
 *
 *  `diagnostic` 在 models.json JSON 解析失败时存在（ConfigManager.readJsonFile 返回），
 *  模型列表为空时据此把原因分类为「配置损坏」，而不是笼统的"没有模型"。 */
export type ModelListConfigSource = {
	getModelsConfig: () => Promise<{
		parsed: unknown;
		diagnostic?: {
			fileName?: string;
			message?: string;
			line?: number;
			column?: number;
			docsUrl?: string;
		};
	}>;
};

/** 模型列表失败分类的输入信号：CLI 错误 + 配置解析诊断 + pi 安装状态。 */
export type ModelListFailureSignals = {
	cliError: Error | null;
	configDiagnostic: ModelListConfigDiagnostic | null;
	piInstalled: boolean;
	version: string | null;
};

/** models.json 解析诊断的模型列表内部形态。 */
export type ModelListConfigDiagnostic = {
	fileName: string;
	message: string;
	line?: number;
	column?: number;
};

/** 全局缓存：模型列表（null = 未加载/已失效） */
let cachedListModels: AvailableModel[] | null = null;
/** 在途请求去重：并发调用只 fork 一次 */
let cachedListModelsPending: Promise<AvailableModel[]> | null = null;
/**
 * 配置变更标记：invalidate 后在途请求的结果不得写缓存（其数据对应失效前的配置），
 * 否则保存 models.json 时若存在旧的在途 fork，旧结果会覆盖新缓存——
 * 表现为「新模型添加后下拉列表有时候没有」。refreshModelList 重取时复位。
 */
let configInvalidated = false;

/** pi --list-models 第一档参数：带扩展（默认发现扩展，含扩展贡献的模型）。
 * 与 CLI 默认行为一致；不使用 --no-extensions，让 pi.registerProvider 类插件
 * （如 antigravity）的模型能进入选择器。 */
export const MODEL_LIST_EXT_ARGS = [
	"--list-models",
	"--offline",
	"--no-skills",
	"--no-themes",
];

/** pi --list-models 加速参数（降级档）：offline 跳过网络目录刷新，no-ext/skills/themes 跳过发现加载。
 * 若第一档因坏扩展/慢扩展失败，用本档再试一次。 */
export const MODEL_LIST_FAST_ARGS = [
	"--list-models",
	"--offline",
	"--no-extensions",
	"--no-skills",
	"--no-themes",
];

/** 老版本 pi 只认 --list-models；加速旗标会 unknown option。 */
export const MODEL_LIST_COMPAT_ARGS = ["--list-models"];

export function isUnknownCliOption(message: string): boolean {
	return /unknown option|unrecognized option|unexpected argument/i.test(message);
}

function isYesNo(token: string): boolean {
	return /^(yes|no)$/i.test(token);
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * 解析 pi --list-models 的文本表格输出。
 * 表格格式：provider  model  context  max-out  thinking  images
 * context/max-out 为人类可读 token 数（如 1M / 65.5K / 272K），解析为数字；
 * thinking/images 为 yes/no。
 * 关键：不能按空白切分前两列——provider 名可能含空格（如用户把 provider 复制为
 * "grok.weishiair.de copy"），split 后 token 数 > 列数。因此从右往左解析：
 * 后 4 列固定是 context/max-out/thinking/images（数值/yes/no 不含空格），
 * 倒数第 5 个 token 是模型 id，再往前的所有 token 拼回 provider 名。
 */
export function parsePiListModels(stdout: string): AvailableModel[] {
	const lines = stripAnsi(stdout)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const models: AvailableModel[] = [];
	for (const line of lines) {
		if (/unknown option|unrecognized option|error:/i.test(line)) continue;
		const parts = line.split(/\s+/).filter(Boolean);
		if (parts.length < 2) continue;
		// 跳过表头，而不是「永远丢掉第一行」——老 pi 可能没有表头，或 stderr 混进 stdout。
		if (parts[0].toLowerCase() === "provider") continue;

		if (parts.length >= 6 && isYesNo(parts[parts.length - 1] ?? "") && isYesNo(parts[parts.length - 2] ?? "")) {
			const tail = parts.slice(-4);
			const provider = parts.slice(0, -5).join(" ");
			const modelId = parts[parts.length - 5];
			if (!provider || !modelId) continue;
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				contextWindow: parseTokenSize(tail[0] ?? ""),
				maxTokens: parseTokenSize(tail[1] ?? ""),
				reasoning: tail[2]?.toLowerCase() === "yes",
				images: tail[3]?.toLowerCase() === "yes",
			});
			continue;
		}

		const last = parts[parts.length - 1] ?? "";
		const prev = parts[parts.length - 2] ?? "";
		if (parts.length >= 4 && parseTokenSize(prev) !== undefined && parseTokenSize(last) !== undefined) {
			const provider = parts.slice(0, -3).join(" ");
			const modelId = parts[parts.length - 3];
			if (!provider || !modelId) continue;
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				contextWindow: parseTokenSize(prev),
				maxTokens: parseTokenSize(last),
			});
			continue;
		}

		if (parts.length >= 3 && isYesNo(last)) {
			const provider = parts.slice(0, -2).join(" ");
			const modelId = parts[parts.length - 2];
			if (!provider || !modelId) continue;
			models.push({
				provider,
				id: modelId,
				name: `${provider}/${modelId}`,
				reasoning: last.toLowerCase() === "yes",
			});
			continue;
		}

		const provider = parts.slice(0, -1).join(" ");
		const modelId = parts[parts.length - 1];
		if (!provider || !modelId) continue;
		models.push({
			provider,
			id: modelId,
			name: `${provider}/${modelId}`,
		});
	}
	return models;
}

/** 解析 pi 表格里的 token 数："1M"→1000000，"65.5K"→65500，"200K"→200000；解析失败返回 undefined。
 *
 * 进制必须与 pi 的 formatTokenCount 对齐（1000 进制，见 pi dist/cli/list-models.js）：
 * 十进制 round 数（1e6→"1M"、272000→"272K"、204800→"204.8K"）用 1000 进制可精确还原；
 * 旧实现按 1024 解析会把 1e6 猜成 1048576（+4.9%，配置回写时把模型容量写超），
 * 而真实值是二进制 1M（1048576）的模型按 1000 解析只低 4.6%，方向安全（提前压缩而非超限）。 */
export function parseTokenSize(value: string): number | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const match = /^([\d.]+)([KkMm])?$/.exec(trimmed);
	if (!match) return undefined;
	const num = Number(match[1]);
	if (!Number.isFinite(num) || num <= 0) return undefined;
	const unit = match[2]?.toLowerCase();
	if (unit === "k") return Math.round(num * 1000);
	if (unit === "m") return Math.round(num * 1000 * 1000);
	return Math.round(num);
}

/**
 * 把设置页同源的 models.json 展平为会话选择器结构。
 * CLI 失败时必须能靠这份数据填列表，否则用户配完默认模型仍看不到可选模型。
 */
export function modelsFromPiConfig(modelsFile: unknown): AvailableModel[] {
	if (!modelsFile || typeof modelsFile !== "object" || Array.isArray(modelsFile)) return [];
	const providers = (modelsFile as { providers?: unknown }).providers;
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return [];
	const models: AvailableModel[] = [];
	for (const [provider, config] of Object.entries(providers)) {
		if (!provider || !config || typeof config !== "object" || Array.isArray(config)) continue;
		const list = (config as { models?: unknown }).models;
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const record = item as Record<string, unknown>;
			if (typeof record.id !== "string" || !record.id) continue;
			const input = record.input;
			models.push({
				provider,
				id: record.id,
				name: typeof record.name === "string" && record.name ? record.name : `${provider}/${record.id}`,
				reasoning: record.reasoning === true,
				contextWindow: typeof record.contextWindow === "number" ? record.contextWindow : undefined,
				maxTokens: typeof record.maxTokens === "number" ? record.maxTokens : undefined,
				images: Array.isArray(input) ? input.includes("image") : undefined,
			});
		}
	}
	return models;
}

/** 截断长错误文本，避免详情区撑爆选择器。 */
function clip(text: string, max = 260): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

/**
 * 把 CLI 失败 + 配置解析诊断 + pi 安装状态分类成可引导的原因（纯函数，可单测）。
 * 优先级：pi 未安装 > 配置损坏 > 版本过旧 > 其他 CLI 失败 > 配置本身为空。
 * - pi-not-found：--version 都跑不起来，先解决 pi 安装/路径；
 * - config-invalid：models.json 解析报错（有行号/列号），或 CLI stderr 出现
 *   json/config 类关键词——修复配置比升级/重装更直接；
 * - version-too-old：连兼容参数（仅 --list-models）也被拒（unknown option）——
 *   老版 pi 不支持该旗标，提示升级而非排查配置；
 * - empty：pi 正常、配置合法但没有模型——去模型页添加 provider。
 */
export function classifyModelListFailure(
	signals: ModelListFailureSignals,
): { reason: ModelListFailReason; detail: string } {
	const first = signals.cliError?.message ?? "";
	if (!signals.piInstalled) {
		return { reason: "pi-not-found", detail: clip(first || "pi not installed") };
	}
	if (signals.configDiagnostic) {
		const d = signals.configDiagnostic;
		const position =
			d.line !== undefined ? ` at line ${d.line}:${d.column ?? 1}` : "";
		return {
			reason: "config-invalid",
			detail: clip(`${d.fileName} parse failed${position}: ${d.message}`),
		};
	}
	if (isUnknownCliOption(first)) {
		return {
			reason: "version-too-old",
			detail: clip(
				`pi ${signals.version ?? "unknown"} rejects --list-models: ${first}`,
			),
		};
	}
	if (/config|json|parse|provider|auth|yaml/i.test(first)) {
		return { reason: "config-invalid", detail: clip(first) };
	}
	if (signals.cliError) {
		return { reason: "cli-failed", detail: clip(first) };
	}
	return { reason: "empty", detail: "no models in models.json / auth.json" };
}

async function loadModelsFromLocalConfigDetailed(
	configSource?: ModelListConfigSource,
): Promise<{ models: AvailableModel[]; diagnostic: ModelListConfigDiagnostic | null }> {
	if (!configSource) return { models: [], diagnostic: null };
	try {
		const result = await configSource.getModelsConfig();
		const diagnostic = result.diagnostic
			? {
					fileName: result.diagnostic.fileName ?? "models.json",
					message: result.diagnostic.message ?? "parse error",
					line: result.diagnostic.line,
					column: result.diagnostic.column,
				}
			: null;
		return { models: modelsFromPiConfig(result.parsed), diagnostic };
	} catch (error) {
		// getModelsConfig 内部已捕获 ENOENT；这里兜底异常也视为解析失败，不向调用方抛。
		return {
			models: [],
			diagnostic: {
				fileName: "models.json",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

async function loadModelsFromLocalConfig(
	configSource?: ModelListConfigSource,
): Promise<AvailableModel[]> {
	return (await loadModelsFromLocalConfigDetailed(configSource)).models;
}

/** 执行 pi CLI 命令并返回 stdout（WSL/customPath 解析与进程环境同 execPiListModels）。 */
async function runPiCliCommand(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	args: readonly string[],
): Promise<string> {
	const settings = settingsStore.get();
	// 拉模型列表可以等 WSL which；不能在 resolveCommand 里同步卡住主进程。
	if (settings.wslEnabled && settings.wslDistro && settings.wslUser) {
		await piLocator.warmWslCommand(settings.wslDistro, settings.wslUser);
	}
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
	);
	const invocation = piLocator.createInvocation(command, [...args]);
	return new Promise((resolve, reject) => {
		void import("node:child_process").then(({ execFile }) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
					shell: invocation.shell,
					windowsHide: true,
					timeout: 20_000,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const message = (stderr || error.message).slice(0, 300);
						reject(new Error(message));
					} else {
						resolve(stdout);
					}
				},
			);
		}).catch(reject);
	});
}

async function execPiListModels(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	args: readonly string[],
): Promise<string> {
	return runPiCliCommand(piLocator, settingsStore, args);
}

/** fork pi --list-models 并解析。降级链：带扩展 → 无扩展加速 → 仅 --list-models。
 * 第一档任何失败都降级（坏扩展/慢扩展不属于配置问题）；后续档位仅在
 * unknown-option 时降级（老版本 pi），真实错误（配置损坏、命令不存在）立即上抛，
 * 保留给 classifyModelListFailure 分类。 */
export async function runPiListModels(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<AvailableModel[]> {
	const argSets = [MODEL_LIST_EXT_ARGS, MODEL_LIST_FAST_ARGS, MODEL_LIST_COMPAT_ARGS];
	let lastError: Error | null = null;
	for (const [index, args] of argSets.entries()) {
		try {
			const stdout = await execPiListModels(piLocator, settingsStore, args);
			if (isUnknownCliOption(stdout)) {
				lastError = new Error(stdout.slice(0, 300));
				continue;
			}
			return parsePiListModels(stdout);
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			lastError = err;
			// 第一档失败可能源于扩展（加载失败/工厂挂起），无条件降级到无扩展档重试；
			// 后续档位只认 unknown-option（老版本 pi），其余错误如实上抛。
			if (index > 0 && !isUnknownCliOption(err.message)) throw err;
		}
	}
	if (lastError) throw lastError;
	return [];
}

/** resolveModelsDetailed 返回的内部细节：模型 + 失败信号（供诊断报告复用同一趟 CLI 调用）。 */
type ModelListResolveDetail = {
	models: AvailableModel[];
	/** CLI 最后一次失败（未知参数/非 0 退出/命令不存在）；成功返回时置 null */
	cliError: Error | null;
	/** CLI 无模型时是否靠本地 models.json 兜底成功（回退可用 = 配置合法） */
	fellBackToConfig: boolean;
	configDiagnostic: ModelListConfigDiagnostic | null;
};

async function resolveModelsDetailed(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	configSource?: ModelListConfigSource,
): Promise<ModelListResolveDetail> {
	let cliError: Error | null = null;
	// 第一次尝试（内部含未知参数自动降级为仅 --list-models）
	try {
		const models = await runPiListModels(piLocator, settingsStore);
		if (models.length > 0) {
			return { models, cliError: null, fellBackToConfig: false, configDiagnostic: null };
		}
	} catch (error) {
		cliError = error instanceof Error ? error : new Error(String(error));
	}
	// 空结果重试一次：启动早期 pi 冷启动/环境未就绪时可能返回空表头。
	await new Promise((resolve) => setTimeout(resolve, 500));
	try {
		const models = await runPiListModels(piLocator, settingsStore);
		if (models.length > 0) {
			return { models, cliError: null, fellBackToConfig: false, configDiagnostic: null };
		}
	} catch (error) {
		cliError = cliError ?? (error instanceof Error ? error : new Error(String(error)));
	}
	// CLI 仍无模型：回退本地 models.json（保留解析诊断供失败分类）。
	const fallback = await loadModelsFromLocalConfigDetailed(configSource);
	return {
		models: fallback.models,
		cliError,
		fellBackToConfig: fallback.models.length > 0,
		configDiagnostic: fallback.diagnostic,
	};
}

async function resolveModels(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	configSource?: ModelListConfigSource,
): Promise<AvailableModel[]> {
	return (await resolveModelsDetailed(piLocator, settingsStore, configSource)).models;
}

/**
 * 获取模型列表（读缓存；无缓存时 fork 一次）。
 * 关键：空结果不写缓存——启动早期 pi 可能尚未就绪导致 fork 返回空，
 * 若把空数组缓存下来会永久显示「没有匹配的模型」。
 * 首次 fork 返回空时自动重试一次（间隔 500ms），覆盖 pi 冷启动慢的场景。
 * 返回的数组由调用方消费，不应修改。
 */
export function fetchModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	configSource?: ModelListConfigSource,
): Promise<AvailableModel[]> {
	if (cachedListModels) return Promise.resolve(cachedListModels);
	if (cachedListModelsPending) return cachedListModelsPending;

	cachedListModelsPending = resolveModels(piLocator, settingsStore, configSource)
		.then((models) => {
			if (models.length > 0 && !configInvalidated) cachedListModels = models;
			return models;
		})
		.finally(() => {
			cachedListModelsPending = null;
		});
	return cachedListModelsPending;
}

/**
 * 强制刷新模型列表（绕过缓存）：配置变更 / 启动 Agent 时调用。
 * 若存在在途请求（可能对应保存前的旧配置），不直接复用其结果——
 * 链式等它结束后重新 fork，保证返回的是新配置的列表。
 */
export function refreshModelList(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	configSource?: ModelListConfigSource,
): Promise<AvailableModel[]> {
	const pending = cachedListModelsPending;
	if (pending) {
		cachedListModelsPending = pending
			.catch(() => undefined)
			.then(() => {
				configInvalidated = false;
				return resolveModels(piLocator, settingsStore, configSource);
			})
			.then((models) => {
				if (models.length > 0 && !configInvalidated) cachedListModels = models;
				return models;
			})
			.finally(() => {
				cachedListModelsPending = null;
			});
		return cachedListModelsPending;
	}
	configInvalidated = false;
	cachedListModelsPending = resolveModels(piLocator, settingsStore, configSource)
		.then((models) => {
			if (models.length > 0 && !configInvalidated) cachedListModels = models;
			return models;
		})
		.finally(() => {
			cachedListModelsPending = null;
		});
	return cachedListModelsPending;
}

/** 清空模型列表缓存（配置变更后调用；后续 fetch 会重新 fork）。 */
export function invalidateModelListCache(): void {
	cachedListModels = null;
	// 在途请求让其自然完成；其结果不得写缓存（对应失效前配置），由 refreshModelList 重取。
	configInvalidated = true;
}

/** 获取当前缓存的模型列表（不触发新的 fork）。 */
export function getCachedModelList(): AvailableModel[] | null {
	return cachedListModels;
}

/** pi update --models：强制刷新模型目录缓存（models-store.json）并退出。
 *
 * pi 内部实现（chunk-E5KXRMZK.js refreshModelCatalogs2）：
 *   ModelRuntime.create({ allowModelNetwork: !1 }).refresh({ allowNetwork: !0, force: !0 })
 * 内置 15s 超时，成功输出 "Model catalogs refreshed"；不启动常驻 RPC 进程。
 * 这是 pi 提供的唯一显式目录刷新入口（--offline 时 RPC 启动自动刷新被跳过）。 */
export const MODEL_CATALOG_REFRESH_ARGS = ["update", "--models"] as const;

/**
 * 目录缓存过期阈值：models-store.json 的 mtime 距今超过该值才值得冷启动刷新。
 * 与 pi 内置 withRemoteCatalog 的远程目录刷新节流（REMOTE_CATALOG_REFRESH_INTERVAL_MS=4h）
 * 保持一致：4h 内任何来源（TUI / 手动 pi update --models / 上次冷启动）更新过目录，
 * PiDeck 就不再出手；超过 4h 无人管过才兜底刷一次（force 网络请求，内置 15s 超时）。
 */
export const MODEL_CATALOG_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * 执行 pi update --models，强制刷新模型目录缓存。
 * 失败不抛出（网络/pi 未安装/超时都返回 false），由调用方按需记日志：
 * 目录刷新是尽力而为的后台任务，不应影响模型列表主流程。
 */
export async function refreshModelCatalogStore(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
): Promise<boolean> {
	try {
		await runPiCliCommand(piLocator, settingsStore, MODEL_CATALOG_REFRESH_ARGS);
		return true;
	} catch {
		return false;
	}
}

/**
 * 判断模型目录缓存是否已过期：models-store.json 不存在（首次使用、从未开过 TUI）
 * 或 mtime 距今超过 maxAgeMs 都视为需要刷新。
 */
export async function isModelCatalogStale(
	configDir: string,
	maxAgeMs: number = MODEL_CATALOG_STALE_MS,
	now: () => number = Date.now,
): Promise<boolean> {
	try {
		const mtimeMs = (await stat(join(configDir, "models-store.json"))).mtimeMs;
		return now() - mtimeMs >= maxAgeMs;
	} catch {
		// 文件不存在 / stat 失败：视为需要刷新（刷新无害，失败也不影响启动）。
		return true;
	}
}

/**
 * 冷启动节流版目录刷新：目录过期才跑 pi update --models，否则跳过。
 * 返回 { ran: 是否实际执行, ok: 执行是否成功 }，不抛错。
 */
export async function refreshModelCatalogIfStale(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	configDir: string,
	options?: { maxAgeMs?: number; now?: () => number },
): Promise<{ ran: boolean; ok: boolean }> {
	if (!(await isModelCatalogStale(configDir, options?.maxAgeMs, options?.now))) {
		return { ran: false, ok: true };
	}
	const ok = await refreshModelCatalogStore(piLocator, settingsStore);
	return { ran: true, ok };
}

/**
 * 面向模型选择器的诊断报告：模型列表 + 为空时的失败原因分类（纯契约，供渲染层引导用户）。
 * - 非 force 且有缓存：直接返回缓存（与 fetchModelList 一致，避免每次开选择器都 fork）；
 * - force（手动刷新）：绕过缓存重新 fork（与 refreshModelList 语义一致）；
 * - 列表为空时额外执行一次 pi --version 健康检查（仅在失败路径），并据
 *   CLI 错误/配置诊断分类成 pi-not-found / version-too-old / config-invalid /
 *   cli-failed / empty，UI 可按原因给出具体引导（升级 pi / 修配置 / 配置 pi 路径）。
 */
export async function resolveModelListReport(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	configSource?: ModelListConfigSource,
	force = false,
): Promise<ModelListReport> {
	const now = Date.now();
	// 非手动刷新且缓存有数据：直接返回，避免与启动预取并发 fork。
	if (!force && cachedListModels && cachedListModels.length > 0) {
		return {
			models: cachedListModels,
			ok: true,
			reason: null,
			version: null,
			detail: "",
			source: "cache",
			at: now,
		};
	}
	// 已有在途请求（启动预取等）：先等它；结果非空就复用，避免重复 fork。
	if (!force && cachedListModelsPending) {
		const models = await cachedListModelsPending.catch(() => [] as AvailableModel[]);
		if (models.length > 0) {
			return {
				models,
				ok: true,
				reason: null,
				version: null,
				detail: "",
				source: "cache",
				at: now,
			};
		}
	}
	const detail = await resolveModelsDetailed(piLocator, settingsStore, configSource);
	if (detail.models.length > 0) {
		// 与 fetchModelList 相同：空结果不写缓存；配置失效期间也不写（避免旧结果覆盖新配置）。
		if (!configInvalidated) cachedListModels = detail.models;
		return {
			models: detail.models,
			ok: true,
			reason: null,
			version: null,
			// CLI 失败但配置兜底成功：仍能看到列表，附带一句来源说明，不打断使用。
			detail:
				detail.fellBackToConfig && detail.cliError
					? `CLI failed, fell back to local models.json: ${clip(detail.cliError.message)}`
					: "",
			source: detail.fellBackToConfig ? "config-fallback" : "cli",
			at: now,
		};
	}
	// 列表为空：多花一次 --version 健康检查确认 pi 是否可用（仅失败路径）。
	const settings = settingsStore.get();
	let installed = true;
	let version: string | null = null;
	let checkError: string | null = null;
	try {
		const status = await piLocator.check(
			settings.customPiPath,
			settings.wslEnabled,
			settings.wslDistro,
			settings.wslUser,
		);
		installed = status.installed;
		version = status.installed && status.version ? status.version : null;
		checkError = status.error ?? null;
	} catch (error) {
		installed = false;
		checkError = error instanceof Error ? error.message : String(error);
	}
	const classification = classifyModelListFailure({
		cliError: detail.cliError,
		configDiagnostic: detail.configDiagnostic,
		piInstalled: installed,
		version,
	});
	// pi 未安装时，--version 健康检查的错误文本比 CLI stderr 更可读（"pi: command not found"）。
	const detailText =
		classification.reason === "pi-not-found" && checkError
			? clip(checkError)
			: classification.detail;
	return {
		models: [],
		ok: false,
		reason: classification.reason,
		version,
		detail: detailText,
		source: "none",
		at: now,
	};
}
