import type { PiDesktopApi } from "../../../../preload";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";

export type TerminalDockIo = {
	input: (data: string) => void;
	resize: (cols: number, rows: number) => void;
	dispose: () => void;
};

type IoOperation = "input" | "resize";

/** 每个 xterm 实例的 IO 边界：就地消化 IPC 拒绝，失效实例不再写入或弹错，不重试输入。 */
export function createTerminalDockIo(terminal: PiDesktopApi["terminal"], tabId: string, isCurrent: () => boolean): TerminalDockIo {
	let disposed = false;
	const failures = new Set<IoOperation>();

	async function run(operation: IoOperation, action: () => Promise<void>) {
		if (disposed || !isCurrent()) return;
		try {
			await action();
			if (!disposed && isCurrent()) failures.delete(operation);
		} catch (error) {
			if (disposed || !isCurrent() || failures.has(operation)) return;
			// 按键和拖动可连续触发大量 IPC：同一失败阶段各报一次，成功后才允许再次反馈。
			failures.add(operation);
			const key = operation === "input" ? "terminal.inputFailed" : "terminal.resizeFailed";
			showNotice(`${t(key)}: ${error instanceof Error ? error.message : String(error)}`, 4000, "error");
		}
	}

	return {
		input: (data) => {
			void run("input", () => terminal.input(tabId, data));
		},
		resize: (cols, rows) => {
			void run("resize", () => terminal.resize(tabId, cols, rows));
		},
		dispose() {
			disposed = true;
			failures.clear();
		},
	};
}
