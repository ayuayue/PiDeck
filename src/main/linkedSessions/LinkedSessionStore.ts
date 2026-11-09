import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
	LINKED_SESSION_MAX_AUTO_CONTINUE,
	LINKED_SESSION_PROMPT_MAX_CHARS,
	LINKED_SESSION_PROPOSAL_TTL_MS,
	LINKED_SESSION_REPORT_MAX_CHARS,
	LINKED_SESSION_TITLE_MAX_CHARS,
	type LinkedSessionLink,
	type LinkedSessionProposal,
	type LinkedSessionProposalStatus,
	type LinkedSessionState,
	type LinkedSessionsSnapshot,
} from "../../shared/types/linkedSessions";

/**
 * 关联会话的本地关系表（<userData>/linked-sessions.json）。
 *
 * 只存引用与展示用摘要（标题、状态、最近回报前 400 字），不存会话正文。
 * 自动续跑计数不落盘：应用重启后父会话的运行时也没了，旧计数没有意义。
 */

const STORE_VERSION = 1;
/** 关系表规模上限：正常使用远达不到，超出时丢最旧的已归档关系。 */
const MAX_LINKS = 2_000;
const MAX_PROPOSALS = 500;

type PersistedState = {
	version: number;
	links: LinkedSessionLink[];
	proposals: LinkedSessionProposal[];
};

