/**
 * Provider 用量/余额查询结果缓存（Jotai 单一 owner）。
 *
 * composer 圆球面板与模型选择器展开区共享同一份 record：任意一处刷新成功，
 * 其他已挂载消费端立即拿到同一 entry，数字滚动动画自然联动。
 * entry 状态机：null（未查过）→ loading → ready | error；fetchedAt 供 TTL 判断。
 */
import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { ProviderUsageResult, UsageProbeProviderState } from "../../../shared/types/providerUsage";

export type ProviderUsageEntry = {
	/**
	 * idle = 从未查询过（自动查询关闭或尚未触发）；loading = 查询中；
	 * ready/error = 最近一次查询完成。idle 与 loading 的差异是渲染层
	 * 「是否显示加载中」的判断依据（interval=0 时不自动查，永远保持 idle 直到手动刷新）。
	 */
	status: "idle" | "loading" | "ready" | "error";
	/** 最近一次结果；loading 首查时为 null（失败重查时保留旧值供降级展示）。 */
	result: ProviderUsageResult | null;
	/** 完成时刻（Date.now()）；loading 中为上次完成时刻或 null。 */
	fetchedAt: number | null;
};

const EMPTY_ENTRY: ProviderUsageEntry = { status: "idle", result: null, fetchedAt: null };

/** provider → entry 的 record 原子：所有写动作都落在这里。 */
const providerUsageRecordsAtom = atom<Record<string, ProviderUsageEntry>>({});

/** record 只读视图（批量刷新的 TTL 判定用；写路径只经 begin/resolve 动作）。 */
export const providerUsageRecordsReadAtom = atom((get) => get(providerUsageRecordsAtom));

/** 按 provider 的只读选择器：record 局部更新只重渲染订阅该 provider 的组件。 */
export const providerUsageEntryAtomFamily = atomFamily((provider: string) =>
	selectAtom(
		providerUsageRecordsAtom,
		(records) => records[provider] ?? EMPTY_ENTRY,
		Object.is,
	),
);

/** 开始查询：已处于 loading 的 provider 幂等跳过（重查时保留旧结果供降级展示）。 */
export const beginProviderUsageAtom = atom(null, (get, set, provider: string) => {
	const current = get(providerUsageRecordsAtom)[provider];
	if (current?.status === "loading") return;
	set(providerUsageRecordsAtom, (records) => ({
		...records,
		[provider]: {
			status: "loading",
			result: records[provider]?.result ?? null,
			fetchedAt: records[provider]?.fetchedAt ?? null,
		},
	}));
});

/** 查询完成：success → ready，否则 error（raw 保留时 UI 可降级展示）。 */
export const resolveProviderUsageAtom = atom(
	null,
	(_get, set, provider: string, result: ProviderUsageResult) => {
		set(providerUsageRecordsAtom, (records) => ({
			...records,
			[provider]: {
				status: result.success ? "ready" : "error",
				result,
				fetchedAt: Date.now(),
			},
		}));
	},
);

/** 全部失效：清空 record（下次任一消费点挂载即重查）。保存探针配置后调用。 */
export const invalidateAllProviderUsageAtom = atom(null, (_get, set) => {
	set(providerUsageRecordsAtom, {});
});

/** 单个失效：清掉指定 provider 的 entry（下次挂载/手动刷新重查）。 */
export const invalidateProviderUsageAtom = atom(null, (_get, set, provider: string) => {
	set(providerUsageRecordsAtom, (records) => {
		if (!(provider in records)) return records;
		const next = { ...records };
		delete next[provider];
		return next;
	});
});

/**
 * provider(cacheKey) → 用量查询状态（生效开关/是否已配置/是否内置识别/模板/间隔）。
 *
 * key 与用量缓存同规则：pi 链路就是 provider 名，dsh 链路是 `dsh:<provider>`
 * （usageCacheKey），因此 pi/dsh 同名供应商互不覆盖。缺失 = 尚未加载（徽章按「开」处理，
 * 与历史行为一致：无状态信息时不主动阻塞查询）。
 */
const providerUsageStatesAtom = atom<Record<string, UsageProbeProviderState>>({});

/** 按 provider 的只读选择器：某条状态更新只重渲染订阅它的卡片。 */
export const providerUsageStateAtomFamily = atomFamily((cacheKey: string) =>
	selectAtom(providerUsageStatesAtom, (states) => states[cacheKey], Object.is),
);

/** 状态表只读视图（启动预热选源用：一次性读全表）。 */
export const providerUsageStatesReadAtom = atom((get) => get(providerUsageStatesAtom));

/** 批量写入状态（状态表 IPC 回来后一次合并；只覆盖本次带回的 key）。 */
export const mergeProviderUsageStatesAtom = atom(
	null,
	(_get, set, entries: Record<string, UsageProbeProviderState>) => {
		set(providerUsageStatesAtom, (states) => ({ ...states, ...entries }));
	},
);

/**
 * 状态表加载阶段（按 backend）：idle = 从未请求（无消费方加载器）、loading = 请求中、
 * ready = 已回过一次。自动查询据此决定「状态未知时要不要等」：
 * loading 期间不抢发（否则关掉的供应商会在状态表回来前白打一轮 HTTP）；
 * idle/ready 时未知 provider 按开处理（圆球面板/选择器可能查表外 provider）。
 */
export const providerUsageStatesStatusAtom = atom<Record<string, "idle" | "loading" | "ready">>({});

export const markProviderUsageStatesStatusAtom = atom(
	null,
	(_get, set, backend: string, status: "idle" | "loading" | "ready") => {
		set(providerUsageStatesStatusAtom, (current) => ({ ...current, [backend]: status }));
	},
);
