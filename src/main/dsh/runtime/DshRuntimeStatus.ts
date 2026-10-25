/**
 * DSH runtime 安装态探测与状态服务（AgentRuntimeProvider 阶段 2）。
 *
 * DSH runtime 不再按环境切换来源：dev 与打包版都优先探测 userData 下的外部 runtime；
 * 仅为兼容依赖分区前的存量安装包，保留由装配层显式开启 app 内置 node_modules 回退。
 * 本模块把「runtime 是否可用」做成一等状态源，UI 据此门控（见 shared/types/dshRuntime）。
 *
 * 探测锚点与 DshHost.start 完全一致：createRequire(appPath).resolve("@deepseek-ai/dsh-base")
 * ——同一接缝（--dsh-node-modules 的 appRoot 推导），保证「探测可用 = host 可 fork」。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DshRuntimeSource, DshRuntimeState, DshRuntimeStatus } from "../../../shared/types/dshRuntime";
import { isDshRuntimeVersionMismatch } from "../../../shared/types/dshRuntime";

/** 探测结果：ok 时给出 runtime node_modules 锚点（appRoot，与 DshHost 的 appRoot 同源）。 */
export type DshRuntimeProbeResult = { ok: true; appRoot: string; runtimeVersion?: string } | { ok: false; error: string };

/**
 * 一次完整的 runtime 探测结果（外部 runtime 优先，兼容性内置回退）。
 * appRoot 语义与阶段 1 一致：包含 node_modules 的那个目录（DshHost 拿它拼
 * `--dsh-node-modules`，hostEntry 再从它建 createRequire）。
 */
export type DshRuntimeProbe = { ok: true; appRoot: string; source: DshRuntimeSource; runtimeVersion?: string; installDir?: string } | { ok: false; error: string };

/**
 * 组合探测：外部已安装 runtime 优先，未安装时按兼容开关回退 app 内置 node_modules。
 *
 * 为什么保留内置回退：存量安装包（依赖分区前发布）的 asar 内仍带 @deepseek-ai；
 * 有回退才能保证「装了新版 PiDeck 但还没下载 runtime」的用户 DSH 功能不消失。
 * 新的 dev/lite 安装路径都以远程 runtime 为准；allowBundledFallback 只服务显式开启的
 * full/旧包兼容，不应再把 dev 项目 node_modules 或残留资源当作已发布 runtime。
 */
export function probeDshRuntime(input: {
	/** 外部 runtime（DshRuntimeManager.resolveActive）；undefined = 未安装。 */
	managed?: { nodeModules: string; runtimeVersion: string };
	/** app 内置 runtime 探测结果。 */
	bundled: DshRuntimeProbeResult;
}): DshRuntimeProbe {
	if (input.managed) {
		return {
			ok: true,
			// node_modules 的上一级才是 appRoot（与 bundled 分支的 dirname×3 对齐）。
			appRoot: dirname(input.managed.nodeModules),
			// 版本目录（runtimesRoot/<version>）即安装落盘位置，UI 概览页展示/打开用。
			installDir: dirname(input.managed.nodeModules),
			source: "managed",
			runtimeVersion: input.managed.runtimeVersion,
		};
	}
	if (input.bundled.ok) {
		return {
			ok: true,
			appRoot: input.bundled.appRoot,
			source: "builtin",
			// 内置分发也有版本号（dsh-base 包版本）：UI 概览页文案模板带 v 前缀，
			// 不填就会渲染成孤零零的「随应用内置 v」。
			runtimeVersion: input.bundled.runtimeVersion,
		};
	}
	return { ok: false, error: input.bundled.error };
}

/**
 * 探测兼容性内置 dsh runtime（纯探测，不抛错）：仅供依赖分区前的存量 full 包使用。
 * 新 dev 与 lite 打包版由装配层关闭此探测，项目 node_modules 不会被当作已发布 runtime。
 * 失败 = runtime 不在（阶段 2 lite 分发 / 依赖被移除），映射为 notInstalled。
 */
