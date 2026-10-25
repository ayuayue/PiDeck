/**
 * useWebProviderUsage — Web 端供应商额度用量（与桌面圆球面板同源，但无 jotai 依赖）。
 *
 * 设计要点：
 * - 用量查询是**用户显式开关**的能力（ConfigManager 的 usage probe）：未开启、供应商无
 *   可用端点、主进程未装配依赖时服务端都返回 success=false（恒 200）。这是正常态不是
 *   故障，所以 hook 只把结果交给渲染层判断，不抛错、不触发 toast。
 * - 探针会真实访问供应商计费接口，必须节流：默认 5 分钟一轮（与桌面
 *   USAGE_PROBE_DEFAULT_INTERVAL_MINUTES 一致），结果自带的 intervalMinutes 优先；
 *   手动 refresh() 有最短间隔保护（30s），避免连点打爆供应商接口。
 * - provider 变化（切会话/换模型）立即作废在途回包并重新查询，绝不把上一家的额度
 *   显示在当前供应商名下。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsageResult, UsageProbeBackend } from "../../../shared/types";
import { fetchProviderUsage } from "./webApi";

/** 无 intervalMinutes 上报时的默认轮询间隔（分钟）：与桌面 usage probe 默认值一致。 */
export const WEB_USAGE_DEFAULT_INTERVAL_MINUTES = 5;
/** 手动刷新的最短间隔（毫秒）：连点只生效一次，保护供应商计费接口。 */
export const WEB_USAGE_REFRESH_COOLDOWN_MS = 30_000;

export type WebProviderUsageState = {
	result: ProviderUsageResult | null;
	loading: boolean;
	/** 手动刷新；冷却期内调用直接返回。 */
	refresh: () => void;
};

/** 节流间隔落位：上报值必须为正有限数，否则回默认档（异常值会退化成疯狂轮询）。 */
export function resolveWebUsageIntervalMs(result: ProviderUsageResult | null): number {
	const minutes = result?.intervalMinutes;
	const safe = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : WEB_USAGE_DEFAULT_INTERVAL_MINUTES;
	return Math.max(60_000, Math.round(safe * 60_000));
}

export function useWebProviderUsage(provider: string | undefined, backend: UsageProbeBackend = "pi", enabled = true): WebProviderUsageState {
	const [result, setResult] = useState<ProviderUsageResult | null>(null);
	const [loading, setLoading] = useState(false);
	// 请求序号：切供应商/切后端时作废在途回包，避免旧结果覆盖新供应商
	const seqRef = useRef(0);
	const lastFetchAtRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const run = useCallback(
		(force: boolean) => {
			if (!provider) return;
			const now = Date.now();
			// 冷却保护：只有强制刷新（用户点、供应商变化后的首轮）才允许穿透
			if (!force && now - lastFetchAtRef.current < WEB_USAGE_REFRESH_COOLDOWN_MS) return;
			lastFetchAtRef.current = now;
			const seq = ++seqRef.current;
			setLoading(true);
			void fetchProviderUsage(provider, backend)
				.then((next) => {
					if (seq !== seqRef.current) return;
					setResult(next);
				})
				.catch(() => {
					// 网络/服务异常按「不可用」处理：结果留空，UI 不渲染额度区块
					if (seq !== seqRef.current) return;
					setResult(null);
				})
				.finally(() => {
					if (seq !== seqRef.current) return;
					setLoading(false);
				});
		},
		[provider, backend],
	);

	// 供应商/后端变化 → 清空旧结果并强制重查（旧供应商的额度不能留在新供应商名下）
	useEffect(() => {
		seqRef.current += 1;
		setResult(null);
		setLoading(false);
		lastFetchAtRef.current = 0;
		if (!enabled || !provider) return;
		run(true);
	}, [enabled, provider, backend, run]);

	// 周期轮询：间隔随服务端上报的 intervalMinutes 走（探针本身也有服务端节流语义）
	useEffect(() => {
		if (!enabled || !provider) return;
		const intervalMs = resolveWebUsageIntervalMs(result);
		timerRef.current = setInterval(() => run(false), intervalMs);
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
			timerRef.current = null;
		};
	}, [enabled, provider, result, run]);

	const refresh = useCallback(() => {
		run(true);
	}, [run]);

	return { result, loading, refresh };
}
