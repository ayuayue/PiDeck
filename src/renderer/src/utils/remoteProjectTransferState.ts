import type { RemoteTransferOperation } from "../../../shared/types/remoteTransfers";

export type RemoteTransferUiPhase = "starting" | "running" | "cancelling" | "succeeded" | "partial" | "cancelled" | "failed" | "unknown";
export type RemoteTransferTerminalPhase = Extract<RemoteTransferUiPhase, "succeeded" | "partial" | "cancelled" | "failed" | "unknown">;

export type RemoteTransferUiItem = {
	readonly id: number;
	readonly operation: RemoteTransferOperation;
	readonly phase: RemoteTransferUiPhase;
	readonly transferred: number;
	readonly total: number;
	readonly code?: string;
	readonly failedCount?: number;
};

const ACTIVE_PHASES: ReadonlySet<RemoteTransferUiPhase> = new Set(["starting", "running", "cancelling"]);
const MAX_TERMINAL_ITEMS = 3;

export function isRemoteTransferActive(phase: RemoteTransferUiPhase): boolean {
	return ACTIVE_PHASES.has(phase);
}

function trimTerminalItems(items: readonly RemoteTransferUiItem[]): RemoteTransferUiItem[] {
	let terminalCount = 0;
	return items.filter((item) => {
		if (isRemoteTransferActive(item.phase)) return true;
		terminalCount += 1;
		return terminalCount <= MAX_TERMINAL_ITEMS;
	});
}

export function createRemoteTransferUiItem(id: number, operation: RemoteTransferOperation): RemoteTransferUiItem {
	return { id, operation, phase: "starting", transferred: 0, total: 0 };
}

export function addRemoteTransferUiItem(items: readonly RemoteTransferUiItem[], item: RemoteTransferUiItem): RemoteTransferUiItem[] {
	return trimTerminalItems([item, ...items]);
}

export function remoteTransferStarted(items: readonly RemoteTransferUiItem[], id: number, total: number): RemoteTransferUiItem[] {
	const safeTotal = Number.isSafeInteger(total) && total >= 0 ? total : 0;
	return items.map((item) => (item.id === id && item.phase === "starting" ? { ...item, phase: "running", total: safeTotal, transferred: safeTotal > 0 ? Math.min(item.transferred, safeTotal) : item.transferred } : item));
}

export function remoteTransferProgress(items: readonly RemoteTransferUiItem[], id: number, operation: RemoteTransferOperation, transferred: number, total: number): RemoteTransferUiItem[] {
	if (!Number.isSafeInteger(transferred) || transferred < 0 || !Number.isSafeInteger(total) || total < 0) return [...items];
	return items.map((item) => {
		if (item.id !== id || item.operation !== operation || (item.phase !== "starting" && item.phase !== "running")) return item;
		if (item.total > 0 && item.total !== total) return item;
		const knownTotal = item.total > 0 ? item.total : total;
		const next = knownTotal > 0 ? Math.min(transferred, knownTotal) : transferred;
		if (next <= item.transferred) return item;
		return { ...item, phase: "running", transferred: next, total: knownTotal };
	});
}

export function remoteTransferCancelling(items: readonly RemoteTransferUiItem[], id: number): RemoteTransferUiItem[] {
	return items.map((item) => (item.id === id && (item.phase === "starting" || item.phase === "running") ? { ...item, phase: "cancelling" } : item));
}

export function settleRemoteTransferUi(items: readonly RemoteTransferUiItem[], id: number, phase: RemoteTransferTerminalPhase, detail: { code?: string; failedCount?: number } = {}): RemoteTransferUiItem[] {
	return trimTerminalItems(
		items.map((item) => {
			if (item.id !== id || !isRemoteTransferActive(item.phase)) return item;
			const completed = phase === "succeeded" && item.total > 0 ? item.total : item.transferred;
			return {
				...item,
				phase,
				transferred: completed,
				...(detail.code === undefined ? {} : { code: detail.code }),
				...(detail.failedCount === undefined ? {} : { failedCount: detail.failedCount }),
			};
		}),
	);
}

export function dismissRemoteTransferUi(items: readonly RemoteTransferUiItem[], id: number): RemoteTransferUiItem[] {
	return items.filter((item) => item.id !== id || isRemoteTransferActive(item.phase));
}

export function remoteTransferPercent(item: RemoteTransferUiItem): number | undefined {
	if (!Number.isSafeInteger(item.total) || item.total <= 0) return undefined;
	const ratio = Math.min(1, Math.max(0, item.transferred / item.total));
	return Math.round(ratio * 100);
}

export function formatRemoteTransferBytes(bytes: number): string {
	if (!Number.isSafeInteger(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let unit = 0;
	let value = bytes;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = unit === 0 ? 0 : value >= 10 ? 0 : value >= 1 ? 1 : 2;
	return `${Number(value.toFixed(digits))} ${units[unit]}`;
}
