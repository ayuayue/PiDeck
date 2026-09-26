import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const upload = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");
const contract = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const transfer = loadTsCommonJs("src/main/remote/RemoteBootstrapTransfer.ts");
const { buildBundleManifest, buildUploadInvocation, bundleContentHash, observeBundleFiles, parseOpenSshVersion, planBundleUpload } = upload;
const { quotePosixArgument } = contract;
const { buildFinalizeFrames } = transfer;

/** Values built inside the loaded module live in another realm; compare them by structure. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const NONCE = "0123456789abcdef0123456789abcdef";
const BUNDLE = "b".repeat(64);
/** The exact banner the pinned Windows client reports; tests/sshClientRuntime.test.mjs pins this shape. */
const WINDOWS_BANNER = "OpenSSH_for_Windows_9.5p2";
const READY = { op: "ready", protocolVersion: 1, bundleSha256: BUNDLE, nonce: NONCE, deployRoot: "/home/dev/.pideck/remote-host", staging: `.staging-${NONCE}` };
const CONNECTION = {
	executable: "C:\\Windows\\System32\\OpenSSH\\scp.exe",
	destination: "pideck-verified-host",
	args: ["-F", "/home/dev/.pideck/ssh-config", "-o", "BatchMode=yes"],
	env: { PATH: "/usr/bin", SystemRoot: "C:\\Windows" },
	openSshVersion: WINDOWS_BANNER,
};

const observation = (name, text) => ({ name, sha256: createHash("sha256").update(text, "utf8").digest("hex"), bytes: Buffer.byteLength(text, "utf8") });

async function bundleDirectory(t, files) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-bundle-"));
	t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
	for (const [name, text] of files) await writeFile(join(directory, name), text);
	return directory;
}

/** A ready frame whose hash really belongs to this bundle, as the entry would have announced it. */
function readyFor(manifest) {
	return { ...READY, bundleSha256: manifest.bundleSha256 };
}

test("reads the version out of every banner shape the pinned clients report", () => {
	// The Windows port spells the product differently; refusing it would make the upload unreachable on
	// the only platform that currently produces a client context at all.
	assert.deepEqual(plain(parseOpenSshVersion(WINDOWS_BANNER)), { major: 9, minor: 5 });
	assert.deepEqual(plain(parseOpenSshVersion("OpenSSH_9.5p2")), { major: 9, minor: 5 });
	assert.deepEqual(plain(parseOpenSshVersion("OpenSSH_8.9p1 Ubuntu-3ubuntu0.10")), { major: 8, minor: 9 });
	assert.deepEqual(plain(parseOpenSshVersion("OpenSSH_10.0")), { major: 10, minor: 0 });
	assert.equal(parseOpenSshVersion("OpenSSH"), null);
	assert.equal(parseOpenSshVersion("openssh_9.5"), null, "the banner is case-sensitive");
	assert.equal(parseOpenSshVersion("ssh 9.5"), null);
	assert.equal(parseOpenSshVersion(undefined), null);
});

test("the bundle hash covers names, digests, sizes and the mode policy", () => {
	const first = observation("helper.mjs", "export const helper = 1;\n");
	const second = observation("bootstrap.mjs", "run();\n");
	assert.equal(bundleContentHash([first, second]), bundleContentHash([second, first]), "declaration order must not change the address");
	assert.notEqual(bundleContentHash([first, second]), bundleContentHash([first, observation("bootstrap.mjs", "run(); // changed\n")]));
	assert.notEqual(bundleContentHash([first, second]), bundleContentHash([first, { ...second, bytes: second.bytes + 1 }]));
	assert.notEqual(bundleContentHash([first, second]), bundleContentHash([observation("helper2.mjs", "export const helper = 1;\n"), second]));
	// Same bytes, different executable set: the entry refuses to rewrite an active directory whose modes
	// disagree, so the address has to differ or the second deployment could never succeed.
	assert.notEqual(bundleContentHash([first, second], { executableNames: ["bootstrap.mjs"] }), bundleContentHash([first, second], { executableNames: [] }));
	// An executable name that is not part of the set is a typo, not a policy.
	assert.throws(() => bundleContentHash([first, second], { executableNames: ["typo.mjs"] }), /BOOTSTRAP_INPUT_INVALID/);
	assert.match(bundleContentHash([first]), /^[0-9a-f]{64}$/);
	// Out-of-contract input would make the separator ambiguous.
	assert.throws(() => bundleContentHash([{ name: "a\nb", sha256: "a".repeat(64), bytes: 1 }]), /BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => bundleContentHash([{ name: "", sha256: "a".repeat(64), bytes: 1 }]), /BOOTSTRAP_INPUT_INVALID/);
});

