import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { resolveAppUpdateDeliveryPlan, type AppUpdateDeliveryPlan } from "./deliveryPlan";

const execFileAsync = promisify(execFile);
// Squirrel.Mac verifies the update against the running app's signing identity.
const DEVELOPER_ID_REQUIREMENT = "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
type RunCodesign = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Bound startup probing; missing codesign or verification failures retain manual delivery. */
async function runSystemCodesign(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return execFileAsync("/usr/bin/codesign", args, { timeout: 5_000, maxBuffer: 256 * 1024 });
}

/** Inspect the installed bundle, never infer signing from version, platform or build flags. */
async function hasDeveloperId(execPath: string, runCodesign: RunCodesign): Promise<boolean> {
	const macOsDir = dirname(execPath);
	const contentsDir = dirname(macOsDir);
	const bundle = dirname(contentsDir);
	if (basename(macOsDir) !== "MacOS" || basename(contentsDir) !== "Contents" || !bundle.endsWith(".app")) return false;
	try {
		const display = await runCodesign(["-d", "-r-", "--verbose=4", bundle]);
		const text = `${display.stdout}\n${display.stderr}`;
		const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(text)?.[1];
		const requirement = /^(?:#\s*)?designated\s*=>\s*(.+)$/m.exec(text)?.[1] ?? "";
		const requiredTeam = /certificate\s+leaf\s*\[\s*subject\.OU\s*\]\s*=\s*"?([A-Z0-9]{10})"?/.exec(requirement)?.[1];
		if (!team || team !== requiredTeam || !/\banchor\s+apple\s+generic\b/.test(requirement) || /\b(?:cdhash|or|not)\b/.test(requirement)) return false;
		// Display names are not proof of trust: ask codesign to validate the Apple chain.
		await runCodesign(["--verify", "--strict", `-R=${DEVELOPER_ID_REQUIREMENT} and certificate leaf[subject.OU] = "${team}"`, bundle]);
		return true;
	} catch {
		return false;
	}
}

/** Compose runtime signing evidence with the existing cross-platform delivery policy. */
export async function resolveInstalledAppUpdateDeliveryPlan(input: { platform: NodeJS.Platform; arch: string; isAppImage?: boolean; isPackaged: boolean; execPath: string }, deps: { runCodesign?: RunCodesign } = {}): Promise<AppUpdateDeliveryPlan> {
	const macHasDeveloperId = input.platform === "darwin" && input.isPackaged && (await hasDeveloperId(input.execPath, deps.runCodesign ?? runSystemCodesign));
	return resolveAppUpdateDeliveryPlan({ ...input, macHasDeveloperId });
}
