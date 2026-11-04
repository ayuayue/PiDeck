import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import type { PiDesktopApi } from "../src/preload";
import type { RemoteAcceptanceCredentials } from "./remote-fixtures";
import { openProjectPanel, q, remote } from "./remote-sftp-helpers";

type Helper = { pid: number; rssKiB: number; threads: number; root: string };
type LocalProcess = { pid: number; name: string; rssBytes: number };
export type ResourceSample = { at: number; label: string; helpers: Helper[]; local: LocalProcess[] };
const execFileAsync = promisify(execFile);

async function helpers(credentials: RemoteAcceptanceCredentials, runRoot: string): Promise<Helper[]> {
	const output = await remote(credentials, "ps -eo pid=,rss=,nlwp=,args=", 15_000);
	return output.split("\n").flatMap((line) => {
		const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
		if (!fields) return [];
		const args = fields[4].split(/\s+/);
		if (args[0] !== "node" && !args[0].endsWith("/node")) return [];
		if (!args.some((arg) => arg.endsWith("/helper.mjs"))) return [];
		const flag = args.indexOf("--root");
		const root = flag < 0 ? "" : args[flag + 1];
		if (!root?.startsWith(runRoot + "/")) return [];
		return [{ pid: Number(fields[1]), rssKiB: Number(fields[2]), threads: Number(fields[3]), root }];
	});
}

async function localProcesses(electronPid: number): Promise<LocalProcess[]> {
	if (process.platform !== "win32") throw new Error("RESOURCE_SAMPLER_REQUIRES_WINDOWS");
	if (!Number.isSafeInteger(electronPid) || electronPid <= 0) throw new Error("ELECTRON_PID_MISSING");
	// Only numeric PID is interpolated. No command lines, keys or unrelated processes leave PowerShell.
	const script = `$items = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${electronPid}); do { $changed = $false; foreach ($item in $items) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } } } while ($changed); @($items | Where-Object { $ids.Contains([int]$_.ProcessId) -and $_.Name -match '^(ssh|electron)\\.exe$' } | ForEach-Object { @{ pid = [int]$_.ProcessId; name = $_.Name; rssBytes = [long]$_.WorkingSetSize } }) | ConvertTo-Json -Compress`;
	const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 });
	const parsed: LocalProcess | LocalProcess[] | null = stdout.trim() === "" ? null : JSON.parse(stdout);
	return parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
}

export function createResourceRecorder(credentials: RemoteAcceptanceCredentials, runRoot: string, electronPid: number) {
	const samples: ResourceSample[] = [];
	const errors: string[] = [];
	let stopped = false;
	const sample = async (label: string): Promise<ResourceSample> => {
		const [remoteHelpers, local] = await Promise.all([helpers(credentials, runRoot), localProcesses(electronPid)]);
		const value = { at: Date.now(), label, helpers: remoteHelpers, local };
		samples.push(value);
		return value;
	};
	const running = (async () => {
		while (!stopped) {
			await sample("periodic").catch(() => {
				errors.push("RESOURCE_SAMPLE_FAILED");
			});
			if (!stopped) await new Promise((resolve) => setTimeout(resolve, 2_000));
		}
	})();
	return {
		samples,
		errors,
		sample,
		async stop() {
			stopped = true;
			await running;
		},
		peaks() {
			return {
				helpers: Math.max(0, ...samples.map((s) => s.helpers.length)),
				helperRssKiB: Math.max(0, ...samples.map((s) => s.helpers.reduce((sum, p) => sum + p.rssKiB, 0))),
				ssh: Math.max(0, ...samples.map((s) => s.local.filter((p) => p.name.toLowerCase() === "ssh.exe").length)),
				sshRssBytes: Math.max(0, ...samples.map((s) => s.local.filter((p) => p.name.toLowerCase() === "ssh.exe").reduce((sum, p) => sum + p.rssBytes, 0))),
			};
		},
	};
}

export function assertHelperBudget(sample: ResourceSample, roots: string[]): void {
	expect(sample.helpers.map((p) => p.root).sort()).toEqual([...roots].sort());
	for (const helper of sample.helpers) {
		expect(helper.rssKiB).toBeLessThanOrEqual(80 * 1024);
		expect(helper.threads).toBeLessThanOrEqual(12);
	}
	// The aggregate follows the per-process ceiling. A tighter special case for three roots would
	// advertise an 80 MiB helper budget while rejecting three compliant helpers at 61 MiB each.
	const total = sample.helpers.reduce((sum, p) => sum + p.rssKiB, 0);
	expect(total).toBeLessThanOrEqual(roots.length * 80 * 1024);
	const ssh = sample.local.filter((p) => p.name.toLowerCase() === "ssh.exe");
	expect(ssh.length).toBeGreaterThanOrEqual(roots.length);
	expect(ssh.length).toBeLessThanOrEqual(roots.length + 1);
}

