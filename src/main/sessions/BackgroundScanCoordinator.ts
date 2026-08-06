/**
 * 项目会话目录后台扫描协调器（2026-08 展开项目卡顿优化）。
 *
 * 背景：展开项目时 `sessionsCatalogList` 同步全量扫描该项目全部会话 JSONL
 * （数百文件遍历 + 摘要解析），侧栏每 3 秒轮询又反复触发，主进程持续承压、
 * 渲染层长时间等待。改造后 IPC 立即返回目录缓存，扫描转入后台：
 * 本协调器负责同项目并发触发的去重与冷却合并——
 *
 * - 扫描进行中再次触发：合并为一次 pending，扫描结束后补跑（不并发重扫）；
 * - 冷却期内触发：延迟到冷却结束再扫（避免 3 秒轮询导致连续扫描）；
 * - 占坑先于延迟：调度即标记 scanning，防止冷却等待期内被重复调度。
 */
export class BackgroundScanCoordinator {
	/** 正在扫描（含冷却等待期）的项目。 */
	private readonly scanningProjects = new Set<string>();
	/** 扫描进行中收到的新触发：扫描结束后补跑一次。 */
	private readonly pendingProjects = new Set<string>();
	/** 最近一次扫描完成时间（冷却计时起点）。 */
	private readonly lastScanAtByProject = new Map<string, number>();
	/** 冷却期内的延迟定时器（测试需要可观测/可清理）。 */
	private readonly delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly cooldownMs = 5000) {}

	/**
	 * 调度一次项目扫描。
	 * @returns true = 本次调度将执行扫描（含冷却延迟后执行）；
	 *          false = 已在扫描中，合并为 pending（扫描结束后由在跑的循环补跑）。
	 */
	schedule(projectId: string, task: () => Promise<void>): boolean {
		if (this.scanningProjects.has(projectId)) {
			this.pendingProjects.add(projectId);
			return false;
		}
		this.scanningProjects.add(projectId);
		const lastScanAt = this.lastScanAtByProject.get(projectId) ?? 0;
		const waitMs = Math.max(0, this.cooldownMs - (Date.now() - lastScanAt));
		const timer = setTimeout(() => {
			this.delayTimers.delete(projectId);
			void this.run(projectId, task);
		}, waitMs);
		// 定时器不应阻止进程退出
		(timer as { unref?: () => void }).unref?.();
		this.delayTimers.set(projectId, timer);
		return true;
	}

	private async run(projectId: string, task: () => Promise<void>): Promise<void> {
		try {
			await task();
		} finally {
			this.lastScanAtByProject.set(projectId, Date.now());
			this.scanningProjects.delete(projectId);
			// 扫描期间积累的新触发补跑一次（新一轮仍受冷却约束）
			if (this.pendingProjects.delete(projectId)) {
				this.schedule(projectId, task);
			}
		}
	}

	/** 测试与退出清理：取消冷却期内的延迟定时器（扫描中的任务不可取消）。 */
	dispose(): void {
		for (const timer of this.delayTimers.values()) clearTimeout(timer);
		this.delayTimers.clear();
		this.pendingProjects.clear();
	}
}
