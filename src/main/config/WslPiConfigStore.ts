/**
 * WslPiConfigStore（P1-1 + W3）：一个 WSL 连接档案的 pi 配置目录，按发行版 HOME 读写 models.json / settings.json。
 *
 * 为什么单独一个存储，而不是复用 ConfigManager / RemotePiConfigBackend：
 * - 绝不复用全局 `configManager.configureWsl`：那会改所有窗口的单例 configDir，两个 WSL 目标并发就串环境。
 *   这里每次调用都从档案重新解析，实例之间没有共享可变状态；
 * - 绝不复用 ssh helper：那条通道要走 SSH 会话，WSL 是本机 UNC 路径，混用会把两套失败语义搅在一起；
 * - 绝不回退 Windows HOME：档案缺失、发行版不可达、HOME 不可读都在**读文件之前**回稳定码，
 *   否则「配置页看着是空的」会被用户当成 WSL 配置真的为空，一保存就把发行版里的配置覆盖掉。
 *
 * 读写分工（W3）：
 * - 读仍走 UNC：9P 读是安全的，pi 自己在发行版里写，读端不需要另一条执行路径；
 * - 写必须走发行版内原子替换：UNC 上 `rename` 不是原子的（跨 9P 复制），中途崩溃会留下半份 JSON。
 *   现在经 `wsl.exe -d <distro> -u <user> --exec /bin/sh -c <script>` 在发行版内用
 *   umask 077 + 同目录 temp + `mv -f` 完成，JSON 只走 stdin，不拼进脚本。
 * - **不与发行版里正在运行的 pi TUI 做跨进程互斥**：这里只保证文件级原子替换（读者永远看到
 *   旧文件或新文件，不会看到半份）。并发保存仍是 last-writer-wins，pi 自己的写入也不经过这里；
 *   要的是不损坏文件，而不是替代 pi 的写锁。
 *
 * 其它语义与本地保持一致：
 * - 读：文件不存在 = 新安装（返回空对象）；JSON 损坏 = WSL_CONFIG_FILE_INVALID（不当作空配置）；
 * - 写 models.json：整文件写入，写前跑与本地相同的校验规则；
 * - 写 settings.json：锁外重读磁盘后按 settingsFormPayload 的合并规则落盘（资源类键以磁盘为准）；
 * - resolve() 全程有 15s 截止：档案查询/HOME 解析/UNC stat 任一挂住都回 WSL_CONFIG_DISTRO_UNAVAILABLE，
 *   不能让设置页永远转圈；非 Windows 或 wsl.exe 缺失一律 WSL_CONFIG_UNAVAILABLE。
 *
 * 解析结果有 5s 缓存（见 resolve()）：设置页一次展开会并行拉 models 与 settings，各自跑一遍
 * wsl.exe HOME 探测 + UNC stat 纯属重复开销。缓存只给读用，保存一定重新解析——档案被改名或
 * 换了发行版时，写不能落在过期的目录上。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { WSL_CONFIG_CODES, WSL_CONFIG_CODE_SET, type PiConfigFileKey, type WslPiConfigSnapshot, type WslPiConfigWriteReceipt } from "../../shared/piConfig";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { mainProcessT, type MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { WslHostListItem } from "../../shared/types/wslHost";
import { linuxPathToWslUnc, parseWslUncPath, type WslEnvironment } from "../wsl/WslPaths";
import { createWslHostStore } from "../wsl/WslHostStore";
import { resolveWslEnvironment } from "../wsl/WslEnvironment";
import { getWslExe } from "../wsl/wslExe";
import { getPiAiCatalogIndex, lookupPiAiCatalogProviderApi } from "../pi/piAiBuiltinCatalog";
import { isSafeProviderName } from "./providerMigration";
import { mergeSettingsFormPayload } from "./settingsFormPayload";

/** 与本地 ConfigManager.validateModels 同一组上限（模型 id 超长往往是误填，且会撑爆网关/日志）。 */
const MODEL_ID_MAX_LENGTH = 256;

/** resolve() 的全程截止：档案查询 + HOME 解析 + 两个 UNC stat 都算在内。 */
const RESOLVE_TIMEOUT_MS = 15_000;

