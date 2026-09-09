/**
 * Provider 用量查询 hook：atoms（provider-usage-atoms）之上的取数副作用层。
 *
 * 自动查询纪律：
 * - 是否查询由每个 provider 徽章里的开关决定（usage-probes.json 的 enabled）：
 *   显式 false → 不查；显式 true / 内置识别 / 已配模板 → 查；
 * - 状态表尚未回来时不抢发（等状态表），状态表已就绪但该 provider 不在表里 → 按开处理
 *   （与历史行为一致，避免圆球面板/选择器对表外 provider 永远不查）；
 * - 新鲜期 = 主进程返回的 intervalMinutes（默认 5 分钟）；
 * - interval = 0：该 provider 不轮询，且已查过的条目不自动重查；
 * - 手动刷新（useProviderUsageRefresh）永远直接发请求，不看新鲜期。
 *
 * 查询只写 atoms（组件卸载后写入也无害：缓存本就是跨组件共享的），无 cancelled 需求。
 */
import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type {
	ProviderUsageResult,
	UsageProbeBackend,
	UsageProbeProviderState,
	UsageProbeStatesResult,
} from "../../../shared/types/providerUsage";
import { normalizeDshDeepseekProvider } from "../../../shared/dshProviderNames";
import { desktopApi } from "../desktopApi";
import {
	beginProviderUsageAtom,
	markProviderUsageStatesStatusAtom,
	mergeProviderUsageStatesAtom,
	providerUsageEntryAtomFamily,
	providerUsageRecordsReadAtom,
	providerUsageStateAtomFamily,
	providerUsageStatesReadAtom,
	providerUsageStatesStatusAtom,
	resolveProviderUsageAtom,
	type ProviderUsageEntry,
} from "../atoms/provider-usage-atoms";
import {
	USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
	shouldAutoFetchProviderUsage,
} from "./providerUsageAutoQuery";
import { selectWarmupProviders, warmupDelayMs } from "./providerUsageWarmup";

export {
	USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
	providerUsageEntryStale,
} from "./providerUsageAutoQuery";

/**
 * 用量展示/缓存 key：DSH 链路的 provider 名前缀 `dsh:`，避免与 pi 侧同名 provider
 * （如 deepseek）串缓存。DSH 官方 DeepSeek 的 provider 名先归一（llm.models 组 id
 * deepseek-official → 配置面规范名 deepseek），使卡片行（deepseek）、模型选择器分组行
 * 与圆球面板（deepseek-official）共享同一缓存 key——一处刷新三处联动。
 * 注意与「发送给主进程的 provider 名」是两个概念——
 * key 只用于渲染层 atom 缓存；主进程按**原始 provider 名**解析端点/配置（主进程侧
 * 再做同一归一化，两条链路各自幂等）。
 */
export function usageCacheKey(provider: string, backend: UsageProbeBackend): string {
	if (backend === "dsh") return `dsh:${normalizeDshDeepseekProvider(provider)}`;
	return provider;
}

/** provider → 正在进行的请求；模块级一处，避免多组件同时挂载重复弹请求。 */
const inFlight = new Map<string, Promise<void>>();

/**
 * 发起一次查询并写入 atoms（in-flight 去重；结果无论成败都 resolve 进缓存）。
 * @param provider 原始 provider 名（主进程按它解析端点/配置）
 * @param cacheKey 渲染层缓存 key（与 provider 相同；DSH 链路为 `dsh:<provider>`）
 */
function startFetch(
	provider: string,
	cacheKey: string,
	resolve: (key: string, result: ProviderUsageResult) => void,
	backend: UsageProbeBackend = "pi",
): void {
	if (inFlight.has(cacheKey)) return;
	const promise = desktopApi.config
		.fetchUsage(provider, backend)
		.then((result) => resolve(cacheKey, result))
		.catch(() => {
			// 网络异常/IPC 失败：写一条结构化失败结果，与主进程返回失败同路径展示。
			resolve(cacheKey, { success: false, error: "fetch failed", at: Date.now() });
		})
		.finally(() => {
			inFlight.delete(cacheKey);
		});
	inFlight.set(cacheKey, promise);
}

