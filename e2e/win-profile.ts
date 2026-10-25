/**
 * e2e 隔离 profile 的 Windows 兼容层。
 *
 * e2e 会把 `USERPROFILE`（以及 `APPDATA` / `HOME`）重定向到临时目录，避免污染开发者本机数据。
 * 但 Chromium 的 appData 路径 provider 在 win32 上走 shell 文件夹解析（`SHGetFolderPath`），
 * 它**不读 `APPDATA` 环境变量**，而是按重定向后的 `USERPROFILE` 去找
 * `<USERPROFILE>\AppData\Roaming`。该目录不存在时解析直接失败，`app.getPath("appData")`
 * 抛 "Failed to get 'appData' path"，主进程在模块加载期就崩掉 —— 表现为弹窗
 * "A JavaScript error occurred in the main process"，或 Playwright `firstWindow: Timeout`
 * （完全不像环境问题；实测 Electron 43.4.0）。
 *
 * **每一个启动 Electron 的 e2e 入口都要在 launch 前调用它**（当前三处：
 * `fixtures.ts`、`mock-pi-fixture.ts`；`history-restore.spec.ts` 只改 APPDATA、不需要，
 * 但调用了也无害）。只补目录骨架、不写任何业务数据，已存在时是幂等 no-op。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** 非 win32 平台直接 no-op（macOS/Linux 走 HOME / XDG_CONFIG_HOME，不受此影响）。 */
export function ensureWindowsProfileSkeleton(profileRoot: string): void {
	if (process.platform !== "win32") return;
	for (const relative of ["AppData\\Roaming", "AppData\\Local", "AppData\\LocalLow", "Desktop", "Documents"]) {
		mkdirSync(join(profileRoot, relative), { recursive: true });
	}
}