test("builds a decoded, name-sorted manifest and refuses sets the codec rejects", () => {
	const manifest = plain(buildBundleManifest([observation("helper.mjs", "b\n"), observation("entry.mjs", "a\n")]));
	assert.deepEqual(
		manifest.files.map((file) => file.name),
		["entry.mjs", "helper.mjs"],
	);
	assert.equal(manifest.schemaVersion, 1);
	assert.match(manifest.bundleSha256, /^[0-9a-f]{64}$/);

	// Duplicate and case-colliding names are the codec's call, so they must fail here too.
	assert.throws(() => buildBundleManifest([observation("helper.mjs", "a\n"), observation("helper.mjs", "a\n")]), /BUNDLE_MANIFEST_INVALID|BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest([observation("Helper.mjs", "a\n"), observation("helper.mjs", "a\n")]), /BUNDLE_MANIFEST_INVALID|BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest([observation("../escape.mjs", "a\n")]), /BUNDLE_MANIFEST_INVALID|BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest([]), /BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest([{ name: "a.mjs", sha256: "short", bytes: 1 }]), /BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest([{ name: "a.mjs", sha256: "a".repeat(64), bytes: 32 * 1024 * 1024 + 1 }]), /BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest(Array.from({ length: 257 }, (_value, index) => ({ name: `f${index}.mjs`, sha256: "a".repeat(64), bytes: 1 }))), /BOOTSTRAP_INPUT_INVALID/);
	// A typo in the executable set would silently deploy the entry point as 0600.
	assert.throws(() => buildBundleManifest([observation("entry.mjs", "a\n")], { executableNames: ["typo.mjs"] }), /BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildBundleManifest([observation("entry.mjs", "a\n")], { executableNames: ["entry.mjs", "entry.mjs"] }), /BOOTSTRAP_INPUT_INVALID/);
});

test("observes regular files only", async (t) => {
	const directory = await bundleDirectory(t, [
		["helper.mjs", "export const helper = 1;\n"],
		["entry.mjs", "run();\n"],
	]);
	const observed = await observeBundleFiles(directory, ["helper.mjs", "entry.mjs"]);
	assert.deepEqual(plain(observed), [observation("helper.mjs", "export const helper = 1;\n"), observation("entry.mjs", "run();\n")]);

	await assert.rejects(observeBundleFiles(directory, ["missing.mjs"]), /BUNDLE_FILE_MISMATCH/);
	await assert.rejects(observeBundleFiles(directory, ["../escape.mjs"]), /BOOTSTRAP_INPUT_INVALID/);
	await assert.rejects(observeBundleFiles(directory, []), /BOOTSTRAP_INPUT_INVALID/);
	// A relative directory would fail later at the launcher boundary, after the remote already holds a lock.
	await assert.rejects(observeBundleFiles("relative/bundle", ["helper.mjs"]), /BOOTSTRAP_INPUT_INVALID/);
	await mkdir(join(directory, "subdir"), { recursive: true });
	await assert.rejects(observeBundleFiles(directory, ["subdir"]), /BUNDLE_FILE_MISMATCH/);

	// A link is not a file we hashed, even when it points at the right content.
	const linked = await symlink(join(directory, "helper.mjs"), join(directory, "link.mjs")).then(
		() => true,
		() => false,
	);
	if (!linked) {
		t.diagnostic("file symlinks are unavailable on this platform; the link case was skipped");
		return;
	}
	assert.equal((await lstat(join(directory, "helper.mjs"))).isSymbolicLink(), false);
	await assert.rejects(observeBundleFiles(directory, ["link.mjs"]), /BUNDLE_FILE_MISMATCH/);
});