const LINK_STATES: readonly LinkedSessionState[] = ["starting", "running", "idle", "failed", "stopped"];
const PROPOSAL_STATUSES: readonly LinkedSessionProposalStatus[] = ["pending", "started", "here", "dismissed", "expired"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 回报截取：压掉多余空白后取前 N 字，超出加省略号。 */
export function clipReport(text: string, max = LINKED_SESSION_REPORT_MAX_CHARS): string {
	const compact = text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function normalizeLink(value: unknown): LinkedSessionLink | null {
	if (!isRecord(value)) return null;
	const childSessionId = str(value.childSessionId, 500);
	const parentSessionId = str(value.parentSessionId, 500);
	const projectId = str(value.projectId, 500);
	if (!childSessionId || !parentSessionId || !projectId || childSessionId === parentSessionId) return null;
	const rawState = value.state as LinkedSessionState;
	// 重启后运行时都没了：落盘时的 starting/running 一律视为已停止，避免侧栏永远转圈。
	const state: LinkedSessionState = LINK_STATES.includes(rawState) ? (rawState === "starting" || rawState === "running" ? "stopped" : rawState) : "stopped";
	return {
		childSessionId,
		parentSessionId,
		projectId,
		title: str(value.title, LINKED_SESSION_TITLE_MAX_CHARS) ?? "",
		createdAt: num(value.createdAt) ?? Date.now(),
		state,
		...(str(value.lastReport, LINKED_SESSION_REPORT_MAX_CHARS + 1) ? { lastReport: str(value.lastReport, LINKED_SESSION_REPORT_MAX_CHARS + 1) } : {}),
		...(num(value.lastReportAt) !== undefined ? { lastReportAt: num(value.lastReportAt) } : {}),
		turnCount: Math.max(0, Math.floor(num(value.turnCount) ?? 0)),
		archived: value.archived === true,
	};
}

function normalizeProposal(value: unknown): LinkedSessionProposal | null {
	if (!isRecord(value)) return null;
	const id = str(value.id, 200);
	const parentSessionId = str(value.parentSessionId, 500);
	const projectId = str(value.projectId, 500);
	const title = str(value.title, LINKED_SESSION_TITLE_MAX_CHARS);
	const prompt = str(value.prompt, LINKED_SESSION_PROMPT_MAX_CHARS);
	if (!id || !parentSessionId || !projectId || !title || !prompt) return null;
	const initiation = value.initiation === "offer" || value.initiation === "own_initiative" ? value.initiation : null;
	if (!initiation) return null;
	const rawStatus = value.status as LinkedSessionProposalStatus;
	// offer 的等待者是内存里的 HTTP 请求，重启后不复存在：落盘的 pending offer 视为过期。
	let status: LinkedSessionProposalStatus = PROPOSAL_STATUSES.includes(rawStatus) ? rawStatus : "expired";
	if (status === "pending" && initiation === "offer") status = "expired";
	return {
		id,
		parentSessionId,
		projectId,
		title,
		prompt,
		initiation,
		...(str(value.toolCallId, 200) ? { toolCallId: str(value.toolCallId, 200) } : {}),
		status,
		createdAt: num(value.createdAt) ?? Date.now(),
		...(str(value.childSessionId, 500) ? { childSessionId: str(value.childSessionId, 500) } : {}),
	};
}

export function normalizeLinkedSessionsState(raw: unknown): PersistedState {
	const state: PersistedState = { version: STORE_VERSION, links: [], proposals: [] };
	if (!isRecord(raw)) return state;
	const seenChildren = new Set<string>();
	for (const candidate of Array.isArray(raw.links) ? raw.links : []) {
		const link = normalizeLink(candidate);
		if (!link || seenChildren.has(link.childSessionId)) continue;
		seenChildren.add(link.childSessionId);
		state.links.push(link);
	}
	const seenProposals = new Set<string>();
	for (const candidate of Array.isArray(raw.proposals) ? raw.proposals : []) {
		const proposal = normalizeProposal(candidate);
		if (!proposal || seenProposals.has(proposal.id)) continue;
		seenProposals.add(proposal.id);
		state.proposals.push(proposal);
	}
	return state;
}

export class LinkedSessionStore {
	private state: PersistedState = { version: STORE_VERSION, links: [], proposals: [] };
	private saveQueue: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<() => void>();
	/** 父会话 id → 本轮用户消息之后被回报自动续跑的次数。 */
	private readonly autoContinueCount = new Map<string, number>();

	constructor(private readonly filePath: string | null) {}

	onChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 读盘只发生一次；写操作等它完成后再动内存，否则 load 会用旧磁盘内容盖掉启动期已做的改动。 */
	private loadPromise: Promise<void> | undefined;

	load(): Promise<void> {
		this.loadPromise ??= this.loadFromDisk();
		return this.loadPromise;
	}

	private async loadFromDisk(): Promise<void> {
		if (!this.filePath) return;
		try {
			this.state = normalizeLinkedSessionsState(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
		} catch {
			this.state = { version: STORE_VERSION, links: [], proposals: [] };
		}
		this.expireProposals(Date.now(), false);
	}

	private async whenLoaded(): Promise<void> {
		await this.loadPromise;
	}

	snapshot(): LinkedSessionsSnapshot {
		return {
			links: this.state.links.map((link) => ({ ...link })),
			proposals: this.state.proposals.map((proposal) => ({ ...proposal })),
		};
	}

	getLink(childSessionId: string): LinkedSessionLink | undefined {
		const link = this.state.links.find((candidate) => candidate.childSessionId === childSessionId);
		return link ? { ...link } : undefined;
	}

	childrenOf(parentSessionId: string, includeArchived = false): LinkedSessionLink[] {
		return this.state.links.filter((link) => link.parentSessionId === parentSessionId && (includeArchived || !link.archived)).map((link) => ({ ...link }));
	}

	/** 两个会话是否直接关联（父子任一方向）：send_to_session 只允许这种对端。 */
	areLinked(a: string, b: string): boolean {
		return this.state.links.some((link) => (link.parentSessionId === a && link.childSessionId === b) || (link.parentSessionId === b && link.childSessionId === a));
	}

	getProposal(id: string): LinkedSessionProposal | undefined {
		const proposal = this.state.proposals.find((candidate) => candidate.id === id);
		return proposal ? { ...proposal } : undefined;
	}

	async addLink(input: { childSessionId: string; parentSessionId: string; projectId: string; title: string; now?: number }): Promise<LinkedSessionLink> {
		await this.whenLoaded();
		const link: LinkedSessionLink = {
			childSessionId: input.childSessionId,
			parentSessionId: input.parentSessionId,
			projectId: input.projectId,
			title: input.title.trim().slice(0, LINKED_SESSION_TITLE_MAX_CHARS),
			createdAt: input.now ?? Date.now(),
			state: "starting",
			turnCount: 0,
			archived: false,
		};
		await this.mutate(() => {
			this.state.links = this.state.links.filter((existing) => existing.childSessionId !== link.childSessionId);
			this.state.links.push(link);
			if (this.state.links.length > MAX_LINKS) {
				const dropIndex = this.state.links.findIndex((existing) => existing.archived);
				this.state.links.splice(dropIndex >= 0 ? dropIndex : 0, 1);
			}
		});
		return { ...link };
	}

	/** 状态没变时不写盘不广播（运行时事件很密）。返回是否变了。 */
	async setState(childSessionId: string, state: LinkedSessionState): Promise<boolean> {
		await this.whenLoaded();
		const link = this.state.links.find((candidate) => candidate.childSessionId === childSessionId);
		if (!link || link.state === state) return false;
		await this.mutate(() => {
			link.state = state;
		});
		return true;
	}

	async recordTurnEnd(childSessionId: string, input: { report: string; failed: boolean; now?: number }): Promise<LinkedSessionLink | undefined> {
		await this.whenLoaded();
		const link = this.state.links.find((candidate) => candidate.childSessionId === childSessionId);
		if (!link) return undefined;
		await this.mutate(() => {
			link.turnCount += 1;
			link.state = input.failed ? "failed" : "idle";
			const report = clipReport(input.report);
			if (report) {
				link.lastReport = report;
				link.lastReportAt = input.now ?? Date.now();
			}
		});
		return { ...link };
	}

	async setArchived(childSessionId: string, archived: boolean): Promise<boolean> {
		await this.whenLoaded();
		const link = this.state.links.find((candidate) => candidate.childSessionId === childSessionId);
		if (!link || link.archived === archived) return false;
		// 归档 / 解档是用户对这组会话的一次手动操作：父会话的自动续跑额度重新计。
		this.autoContinueCount.delete(link.parentSessionId);
		await this.mutate(() => {
			link.archived = archived;
		});
		return true;
	}

	/**
	 * 会话行从 catalog 消失（删除 / 归档 / 删项目 / 外部删除清理）：
	 * 它作子会话的关系、作父会话的关系、它作父会话挂着的提议一并清掉；其余会话本身不动，回到普通会话。
	 * 归档后恢复出来的是新 id 的普通会话，旧关系留着只会变孤儿，所以归档同样清除。
	 * 返回被清掉的关系（调用方据此清理内存里的回合跟踪）。
	 */
	async forgetSessions(sessionIds: readonly string[]): Promise<LinkedSessionLink[]> {
		await this.whenLoaded();
		const gone = new Set(sessionIds);
		if (gone.size === 0) return [];
		const removed = this.state.links.filter((link) => gone.has(link.childSessionId) || gone.has(link.parentSessionId));
		const proposalGone = this.state.proposals.some((proposal) => gone.has(proposal.parentSessionId));
		for (const id of gone) this.autoContinueCount.delete(id);
		for (const link of removed) this.autoContinueCount.delete(link.parentSessionId);
		if (removed.length === 0 && !proposalGone) return [];
		await this.mutate(() => {
			this.state.links = this.state.links.filter((link) => !gone.has(link.childSessionId) && !gone.has(link.parentSessionId));
			this.state.proposals = this.state.proposals.filter((proposal) => !gone.has(proposal.parentSessionId));
		});
		return removed.map((link) => ({ ...link }));
	}

	async forgetSession(sessionId: string): Promise<boolean> {
		return (await this.forgetSessions([sessionId])).length > 0;
	}

	async addProposal(input: Omit<LinkedSessionProposal, "id" | "status" | "createdAt"> & { now?: number }): Promise<LinkedSessionProposal> {
		await this.whenLoaded();
		const proposal: LinkedSessionProposal = {
			id: randomUUID(),
			parentSessionId: input.parentSessionId,
			projectId: input.projectId,
			title: input.title.trim().slice(0, LINKED_SESSION_TITLE_MAX_CHARS),
			prompt: input.prompt.trim().slice(0, LINKED_SESSION_PROMPT_MAX_CHARS),
			initiation: input.initiation,
			...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
			status: "pending",
			createdAt: input.now ?? Date.now(),
		};
		await this.mutate(() => {
			this.state.proposals.push(proposal);
			if (this.state.proposals.length > MAX_PROPOSALS) {
				const dropIndex = this.state.proposals.findIndex((existing) => existing.status !== "pending");
				this.state.proposals.splice(dropIndex >= 0 ? dropIndex : 0, 1);
			}
		});
		return { ...proposal };
	}

	/**
	 * 结算一个提议。只有 pending 能被结算（重复点击、过期后再点都返回 false）——
	 * 这是「一张卡片只能开一个会话」的唯一闸门，调用方据返回值决定要不要真的建会话。
	 */
	async settleProposal(id: string, status: Exclude<LinkedSessionProposalStatus, "pending">, childSessionId?: string): Promise<boolean> {
		await this.whenLoaded();
		const proposal = this.state.proposals.find((candidate) => candidate.id === id);
		if (!proposal || proposal.status !== "pending") return false;
		await this.mutate(() => {
			proposal.status = status;
			if (childSessionId) proposal.childSessionId = childSessionId;
		});
		return true;
	}

	/** 把已 started 的提议补上子会话 id（先占位结算再建会话，建好后回填）。 */
	async attachProposalChild(id: string, childSessionId: string): Promise<void> {
		await this.whenLoaded();
		const proposal = this.state.proposals.find((candidate) => candidate.id === id);
		if (!proposal) return;
		await this.mutate(() => {
			proposal.childSessionId = childSessionId;
		});
	}

	/**
	 * 「先占位结算再建会话」的建会话那步失败时撤销占位：own_initiative 卡片回到 pending 让用户能再点；
	 * offer 的等待者已经收到错误，卡片按过期收口。只处理 started 且还没挂上子会话的提议。
	 */
	async revertStartedProposal(id: string): Promise<void> {
		await this.whenLoaded();
		const proposal = this.state.proposals.find((candidate) => candidate.id === id);
		if (!proposal || proposal.status !== "started") return;
		await this.mutate(() => {
			proposal.status = proposal.initiation === "own_initiative" ? "pending" : "expired";
			delete proposal.childSessionId;
		});
	}

	/** own_initiative 提议过期；返回过期条数。 */
	expireProposals(now: number, persist = true): number {
		let expired = 0;
		for (const proposal of this.state.proposals) {
			if (proposal.status === "pending" && proposal.initiation === "own_initiative" && now - proposal.createdAt > LINKED_SESSION_PROPOSAL_TTL_MS) {
				proposal.status = "expired";
				expired += 1;
			}
		}
		if (expired > 0 && persist) void this.mutate(() => undefined).catch(() => undefined);
		return expired;
	}

	/** 父会话能否被一条回报自动续跑；能则计数加一。 */
	tryConsumeAutoContinue(parentSessionId: string): boolean {
		const used = this.autoContinueCount.get(parentSessionId) ?? 0;
		if (used >= LINKED_SESSION_MAX_AUTO_CONTINUE) return false;
		this.autoContinueCount.set(parentSessionId, used + 1);
		return true;
	}

	/** 投递被父会话拒绝：额度没用上，退还。 */
	refundAutoContinue(parentSessionId: string): void {
		const used = this.autoContinueCount.get(parentSessionId) ?? 0;
		if (used <= 1) this.autoContinueCount.delete(parentSessionId);
		else this.autoContinueCount.set(parentSessionId, used - 1);
	}

	/** 父会话收到了非回报的输入（用户消息等）：自动续跑额度清零。 */
	resetAutoContinue(sessionId: string): void {
		this.autoContinueCount.delete(sessionId);
	}

	private async mutate(apply: () => void): Promise<void> {
		apply();
		let failure: { error: unknown } | undefined;
		if (this.filePath) {
			const task = this.saveQueue.then(() => this.persist());
			this.saveQueue = task.catch(() => undefined);
			try {
				await task;
			} catch (error) {
				failure = { error };
			}
		}
		// 内存已变：落盘失败也要通知侧栏刷新，再把失败交给调用方。
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// 监听者失败不影响落盘结果
			}
		}
		if (failure) throw failure.error;
	}

	private async persist(): Promise<void> {
		if (!this.filePath) return;
		const tmpPath = `${this.filePath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
		await rename(tmpPath, this.filePath);
	}
}
