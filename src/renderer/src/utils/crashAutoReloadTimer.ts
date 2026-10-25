/**
 * 崩溃自动刷新倒计时 timer 的生命周期管理（与 React 解耦，便于 node --test 单测）。
 *
 * 背景：React 19 StrictMode 下（dev 构建），error boundary 的 fallback 会经历
 * mount → unmount → remount 的伪生命周期（double-invoke）。若 interval 只在
 * componentDidCatch 里创建，它会在伪卸载时被 componentWillUnmount 清掉且无人
 * 重建——表现为「将在 5 秒后自动刷新…」文案渲染成功（state 已设置）但数字不
 * 递减、永不刷新。因此提供 ensure()：remount 后按组件状态兜底重建 timer，
 * 保证「有倒计时状态必有存活 timer」这一不变量。生产构建无 StrictMode 影响，
 * ensure() 不产生额外行为。
 */
export type AutoReloadTimerOptions = {
	/** 每个 tick 回调，参数为递减后的剩余秒数 */
	onTick: (remaining: number) => void;
	/** 倒计时归零回调（调用方负责刷新页面等动作） */
	onDone: () => void;
	/** tick 间隔毫秒，默认 1000；测试可传小值加速 */
	intervalMs?: number;
};

export class AutoReloadTimer {
	// 用 ReturnType 自适应宿主类型：浏览器（number）与 node（Timeout）签名不同
	private timerId: ReturnType<typeof globalThis.setInterval> | null = null;
	private readonly intervalMs: number;
	private readonly onTick: AutoReloadTimerOptions["onTick"];
	private readonly onDone: AutoReloadTimerOptions["onDone"];

	constructor(options: AutoReloadTimerOptions) {
		this.onTick = options.onTick;
		this.onDone = options.onDone;
		this.intervalMs = options.intervalMs ?? 1000;
	}

	get running(): boolean {
		return this.timerId != null;
	}

	/**
	 * 启动/重启倒计时。已在运行则先停再启（保证从传入秒数重新开始）。
	 * seconds <= 0 视为无效，直接不启动。
	 */
	start(seconds: number): void {
		this.stop();
		if (seconds <= 0) return;
		let remaining = seconds;
		this.timerId = globalThis.setInterval(() => {
			remaining -= 1;
			if (remaining <= 0) {
				this.stop();
				this.onDone();
				return;
			}
			this.onTick(remaining);
		}, this.intervalMs);
	}

	/** 停止并清理 timer；幂等，组件卸载/用户取消时调用。 */
	stop(): void {
		if (this.timerId != null) {
			globalThis.clearInterval(this.timerId);
			this.timerId = null;
		}
	}

	/**
	 * StrictMode remount 兜底：有倒计时状态（seconds > 0）但 timer 未运行时重建。
	 * 初次挂载（无错误）或用户已取消（seconds 为 null）时不会误启动。
	 */
	ensure(seconds: number | null): void {
		if (this.timerId == null && seconds != null && seconds > 0) {
			this.start(seconds);
		}
	}
}