/** 解析结果缓存窗口：够并行的 models/settings 两次读取合并成一次探测，又短到档案改动几乎立刻生效。 */
const RESOLVE_CACHE_TTL_MS = 5_000;

/** 单次 wsl.exe 写命令的截止：发行版/9P 挂起时不能让保存请求永远不返回。 */
const WRITE_TIMEOUT_MS = 15_000;

/**
 * 发行版内原子替换脚本。
 * - `umask 077`：配置里有 API key，落盘后只允许属主读写；
 * - 临时文件放**同一目录**，`mv -f` 才可能是同文件系统 rename（跨目录复制不是原子替换）；
 * - `cat > "$tmp"` 从 stdin 收完整 JSON：脚本不拼 JSON，换行/引号/非 ASCII 都不会被 shell 改写；
 * - 参数：$0=pideck-config（便于 ps 识别），$1=配置目录，$2=文件名。
 */
const CONFIG_WRITE_SCRIPT = ["umask 077", 'dir="$1"', 'name="$2"', 'tmp="$dir/.$name.tmp.$$"', "trap 'rm -f \"$tmp\"' EXIT HUP INT TERM", 'cat > "$tmp"', 'mv -f "$tmp" "$dir/$name"'].join("\n") + "\n";

type WslConfigCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * 文件系统边界（可注入）：单测用假端口证明「读了哪些路径、失败怎么映射」。
 * 只有读与目录探测——写不再经过 UNC，见 `WslPiConfigExec`。
 * 两个方法都按「目录不存在返回 null / 其它错误抛出」约定。
 */
export type WslPiConfigFileSystem = {
	statDirectory(path: string): Promise<{ isDirectory: boolean } | null>;
	readTextFile(path: string): Promise<string | null>;
};

/**
 * 发行版内写端口（可注入）：输入已经是「写哪个发行版/用户、写哪个 Linux 目录与文件、完整 JSON 文本」。
 * 生产实现用 wsl.exe 在发行版内执行原子替换；测试注入假端口，不真跑 wsl.exe。
 */
export type WslPiConfigExecInput = {
	distro: string;
	user: string;
	/** 发行版内配置目录（Linux 绝对路径），不是 UNC。 */
	configDir: string;
	fileName: `${PiConfigFileKey}.json`;
	/** 完整 JSON 文本；原样写入 stdin，不经过 shell。 */
	content: string;
};
export type WslPiConfigExec = (input: WslPiConfigExecInput) => Promise<void>;

/** 生产执行端口的下层：默认 node:child_process.execFile；测试注入后只断言 argv/stdin。 */
export type WslPiConfigExecFileOptions = { timeoutMs: number; windowsHide: boolean; shell: false };
export type WslPiConfigExecFile = (command: string, args: readonly string[], options: WslPiConfigExecFileOptions, stdin: string) => Promise<void>;

export type NodeWslPiConfigExecOptions = {
	/** 生产默认 process.platform；非 win32 一律 fail closed。 */
	platform?: string;
	wslExe?: () => { command: string; shell: boolean };
	/** 仅用于判定绝对路径的 wsl.exe 是否存在（测试注入）。 */
	exists?: (path: string) => boolean;
	execFile?: WslPiConfigExecFile;
	timeoutMs?: number;
};

export type WslPiConfigTimer = {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};

export type WslPiConfigStorePorts = {
	/** WslHostStore.list()：每次调用都重新读档案，用户改名/换 distro 后不需要重启。 */
	listProfiles: () => Promise<readonly WslHostListItem[]>;
	/** resolveWslEnvironment(distro, user)：失败时它会静默回退 /home/<user>，所以下面还会用 stat 验证 HOME 真的存在。 */
	resolveEnvironment: (distro: string, user: string) => Promise<WslEnvironment>;
	fs?: WslPiConfigFileSystem;
	/** 发行版内写端口；未装配时写操作 fail closed（WSL_CONFIG_UNAVAILABLE），绝不回退 UNC 写。 */
	execInDistro?: WslPiConfigExec;
	translate?: WslConfigCopy;
	/** 生产注入 process.platform；非 win32 整个存储不可用（读也不能假装能读 WSL 路径）。 */
	platform?: string;
	/** resolve() 的定时器（测试注入假定时器，不真等 15s）。 */
	timer?: WslPiConfigTimer;
	resolveTimeoutMs?: number;
	/** 解析结果缓存窗口，默认 5s；设 0 关闭缓存。 */
	resolveCacheTtlMs?: number;
};

