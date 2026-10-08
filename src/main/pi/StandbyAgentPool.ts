/**
 * standby agent 池：单实例、按项目一个、TTL 回收。
 *
 * 拥有一个「已握手完成、尚未绑定会话」的 pi 进程（AgentTab.standby=true 时
 * AgentManager 不把它放进 agents 可见集合，UI/事件不可见）。claim 时由
 * AgentManager 校验指纹并把 tab 转正；本类只负责生命周期（创建回调、TTL、
 * 丢弃），不关心进程细节。
 */
export interface StandbyEntry {
	projectId: string;
	fingerprint: string;
	agentId: string;
	createdAt: number;
	timer: ReturnType<typeof setTimeout>;
}

export interface StandbyPoolOptions {
	ttlMs: number;
	/** 到期的最终清理（stop agent），由 AgentManager 注入。 */
	onExpire: (agentId: string) => void;
	now?: () => number;
}

export const STANDBY_TTL_MS = 10 * 60 * 1000;

export class StandbyAgentPool {
	private entry: StandbyEntry | null = null;
	private readonly ttlMs: number;
	private readonly onExpire: (agentId: string) => void;
	private readonly now: () => number;

	constructor(options: StandbyPoolOptions) {
		this.ttlMs = options.ttlMs;
		this.onExpire = options.onExpire;
		this.now = options.now ?? Date.now;
	}

	/** 登记新 standby；已有条目先丢弃并交给 onExpire 停掉旧进程（同项目换指纹或跨项目都只留最新一个）。 */
	put(entry: { projectId: string; fingerprint: string; agentId: string }): void {
		const discarded = this.clear();
		// 被顶掉的旧 standby 不能留在 agents map 里渗漏（UI 不可见且无 TTL），统一走到期同一路径停掉。
		if (discarded) this.onExpire(discarded);
		const timer = setTimeout(() => {
			const expired = this.entry;
			this.entry = null;
			if (expired) this.onExpire(expired.agentId);
		}, this.ttlMs);
		if (typeof timer.unref === "function") timer.unref();
		this.entry = { ...entry, createdAt: this.now(), timer };
	}

	/** 命中则取出（并清 TTL）；项目/指纹不符 = spawn 参数已固化永远服务不了本次认领，
	 * 立即丢弃回收（否则池子被旧参数条目占死到 TTL，ensure 又因其存在不补新）。 */
	take(projectId: string, fingerprint: string): StandbyEntry | null {
		const current = this.entry;
		if (!current) return null;
		if (current.projectId !== projectId || current.fingerprint !== fingerprint) {
			this.clear();
			this.onExpire(current.agentId);
			return null;
		}
		clearTimeout(current.timer);
		this.entry = null;
		return current;
	}

	/** 只读查看当前条目（不消费、不动 TTL）；项目不符或池空返回 null。供草稿命令预览等只读用途。 */
	peek(projectId: string): { agentId: string; fingerprint: string } | null {
		if (!this.entry || this.entry.projectId !== projectId) return null;
		return { agentId: this.entry.agentId, fingerprint: this.entry.fingerprint };
	}

	/** 当前条目信息（状态查询用），不暴露 timer。 */
	status(): { projectId: string; agentId: string; idleMs: number } | null {
		if (!this.entry) return null;
		return { projectId: this.entry.projectId, agentId: this.entry.agentId, idleMs: this.now() - this.entry.createdAt };
	}

	/** 丢弃当前条目（指纹失效/设置变更/退出时），返回被丢弃的 agentId。 */
	clear(): string | null {
		const current = this.entry;
		if (!current) return null;
		clearTimeout(current.timer);
		this.entry = null;
		return current.agentId;
	}

	/** 只释放定时器不触发 onExpire（进程回收由调用方自行处理，如 stopAll 的统一循环）。 */
	dispose(): void {
		this.clear();
	}

	has(projectId?: string): boolean {
		if (!this.entry) return false;
		return projectId ? this.entry.projectId === projectId : true;
	}
}
