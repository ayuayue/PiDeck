import { app, ipcMain } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import { GtdLedgerStore } from "../gtd/GtdLedger";

/**
 * GTD 分诊账本 IPC（#546）。
 *
 * 账本是纯本地人类意图（结清/已读/稍后提醒），与会话文件无关；这里只做入参整形，
 * 消毒与原子落盘在 `GtdLedgerStore`。分桶由渲染层用 shared/gtdProjection 实时算，
 * 所以没有「读桶」通道——读到的永远是原始水位。
 */
export function registerGtdIpc(options?: { filePath?: string }): void {
	const ledger = new GtdLedgerStore(options?.filePath ?? join(app.getPath("userData"), "gtd-ledger.json"));
	ipcMain.handle(ipcChannels.gtdStateGet, () => ledger.snapshot());
	ipcMain.handle(ipcChannels.gtdStatePatch, async (_event, rawSessionId: unknown, rawPatch: unknown) => {
		if (typeof rawSessionId !== "string" || !rawSessionId.trim()) throw new Error("gtd: invalid sessionId");
		if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) throw new Error("gtd: invalid patch");
		const raw = rawPatch as Record<string, unknown>;
		const pick = (value: unknown): number | null | undefined => (value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : undefined);
		// 只收三个已知水位键，其余字段丢弃（渲染层入参不可信）；undefined = 本次不改。
		return ledger.patch(rawSessionId.trim(), {
			settledAt: pick(raw.settledAt),
			viewedAt: pick(raw.viewedAt),
			snoozeUntil: pick(raw.snoozeUntil),
		});
	});
}