test("formats the remote path for the protocol the client will actually speak", () => {
	// OpenSSH 9.0+ runs scp over SFTP: the path reaches the server literally, so quoting it would upload
	// into a directory whose name contains quotes. The Windows banner is a 9.x client.
	const modern = plain(buildUploadInvocation({ connection: CONNECTION, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs"] }));
	assert.equal(modern.sftp, true);
	assert.equal(modern.args.at(-1), `pideck-verified-host:${READY.deployRoot}/${READY.staging}`);

	// Older clients keep the legacy protocol, where the remote shell splits the path. The expectation is
	// written out in full so a regression in the quoting helper cannot hide behind the helper itself.
	const legacy = plain(buildUploadInvocation({ connection: { ...CONNECTION, openSshVersion: "OpenSSH_8.9p1 Ubuntu-3ubuntu0.10" }, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs"] }));
	assert.equal(legacy.sftp, false);
	assert.equal(legacy.args.at(-1), `pideck-verified-host:'${READY.deployRoot}/${READY.staging}'`);

	// A path with a space proves the two protocols really differ.
	const spaced = { ...READY, deployRoot: "/home/my dev/.pideck/remote-host" };
	const sftpTarget = plain(buildUploadInvocation({ connection: CONNECTION, ready: spaced, directory: "/tmp/bundle", names: ["entry.mjs"] })).args.at(-1);
	const legacyTarget = plain(buildUploadInvocation({ connection: { ...CONNECTION, openSshVersion: "OpenSSH_7.4" }, ready: spaced, directory: "/tmp/bundle", names: ["entry.mjs"] })).args.at(-1);
	assert.equal(sftpTarget, `pideck-verified-host:${spaced.deployRoot}/${spaced.staging}`);
	assert.equal(legacyTarget, `pideck-verified-host:'${spaced.deployRoot}/${spaced.staging}'`);

	// An unreadable version cannot be guessed at, because the wrong choice is not detectable remotely.
	for (const openSshVersion of ["", "OpenSSH", "ssh 9.5", "9.5p2", undefined, null, 9.5]) {
		assert.throws(() => buildUploadInvocation({ connection: { ...CONNECTION, openSshVersion }, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs"] }), /BOOTSTRAP_INPUT_INVALID/, String(openSshVersion));
	}
});

test("puts every scp option before the terminator and never sends -p", () => {
	const legacyConnection = { ...CONNECTION, openSshVersion: "OpenSSH_8.9p1" };
	const invocation = plain(buildUploadInvocation({ connection: legacyConnection, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs", "helper.mjs"] }));
	assert.equal(invocation.executable, legacyConnection.executable);
	assert.equal(invocation.cwd, "/tmp/bundle");
	assert.equal(invocation.env.PATH, "/usr/bin");
	assert.deepEqual(invocation.args, [...legacyConnection.args, "-q", "-B", "--", "entry.mjs", "helper.mjs", `pideck-verified-host:${quotePosixArgument(`${READY.deployRoot}/${READY.staging}`)}`]);
	// `-p` is intentionally absent (the entry enforces the declared mode) and `--` must precede sources.
	assert.equal(invocation.args.includes("-p"), false);
	assert.equal(invocation.args.indexOf("--"), invocation.args.indexOf("entry.mjs") - 1);
	const odd = plain(buildUploadInvocation({ connection: legacyConnection, ready: { ...READY, deployRoot: "/home/o'brien dir/.pideck/remote-host" }, directory: "/tmp/bundle", names: ["entry.mjs"] }));
	// Written out literally: the quote is closed, escaped and reopened, so the remote shell sees one word.
	assert.equal(odd.args.at(-1), `pideck-verified-host:'/home/o'\\''brien dir/.pideck/remote-host/${READY.staging}'`);
	assert.equal(odd.args.at(-1).includes("'\\''"), true, "a quote in the deploy root must be escaped, not passed through");
});

test("refuses a staging identity, source list or alias that could land bytes elsewhere", () => {
	const cases = [
		{ ready: { ...READY, deployRoot: "relative/root" } },
		{ ready: { ...READY, deployRoot: "/" } },
		{ ready: { ...READY, deployRoot: "/home/dev/../etc/.pideck" } },
		{ ready: { ...READY, deployRoot: "/home/dev/$(touch pwned)/host" } },
		{ ready: { ...READY, deployRoot: "/home/dev/`id`/host" } },
		{ ready: { ...READY, deployRoot: "/home/dev/*/host" } },
		{ ready: { ...READY, staging: "../../.." } },
		{ ready: { ...READY, nonce: "short" } },
		{ ready: { ...READY, deployRoot: "/home/dev/bad\u0000root" } },
		{ names: ["../escape.mjs"] },
		{ names: ["dir/entry.mjs"] },
		{ names: [] },
		{ names: ["entry.mjs"], directory: "" },
		{ names: ["entry.mjs"], directory: "relative/bundle" },
	];
	for (const overrides of cases) {
		assert.throws(() => buildUploadInvocation({ connection: CONNECTION, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs"], ...overrides }), /BOOTSTRAP_INPUT_INVALID/, JSON.stringify(overrides));
	}
	assert.throws(() => buildUploadInvocation({ connection: { ...CONNECTION, args: ["-o", "bad\r\narg"] }, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs"] }), /BOOTSTRAP_INPUT_INVALID/);
	// The alias is forwarded to ssh as its host operand, so an option-looking or IPv6 literal must not pass.
	for (const destination of ["", "-oProxyCommand=calc", "fe80::1", "host:2222", "host name", "host/path"]) {
		assert.throws(() => buildUploadInvocation({ connection: { ...CONNECTION, destination }, ready: READY, directory: "/tmp/bundle", names: ["entry.mjs"] }), /BOOTSTRAP_INPUT_INVALID/, destination);
	}
});

test("plans an upload whose manifest the finalize encoder accepts", async (t) => {
	const directory = await bundleDirectory(t, [
		["entry.mjs", "run();\n"],
		["helper.mjs", "export const helper = 1;\n"],
	]);
	const observations = await observeBundleFiles(directory, ["helper.mjs", "entry.mjs"]);
	const expected = buildBundleManifest(observations, { executableNames: ["entry.mjs"] });
	const plan = await planBundleUpload({ connection: CONNECTION, ready: readyFor(expected), directory, names: ["helper.mjs", "entry.mjs"], executableNames: ["entry.mjs"] });
	assert.equal(plan.invocation.cwd, directory);
	assert.deepEqual(plain(plan.executableNames), ["entry.mjs"]);
	// The address this plan carries must be the one the entry was started with.
	assert.equal(plan.manifest.bundleSha256, expected.bundleSha256);
	// The seam that would silently drift: the manifest this module builds must drive the frames the
	// entry verifies, with the same names, digests and modes.
	const frames = buildFinalizeFrames(plan.manifest, { executableNames: [...plan.executableNames] }).map((line) => JSON.parse(line));
	assert.equal(frames[0].op, "finalize-begin");
	assert.equal(frames[0].files, 2);
	assert.deepEqual(
		plain(frames.slice(1, 3).map((frame) => [frame.name, frame.sha256, frame.mode])),
		plain(plan.observations)
			.slice()
			.sort((left, right) => (left.name < right.name ? -1 : 1))
			.map((entry) => [entry.name, entry.sha256, entry.name === "entry.mjs" ? "0700" : "0600"]),
	);
	assert.equal(frames.at(-1).op, "finalize-commit");

	// A ready frame from another run must be refused before the whole bundle is moved.
	await assert.rejects(planBundleUpload({ connection: CONNECTION, ready: { ...READY, bundleSha256: "c".repeat(64) }, directory, names: ["helper.mjs", "entry.mjs"] }), /BUNDLE_MANIFEST_INVALID/);
});
