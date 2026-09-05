/**
 * Provider 用量查询 hook：atoms（provider-usage-atoms）之上的取数副作用层。
 *
 * 自动查询纪律（对齐 cc-switch「按设置的间隔探查、不主动冗余刷新」）：
 * - 新鲜期 = 主进程返回的 intervalMinutes（默认 5 分钟，0 = 关闭自动查询）——
 *   不是固定 60s。打开面板/卡片时只有「从未查过」或「已超过间隔」才发请求；
 * - interval = 0：打开时查一次（用户主动查看 = 手动性质），此后不自动重查、
 *   不轮询，只有手动刷新 / 测试 / 保存后置失效才会再发；
 * - 手动刷新（useProviderUsageRefresh）永远直接发请求，不走新鲜期判定。
 *
 * 查询只写 atoms（组件卸载后写入也无害：缓存本就是跨组件共享的），无 cancelled 需求。
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ProviderUsageResult, UsageProbeBackend } from "../../../shared/types/providerUsage";
import { normalizeDshDeepseekProvider } from "../../../shared/dshProviderNames";
import { desktopApi } from "../desktopApi";
import {
	beginProviderUsageAtom,
	providerUsageEntryAtomFamily,
	providerUsageRecordsReadAtom,
	resolveProviderUsageAtom,
	type ProviderUsageEntry,
} from "../atoms/provider-usage-atoms";

/** 默认自动查询间隔（分钟）：与主进程默认一致（学 cc-switch），0 = 关闭自动查询。 */
export const USAGE_PROBE_DEFAULT_INTERVAL_MINUTES = 5;

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

/**
 * entry 是否需要（重）查：
 * - 从未完成过（fetchedAt=null）→ 需要（首查）；
 * - interval <= 0（关闭自动查询）→ 不需要（只靠手动刷新）；
 * - 否则按 interval 分钟过期判定（默认 5 分钟），不再有固定 60s 的冗余重查。
 */
export function providerUsageEntryStale(
	entry: Pick<ProviderUsageEntry, "fetchedAt"> | null,
	intervalMinutes: number = USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
	now: number = Date.now(),
): boolean {
	if (!entry || entry.fetchedAt == null) return true;
	if (intervalMinutes <= 0) return false;
	return now - entry.fetchedAt >= intervalMinutes * 60_000;
}

/** provider → 内置识别结果的模块级缓存（跨组件共享，避免重复 IPC）；识别结果跟随 provider 名/backend。 */
const usageRecognizedCache = new Map<string, boolean>();
const usageRecognizedInFlight = new Map<string, Promise<boolean>>();

/**
 * provider 是否命中内置用量模板（零配置自动生效）：渲染层据此隐藏「用量查询」配置按钮。
 * 缓存 key 与 usageCacheKey 同规则（DSH 链路 dsh: 前缀隔离）；首次查询后在模块级缓存，
 * 多次卡片挂载共享同一结果、不重复发 IPC。识别结果可能随 baseUrl 编辑过期——卡片重挂载时
 * 若已有缓存仍沿用（用量本身也按缓存展示，行为一致；重开应用即刷新）。
 */
export function useProviderUsageRecognized(
	provider: string | undefined,
	backend: UsageProbeBackend = "pi",
): boolean {
	const cacheKey = provider ? usageCacheKey(provider, backend) : undefined;
	const [recognized, setRecognized] = useState<boolean>(() =>
		cacheKey ? (usageRecognizedCache.get(cacheKey) ?? false) : false,
	);
	useEffect(() => {
		if (!provider || !cacheKey) return;
		if (usageRecognizedCache.has(cacheKey)) {
			setRecognized(usageRecognizedCache.get(cacheKey)!);
			return;
		}
		// in-flight 去重：并发挂载的多个卡片共享同一次 IPC，避免重复请求。
		if (usageRecognizedInFlight.has(cacheKey)) {
			void usageRecognizedInFlight.get(cacheKey)!.then(setRecognized);
			return;
		}
		const promise = desktopApi.config.usageRecognized(provider, backend).then((res) => res.recognized);
		usageRecognizedInFlight.set(cacheKey, promise);
		promise.then((value) => {
			usageRecognizedCache.set(cacheKey, value);
			setRecognized(value);
		});
	}, [provider, cacheKey, backend]);
	return recognized;
}

/** 订阅并自动取数：provider 未指定时不查（三处调用方各自兜底 provider 来源）。
 * backend="dsh" 时查询走 DSH 链路（$DSH_HOME 配置 + DSH 凭据库），缓存 key 用
 * `dsh:<provider>` 隔离；**主进程收到的永远是原始 provider 名**（缓存 key 只在
 * 渲染层 atom 里用，不能当 provider 名发过去——之前把 `dsh:deepseek` 整体当
 * provider 寄回主进程，导致 DSH 卡片用量永远解析不出、显示为空）。
 * 首次挂载查一次；成功后按主进程返回的 intervalMinutes 排下一次自动刷新
 * （0 = 不自动；默认 5 分钟）。 */
export function useProviderUsageEntry(
	provider: string | undefined,
	backend: UsageProbeBackend = "pi",
): ProviderUsageEntry {
	const cacheKey = provider ? usageCacheKey(provider, backend) : undefined;
	const entry = useAtomValue(providerUsageEntryAtomFamily(cacheKey ?? ""));
	const begin = useSetAtom(beginProviderUsageAtom);
	const resolve = useSetAtom(resolveProviderUsageAtom);
	// 生效间隔：已查到结果用配置值（0 = 不自动）；未查到用默认值（首查）。
	const intervalMinutes =
		entry.result?.intervalMinutes ?? USAGE_PROBE_DEFAULT_INTERVAL_MINUTES;
	useEffect(() => {
		if (!provider || !cacheKey) return;
		// 依赖只用原始值 cacheKey/fetchedAt / intervalMinutes（entry 对象引用经 selectAtom/Object.is 已稳定）。
		if (!providerUsageEntryStale(entry, intervalMinutes)) return;
		begin(cacheKey);
		startFetch(provider, cacheKey, resolve, backend);
	}, [provider, cacheKey, entry.fetchedAt, intervalMinutes, begin, resolve, backend]);

	// 自动轮询：只对「已成功且间隔 > 0」的 provider 排下一次刷新；
	// interval = 0 时不轮询（关闭自动查询 = 完全手动）。
	// 挂载在哪个面板就轮询哪个（模型卡片/选择器可见时才有订阅者），不后台刷全部。
	useEffect(() => {
		if (!provider || !cacheKey || intervalMinutes <= 0) return;
		const timer = window.setTimeout(() => {
			begin(cacheKey);
			startFetch(provider, cacheKey, resolve, backend);
		}, intervalMinutes * 60_000);
		return () => window.clearTimeout(timer);
	}, [provider, cacheKey, intervalMinutes, begin, resolve, backend]);

	return entry;
}

/** 手动刷新单个 provider（详情面板刷新按钮 / 保存探针后重查）：不走新鲜期判定。 */
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

/** 批量刷新（模型选择器打开时）：只查「从未查过或已超过各自间隔」的 provider，跳过新鲜条目。
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
				// 新鲜期去重：未查过（无记录）才触发；interval=0 的已查条目不再自动重查。
				if (!providerUsageEntryStale(record, interval)) continue;
				begin(cacheKey);
				startFetch(provider, cacheKey, resolve, backend);
			}
		},
		[records, begin, resolve],
	);
}