/** 订阅单个 provider 的用量查询状态（徽章只读展示用）：未加载到 = undefined。 */
export function useProviderUsageState(
	provider: string | undefined,
	backend: UsageProbeBackend = "pi",
): UsageProbeProviderState | undefined {
	const cacheKey = provider ? usageCacheKey(provider, backend) : "";
	return useAtomValue(providerUsageStateAtomFamily(cacheKey));
}

/** 状态表模块级去重：同一 (backend, provider 列表签名) 只发一次 IPC，多张卡片共享结果。 */
const statesInFlight = new Map<string, Promise<UsageProbeStatesResult>>();

/**
 * 批量拉取 provider 用量状态（徽章开关 / 启动预热选源）。
 *
 * - pi 链路 providers 传空数组 = 主进程按 models.json + auth.json + 已配置项枚举；
 * - dsh 链路必须显式传卡片 provider 名（主进程不枚举 DSH settings.yaml）；
 * - 结果按 usageCacheKey 写入 atom，同一签名并发挂载共享一次 IPC；
 * - 拉取期间把 backend 标为 loading，避免卡片在「状态未知」时抢发一轮白请求。
 */
export function useProviderUsageStatesLoader(
	providers: string[],
	backend: UsageProbeBackend = "pi",
): void {
	const merge = useSetAtom(mergeProviderUsageStatesAtom);
	const markStatus = useSetAtom(markProviderUsageStatesStatusAtom);
	// 用字符串签名做依赖：调用方每次渲染传新数组也不会重跑 effect。
	const providerKey = providers.join("\n");
	useEffect(() => {
		// pi 链路一律请求「全量」（主进程按 models.json + auth.json + 已配置项枚举）：
		// 签名与 backend 同名，多张卡片/多个消费点共享同一次 IPC，不会按卡片扇出。
		// dsh 链路必须带卡片 provider 名（主进程不枚举 DSH settings.yaml），按列表签名去重。
		const list = backend === "pi" ? [] : providerKey ? providerKey.split("\n") : [];
		const signature = backend === "pi" ? "pi" : `dsh|${providerKey}`;
		let cancelled = false;
		markStatus(backend, "loading");
		const pending =
			statesInFlight.get(signature) ??
			desktopApi.config
				.listUsageProbeStates({ providers: list, backend })
				.catch(() => ({ providers: {}, errors: [] }));
		statesInFlight.set(signature, pending);
		void pending.then((result) => {
			// 卸载后仍写 atoms 无害（状态是跨组件共享的），但标记状态要避免覆盖后一次加载。
			if (!cancelled) markStatus(backend, "ready");
			const entries: Record<string, UsageProbeProviderState> = {};
			for (const [name, state] of Object.entries(result.providers)) {
				entries[usageCacheKey(name, backend)] = state;
			}
			merge(entries);
		});
		return () => {
			cancelled = true;
		};
	}, [providerKey, backend, merge, markStatus]);
}

/**
 * 重拉指定 provider 的状态（用量查询弹窗保存后调）：徽章的开关态/间隔来自状态表，
 * 保存只写了 usage-probes.json，必须回读一次才能让徽章立即从「未启用」变「查询中」。
 * 只请求该 provider（pi 侧主进程仍全量解析，dsh 侧只回名单内），开销与一次刷新同级。
 */
