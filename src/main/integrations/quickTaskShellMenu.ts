import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const options = { windowsHide: true } as const;
const base = "HKCU\\Software\\Classes";
export const QUICK_TASK_MENU_KEYS = [`${base}\\Directory\\shell\\PiDeckQuickTask`, `${base}\\Directory\\Background\\shell\\PiDeckQuickTask`, `${base}\\DesktopBackground\\Shell\\PiDeckQuickTask`];

/** Explorer substitutes folder placeholders; desktop uses Electron's redirected known-folder path. */
export function quickTaskMenuEntries(exe: string, appPath: string, title: string): { key: string; title: string; icon: string; command: string }[] {
	if (!exe || /["\r\n\u0000]/u.test(exe + appPath)) throw new Error("QUICK_TASK_INVALID_EXECUTABLE");
	const prefix = `"${exe}"${appPath ? ` "${appPath}"` : ""}`;
	// End quoted directory arguments with a dot: a drive root's trailing backslash would
	// otherwise escape the closing quote in Windows argv parsing. Main normalizes the dot away.
	return QUICK_TASK_MENU_KEYS.map((key, index) => ({ key, title, icon: exe, command: `${prefix} ${index === 2 ? "--quick-task-desktop" : `--quick-task "${index === 0 ? "%1" : "%V"}\\."`}` }));
}

/** Independent opt-in verbs leave the existing Open with PiDeck registration untouched. */
export async function registerQuickTaskShellMenu(exe: string, appPath: string, title: string): Promise<void> {
	for (const entry of quickTaskMenuEntries(exe, appPath, title)) {
		await run("reg", ["add", entry.key, "/ve", "/d", entry.title, "/f"], options);
		await run("reg", ["add", entry.key, "/v", "Icon", "/d", entry.icon, "/f"], options);
		await run("reg", ["add", `${entry.key}\\command`, "/ve", "/d", entry.command, "/f"], options);
	}
}

export async function quickTaskShellMenuRegistered(): Promise<boolean> {
	for (const key of QUICK_TASK_MENU_KEYS) {
		try {
			await run("reg", ["query", `${key}\\command`, "/ve"], options);
		} catch {
			return false;
		}
	}
	return true;
}

/** Idempotently remove this feature's keys; existing Open with PiDeck verbs are untouched. */
export async function unregisterQuickTaskShellMenu(): Promise<void> {
	for (const key of QUICK_TASK_MENU_KEYS) {
		try {
			await run("reg", ["query", key], options);
		} catch {
			continue;
		}
		await run("reg", ["delete", key, "/f"], options);
	}
}
