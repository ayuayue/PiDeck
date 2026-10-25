import { screen, type BrowserWindow, type Rectangle } from "electron";
import { ipcChannels } from "../../shared/ipc";

/**
 * PetPatrol —— idle 时沿屏幕底部巡游。
 * 停顿 N 分钟后朝路程远的方向走，碰边反向，往复。
 *
 * 设计要点（防瞬移）：
 * 1. 每个 tick 都用时间增量计算步长，而非固定 step；并对 delta 做上限钳制，
 *    避免系统抖动（睡眠唤醒 / App Nap / CPU 峰值）累积出超大单步位移。
 * 2. 每次 setPosition 之前都对目标 x 做硬钳制，绝不输出越界坐标——
 *    这样即便外部（系统/拖拽残留）把窗口挪到边界外，巡游也只会让它贴边走回，不会瞬移到对侧。
 * 3. 检测「异常跳变」：若两次 tick 之间窗口位移远超本 tick 应有步长，
 *    说明被系统/用户搬动了，立即以当前位置重算 workArea 并结束本次巡游。
 */

export class PetPatrol {
	private tickTimer: NodeJS.Timeout | null = null;
	private pauseTimer: NodeJS.Timeout | null = null;
	private direction: "left" | "right" = "right";
	private readonly speed = 40; // px/s
	private readonly tickMs = 50;
	private readonly edgeMargin = 16;
	/** 巡游中锁定的工作区，避免行进途中显示器坐标系抖动 */
	private walkWorkArea: Rectangle | null = null;
	/** 上一次 tick 记录的 x，用于检测外部造成的异常跳变 */
	private lastTickX: number | null = null;
	/** 上一次 tick 的时间戳，用于按真实增量计算步长 */
	private lastTickAt = 0;
	/** 拖拽中：阻塞 start/tick，避免巡游与手动移动争抢窗口位置造成瞬移 */
	private dragging = false;
	/** 业务空闲检查（由 PetStateBridge 注入）：业务非 idle（任务运行/出错/待输入）时巡游必须让位 */
	private businessIdleCheck: (() => boolean) | null = null;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
		private readonly getPauseMin: () => number = () => 5,
		private readonly movePetWindow?: (x: number, y: number) => void,
	) {}

	/** 注入业务空闲检查（PetSystem 装配时接 bridge.businessMode）；null 表示不检查（测试/缺省） */
	setBusinessIdleCheck(fn: (() => boolean) | null) {
		this.businessIdleCheck = fn;
	}

	private isBusinessIdle(): boolean {
		return this.businessIdleCheck ? this.businessIdleCheck() : true;
	}

	get active(): boolean {
		return this.tickTimer !== null || this.pauseTimer !== null;
	}

	start() {
		// 拖拽中绝不（重新）起巡游。拖拽开始时 bridge.update() 仍会异步触发 maybeStartPatrol，
		// 没有这个守卫，start() 会重新 scheduleWalk→beginWalk→tick，与拖拽 moveWindow 争抢窗口位置
		// → 出现「继续跑 + 闪到边界 + 闪回鼠标」的双重瞬移。
		if (this.dragging) return;
		if (this.active) return;
		// 业务非 idle 不起巡游：状态由桥接层接管
		if (!this.isBusinessIdle()) return;
		this.pushState("idle");
		this.scheduleWalk();
	}

	stop() {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		if (this.pauseTimer) {
			clearTimeout(this.pauseTimer);
			this.pauseTimer = null;
		}
		this.walkWorkArea = null;
		this.lastTickX = null;
	}

	/** 拖拽起止：开始时立刻停巡游并置位标志，结束时清位（由 bridge 决定是否恢复巡游） */
	setDragging(dragging: boolean) {
		this.dragging = dragging;
		if (dragging) this.stop();
	}

	private beginWalk() {
		if (this.pauseTimer) {
			clearTimeout(this.pauseTimer);
			this.pauseTimer = null;
		}
		// 业务非 idle（任务运行/出错/待输入）时不起步：散步帧不得抢占动画通道
		if (!this.isBusinessIdle()) {
			this.stop();
			return;
		}
		const wa = this.resolveWorkArea();
		if (!wa) return; // 无法确定坐标系则不开始，避免用错边界位移
		this.walkWorkArea = wa;
		this.lastTickX = null;
		this.lastTickAt = Date.now();
		this.pushState(this.direction === "right" ? "running-right" : "running-left");
		this.tickTimer = setInterval(() => this.tick(), this.tickMs);
	}

	/** 抵达边界：停止步行，进入 idle 停顿并安排下一次巡游 */
	private endWalk() {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.walkWorkArea = null;
		this.lastTickX = null;
		this.pushState("idle");
		this.scheduleWalk();
	}

	/** 异常跳变/外部搬动（含拖拽）：直接停下并归位 idle，不重新排程。
	 *  用 halt 而非 endWalk：endWalk 会 scheduleWalk 重新起巡游，
	 *  在拖拽场景下会与手动移动争抢窗口位置 → 边界闪现。*/
	private halt() {
		this.stop();
		this.pushState("idle");
	}

	/** 读取窗口所在显示器的 workArea；窗口不存在或检测失败返回 null */
	private resolveWorkArea(): Rectangle | null {
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return null;
		const [x, y] = win.getPosition();
		const [w, h] = win.getSize();
		return screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
	}

	/** 把目标 x 硬钳制到 [leftEdge, rightEdge]，保证任何来源的坐标都不会越界 */
	private clampX(x: number, wa: Rectangle): number {
		const [w] = this.getPetWindow()?.getSize() ?? [0];
		const leftEdge = wa.x + this.edgeMargin;
		const rightEdge = wa.x + wa.width - w - this.edgeMargin;
		if (rightEdge < leftEdge) return Math.round((leftEdge + rightEdge) / 2); // 屏幕过窄，居中
		return Math.round(Math.min(rightEdge, Math.max(leftEdge, x)));
	}

	private tick() {
		// 双保险：即便因时序问题 tick 仍被触发，拖拽中也绝不移动窗口
		if (this.dragging) {
			this.stop();
			return;
		}
		// 业务态检查：过渡期间（failed/review）或任务恢复运行时，散步帧立即让位
		if (!this.isBusinessIdle()) {
			this.stop();
			return;
		}
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) {
			this.stop();
			return;
		}
		const wa = this.walkWorkArea;
		if (!wa) {
			this.endWalk();
			return;
		}

		const now = Date.now();
		const [x, y] = win.getPosition();
		// 按真实时间增量算步长；delta 异常大（睡眠唤醒等）时钳制到单步上限，防止一帧飞出去
		let delta = now - this.lastTickAt;
		this.lastTickAt = now;
		if (delta > 500 || delta < 0) delta = this.tickMs;
		const step = (this.speed * delta) / 1000;

		// 检测异常跳变：本 tick 之间窗口位置的变化远超我们应输出的步长，
		// 说明被系统（Space 切换、显示器热插拔）或拖拽残留搬动过。
		// 立刻重锚坐标系并结束巡游，避免在新位置上继续按旧方向走出诡异的位移。
		if (this.lastTickX !== null) {
			const drift = Math.abs(x - (this.lastTickX + (this.direction === "right" ? step : -step)));
			if (drift > step * 3 + 8) {
				// 外部搬动（拖拽/Space 切换/显示器热插拔）：归位 idle 不再排程，
				// 避免在新位置上继续按旧方向走出诡位移、或重新起巡游造成闪现。
				this.halt();
				return;
			}
		}
		this.lastTickX = x;

		if (this.direction === "right") {
			const rightEdge = wa.x + wa.width - win.getSize()[0] - this.edgeMargin;
			const nx = this.clampX(x + step, wa);
			this.movePetWindow?.(nx, y) ?? win.setPosition(nx, y);
			if (x + step >= rightEdge) {
				this.endWalk();
				return;
			}
		} else {
			const leftEdge = wa.x + this.edgeMargin;
			const nx = this.clampX(x - step, wa);
			this.movePetWindow?.(nx, y) ?? win.setPosition(nx, y);
			if (x - step <= leftEdge) {
				this.endWalk();
				return;
			}
		}
	}

	private scheduleWalk() {
		if (this.pauseTimer) clearTimeout(this.pauseTimer);
		const pauseMs = Math.max(1, this.getPauseMin()) * 60_000 * (0.8 + Math.random() * 0.4);
		this.pauseTimer = setTimeout(() => {
			this.pauseTimer = null;
			this.pickDirection();
			this.beginWalk();
		}, pauseMs);
	}

	/** 从当前位置选路程远的方向 */
	private pickDirection() {
		const wa = this.resolveWorkArea();
		if (!wa) return;
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		const [x] = win.getPosition();
		const [w] = win.getSize();
		this.direction = wa.x + wa.width - w - x >= x - wa.x ? "right" : "left";
	}

	private pushState(mode: string) {
		const win = this.getPetWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(ipcChannels.petState, { mode, runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
		}
	}
}