export type WslPiConfigSaveResult = { valid: true; receipt: WslPiConfigWriteReceipt } | { valid: false; error: string };

export type WslPiConfigStore = {
	read(input: { hostId: string; file: PiConfigFileKey }): Promise<WslPiConfigSnapshot>;
	saveModels(input: { hostId: string; data: unknown }): Promise<WslPiConfigSaveResult>;
	saveSettings(input: { hostId: string; settings: Record<string, unknown> }): Promise<WslPiConfigSaveResult>;
};

function stable(code: string): Error {
	return new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 端口抛出的错误若已经是闭集里的稳定码就原样保留，避免把「环境与档案不符」洗成「发行版不可用」。 */
function stableCodeOf(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : "";
	return WSL_CONFIG_CODE_SET.has(message) ? message : undefined;
}

function errorCodeOf(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

function isMissingFile(error: unknown): boolean {
	const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Windows PowerShell 5.1 手写的配置常带 BOM，裸 JSON.parse 会直接失败（与本地读写同一条规则）。 */
function stripBom(raw: string): string {
	return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * models.json 保存校验：规则与本地 ConfigManager.validateModels 一致（provider 名宽松安全校验、
 * models 数组、模型 id 控制字符/长度、baseUrl 控制字符、provider/模型的 api 缺省校验），文案复用同一组 mainConfig.* 词典。
 * 为什么不再抽一份共享实现：ConfigManager 的校验是私有的、且被 tests/configValidateModels.test.mjs
 * 按私有方法直接调用（单文件转译 harness 不认新依赖），抽走会让存量断言变红；规则本身只有这几条。
 */
function validateModelsForSave(data: unknown, translate: WslConfigCopy): { ok: true } | { ok: false; error: string } {
	if (!isRecord(data) || !isRecord(data.providers)) return { ok: false, error: translate("mainConfig.modelsProvidersRequired") };
	for (const [providerName, providerValue] of Object.entries(data.providers)) {
		if (!isSafeProviderName(providerName) || CONTROL_CHARS.test(providerName)) return { ok: false, error: translate("mainConfig.providerNameInvalid", { provider: providerName }) };
		if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) return { ok: false, error: translate("mainConfig.providerModelsRequired", { provider: providerName }) };
		if (typeof providerValue.baseUrl === "string" && CONTROL_CHARS.test(providerValue.baseUrl)) return { ok: false, error: translate("mainConfig.baseUrlInvalid", { provider: providerName }) };
		const defaultApi = (typeof providerValue.api === "string" ? providerValue.api.trim() : "") || lookupPiAiCatalogProviderApi(getPiAiCatalogIndex(), providerName);
		const models = providerValue.models;
		for (let index = 0; index < models.length; index += 1) {
			const model = models[index];
			if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) return { ok: false, error: translate("mainConfig.modelIdRequired", { provider: providerName, index: index + 1 }) };
			if (CONTROL_CHARS.test(model.id) || model.id.length > MODEL_ID_MAX_LENGTH) return { ok: false, error: translate("mainConfig.modelIdInvalid", { provider: providerName, index: index + 1 }) };
			const modelApi = typeof model.api === "string" ? model.api.trim() : "";
			if (!modelApi && !defaultApi) return { ok: false, error: translate("mainConfig.modelApiRequired", { provider: providerName, model: model.id }) };
		}
	}
	return { ok: true };
}

/** 默认 fs 端口：只做目录 stat 与 UTF-8 读（写走发行版内 exec，不再有 UNC 写实现）。 */
export function createNodeWslPiConfigFileSystem(): WslPiConfigFileSystem {
	return {
		async statDirectory(path) {
			try {
				return { isDirectory: (await stat(path)).isDirectory() };
			} catch (error) {
				if (isMissingFile(error)) return null;
				throw error;
			}
		},
		async readTextFile(path) {
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if (isMissingFile(error)) return null;
				throw error;
			}
		},
	};
}

/** 默认执行端口：execFile（shell:false）→ wsl.exe → /bin/sh -c 脚本；stdin 写完整 JSON。 */
const defaultExecFile: WslPiConfigExecFile = (command, args, options, stdin) =>
	new Promise((resolve, reject) => {
		const child = execFile(command, [...args], { timeout: options.timeoutMs, windowsHide: options.windowsHide, shell: false, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error) => {
			if (error !== null) reject(error);
			else resolve();
		});
		// 子进程提前退出时 stdin 可能 EPIPE：这是「写失败」的一部分，交给回调统一结算，不能崩主进程。
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(stdin, "utf8");
	});

/**
 * 生产写端口。关键约束：
 * - 只允许 shell:false 的 wsl.exe argv；distro/user 是档案数据，绝不能被 shell 解释；
 * - 绝对路径 wsl.exe 先判存在；PATH 回退的 ENOENT 也映射成 WSL_CONFIG_UNAVAILABLE；
 * - 非零退出/超时/其它 spawn 失败一律 WSL_CONFIG_PATH_UNREADABLE（错误信息只留稳定码，不透出 stderr）。
 */
export function createNodeWslPiConfigExec(options: NodeWslPiConfigExecOptions = {}): WslPiConfigExec {
	const platform = options.platform ?? process.platform;
	const wslExe = options.wslExe ?? getWslExe;
	const exists = options.exists ?? existsSync;
	const run = options.execFile ?? defaultExecFile;
	const timeoutMs = options.timeoutMs ?? WRITE_TIMEOUT_MS;
	return async (input) => {
		if (platform !== "win32") throw stable(WSL_CONFIG_CODES.unavailable);
		const exe = wslExe();
		// shell 回退会把 & | 等字符变成命令语法：宁可不写，也不经 shell。
		if (exe.shell || (isAbsolute(exe.command) && !exists(exe.command))) throw stable(WSL_CONFIG_CODES.unavailable);
		try {
			await run(exe.command, ["-d", input.distro, "-u", input.user, "--exec", "/bin/sh", "-c", CONFIG_WRITE_SCRIPT, "pideck-config", input.configDir, input.fileName], { timeoutMs, windowsHide: true, shell: false }, input.content);
		} catch (error) {
			throw stable(errorCodeOf(error) === "ENOENT" ? WSL_CONFIG_CODES.unavailable : WSL_CONFIG_CODES.pathUnreadable);
		}
	};
}

function defaultTimer(): WslPiConfigTimer {
	return {
		set(callback, ms) {
			const handle = setTimeout(callback, ms);
			handle.unref?.();
			return handle;
		},
		clear(handle) {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
	};
}

function fileKeyOf(file: unknown): PiConfigFileKey {
	if (file === "models" || file === "settings") return file;
	throw stable(WSL_CONFIG_CODES.targetInvalid);
}

export function createWslPiConfigStore(ports: WslPiConfigStorePorts): WslPiConfigStore {
	const fs = ports.fs ?? createNodeWslPiConfigFileSystem();
	const execInDistro = ports.execInDistro;
	const translate = ports.translate ?? ((key, params) => mainProcessT("zh-CN", key, params));
	const platform = ports.platform ?? process.platform;
	const timer = ports.timer ?? defaultTimer();
	const resolveTimeoutMs = ports.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS;
	const resolveCacheTtlMs = ports.resolveCacheTtlMs ?? RESOLVE_CACHE_TTL_MS;

	type Resolved = { configDir: string; linuxConfigDir: string; profile: WslHostListItem };

	/** 非 Windows 没有 WSL：读也不能假装 UNC 可读，直接回稳定码。 */
	function requireSupportedPlatform(): void {
		if (platform !== "win32") throw stable(WSL_CONFIG_CODES.unavailable);
	}

	/**
	 * 解析一步都不许「乐观成功」：档案 → 发行版 HOME → 目录可访问，全部判定通过才允许读/写文件。
	 * 发行版根用 \\wsl.localhost\<distro> 判定：发行版被注销/9P 不可达时 stat 直接失败，
	 * 而不是等 wsl.exe 超时后把 /home/<user> 当成真的 HOME 去读写。
	 */
	async function resolveInner(hostId: unknown): Promise<Resolved> {
		if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId)) throw stable(WSL_CONFIG_CODES.targetInvalid);
		let profiles: readonly WslHostListItem[];
		try {
			profiles = await ports.listProfiles();
		} catch {
			throw stable(WSL_CONFIG_CODES.unavailable);
		}
		const profile = profiles.find((item) => item.id === hostId);
		if (!profile) throw stable(WSL_CONFIG_CODES.hostNotFound);

		let environment: WslEnvironment;
		try {
			environment = await ports.resolveEnvironment(profile.distro, profile.user);
		} catch (error) {
			// 端口自己给出的稳定码原样透出（装配层用它表达「解析出的环境与档案对不上」）；
			// 端口意外失败按发行版不可用处理——绝不当成本机目录继续读写。
			throw stable(stableCodeOf(error) ?? WSL_CONFIG_CODES.distroUnavailable);
		}
		if (!isAbsolute(environment.windowsHome)) throw stable(WSL_CONFIG_CODES.unavailable);
		// linuxHome 是脚本在发行版内的目标目录：必须绝对，否则 posix.join 会落到错误位置。
		if (!environment.linuxHome.startsWith("/")) throw stable(WSL_CONFIG_CODES.unavailable);

		await requireDirectory(linuxPathToWslUnc("/", profile.distro), WSL_CONFIG_CODES.distroUnavailable);
		await requireDirectory(environment.windowsHome, WSL_CONFIG_CODES.pathUnreadable);
		return {
			configDir: join(environment.windowsHome, ".pi", "agent"),
			linuxConfigDir: posix.join(environment.linuxHome, ".pi", "agent"),
			profile,
		};
	}

	/** 整个解析流程共用一个截止；超时不取消端口调用，但迟到的结果不会再被采用。 */
	function resolve(hostId: unknown): Promise<Resolved> {
		return new Promise<Resolved>((resolvePromise, reject) => {
			let settled = false;
			const handle = timer.set(() => {
				if (settled) return;
				settled = true;
				reject(stable(WSL_CONFIG_CODES.distroUnavailable));
			}, resolveTimeoutMs);
			resolveInner(hostId).then(
				(value) => {
					if (settled) return;
					settled = true;
					timer.clear(handle);
					resolvePromise(value);
				},
				(error) => {
					if (settled) return;
					settled = true;
					timer.clear(handle);
					reject(error);
				},
			);
		});
	}

	/**
	 * 带缓存的解析：同一 hostId 在 TTL 内复用结果，并发请求共享同一个在途 promise。
	 * 只缓存成功——失败（发行版刚被关掉、档案刚改）必须让下一次读取重新探测。
	 */
	const resolvedCache = new Map<string, { expiresAt: number; value: Resolved }>();
	const inFlight = new Map<string, Promise<Resolved>>();

	function resolveCached(hostId: unknown): Promise<Resolved> {
		const key = typeof hostId === "string" ? hostId : "";
		const hit = resolvedCache.get(key);
		if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
		const pending = inFlight.get(key);
		if (pending) return pending;
		const task = resolve(hostId).then(
			(value) => {
				inFlight.delete(key);
				resolvedCache.set(key, { expiresAt: Date.now() + resolveCacheTtlMs, value });
				return value;
			},
			(error) => {
				inFlight.delete(key);
				throw error;
			},
		);
		inFlight.set(key, task);
		return task;
	}

	async function requireDirectory(path: string, code: string): Promise<void> {
		let stats: { isDirectory: boolean } | null;
		try {
			stats = await fs.statDirectory(path);
		} catch {
			throw stable(code);
		}
		if (!stats?.isDirectory) throw stable(code);
	}

	async function readFileData(path: string, file: PiConfigFileKey): Promise<Record<string, unknown>> {
		let raw: string | null;
		try {
			raw = await fs.readTextFile(path);
		} catch {
			throw stable(WSL_CONFIG_CODES.pathUnreadable);
		}
		if (raw === null) return file === "models" ? { providers: {} } : {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(raw));
		} catch {
			throw stable(WSL_CONFIG_CODES.fileInvalid);
		}
		if (!isRecord(parsed)) throw stable(WSL_CONFIG_CODES.fileInvalid);
		return parsed;
	}

	function snapshotOf(profile: WslHostListItem, file: PiConfigFileKey, data: Record<string, unknown>): WslPiConfigSnapshot {
		return { kind: "wsl", hostId: profile.id, file, label: profile.label, distro: profile.distro, user: profile.user, data };
	}

	async function writeConfigFile(target: Resolved, file: PiConfigFileKey, data: Record<string, unknown>): Promise<void> {
		if (execInDistro === undefined) throw stable(WSL_CONFIG_CODES.unavailable);
		try {
			await execInDistro({
				distro: target.profile.distro,
				user: target.profile.user,
				configDir: target.linuxConfigDir,
				fileName: `${file}.json`,
				content: `${JSON.stringify(data, null, 2)}\n`,
			});
		} catch (error) {
			// 执行端口自己的稳定码原样透出（非 Windows / wsl.exe 缺失 = UNAVAILABLE）；
			// 其余失败（非零退出、超时、其它 spawn 错误）统一按 PATH_UNREADABLE，不把 stderr 带到 IPC。
			throw stable(stableCodeOf(error) ?? WSL_CONFIG_CODES.pathUnreadable);
		}
	}

	function receiptOf(profile: WslHostListItem, file: PiConfigFileKey): WslPiConfigWriteReceipt {
		return { kind: "wsl", hostId: profile.id, file };
	}

	return {
		async read(input) {
			requireSupportedPlatform();
			const file = fileKeyOf(input.file);
			const { configDir, profile } = await resolveCached(input.hostId);
			return snapshotOf(profile, file, await readFileData(join(configDir, `${file}.json`), file));
		},
		async saveModels(input) {
			requireSupportedPlatform();
			const resolved = await resolve(input.hostId);
			const validation = validateModelsForSave(input.data, translate);
			if (!validation.ok) return { valid: false, error: validation.error };
			await writeConfigFile(resolved, "models", input.data as Record<string, unknown>);
			return { valid: true, receipt: receiptOf(resolved.profile, "models") };
		},
		async saveSettings(input) {
			requireSupportedPlatform();
			if (!isRecord(input.settings)) throw stable(WSL_CONFIG_CODES.fileInvalid);
			const resolved = await resolve(input.hostId);
			const path = join(resolved.configDir, "settings.json");
			// 锁外重读 + 合并：与本地 saveSettingsConfig 一样，资源类键以磁盘为准，
			// 页面的整份快照不能把别处刚写入的 packages/extensions 静默回退。
			const current = await readFileData(path, "settings");
			await writeConfigFile(resolved, "settings", mergeSettingsFormPayload(current, input.settings));
			return { valid: true, receipt: receiptOf(resolved.profile, "settings") };
		},
	};
}

