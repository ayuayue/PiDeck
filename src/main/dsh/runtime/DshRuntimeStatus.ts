/**
 * DSH runtime 安装态探测与状态服务（AgentRuntimeProvider 阶段 1）。
 *
 * 阶段 1：dsh runtime（28 个 @deepseek-ai/* 依赖）仍随包分发，探测结果恒 installed；
 * 本模块先把「runtime 是否可用」做成一等状态源，UI 据此门控（见 shared/types/dshRuntime）。
 * 阶段 2 状态源切换为「外部 runtime 目录 manifest 探测 + app 内置 node_modules 回退」时，
 * 消费方（IPC / 渲染层）零改动。
 *
 * 探测锚点与 DshHost.start 完全一致：createRequire(appPath).resolve("@deepseek-ai/dsh-base")
 * ——同一接缝（--dsh-node-modules 的 appRoot 推导），保证「探测可用 = host 可 fork」。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	DshRuntimeSource,
	DshRuntimeState,
	DshRuntimeStatus,
} from "../../../shared/types/dshRuntime";

/** 探测结果：ok 时给出 runtime node_modules 锚点（appRoot，与 DshHost 的 appRoot 同源）。 */
export type DshRuntimeProbeResult =
	| { ok: true; appRoot: string; runtimeVersion?: string }
	| { ok: false; error: string };

/**
 * 一次完整的 runtime 探测结果（外部 runtime 优先，内置回退）。
 * appRoot 语义与阶段 1 一致：包含 node_modules 的那个目录（DshHost 拿它拼
 * `--dsh-node-modules`，hostEntry 再从它建 createRequire）。
 */
export type DshRuntimeProbe =
	| { ok: true; appRoot: string; source: DshRuntimeSource; runtimeVersion?: string; installDir?: string }
	| { ok: false; error: string };

/**
 * 组合探测：外部已安装 runtime 优先，未安装时回退 app 内置 node_modules。
 *
 * 为什么保留内置回退：存量安装包（依赖分区前发布）的 asar 内仍带 @deepseek-ai；
 * 有回退才能保证「装了新版 PiDeck 但还没下载 runtime」的用户 DSH 功能不消失。
 * 回退开关（allowBundledFallback）由装配层注入：打包态 true（存量包兼容）、
 * dev 模式 false（项目 node_modules 是开发依赖，不视为随应用分发，强制外部安装）。
 * 依赖分区后的新包内置探测恒失败，行为自动退化为纯外部模式。
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
 * 探测 app 内置 dsh runtime（纯探测，不抛错）：
 * dev = 项目 node_modules；打包 = app.asar(unpacked) 内 node_modules。
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
	 * @param allowBundledFallback 是否允许回退 app 内置 node_modules 探测：
	 *   打包态 true（依赖分区前的存量安装包内置可用）；dev 模式 false——项目
	 *   node_modules 里的 @deepseek-ai 是开发依赖，不能当作「随应用分发」的已安装
	 *   runtime，否则 UI 会显示内置且不可卸载（用户诉求：默认不安装、可安装可卸、
	 *   安装后显示版本号）。
	 * @param isPackaged 是否打包态（app.isPackaged）：决定 installEnabled——
	 *   dev 模式禁止「在线下载安装」入口，runtime 只在打包时随包分发，避免开发者
	 *   误下载与本地代码不配套的产物。
	 */
	constructor(
		private readonly getAppPath: () => string,
		private readonly log: (scope: string, message: string, detail?: unknown) => void = () => {},
		private readonly resolveManaged: () =>
			| { nodeModules: string; runtimeVersion: string }
			| undefined = () => undefined,
		private readonly allowBundledFallback: () => boolean = () => true,
		private readonly isPackaged: () => boolean = () => true,
	) {}

	/** 当前状态（首次调用探测并缓存；IPC 查询走这里）。 */
	getStatus(): DshRuntimeStatus {
		this.current ??= this.probeOnce();
		return this.current;
	}

	/**
	 * 供 DshHost 取 runtime 锚点（appRoot，即包含 node_modules 的目录）。
	 * 与 getStatus 共用同一份探测结果，避免「状态说装了、host 却找不到路径」的分叉。
	 */
	resolveAppRoot(): string | undefined {
		const probe = this.probeOnceFresh();
		return probe.ok ? probe.appRoot : undefined;
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
		const changed =
			this.current?.state !== next.state ||
			this.current?.runtimeVersion !== next.runtimeVersion ||
			this.current?.source !== next.source;
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

	/** 探测一次并返回状态快照（不写缓存，供 resolveAppRoot 这类旁路查询用）。 */
	private probeOnceFresh(): DshRuntimeProbe {
		return probeDshRuntime({
			managed: this.resolveManaged(),
			// dev 模式禁止内置回退：项目 node_modules 的包是开发依赖，不视为应用内置。
			bundled: this.allowBundledFallback()
				? probeBundledDshRuntime(this.getAppPath())
				: { ok: false, error: "bundled fallback disabled" },
		});
	}

	private probeOnce(): DshRuntimeStatus {
		const probe = this.probeOnceFresh();
		if (probe.ok) {
			return {
				state: "installed",
				source: probe.source,
				...(probe.runtimeVersion ? { runtimeVersion: probe.runtimeVersion } : {}),
				// 外部 managed runtime 时给出落盘目录（runtimesRoot/<version>），UI 概览页展示/打开用；
				// builtin 内置分发没有独立安装目录（在 app.asar 内），不填。
				...(probe.source === "managed" && probe.installDir ? { installDir: probe.installDir } : {}),
				// 仅打包态允许在线下载/重装；dev 由渲染层隐藏该入口。
				installEnabled: this.isPackaged(),
			};
		}
		// 两者都没有 = 未安装 runtime（阶段 2 依赖分区后的常态）。
		this.log("dsh-runtime", "dsh runtime not available", { error: probe.error });
		return { state: "notInstalled", installEnabled: this.isPackaged() };
	}
}
