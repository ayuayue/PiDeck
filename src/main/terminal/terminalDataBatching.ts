/**
 * PTY 输出合批器（纯函数工厂，可单测）。
 *
 * 背景：node-pty 在高吞吐场景（cat 大文件 / 编译输出 / 逐字符动画）下逐 chunk 回调，
 * 若每个 chunk 都直接 emit 一次 IPC，主进程与渲染层会双双被调用频率打满——渲染层
 * 每个事件还要走一次 xterm.write（每次调用有固定解析开销）。
 *
 * 策略：16ms（一帧）窗口内的小 chunk 合并成一次 emit；打字回显延迟人眼不可感知，
 * 而 xterm 拿到大块数据批量解析反而更快。
 *
 * 硬约束（接线方必须遵守，tests/terminalDataBatching.test.mjs 有源码扫描守卫）：
 * - exit / close 路径必须先 flush() 再发 terminalExit / 删除 runtime，保证
 *   「数据事件全部到达 → 退出事件」的顺序，否则渲染层回放会丢尾巴。
 * - 关闭 tab 时先 flush() 再 dispose()，dispose 丢弃未发数据并停表，防止
 *   已删 runtime 的迟到 emit。
 */

export type TerminalDataBatcher = {
	/** 追加一段输出；超过 maxChars 时立即刷出，不等窗口 */
	push: (data: string) => void;
	/** 立即发出挂起的数据（幂等：无挂起时为 no-op） */
	flush: () => void;
	/** 停表并丢弃挂起数据（tab 关闭路径用） */
	dispose: () => void;
};

export const TERMINAL_BATCH_MS = 16;
/** 单个 IPC 载荷的字符上界：高速产出（如 `yes`）不让单帧批无限膨胀 */
export const TERMINAL_BATCH_MAX_CHARS = 64_000;

export function createTerminalDataBatcher(emit: (data: string) => void, options?: { batchMs?: number; maxChars?: number }): TerminalDataBatcher {
	const batchMs = options?.batchMs ?? TERMINAL_BATCH_MS;
	const maxChars = options?.maxChars ?? TERMINAL_BATCH_MAX_CHARS;
	let pending = "";
	let timer: NodeJS.Timeout | null = null;

	function flush() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!pending) return;
		const data = pending;
		pending = "";
		emit(data);
	}

	function push(data: string) {
		if (!data) return;
		pending += data;
		if (pending.length >= maxChars) {
			flush();
			return;
		}
		if (!timer) timer = setTimeout(flush, batchMs);
	}

	function dispose() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		pending = "";
	}

	return { push, flush, dispose };
}
