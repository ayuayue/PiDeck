import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(new URL("../scripts/verify-mac-signature.mjs", import.meta.url));

/** Invoke the real CLI while keeping its policy independent of the developer's environment. */
function verify(release, args = [], env = {}) {
	const result = spawnSync(process.execPath, [verifier, "--release-dir", release, "--json", ...args], {
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, PIDECK_MAC_REQUIRE_DEVELOPER_ID: "", PIDECK_MAC_TEAM_ID: "", ...env },
	});
	if (result.error) throw result.error;
	return { status: result.status, report: JSON.parse(result.stdout) };
}

// No TCC reset, user-folder access or signing key is needed to exercise the
// OS identity check: a saved designated requirement is the same input TCC uses.
test("native macOS signing exposes hash-bound ad-hoc identity and rejects it in certificate mode", { skip: process.platform !== "darwin" }, async (t) => {
	const release = await mkdtemp(join(tmpdir(), "pideck-permission-identity-"));
	t.after(() => rm(release, { recursive: true, force: true }));
	const app = join(release, "mac-arm64", "PermissionIdentityTest.app");
	await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
	await mkdir(join(app, "Contents", "Resources"), { recursive: true });
	await copyFile("/usr/bin/true", join(app, "Contents", "MacOS", "probe"));
	const plist = join(app, "Contents", "Info.plist");
	await writeFile(plist, JSON.stringify({ CFBundleIdentifier: "com.example.pideck-permission-test", CFBundleExecutable: "probe", CFBundlePackageType: "APPL", NSLocalNetworkUsageDescription: "Temporary signature regression test." }));
	execFileSync("/usr/bin/plutil", ["-convert", "xml1", plist], { timeout: 30_000 });
	const resource = join(app, "Contents", "Resources", "version.txt");
	await writeFile(resource, "version 1");
	const sign = () => execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", app], { timeout: 30_000, stdio: "pipe" });
	sign();
	const displayed = spawnSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8", timeout: 30_000 });
	assert.equal(displayed.status, 0);
	const requirement = /^(?:#\s*)?designated\s*=>\s*(.+)$/m.exec(displayed.stdout + displayed.stderr)?.[1];
	assert.match(requirement ?? "", /\bcdhash\b/);

	await t.test("a valid ad-hoc bundle passes integrity checks but reports the TCC limitation", () => {
		const { status, report } = verify(release);
		assert.equal(status, 0, report.errors.join("\n"));
		assert.equal(report.apps[0].signature, "adhoc");
		assert.match(report.warnings.join("\n"), /ad-hoc.*TCC/);
	});

	await t.test("updating a sealed resource invalidates the saved requirement despite an unchanged bundle id", async () => {
		await writeFile(resource, "version 2");
		sign();
		const checked = spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${requirement}`, app], { encoding: "utf8", timeout: 30_000 });
		assert.equal(checked.status, 3, checked.stderr);
		assert.match(checked.stderr, /failed to satisfy specified code requirement/);
		assert.equal(verify(release).status, 0, "the updated bundle is validly signed even though its previous identity no longer matches");
	});

	await t.test("both CLI and workflow policy reject real ad-hoc signing when a certificate is required", () => {
		for (const [args, env] of [
			[["--require-developer-id"], {}],
			[[], { PIDECK_MAC_REQUIRE_DEVELOPER_ID: "true" }],
			[[], { PIDECK_MAC_TEAM_ID: "A1B2C3D4E5" }],
		]) {
			const { status, report } = verify(release, args, env);
			assert.equal(status, 1);
			assert.match(report.errors.join("\n"), /Developer ID/);
		}
	});
});