/**
 * 装配用默认端口：档案来自 WslHostStore（每次重读），发行版 HOME 走 resolveWslEnvironment，
 * 写走 createNodeWslPiConfigExec。
 * warn 用于暴露 printenv 失败后的兼容回退——回退仍然会被 stat 校验，不会静默假装成功。
 */
export function createWslPiConfigStoreFor(userDataDir: string, options: { warn?: (message: string, details: Record<string, unknown>) => void; execInDistro?: WslPiConfigExec } = {}): WslPiConfigStore {
	return createWslPiConfigStore({
		listProfiles: async () => (await createWslHostStore(userDataDir)).list(),
		resolveEnvironment: async (distro, user) => {
			const environment = await resolveWslEnvironment(distro, user, options.warn ? { warn: options.warn } : {});
			// 环境与档案必须自洽：解析回退或发行版改名后，宁可拒绝，也不把配置写到另一个发行版目录。
			const unc = parseWslUncPath(environment.windowsHome);
			if (!unc || unc.distro.toLowerCase() !== distro.toLowerCase() || unc.linuxPath !== environment.linuxHome) throw stable(WSL_CONFIG_CODES.unavailable);
			return environment;
		},
		execInDistro: options.execInDistro ?? createNodeWslPiConfigExec(),
	});
}