export function useRefreshProviderUsageState(): (
	provider: string,
	backend?: UsageProbeBackend,
) => Promise<void> {
	const merge = useSetAtom(mergeProviderUsageStatesAtom);
	return useCallback(
		async (provider: string, backend: UsageProbeBackend = "pi") => {
			if (!provider) return;
			const result = await desktopApi.config
				.listUsageProbeStates({ providers: [provider], backend })
				.catch(() => ({ providers: {}, errors: [] }));
			const entries: Record<string, UsageProbeProviderState> = {};
			for (const [name, state] of Object.entries(result.providers)) {
				entries[usageCacheKey(name, backend)] = state;
			}
			merge(entries);
		},
		[merge],
	);
}

/** 订阅并自动取数：provider 未指定时不查（三处调用方各自兜底 provider 来源）。
 * backend="dsh" 时查询走 DSH 链路（$DSH_HOME 配置 + DSH 凭据库），缓存 key 用
 * `dsh:<provider>` 隔离；**主进程收到的永远是原始 provider 名**（缓存 key 只在
 * 渲染层 atom 里用，不能当 provider 名发过去——之前把 `dsh:deepseek` 整体当
 * provider 寄回主进程，导致 DSH 卡片用量永远解析不出、显示为空）。
 * 自动查询前置条件 = 该 provider 的开关为真（徽章开关/弹窗「是否启用」，默认关）；
 * 本 hook 自己拉一次该 provider 的状态（pi 全量/单条同一次 IPC，dsh 按名字）。
 * 开关打开后按 intervalMinutes 排下一次自动刷新（0 = 不轮询；默认 5 分钟）。 */
export function useProviderUsageEntry(
	provider: string | undefined,
	backend: UsageProbeBackend = "pi",
): ProviderUsageEntry {
	const cacheKey = provider ? usageCacheKey(provider, backend) : undefined;
	// 自己拉状态：调用方（卡片/圆球/选择器）不必各自记着先加载状态表。
	useProviderUsageStatesLoader(provider ? [provider] : [], backend);
	const entry = useAtomValue(providerUsageEntryAtomFamily(cacheKey ?? ""));
	const state = useAtomValue(providerUsageStateAtomFamily(cacheKey ?? ""));
	const begin = useSetAtom(beginProviderUsageAtom);
	const resolve = useSetAtom(resolveProviderUsageAtom);
	// provider 级开关：未显式开启（状态未到或 enabled=false）一律不自动查。
	const queryEnabled = state?.enabled === true;
	// 生效间隔：已查到结果用配置值（0 = 该 provider 不轮询）；未查到用状态表/默认值。
	const intervalMinutes =
		entry.result?.intervalMinutes ??
		state?.intervalMinutes ??
		USAGE_PROBE_DEFAULT_INTERVAL_MINUTES;
	useEffect(() => {
		if (!provider || !cacheKey || !queryEnabled) return;
		// 走新鲜期（从未查过或已过 interval 才发）。
		if (
			shouldAutoFetchProviderUsage({
				reason: "mount",
				entry,
				intervalMinutes,
			})
		) {
			begin(cacheKey);
			startFetch(provider, cacheKey, resolve, backend);
		}
		// 依赖只用 fetchedAt 而非整个 entry：begin() 会把 status 改成 loading，
		// 若订整个对象会在首查发出后立刻重跑 effect（inFlight 能挡住 HTTP，但仍多一次 begin）。
	}, [provider, cacheKey, entry.fetchedAt, intervalMinutes, queryEnabled, begin, resolve, backend]);

	// 自动轮询：开关开 + 间隔 > 0 才排下一次刷新。
	// 挂载在哪个消费面板就轮询哪个（圆球面板/模型选择器展开区/配置卡片），不后台刷全部供应商。
	useEffect(() => {
		if (!provider || !cacheKey || !queryEnabled) return;
		if (
			!shouldAutoFetchProviderUsage({
				reason: "poll",
				entry,
				intervalMinutes,
			})
		) {
			return;
		}
		const timer = window.setTimeout(() => {
			begin(cacheKey);
			startFetch(provider, cacheKey, resolve, backend);
		}, intervalMinutes * 60_000);
		return () => window.clearTimeout(timer);
	}, [provider, cacheKey, intervalMinutes, queryEnabled, begin, resolve, backend]);

	return entry;
}

