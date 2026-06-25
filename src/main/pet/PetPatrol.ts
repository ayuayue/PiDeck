import { screen, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";

/**
 * PetPatrol —— 桌面巡游引擎。
 *
 * 策略：启动后先 idle 停顿（时长同设置），判断左右哪边路程远就朝那边走；
 * 碰边后 idle 停顿 → 反向再走 → 往复。大部分时间在 idle 静止。
 */

export class PetPatrol {
	private tickTimer: NodeJS.Timeout | null = null;
	private pauseTimer: NodeJS.Timeout | null = null;
	private direction: "left" | "right" = "right";
	private readonly speedPxPerSec = 40;
	private readonly tickMs = 50;
	private readonly edgeMargin = 16;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
		/** 返回巡游停顿分钟数（如 5 = 5 分钟），由设置面板控制 */
		private readonly getPauseMin: () => number = () => 5,
	) {}

	get active(): boolean {
		return this.tickTimer !== null || this.pauseTimer !== null;
	}

	/** 开启巡游：先 idle 停顿（与碰边后等长），然后朝路程远的方向走。幂等。 */
	start() {
		if (this.active) return;
		// 不立即走——先在原地 idle，给宠物亮相时间
		this.pushIdle();
		this.scheduleWalk();
	}

	stop() {
		if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
		if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
	}

	// ── 步行 ──

	private beginWalk() {
		if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
		this.pushMode();
		this.tickTimer = setInterval(() => this.tick(), this.tickMs);
	}

	private tick() {
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) { this.stop(); return; }
		const [x, y] = win.getPosition();
		const [w, h] = win.getSize();
		const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
		const step = (this.speedPxPerSec * this.tickMs) / 1000;
		let nx = this.direction === "right" ? x + step : x - step;

		// 碰边 → 立即结束步行，进入长 idle 停顿
		if (nx >= wa.x + wa.width - w - this.edgeMargin) {
			nx = wa.x + wa.width - w - this.edgeMargin;
			win.setPosition(Math.round(nx), y);
			this.stopWalkAndPause();
			return;
		}
		if (nx <= wa.x + this.edgeMargin) {
			nx = wa.x + this.edgeMargin;
			win.setPosition(Math.round(nx), y);
			this.stopWalkAndPause();
			return;
		}
		win.setPosition(Math.round(nx), y);
	}

	// ── 停顿 ──

	/** 碰边后：推 idle，按设置停顿时长等待，然后朝路程远的方向走 */
	private stopWalkAndPause() {
		if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
		if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
		this.pushIdle();
		this.scheduleWalk();
	}

	/** 按设置停顿时长等候，到时从当前位置算远端方向再走。
	 *  无论第几次，都实时判断哪边路程远，不依赖旧方向或翻转——
	 *  这样即使用户拖拽了宠物，巡游也会自动适应新位置。 */
	private scheduleWalk() {
		if (this.pauseTimer) { clearTimeout(this.pauseTimer); }
		const baseMin = Math.max(1, this.getPauseMin());
		const jitter = 0.8 + Math.random() * 0.4;
		const pauseMs = baseMin * 60 * 1000 * jitter;
		this.pauseTimer = setTimeout(() => {
			this.pauseTimer = null;
			this.pickFartherDirection();
			this.beginWalk();
		}, pauseMs);
	}

	/** 从当前位置算到左右屏边的距离，选路程远的走 */
	private pickFartherDirection() {
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		const [x, y] = win.getPosition();
		const [w, h] = win.getSize();
		const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
		const distLeft = x - wa.x;
		const distRight = wa.x + wa.width - w - x;
		this.direction = distRight >= distLeft ? "right" : "left";
	}

	// ── IPC ──

	private pushMode() {
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.petState, {
			mode: this.direction === "right" ? "running-right" : "running-left",
			runningCount: 0,
			errorCount: 0,
			activeAgentId: null,
			timestamp: Date.now(),
		});
	}

	private pushIdle() {
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		win.webContents.send(ipcChannels.petState, {
			mode: "idle",
			runningCount: 0,
			errorCount: 0,
			activeAgentId: null,
			timestamp: Date.now(),
		});
	}
}
