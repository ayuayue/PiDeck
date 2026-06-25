import { screen, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";

/**
 * PetPatrol —— idle 时沿屏幕底部巡游。
 * 停顿 N 分钟后朝路程远的方向走，碰边反向，往复。
 */

export class PetPatrol {
	private tickTimer: NodeJS.Timeout | null = null;
	private pauseTimer: NodeJS.Timeout | null = null;
	private direction: "left" | "right" = "right";
	private readonly speed = 40;     // px/s
	private readonly tickMs = 50;
	private readonly edgeMargin = 16;

	constructor(
		private readonly getPetWindow: () => BrowserWindow | null,
		private readonly getPauseMin: () => number = () => 5,
	) {}

	get active(): boolean { return this.tickTimer !== null || this.pauseTimer !== null; }

	start() {
		if (this.active) return;
		this.pushState("idle");
		this.scheduleWalk();
	}

	stop() {
		if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
		if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
	}

	private beginWalk() {
		if (this.pauseTimer) { clearTimeout(this.pauseTimer); this.pauseTimer = null; }
		this.pushState(this.direction === "right" ? "running-right" : "running-left");
		this.tickTimer = setInterval(() => this.tick(), this.tickMs);
	}

	private tick() {
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) { this.stop(); return; }
		const [x, y] = win.getPosition();
		const [w, h] = win.getSize();
		const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
		const step = (this.speed * this.tickMs) / 1000;
		let nx = this.direction === "right" ? x + step : x - step;

		if (nx >= wa.x + wa.width - w - this.edgeMargin || nx <= wa.x + this.edgeMargin) {
			// 碰边 → 停止步行，进入 idle 停顿
			win.setPosition(Math.round(this.direction === "right" ? wa.x + wa.width - w - this.edgeMargin : wa.x + this.edgeMargin), y);
			if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
			this.pushState("idle");
			this.scheduleWalk();
			return;
		}
		win.setPosition(Math.round(nx), y);
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
		const win = this.getPetWindow();
		if (!win || win.isDestroyed()) return;
		const [x, y] = win.getPosition();
		const [w, h] = win.getSize();
		const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
		this.direction = wa.x + wa.width - w - x >= x - wa.x ? "right" : "left";
	}

	private pushState(mode: string) {
		const win = this.getPetWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(ipcChannels.petState, { mode, runningCount: 0, errorCount: 0, activeAgentId: null, timestamp: Date.now() });
		}
	}
}
