/**
 * useSessionSubagents — pi-subagents 子代理列表数据 hook。
 *
 * 三源合并（主进程 IPC 的 record 记录 + 桥接扩展实时 widget 快照 + 工具调用推导兜底），
 * 另叠加 nicobailon pi-subagents 的 subagent-async widget 运行态快照（后台/工作流
 * 运行不经 record/桥接链，由插件经 setWidget 直接推送）。输出统一数组供
 * SessionSubagentsStrip 渲染。
 *
 * @module useSessionSubagents
 */

import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { PiSubagentEntry, PiSubagentStatus } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import {
	sessionRuntimeUiBySessionIdAtomFamily,
} from "../atoms";

/* ------------------------------------------------------------------ */
/* 纯函数合并逻辑（可单测）                                              */
/* ------------------------------------------------------------------ */

/** 桥接 widget 快照首行 JSON 的形状（扩展字段无额外类型安全）。 */
interface BridgeSnapshot {
	v?: number;
	kind?: string;
	pluginActive?: boolean;
	agents?: Array<{
		id: string;
		type: string;
		description: string;
		status: string;
		toolUses?: number;
		tokens?: number;
		startedAt?: number;
		completedAt?: number;
		result?: string;
		error?: string;
		via?: string;
	}>;
}

const VALID_STATUSES = new Set([
	"queued", "running", "completed", "steered", "aborted", "stopped", "error",
]);

function parseBridgeSnapshot(lines: readonly string[] | undefined): {
	pluginActive: boolean | undefined;
	entries: PiSubagentEntry[];
} {
	// 无桥接快照（历史会话无 runtime、或扩展从未推送）≠ 插件不在位：
	// 返回 undefined 三态，让 UI 走中性空态而不是误导性的「未检测到插件」。
	if (!lines || lines.length === 0) return { pluginActive: undefined, entries: [] };
	try {
		const snap: BridgeSnapshot = JSON.parse(lines[0]);
		const pluginActive = snap.pluginActive === true;
		const entries: PiSubagentEntry[] = (snap.agents ?? [])
			.map((a): PiSubagentEntry => {
				const status = VALID_STATUSES.has(a.status ?? "") ? a.status : "queued";
				return {
					id: a.id ?? "",
					type: a.type ?? "",
					description: a.description ?? "",
					status: status as PiSubagentEntry["status"],
					toolUses: typeof a.toolUses === "number" ? a.toolUses : undefined,
					tokens: typeof a.tokens === "number" ? a.tokens : undefined,
					startedAt: typeof a.startedAt === "number" ? a.startedAt : undefined,
					completedAt: typeof a.completedAt === "number" ? a.completedAt : undefined,
					result: typeof a.result === "string" ? a.result : undefined,
					error: typeof a.error === "string" ? a.error : undefined,
					via: a.via === "acp-delegate" ? "acp-delegate" : undefined,
					source: "bridge" as const,
				};
			})
			.filter((e) => e.id);
		return { pluginActive, entries };
	} catch {
		return { pluginActive: undefined, entries: [] };
	}
}

export function mergeSubagentEntries(
	records: PiSubagentEntry[],
	bridgeLines: readonly string[] | undefined,
): { merged: PiSubagentEntry[]; pluginActive: boolean | undefined } {
	const bridge = parseBridgeSnapshot(bridgeLines);
	const byId = new Map<string, PiSubagentEntry>();

	// 底座：record（权威终态）
	for (const r of records) {
		byId.set(r.id, r);
	}

	// 覆盖：bridge 快照运行中覆写（更新 toolUses / tokens / running status）
	for (const b of bridge.entries) {
		const existing = byId.get(b.id);
		if (existing) {
			// 仅当 record 不是终态时覆写 status；record 终态（completed/error/...）保持不变
			if (existing.status !== "running" && existing.status !== "queued") {
				continue; // record 已是终态，桥接快照不应倒覆
			}
			// 桥接快照字段缺失时降级为 0，不能用 0 倒覆 record 的真实计数
			byId.set(b.id, {
				...existing,
				status: b.status,
				toolUses: (b.toolUses ?? 0) > 0 ? b.toolUses : existing.toolUses,
				tokens: (b.tokens ?? 0) > 0 ? b.tokens : existing.tokens,
			});
		} else {
			// record 中没有 = 纯桥接条目（如刚创建、尚未来得及落盘）
			byId.set(b.id, b);
		}
	}

	// 排序：运行中置顶 → completed / error / stopped 等终态倒序 → 其余按 startedAt 降序
	const merged = Array.from(byId.values()).sort((a, b) => {
		const aActive = a.status === "running" || a.status === "queued";
		const bActive = b.status === "running" || b.status === "queued";
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return (b.startedAt ?? 0) - (a.startedAt ?? 0);
	});

	return { merged, pluginActive: bridge.pluginActive };
}

/* ------------------------------------------------------------------ */
/* nicobailon pi-subagents：subagent-async widget 快照                  */
/* ------------------------------------------------------------------ */

const SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async";
const SUBAGENT_ASYNC_LINE_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const SUBAGENT_ASYNC_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";

