import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GtdLedger, GtdSessionState, GtdStatePatch } from "../../shared/types/gtd";

/**
 * GTD 分诊账本（#546）：`<userData>/gtd-ledger.json`。
 *
 * 只存人类意图与时间水位（结清 / 已读 / 稍后提醒），桶由投影实时算出（shared/gtdProjection）。
 * 稀疏存储：只有被用户操作过的会话才有条目；会话被删/归档后残留的水位线无害
 * （读取方按 sessionId 命中才算），所以不做清理任务。
 *
 * 写盘走 tmp + rename：中途崩溃只会留下一个孤立 tmp，不会写出半截 JSON。
 */

const STORE_VERSION = 1;
/** 规模上限：正常使用远达不到；超出时丢最旧的水位线（按三个时间戳的最大值排序）。 */
const MAX_ENTRIES = 5_000;

type PersistedState = { version: number; sessions: GtdLedger };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/** 单条消毒：只保留有限正数时间戳；空条目直接丢（等于「没有人类意图」）。 */
function normalizeState(value: unknown): GtdSessionState | undefined {
	if (!isRecord(value)) return undefined;
	const state: GtdSessionState = {};
	const settledAt = positiveTimestamp(value.settledAt);
	const viewedAt = positiveTimestamp(value.viewedAt);
	const snoozeUntil = positiveTimestamp(value.snoozeUntil);
	if (settledAt !== undefined) state.settledAt = settledAt;
	if (viewedAt !== undefined) state.viewedAt = viewedAt;
	if (snoozeUntil !== undefined) state.snoozeUntil = snoozeUntil;
	return Object.keys(state).length > 0 ? state : undefined;
}

function latestTimestamp(state: GtdSessionState): number {
	return Math.max(state.settledAt ?? 0, state.viewedAt ?? 0, state.snoozeUntil ?? 0);
}

export class GtdLedgerStore {
	private sessions: GtdLedger = {};
	private loaded: Promise<void> | undefined;
	/** 串行化写入：同一时刻只允许一个落盘，避免两个 patch 互相覆盖。 */
	private writeChain: Promise<unknown> = Promise.resolve();

	constructor(private readonly filePath: string) {}

	/** 读快照（懒加载；首次调用触发一次磁盘读取）。 */
	async snapshot(): Promise<GtdLedger> {
		await this.ensureLoaded();
		return { ...this.sessions };
	}

	/** 应用一个补丁并落盘，返回应用后的完整快照。 */
	async patch(sessionId: string, patch: GtdStatePatch): Promise<GtdLedger> {
		await this.ensureLoaded();
		const previous = this.sessions[sessionId] ?? {};
		const next: GtdSessionState = { ...previous };
		for (const key of ["settledAt", "viewedAt", "snoozeUntil"] as const) {
			const value = patch[key];
			// undefined = 本次不改；null = 明确清除该水位（撤销结清 / 取消 snooze）。
			if (value === undefined) continue;
			const normalized = value === null ? undefined : positiveTimestamp(value);
			if (normalized === undefined) delete next[key];
			else next[key] = normalized;
		}
		if (Object.keys(next).length > 0) this.sessions[sessionId] = next;
		else delete this.sessions[sessionId];
		this.enforceLimit();
		await this.persist();
		return { ...this.sessions };
	}

	private async ensureLoaded(): Promise<void> {
		this.loaded ??= this.load();
		await this.loaded;
	}

	private async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch {
			// 不存在/不可读：空账本。分诊状态是可再生的人类意图，不值得为读失败阻塞启动。
			return;
		}
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed) || !isRecord(parsed.sessions)) return;
			const sessions: GtdLedger = {};
			for (const [sessionId, value] of Object.entries(parsed.sessions)) {
				if (!sessionId) continue;
				const state = normalizeState(value);
				if (state) sessions[sessionId] = state;
			}
			this.sessions = sessions;
			this.enforceLimit();
		} catch {
			// 坏 JSON：按空账本继续，下次写入覆盖它。
		}
	}

	private enforceLimit(): void {
		const ids = Object.keys(this.sessions);
		if (ids.length <= MAX_ENTRIES) return;
		const oldest = ids.sort((left, right) => latestTimestamp(this.sessions[left]) - latestTimestamp(this.sessions[right]));
		for (const id of oldest.slice(0, ids.length - MAX_ENTRIES)) delete this.sessions[id];
	}

	private persist(): Promise<void> {
		const payload: PersistedState = { version: STORE_VERSION, sessions: { ...this.sessions } };
		const body = JSON.stringify(payload);
		this.writeChain = this.writeChain.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.${process.pid}-${randomUUID()}.tmp`;
			await writeFile(tmp, body, "utf8");
			await rename(tmp, this.filePath);
		});
		return this.writeChain.then(
			() => undefined,
			(error) => {
				// 落盘失败不能让 UI 看起来「结清成功了」：把错误交给调用方（IPC 会透出）。
				throw error;
			},
		);
	}
}