/**
 * 启动预热：应用启动后把「已开启」的 provider 各查一次，让卡片一打开就有数据。
 *
 * 为什么只查已开启的：默认关（enabled ?? false），所以预热名单通常只有用户真正开过的几条；
 * 又因为串行 + 错峰（warmupDelayMs），即使多条共用一个本地网关也不会同时打过去。
 * 只跑一次：整个应用生命周期内预热一轮，之后的刷新交给轮询/手动/挂载首查。
 * 调用方：App.tsx 装配层。
 */
export function useProviderUsageStartupWarmup(): void {
	// pi 链路请求全量（主进程按 models.json + auth.json + 已配置项枚举）；
	// dsh 链路不带名字 = 主进程只回 DSH 侧已配置过的 provider。
	useProviderUsageStatesLoader([], "pi");
	useProviderUsageStatesLoader([], "dsh");
	const states = useAtomValue(providerUsageStatesReadAtom);
	const status = useAtomValue(providerUsageStatesStatusAtom);
	const refresh = useProviderUsageRefresh();
	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		const piStatus = status.pi ?? "idle";
		const dshStatus = status.dsh ?? "idle";
		// 状态表在途就等；两边都从未请求（不可能，但保持幂等）也不排。
		if (piStatus === "loading" || dshStatus === "loading") return;
		if (piStatus === "idle" && dshStatus === "idle") return;
		started.current = true;
		const targets = selectWarmupProviders(states);
		const timers = targets.map((target, index) =>
			window.setTimeout(() => refresh(target.provider, target.backend), warmupDelayMs(index)),
		);
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [status.pi, status.dsh, states, refresh]);
}

/** 手动刷新单个 provider（详情面板刷新按钮 / 保存探针后重查）：不看开关、不走新鲜期。 */
export function useProviderUsageRefresh(): (provider: string, backend?: UsageProbeBackend) => void {
	const begin = useSetAtom(beginProviderUsageAtom);
	const resolve = useSetAtom(resolveProviderUsageAtom);
	return useCallback(
		(provider: string, backend: UsageProbeBackend = "pi") => {
			if (!provider) return;
			const cacheKey = usageCacheKey(provider, backend);
			begin(cacheKey);
			startFetch(provider, cacheKey, resolve, backend);
		},
		[begin, resolve],
	);
}

/** 批量刷新（模型选择器打开时）：只查「从未查过或已超过各自间隔」的 provider。
 * 调用方为模型选择器（provider 即缓存 key）；DSH 会话的选择器传 backend="dsh"，
 * 与 pi 侧同名 provider（如 deepseek）互不串缓存、也不误读对方链路的配置。 */
export function useProviderUsageBatchRefresh(): (providers: string[], backend?: UsageProbeBackend) => void {
	const records = useAtomValue(providerUsageRecordsReadAtom);
	const begin = useSetAtom(beginProviderUsageAtom);
	const resolve = useSetAtom(resolveProviderUsageAtom);
	return useCallback(
		(providers: string[], backend: UsageProbeBackend = "pi") => {
			for (const provider of providers) {
				if (!provider) continue;
				const cacheKey = usageCacheKey(provider, backend);
				const record = records[cacheKey] ?? null;
				const interval = record?.result?.intervalMinutes ?? USAGE_PROBE_DEFAULT_INTERVAL_MINUTES;
				// 走新鲜期（未查过才触发；interval=0 的已查条目不再自动重查）。
				if (
					!shouldAutoFetchProviderUsage({
						reason: "batch",
						entry: record,
						intervalMinutes: interval,
					})
				) {
					continue;
				}
				begin(cacheKey);
				startFetch(provider, cacheKey, resolve, backend);
			}
		},
		[records, begin, resolve],
	);
}