/** async 快照 state → PiSubagentStatus；partial（部分失败）按失败类呈现引导关注。 */
const SNAPSHOT_STATE_TO_STATUS: Record<string, PiSubagentStatus> = {
	queued: "queued",
	running: "running",
	paused: "running",
	complete: "completed",
	failed: "error",
	partial: "error",
	stopped: "stopped",
	rejected: "stopped",
};

/**
 * 解析 subagent-async widget 行（首行 PI_SUBAGENT_ASYNC_JSON:{...}，rpc 模式由
 * nicobailon pi-subagents 插件推送）为子代理条目。快照无 task 文本（label 为
 * agent 名），description 留空，由 applyAsyncSnapshotEntries 从同 id 的推导条目
 * 补充；id 为插件 asyncId，与主进程派发回执推导的条目 id 同源。损坏载荷返回
 * []（fail-soft，不影响其他源）。
 */
export function parseSubagentAsyncSnapshot(
	lines: readonly string[] | undefined,
): PiSubagentEntry[] {
	const line = lines?.find((candidate) =>
		typeof candidate === "string" && candidate.startsWith(SUBAGENT_ASYNC_LINE_PREFIX),
	);
	if (!line) return [];
	try {
		const snapshot = JSON.parse(line.slice(SUBAGENT_ASYNC_LINE_PREFIX.length)) as {
			kind?: string;
			runs?: Array<Record<string, unknown>>;
		};
		if (snapshot?.kind !== SUBAGENT_ASYNC_SNAPSHOT_KIND || !Array.isArray(snapshot.runs)) {
			return [];
		}
		const entries: PiSubagentEntry[] = [];
		for (const run of snapshot.runs) {
			const id = typeof run?.id === "string" ? run.id : "";
			if (!id) continue;
			const state = typeof run?.state === "string" ? run.state : "running";
			entries.push({
				id,
				type: typeof run?.label === "string" && run.label ? run.label : "subagent",
				description: "",
				status: SNAPSHOT_STATE_TO_STATUS[state] ?? "running",
				startedAt: typeof run?.startedAt === "number" ? run.startedAt : undefined,
				completedAt: typeof run?.endedAt === "number" ? run.endedAt : undefined,
				source: "bridge",
				via: "pi-subagents-tool",
			});
		}
		return entries;
	} catch {
		return [];
	}
}

/**
 * 将 subagent-async widget 快照条目叠加进合并结果：快照是运行态唯一实时真源，
 * 同 id 时以快照为准（状态更新）；快照条目无 task 文本（description 为空），
 * 已存在同 id 条目时保留其 description（主进程从派发 args.task 推导）。
 */
export function applyAsyncSnapshotEntries(
	existing: PiSubagentEntry[],
	asyncEntries: PiSubagentEntry[],
): PiSubagentEntry[] {
	if (asyncEntries.length === 0) return existing;
	const byId = new Map(existing.map((entry) => [entry.id, entry]));
	for (const entry of asyncEntries) {
		const prev = byId.get(entry.id);
		byId.set(
			entry.id,
			!entry.description && prev?.description ? { ...entry, description: prev.description } : entry,
		);
	}
	return [...byId.values()];
}

/* ------------------------------------------------------------------ */
/* Hook                                                               */
/* ------------------------------------------------------------------ */

export function useSessionSubagents(
	sessionId: string,
): {
	entries: PiSubagentEntry[];
	pluginActive: boolean | undefined;
	loading: boolean;
} {
	const [loading, setLoading] = useState(false);
	const [records, setRecords] = useState<PiSubagentEntry[]>([]);

	// 桥接实时数据：widgets["pi-deck-subagents"]（tintinweb 桥接快照）与
	// widgets["subagent-async"]（nicobailon pi-subagents 的 async 运行快照）。
	// atom family 按 Record 索引取值，无 runtime UI 记录的会话（如起始页未启动会话）
	// 运行时为 undefined，必须可选链防护，否则整卡渲染崩溃。
	const widgets = useAtomValue(
		sessionRuntimeUiBySessionIdAtomFamily(sessionId),
	)?.widgets;
	const bridgeLines = widgets?.["pi-deck-subagents"] as
		| readonly string[]
		| undefined;
	const subagentAsyncLines = widgets?.["subagent-async"] as
		| readonly string[]
		| undefined;

	// 主进程 IPC：拉取 record（初次 / 会话切换时）
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		desktopApi.sessions
			.listSessionSubagents(sessionId)
			.then((entries) => {
				if (!cancelled) {
					setRecords(entries);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// 合并：record（主进程侧已含工具推导）+ tintinweb 桥接 → 叠加 nicobailon async 条目
	const { merged, pluginActive } = useMemo(
		() => mergeSubagentEntries(records, bridgeLines),
		[records, bridgeLines],
	);
	const entries = useMemo(
		() => applyAsyncSnapshotEntries(merged, parseSubagentAsyncSnapshot(subagentAsyncLines)),
		[merged, subagentAsyncLines],
	);

	return { entries, pluginActive, loading };
}