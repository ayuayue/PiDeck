import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveInstalledAppUpdateDeliveryPlan } = loadTsCommonJs("src/main/update/installedAppDelivery.ts");
const APP = { platform: "darwin", arch: "arm64", isPackaged: true, execPath: "/Applications/PiDeck.app/Contents/MacOS/PiDeck" };
const DISPLAY = 'Identifier=com.ayuayue.pi-desktop\nTeamIdentifier=A1B2C3D4E5\ndesignated => identifier "com.ayuayue.pi-desktop" and anchor apple generic and certificate leaf[subject.OU] = A1B2C3D4E5\n';

/** Only the OS command is replaced; capability and delivery selection remain real. */
function runner(display = DISPLAY, trusted = true) {
	const calls = [];
	return {
		calls,
		async runCodesign(args) {
			calls.push(args);
			if (args[0] === "-d") return { stdout: "", stderr: display };
			if (!trusted) throw new Error("code failed to satisfy specified code requirement(s)");
			assert.ok(args.some((arg) => arg.includes("anchor apple generic") && arg.includes("1.2.840.113635.100.6.1.13")));
			assert.equal(args.at(-1), "/Applications/PiDeck.app");
			return { stdout: "", stderr: "" };
		},
	};
}

test("an installed Developer ID app enables automatic delivery only after OS verification", async () => {
	const probe = runner();
	const plan = await resolveInstalledAppUpdateDeliveryPlan(APP, probe);
	assert.equal(plan.mode, "automatic");
	assert.equal(probe.calls.length, 2);
});

for (const [name, display, trusted] of [
	["ad-hoc identity", 'Signature=adhoc\nTeamIdentifier=not set\ndesignated => cdhash H"012345"', true],
	["hash-bound Developer ID identity", DISPLAY.replace(/designated => .+/, 'designated => cdhash H"012345"'), true],
	["untrusted certificate chain", DISPLAY, false],
	["missing team constraint", DISPLAY.replace(" and certificate leaf[subject.OU] = A1B2C3D4E5", ""), true],
]) {
	test(`${name} retains manual delivery`, async () => {
		const plan = await resolveInstalledAppUpdateDeliveryPlan(APP, runner(display, trusted));
		assert.equal(plan.mode, "manual");
		assert.equal(plan.reason, "mac-unsigned");
	});
}

test("source runs and non-macOS builds never probe codesign", async () => {
	const probe = {
		runCodesign: async () => {
			throw new Error("must not be called");
		},
	};
	assert.equal((await resolveInstalledAppUpdateDeliveryPlan({ ...APP, isPackaged: false }, probe)).mode, "manual");
	assert.equal((await resolveInstalledAppUpdateDeliveryPlan({ ...APP, platform: "win32" }, probe)).mode, "automatic");
	assert.equal((await resolveInstalledAppUpdateDeliveryPlan({ ...APP, platform: "linux", arch: "arm64", isAppImage: true }, probe)).reason, "linux-arm64");
});

test("a real, valid ad-hoc Mac bundle retains manual delivery", { skip: process.platform !== "darwin" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-installed-signature-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bundle = join(root, "PiDeck.app");
	const execPath = join(bundle, "Contents/MacOS/probe");
	await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
	await copyFile("/usr/bin/true", execPath);
	const plist = join(bundle, "Contents/Info.plist");
	await writeFile(plist, JSON.stringify({ CFBundleIdentifier: "com.example.pideck-updater-test", CFBundleExecutable: "probe", CFBundlePackageType: "APPL" }));
	execFileSync("/usr/bin/plutil", ["-convert", "xml1", plist]);
	execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], { stdio: "pipe" });
	execFileSync("/usr/bin/codesign", ["--verify", "--strict", bundle]);
	const result = await resolveInstalledAppUpdateDeliveryPlan({ ...APP, execPath });
	assert.equal(result.mode, "manual");
	assert.equal(result.reason, "mac-unsigned");
});

test("codesign failures or timeouts degrade to manual instead of breaking startup", async () => {
	const plan = await resolveInstalledAppUpdateDeliveryPlan(APP, {
		runCodesign: async () => {
			throw new Error("ETIMEDOUT");
		},
	});
	assert.equal(plan.mode, "manual");
});