export function probeBundledDshRuntime(appPath: string): DshRuntimeProbeResult {
	try {
		// 与 DshHost.start 相同的解析链：从 appPath 建 require 再解析 dsh-base，
		// 避免主进程产物（CJS）自身解析路径与 host fork 时产生分叉。
		const require = createRequire(join(appPath, "package.json"));
		const basePkgPath = require.resolve("@deepseek-ai/dsh-base/package.json");
		// 顺带读出版本号：resolve 出的就是 package.json 路径，读它比再探测目录更稳。
		// 读失败不致命——版本缺失只是 UI 少显示一个数字，不能因此把整个探测判失败。
		let runtimeVersion: string | undefined;
		try {
			const pkg = JSON.parse(readFileSync(basePkgPath, "utf8")) as { version?: string };
			if (typeof pkg.version === "string" && pkg.version) runtimeVersion = pkg.version;
		} catch {
			runtimeVersion = undefined;
		}
		return {
			ok: true,
			appRoot: dirname(dirname(dirname(basePkgPath))),
			runtimeVersion,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 探测结果 → 安装态映射（纯函数，单测覆盖）。阶段 2 增补 manifest 兼容区间判定 → broken。 */
export function dshRuntimeStateFromProbe(probe: DshRuntimeProbeResult): DshRuntimeState {
	return probe.ok ? "installed" : "notInstalled";
}

/**
 * DSH runtime 状态服务：进程内缓存探测结果 + 变更订阅。
 * 安装/卸载/更新后调 refresh() 重探测并广播，渲染层经 dsh-runtime:status-changed 收到推送。
 */
export class DshRuntimeStatusService {
	private current: DshRuntimeStatus | null = null;
	private readonly listeners = new Set<(status: DshRuntimeStatus) => void>();

	/**
	 * @param getAppPath 内置 runtime 的解析起点（app.asar / 项目根）。
	 * @param log 日志出口。
	 * @param resolveManaged 外部 runtime 解析（阶段 2：DshRuntimeManager.resolveActive）。
	 *   缺省 = 纯内置模式（阶段 1 形态，也是不装 runtime 时的自然退路）。
	 * @param allowBundledFallback 是否允许回退 app 内置 node_modules 探测：仅用于依赖分区前的
	 *   存量安装包兼容；dev 装配必须传 false，避免把项目 node_modules 误判为已发布 runtime。
	 * @param isPackaged 是否打包态（app.isPackaged）：仅用于兼容调用方；
	 *   dev 与打包态现在都走同一份远程索引/手动导入链路，避免开发环境和用户环境
	 *   使用两套不同的 runtime 获取行为。
	 * @param resolveDeclaredVersion 当前 app 声明的配套 dsh 版本（package.json 的
	 *   @deepseek-ai/dsh）。与已装 runtime 比对得出 updateAvailable——runtime 的
	 *   maxAppVersion 为空意味着旧版永远「兼容」，没有这个比对用户升级 app 后会
	 *   静默跑在旧 runtime 上（manifest 只挡「不兼容」，挡不住「过旧但兼容」）。
	 */
	constructor(
		private readonly getAppPath: () => string,
		private readonly log: (scope: string, message: string, detail?: unknown) => void = () => {},
		private readonly resolveManaged: () => { nodeModules: string; runtimeVersion: string } | undefined = () => undefined,
		private readonly allowBundledFallback: () => boolean = () => true,
		// 保留旧构造参数，避免外部装配/测试升级时发生位置错位；来源策略不再读取它。
		private readonly _isPackaged: () => boolean = () => true,
		private readonly resolveDeclaredVersion: () => string | undefined = () => undefined,
	) {}

	/** 当前状态（首次调用探测并缓存；IPC 查询走这里）。 */
	getStatus(): DshRuntimeStatus {
		this.current ??= this.probeOnce();
		return this.current;
	}

	/**
	 * 供 DshHost 取 runtime 锚点（appRoot，即包含 node_modules 的目录）。
	 * 与 getStatus 共用同一份探测结果，避免「状态说装了、host 却找不到路径」的分叉。
	 * outdated（版本不一致）时返回 undefined：host 不得用不配套的 runtime 启动。
	 */
	resolveAppRoot(): string | undefined {
		const { status, probe } = this.probeFull();
		// 只有 installed 才交付锚点；outdated 的探测虽然「可解析」，但桥协议/插件表
		// 不保证配套——这里的 undefined 会让 DshHost.start 直接失败，而不是起一个
		// 随时可能崩的 host。
		return status.state === "installed" && probe.ok ? probe.appRoot : undefined;
	}

	/** 是否允许新建 DSH 会话（门控判定的唯一入口，避免调用方各自比对状态枚举）。 */
	canCreateDshSession(): boolean {
		return this.getStatus().state === "installed";
	}

	/** 订阅状态变更（返回退订函数）。 */
	subscribe(listener: (status: DshRuntimeStatus) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * 重探测并广播（阶段 2 安装/卸载/更新后调用）。
	 * 状态未变化时不广播，避免无意义的 UI 重渲染。
	 */
	refresh(): DshRuntimeStatus {
		const next = this.probeOnce();
		const changed = this.current?.state !== next.state || this.current?.runtimeVersion !== next.runtimeVersion || this.current?.source !== next.source;
		this.current = next;
		if (changed) {
			this.log("dsh-runtime", `runtime status changed: ${next.state}`, { source: next.source });
			for (const listener of this.listeners) {
				try {
					listener(next);
				} catch {
					// 订阅者异常不影响后续广播
				}
			}
		}
		return next;
	}

	/** 原始探测（不写缓存、不做 outdated 判定；判定在 probeFull 里做）。 */
	private probeOnceFresh(): DshRuntimeProbe {
		return probeDshRuntime({
			managed: this.resolveManaged(),
			// 由装配层显式关闭兼容性内置回退；项目 node_modules 不是已发布 runtime。
			bundled: this.allowBundledFallback() ? probeBundledDshRuntime(this.getAppPath()) : { ok: false, error: "bundled fallback disabled" },
		});
	}

	private probeOnce(): DshRuntimeStatus {
		return this.probeFull().status;
	}

	/**
	 * 探测一次，同时返回状态快照与原始探测（resolveAppRoot 需要原始 appRoot）。
	 * 声明的配套 dsh 版本（package.json）在此与实装版本比对：不一致 → outdated。
	 */
	private probeFull(): { status: DshRuntimeStatus; probe: DshRuntimeProbe } {
		const probe = this.probeOnceFresh();
		// 声明的配套 dsh 版本（package.json），dev 与打包态均可读；读不到只是退回
		// 旧的兼容区间判定，不能因此误杀（宁缺毋滥：判定不了就不判）。
		const declaredVersion = this.resolveDeclaredVersion();
		if (probe.ok) {
			// 版本不一致 → outdated（硬门控）：manifest 兼容区间只挡「不兼容」，
			// 挡不住「过旧但兼容」；跨版本混用桥协议不可信，直接禁止启动。
			const mismatched = isDshRuntimeVersionMismatch(declaredVersion, probe.runtimeVersion);
			if (mismatched) {
				this.log("dsh-runtime", "runtime version mismatch with declared version", {
					installed: probe.runtimeVersion,
					declared: declaredVersion,
					action: "host start blocked, reinstall required",
				});
			}
			const status: DshRuntimeStatus = mismatched
				? {
						state: "outdated",
						source: probe.source,
						...(probe.runtimeVersion ? { runtimeVersion: probe.runtimeVersion } : {}),
						...(probe.source === "managed" && probe.installDir ? { installDir: probe.installDir } : {}),
						// dev 与打包态统一允许在线下载/重装；两者都从同一份 Release 索引取 runtime。
						installEnabled: true,
						...(declaredVersion ? { declaredRuntimeVersion: declaredVersion } : {}),
					}
				: {
						state: "installed",
						source: probe.source,
						...(probe.runtimeVersion ? { runtimeVersion: probe.runtimeVersion } : {}),
						// 外部 managed runtime 时给出落盘目录（runtimesRoot/<version>），UI 概览页展示/打开用；
						// builtin 内置分发没有独立安装目录（在 app.asar 内），不填。
						...(probe.source === "managed" && probe.installDir ? { installDir: probe.installDir } : {}),
						// dev 与打包态统一允许在线下载/重装；两者都从同一份 Release 索引取 runtime。
						installEnabled: true,
						...(declaredVersion ? { declaredRuntimeVersion: declaredVersion } : {}),
					};
			return { status, probe };
		}
		// 两者都没有 = 未安装 runtime（阶段 2 依赖分区后的常态）。
		this.log("dsh-runtime", "dsh runtime not available", { error: probe.error });
		return {
			status: {
				state: "notInstalled",
				// dev 与打包态统一允许在线下载/重装；未安装时安装引导直接提供远程下载。
				installEnabled: true,
				// 未安装无所谓「不一致」，但声明版本仍可带给 UI（安装引导可展示目标版本）。
				...(declaredVersion ? { declaredRuntimeVersion: declaredVersion } : {}),
			},
			probe,
		};
	}
}