export async function waitHelpers(credentials: RemoteAcceptanceCredentials, runRoot: string, roots: string[]): Promise<Helper[]> {
	let current: Helper[] = [];
	await expect
		.poll(
			async () => {
				current = await helpers(credentials, runRoot);
				return current.map((p) => p.root).sort();
			},
			{ timeout: 30_000, intervals: [250, 500, 1_000] },
		)
		.toEqual([...roots].sort());
	return current;
}

export async function assertRootPage(window: Page, projectId: string, name: string): Promise<string> {
	const result = await window.evaluate(async (id) => {
		const api = (window as unknown as { piDesktop: PiDesktopApi }).piDesktop;
		return api.files.directoryPage({ projectId: id, relativePath: "" });
	}, projectId);
	expect(result.ok, "directory page must resolve in its own root").toBe(true);
	if (!result.ok) throw new Error(result.code);
	expect(result.value.dirWatch).toBeUndefined();
	expect(result.value.entries.some((entry) => entry.relativePath === "root-" + name + ".txt")).toBe(true);
	expect(result.value.entries.filter((entry) => /^root-[a-f]\.txt$/.test(entry.relativePath))).toHaveLength(1);
	return result.value.generation;
}

export async function runRootSoak(window: Page, credentials: RemoteAcceptanceCredentials, runRoot: string, projects: { id: string; name: string }[]) {
	const latencies: number[] = [];
	const generations = new Map<string, string>();
	for (const project of projects) {
		await openProjectPanel(window, project.id);
		generations.set(project.id, await assertRootPage(window, project.id, project.name));
	}
	const before = await waitHelpers(
		credentials,
		runRoot,
		projects.map((p) => runRoot + "/" + p.name),
	);
	await window.evaluate(
		(ids) => {
			const holder = window as unknown as { piDesktop: PiDesktopApi; __rootWatchEvents: Record<string, number>; __rootWatchStops: (() => void)[] };
			holder.__rootWatchEvents = {};
			holder.__rootWatchStops = ids.map((id) =>
				holder.piDesktop.remoteHosts.onProjectFactsChanged(id, (event) => {
					if (event.scopes.some((scope) => scope.kind === "dir")) holder.__rootWatchEvents[id] = (holder.__rootWatchEvents[id] ?? 0) + 1;
				}),
			);
		},
		projects.map((p) => p.id),
	);
	const started = Date.now();
	let cycles = 0;
	try {
		do {
			for (const project of projects) {
				latencies.push(await openProjectPanel(window, project.id, 5_000));
				await expect(
					window
						.locator(".file-node-name")
						.filter({ hasText: "root-" + project.name + ".txt" })
						.first(),
				).toBeVisible({ timeout: 5_000 });
				expect(await assertRootPage(window, project.id, project.name)).toBe(generations.get(project.id));
				await window.evaluate(() => {
					(window as unknown as { __rootWatchEvents: Record<string, number> }).__rootWatchEvents = {};
				});
				const marker = runRoot + "/" + project.name + "/watch-" + cycles + ".txt";
				await remote(credentials, "printf watched > " + q(marker));
				await expect.poll(() => window.evaluate((id) => (window as unknown as { __rootWatchEvents: Record<string, number> }).__rootWatchEvents[id] ?? 0, project.id), { timeout: 5_000 }).toBeGreaterThan(0);
				const visible = window.locator(".file-node-name").filter({ hasText: "watch-" + cycles + ".txt" });
				await expect(visible.first()).toBeVisible({ timeout: 5_000 });
			}
			cycles += 1;
		} while (Date.now() - started < 60_000 || cycles < 3);
	} finally {
		await window.evaluate(() => {
			for (const stop of (window as unknown as { __rootWatchStops: (() => void)[] }).__rootWatchStops) stop();
		});
	}
	const after = await waitHelpers(
		credentials,
		runRoot,
		projects.map((p) => runRoot + "/" + p.name),
	);
	expect(after.map((p) => p.pid).sort()).toEqual(before.map((p) => p.pid).sort());
	return { elapsedMs: Date.now() - started, cycles, switchMs: latencies, generations: Object.fromEntries(generations), helperPids: after.map((p) => p.pid) };
}

export async function disconnectHost(window: Page, hostId: string): Promise<void> {
	const result = await window.evaluate((id) => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.remoteHosts.disconnect(id), hostId);
	expect(result.ok).toBe(true);
}

export function readPoolLogs(profileDir: string): { time: number; message: string; detail: { stats: { peakEntries: number; entries: number; watched: number }; before?: unknown } }[] {
	const directory = join(profileDir, "logs");
	return readdirSync(directory)
		.filter((name) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(name))
		.flatMap((name) =>
			readFileSync(join(directory, name), "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		)
		.filter((event) => event.scope === "remote-root-pool");
}
