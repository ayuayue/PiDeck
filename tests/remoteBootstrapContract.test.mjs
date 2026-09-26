import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME, REMOTE_BOOTSTRAP_FILE_MODES, REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES, REMOTE_BOOTSTRAP_MAX_FRAME_BYTES, REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, REMOTE_BUNDLE_MAX_FILES, REMOTE_BUNDLE_MAX_FILE_BYTES, REMOTE_BUNDLE_MAX_TOTAL_BYTES } = contract;
const {
	assertActivationPreconditions,
	buildBootstrapCommand,
	buildStagingIdentity,
	decodeBundleManifest,
	quotePosixArgument,
	resolveBootstrapDeployRoot,
	verifyBundleFiles,
	REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS,
	REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES,
	REMOTE_BOOTSTRAP_ENTRY_FILE_MODE,
	REMOTE_BOOTSTRAP_ERROR_CODES,
	REMOTE_BOOTSTRAP_FILE_MODE,
	REMOTE_BOOTSTRAP_INLINE_ENTRY,
	REMOTE_BOOTSTRAP_INLINE_SOURCE,
	REMOTE_BOOTSTRAP_LOCK_FILE_NAME,
	REMOTE_BOOTSTRAP_STAGING_MODE,
	REMOTE_BOOTSTRAP_STAGING_PREFIX,
} = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");

const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";
const NONCE = "0123456789abcdef0123456789abcdef";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const NODE_PATH = "/usr/local/bin/node";
const OWNER = "1000";

/**
 * The module under test runs in its own VM realm, so `instanceof Error` and prototype-sensitive deep
 * comparisons do not hold across the boundary. Assert on the stable code and normalise via JSON.
 */
function throwsCode(fn, code) {
	assert.throws(fn, (error) => {
		assert.equal(error.message, code);
		return true;
	});
}

function captureError(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

const plain = (value) => JSON.parse(JSON.stringify(value));
/** Complete factories: a partial literal would silently hide a missing-field bug in the decoder. */
const bundleFile = (name, overrides = {}) => ({ name, sha256: SHA_A, bytes: 128, ...overrides });
const manifestOf = (files, overrides = {}) => ({ schemaVersion: REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, bundleSha256: SHA_B, files, ...overrides });
const observedOf = (files) => files.map((file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes }));
const ownerModeOf = (files, { owner = OWNER, executable = [], dataMode = REMOTE_BOOTSTRAP_FILE_MODE, entryMode = REMOTE_BOOTSTRAP_ENTRY_FILE_MODE } = {}) => files.map((file) => ({ name: file.name, owner, mode: executable.includes(file.name) ? entryMode : dataMode }));
const commandInput = (overrides = {}) => ({ nodeExecutable: NODE_PATH, protocolVersion: 1, bundleSha256: SHA_B, nonce: NONCE, ...overrides });

test("quotePosixArgument wraps a plain token in single quotes", () => {
	assert.equal(quotePosixArgument("plain"), "'plain'");
	assert.equal(quotePosixArgument("with space"), "'with space'");
});

test("quotePosixArgument neutralises a single-quote injection", () => {
	// `'` must leave the single-quoted word and come back as an escaped literal char, so the `;`
	// that follows can never start a second command.
	const quoted = quotePosixArgument("'; rm -rf /");
	assert.equal(quoted, "''\\''; rm -rf /'");
	assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
});

test("quotePosixArgument keeps substitution, backticks and shell separators inside the quotes", () => {
	const payload = "$(id)`whoami`;|&&>out<in";
	assert.equal(quotePosixArgument(payload), `'${payload}'`);
	assert.equal(quotePosixArgument("a$.b`c`"), "'a$.b`c`'");
});

test("quotePosixArgument preserves unicode and the empty string", () => {
	assert.equal(quotePosixArgument("远程 目录"), "'远程 目录'");
	assert.equal(quotePosixArgument(""), "''");
});

test("quotePosixArgument rejects NUL and control characters", () => {
	for (const bad of ["\u0000", "a\nb", "a\tb", "a\u001bb", "a\u007fb", "\u0000"]) {
		throwsCode(() => quotePosixArgument(bad), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("quotePosixArgument rejects a non-string at runtime without echoing it", () => {
	const error = captureError(() => quotePosixArgument(42));
	assert.equal(error.message, "BOOTSTRAP_INPUT_INVALID");
	assert.ok(!error.message.includes("42"));
});

test("buildBootstrapCommand emits the fixed token order", () => {
	const command = buildBootstrapCommand(commandInput());
	assert.ok(command.startsWith(`'${NODE_PATH}' '-e' '`));
	assert.ok(command.includes(quotePosixArgument(REMOTE_BOOTSTRAP_INLINE_SOURCE)));
	// `--` is required: without it node parses the leading `--pideck-…` argument as a bad option.
	assert.ok(command.endsWith(`' '--' '${REMOTE_BOOTSTRAP_INLINE_ENTRY}' '1' '${SHA_B}' '${NONCE}'`));
	assert.equal(command, [quotePosixArgument(NODE_PATH), quotePosixArgument("-e"), quotePosixArgument(REMOTE_BOOTSTRAP_INLINE_SOURCE), quotePosixArgument("--"), quotePosixArgument(REMOTE_BOOTSTRAP_INLINE_ENTRY), quotePosixArgument("1"), quotePosixArgument(SHA_B), quotePosixArgument(NONCE)].join(" "));
});

test("buildBootstrapCommand accepts only a verified absolute node executable", () => {
	assert.doesNotThrow(() => buildBootstrapCommand(commandInput({ nodeExecutable: "/usr/bin/node" })));
	assert.doesNotThrow(() => buildBootstrapCommand(commandInput({ nodeExecutable: "/home/deploy/.nvm/versions/node/v24.13.0/bin/node" })));
	for (const bad of ["node", "/bin/sh", "/usr/bin/env", "/etc/passwd", "/usr/local/bin/node-v24", "/usr/local/bin/node/", "/usr/local/bin/../bin/node", "relative/bin/node", " /usr/local/bin/node", "C:/Program Files/nodejs/node.exe", ""]) {
		throwsCode(() => buildBootstrapCommand(commandInput({ nodeExecutable: bad })), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildBootstrapCommand rejects a protocol version that is not a bounded integer", () => {
	for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, 65536, "1", null, undefined]) {
		throwsCode(() => buildBootstrapCommand(commandInput({ protocolVersion: bad })), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildBootstrapCommand rejects a bundle hash that is not 64 lowercase hex characters", () => {
	for (const bad of ["", SHA_B.toUpperCase(), SHA_B.slice(0, 63), `${SHA_B}0`, "z".repeat(64), 7, null]) {
		throwsCode(() => buildBootstrapCommand(commandInput({ bundleSha256: bad })), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildBootstrapCommand rejects a nonce outside the bounded charset", () => {
	for (const bad of ["", "a".repeat(15), "a".repeat(65), `-${"a".repeat(20)}`, `.${"a".repeat(20)}`, "0123456789abcdef 0123456789abcd", "0123456789abcdef\n0123456789abcd", "0123456789abcdef0123456789abcde\u0000", 42, null]) {
		throwsCode(() => buildBootstrapCommand(commandInput({ nonce: bad })), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildBootstrapCommand refuses host text in any slot and never echoes it", () => {
	const secret = "/home/deploy/secret-project";
	for (const input of [commandInput({ nodeExecutable: secret }), commandInput({ bundleSha256: secret }), commandInput({ nonce: secret })]) {
		const error = captureError(() => buildBootstrapCommand(input));
		assert.equal(error.message, "BOOTSTRAP_INPUT_INVALID");
		assert.ok(!error.message.includes("secret"));
		assert.ok(!error.message.includes("deploy"));
	}
});

test("buildBootstrapCommand rejects missing input at runtime", () => {
	for (const value of [undefined, null, {}, { nodeExecutable: NODE_PATH }]) {
		throwsCode(() => buildBootstrapCommand(value), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("resolveBootstrapDeployRoot joins the fixed segments onto an absolute home", () => {
	assert.equal(resolveBootstrapDeployRoot("/home/deploy"), "/home/deploy/.pideck/remote-host");
	assert.equal(resolveBootstrapDeployRoot("/home/deploy/"), "/home/deploy/.pideck/remote-host");
	assert.equal(resolveBootstrapDeployRoot("/Users/x"), "/Users/x/.pideck/remote-host");
});

test("resolveBootstrapDeployRoot rejects relative, traversal and control-character homes", () => {
	for (const bad of ["", "/", "relative/home", "/home/../root", "/home//deploy", "/home/./deploy", "/home/deploy\u0000", 42, null]) {
		throwsCode(() => resolveBootstrapDeployRoot(bad), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildStagingIdentity names the staging directory after the nonce only", () => {
	const identity = buildStagingIdentity({ hostId: HOST_ID, runtimeGeneration: 7, nonce: NONCE });
	assert.equal(identity.directory, `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${NONCE}`);
	assert.equal(identity.mode, REMOTE_BOOTSTRAP_STAGING_MODE);
	assert.equal(identity.mode, "0700");
	// Deploy-root relative, one segment: hostId is not unique across PiDeck instances (plan §171).
	assert.ok(!identity.directory.includes("/"));
	assert.ok(!identity.directory.includes(HOST_ID));
});

test("buildStagingIdentity rejects a host id that is not a store UUID", () => {
	for (const bad of ["", "host-1", HOST_ID.toUpperCase(), "01234567-89ab-0def-8123-456789abcdef", "01234567-89ab-4def-0123-456789abcdef", 42, null]) {
		throwsCode(() => buildStagingIdentity({ hostId: bad, runtimeGeneration: 1, nonce: NONCE }), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildStagingIdentity rejects an out-of-range runtime generation", () => {
	for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "7", null, undefined]) {
		throwsCode(() => buildStagingIdentity({ hostId: HOST_ID, runtimeGeneration: bad, nonce: NONCE }), "BOOTSTRAP_INPUT_INVALID");
	}
	assert.doesNotThrow(() => buildStagingIdentity({ hostId: HOST_ID, runtimeGeneration: 0, nonce: NONCE }));
});

test("buildStagingIdentity rejects a nonce that cannot be a path segment", () => {
	for (const bad of ["", "short", "a".repeat(65), "../x", "a/b", `a\\b`, `${NONCE}\u0000`, `${NONCE}/`, 42]) {
		throwsCode(() => buildStagingIdentity({ hostId: HOST_ID, runtimeGeneration: 1, nonce: bad }), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("buildStagingIdentity rejects a non-object input", () => {
	for (const value of [undefined, null, "identity", 42]) {
		throwsCode(() => buildStagingIdentity(value), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("decodeBundleManifest returns a fresh copy of a valid manifest", () => {
	const input = manifestOf([bundleFile("helper.mjs"), bundleFile("runner.mjs", { sha256: SHA_C, bytes: 7 })]);
	const decoded = decodeBundleManifest(input);
	assert.deepEqual(plain(decoded), plain(input));
	assert.notStrictEqual(decoded, input);
	assert.notStrictEqual(decoded.files, input.files);
	assert.notStrictEqual(decoded.files[0], input.files[0]);
	input.files[0].bytes = 999_999;
	assert.equal(decoded.files[0].bytes, 128);
});

test("decodeBundleManifest rejects unknown fields at every level", () => {
	throwsCode(() => decodeBundleManifest({ ...manifestOf([bundleFile("helper.mjs")]), protocolVersion: 1 }), "BUNDLE_MANIFEST_INVALID");
	throwsCode(() => decodeBundleManifest({ ...manifestOf([bundleFile("helper.mjs")]), bundleVersion: "1.2.3" }), "BUNDLE_MANIFEST_INVALID");
	throwsCode(() => decodeBundleManifest(manifestOf([{ ...bundleFile("helper.mjs"), url: "https://example.test/x" }])), "BUNDLE_MANIFEST_INVALID");
	throwsCode(() => decodeBundleManifest(manifestOf([{ ...bundleFile("helper.mjs"), mode: "0600" }])), "BUNDLE_MANIFEST_INVALID");
});

test("decodeBundleManifest rejects non-objects and a different schema version", () => {
	for (const value of [null, undefined, "manifest", 42, [], manifestOf([bundleFile("helper.mjs")], { schemaVersion: 0 }), manifestOf([bundleFile("helper.mjs")], { schemaVersion: 2 }), manifestOf([bundleFile("helper.mjs")], { schemaVersion: "1" })]) {
		throwsCode(() => decodeBundleManifest(value), "BUNDLE_MANIFEST_INVALID");
	}
});

test("decodeBundleManifest rejects a bundle hash that is not 64 lowercase hex characters", () => {
	for (const bad of ["", SHA_B.toUpperCase(), SHA_B.slice(0, 63), "z".repeat(64), 7, null]) {
		throwsCode(() => decodeBundleManifest(manifestOf([bundleFile("helper.mjs")], { bundleSha256: bad })), "BUNDLE_MANIFEST_INVALID");
	}
});

test("decodeBundleManifest rejects empty, non-array and oversized file lists", () => {
	for (const files of [[], "files", null, {}, 42]) {
		throwsCode(() => decodeBundleManifest(manifestOf(files)), "BUNDLE_MANIFEST_INVALID");
	}
	const tooMany = Array.from({ length: REMOTE_BUNDLE_MAX_FILES + 1 }, (_, index) => bundleFile(`file-${index}.mjs`));
	throwsCode(() => decodeBundleManifest(manifestOf(tooMany)), "BUNDLE_MANIFEST_INVALID");
	assert.equal(decodeBundleManifest(manifestOf(Array.from({ length: REMOTE_BUNDLE_MAX_FILES }, (_, index) => bundleFile(`file-${index}.mjs`)))).files.length, REMOTE_BUNDLE_MAX_FILES);
});

test("decodeBundleManifest enforces the per-file and total byte limits", () => {
	assert.equal(decodeBundleManifest(manifestOf([bundleFile("big.mjs", { bytes: REMOTE_BUNDLE_MAX_FILE_BYTES })])).files[0].bytes, REMOTE_BUNDLE_MAX_FILE_BYTES);
	throwsCode(() => decodeBundleManifest(manifestOf([bundleFile("big.mjs", { bytes: REMOTE_BUNDLE_MAX_FILE_BYTES + 1 })])), "BUNDLE_MANIFEST_INVALID");
	const oversized = Array.from({ length: Math.ceil(REMOTE_BUNDLE_MAX_TOTAL_BYTES / REMOTE_BUNDLE_MAX_FILE_BYTES) + 1 }, (_, index) => bundleFile(`big-${index}.mjs`, { bytes: REMOTE_BUNDLE_MAX_FILE_BYTES }));
	// The count cap must not be what rejects this list, otherwise the total-bytes branch is untested.
	assert.ok(oversized.length <= REMOTE_BUNDLE_MAX_FILES);
	throwsCode(() => decodeBundleManifest(manifestOf(oversized)), "BUNDLE_MANIFEST_INVALID");
});

test("decodeBundleManifest rejects unsafe file names", () => {
	const unsafe = ["", ".", "..", "../x", "a/b", "/abs/x", "a\\b", "a\u0000b", "a\nb", "a\tb", "-flag", ".hidden", "a".repeat(129), "a b", "a:b", "a?b", 42, null, undefined];
	for (const name of unsafe) {
		throwsCode(() => decodeBundleManifest(manifestOf([bundleFile(name)])), "BUNDLE_MANIFEST_INVALID");
	}
	assert.doesNotThrow(() => decodeBundleManifest(manifestOf([bundleFile("helper.core.mjs"), bundleFile("runner-v1.mjs")])));
});

test("decodeBundleManifest rejects duplicate names", () => {
	throwsCode(() => decodeBundleManifest(manifestOf([bundleFile("helper.mjs"), bundleFile("helper.mjs", { bytes: 1 })])), "BUNDLE_MANIFEST_INVALID");
});

test("decodeBundleManifest rejects malformed digests and byte counts", () => {
	for (const overrides of [{ sha256: SHA_A.toUpperCase() }, { sha256: SHA_A.slice(0, 63) }, { sha256: "z".repeat(64) }, { sha256: 7 }, { sha256: null }, { bytes: -1 }, { bytes: 1.5 }, { bytes: "1" }, { bytes: Number.MAX_SAFE_INTEGER + 2 }, { bytes: null }]) {
		throwsCode(() => decodeBundleManifest(manifestOf([bundleFile("helper.mjs", overrides)])), "BUNDLE_MANIFEST_INVALID");
	}
});

test("decodeBundleManifest failures carry only the stable code", () => {
	const error = captureError(() => decodeBundleManifest(manifestOf([bundleFile("../secret.mjs")])));
	assert.equal(error.message, "BUNDLE_MANIFEST_INVALID");
	assert.ok(!error.message.includes("secret"));
});

test("verifyBundleFiles accepts an exact report regardless of order", () => {
	const files = [bundleFile("helper.mjs"), bundleFile("runner.mjs", { sha256: SHA_C, bytes: 7 })];
	const [first, second] = observedOf(files);
	assert.doesNotThrow(() => verifyBundleFiles(manifestOf(files), [second, first]));
});

test("verifyBundleFiles rejects a missing or an unexpected file", () => {
	const files = [bundleFile("helper.mjs"), bundleFile("runner.mjs", { sha256: SHA_C, bytes: 7 })];
	const observed = observedOf(files);
	throwsCode(() => verifyBundleFiles(manifestOf(files), observed.slice(0, 1)), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), [...observed, { name: "extra.mjs", sha256: SHA_A, bytes: 128 }]), "BUNDLE_FILE_MISMATCH");
});

test("verifyBundleFiles rejects a content or size mismatch", () => {
	const files = [bundleFile("helper.mjs")];
	throwsCode(() => verifyBundleFiles(manifestOf(files), [{ name: "helper.mjs", sha256: SHA_C, bytes: 128 }]), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), [{ name: "helper.mjs", sha256: SHA_A, bytes: 129 }]), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), [{ name: "helper.mjs", sha256: SHA_A.toUpperCase(), bytes: 128 }]), "BUNDLE_FILE_MISMATCH");
});

test("verifyBundleFiles rejects a duplicated or malformed report", () => {
	const files = [bundleFile("helper.mjs")];
	const observed = observedOf(files);
	throwsCode(() => verifyBundleFiles(manifestOf(files), [...observed, ...observed]), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), [{ ...observed[0], source: "/tmp/x" }]), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), [null]), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), "not-a-report"), "BUNDLE_FILE_MISMATCH");
	throwsCode(() => verifyBundleFiles(manifestOf(files), undefined), "BUNDLE_FILE_MISMATCH");
});

test("verifyBundleFiles re-validates the manifest it is given", () => {
	throwsCode(() => verifyBundleFiles(manifestOf([bundleFile("../escape.mjs")]), []), "BUNDLE_MANIFEST_INVALID");
	throwsCode(() => verifyBundleFiles({ ...manifestOf([bundleFile("helper.mjs")]), files: "x" }, []), "BUNDLE_MANIFEST_INVALID");
});

test("verifyBundleFiles failures carry only the stable code", () => {
	const error = captureError(() => verifyBundleFiles(manifestOf([bundleFile("secret-helper.mjs")]), []));
	assert.equal(error.message, "BUNDLE_FILE_MISMATCH");
	assert.ok(!error.message.includes("secret"));
});

test("assertActivationPreconditions accepts a fully verified deployment", () => {
	const files = [bundleFile("helper.mjs"), bundleFile("bootstrap.mjs", { sha256: SHA_C, bytes: 7 })];
	assert.doesNotThrow(() =>
		assertActivationPreconditions({
			manifest: manifestOf(files),
			observed: observedOf(files),
			ownerMode: ownerModeOf(files, { executable: ["bootstrap.mjs"] }),
			expectedOwner: OWNER,
			executableNames: ["bootstrap.mjs"],
		}),
	);
});

test("assertActivationPreconditions refuses to activate before the file set verifies", () => {
	const files = [bundleFile("helper.mjs")];
	// Mode and owner are perfect here; the missing file must still win, because nothing may be
	// activated on the strength of a mode report alone.
	throwsCode(() => assertActivationPreconditions({ manifest: manifestOf(files), observed: [], ownerMode: ownerModeOf(files), expectedOwner: OWNER }), "BUNDLE_FILE_MISMATCH");
});

test("assertActivationPreconditions enforces the owner", () => {
	const files = [bundleFile("helper.mjs")];
	const input = { manifest: manifestOf(files), observed: observedOf(files), ownerMode: ownerModeOf(files), expectedOwner: OWNER };
	assert.doesNotThrow(() => assertActivationPreconditions(input));
	throwsCode(() => assertActivationPreconditions({ ...input, ownerMode: ownerModeOf(files, { owner: "0" }) }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...input, ownerMode: [{ name: "helper.mjs", owner: "1000 ", mode: REMOTE_BOOTSTRAP_FILE_MODE }] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...input, expectedOwner: "" }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...input, expectedOwner: 1000 }), "BUNDLE_MODE_INVALID");
});

test("assertActivationPreconditions enforces the mode policy", () => {
	const files = [bundleFile("helper.mjs"), bundleFile("bootstrap.mjs", { sha256: SHA_C })];
	const base = { manifest: manifestOf(files), observed: observedOf(files), ownerMode: ownerModeOf(files, { executable: ["bootstrap.mjs"] }), expectedOwner: OWNER, executableNames: ["bootstrap.mjs"] };
	assert.doesNotThrow(() => assertActivationPreconditions(base));
	// A data file must not be executable, and a declared entry point must not be readable-only.
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: ownerModeOf(files, { executable: ["helper.mjs", "bootstrap.mjs"] }) }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: ownerModeOf(files, { executable: [] }) }), "BUNDLE_MODE_INVALID");
	// Group/other bits, setuid, a non-canonical octal string and a numeric mode are all refused.
	for (const mode of ["0644", "0777", "0600 ", "600", "4755", "0755", 384, null]) {
		throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: ownerModeOf(files, { executable: ["bootstrap.mjs"], dataMode: mode }) }), "BUNDLE_MODE_INVALID");
	}
});

test("assertActivationPreconditions requires the mode report to cover the manifest exactly", () => {
	const files = [bundleFile("helper.mjs"), bundleFile("bootstrap.mjs", { sha256: SHA_C })];
	const base = { manifest: manifestOf(files), observed: observedOf(files), ownerMode: ownerModeOf(files, { executable: ["bootstrap.mjs"] }), expectedOwner: OWNER, executableNames: ["bootstrap.mjs"] };
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: base.ownerMode.slice(0, 1) }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: [...base.ownerMode, { name: "extra.mjs", owner: OWNER, mode: REMOTE_BOOTSTRAP_FILE_MODE }] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: [base.ownerMode[0], base.ownerMode[0]] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: [{ ...base.ownerMode[0], extra: true }, base.ownerMode[1]] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, ownerMode: "not-a-report" }), "BUNDLE_MODE_INVALID");
});

test("assertActivationPreconditions treats executableNames as a closed set", () => {
	const files = [bundleFile("bootstrap.mjs")];
	const base = { manifest: manifestOf(files), observed: observedOf(files), ownerMode: ownerModeOf(files, { executable: ["bootstrap.mjs"] }), expectedOwner: OWNER };
	assert.doesNotThrow(() => assertActivationPreconditions({ ...base, executableNames: ["bootstrap.mjs"] }));
	// An entry-point mode with no declared entry point is a mode failure, not a silent pass.
	throwsCode(() => assertActivationPreconditions(base), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, executableNames: [] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, executableNames: ["missing.mjs"] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, executableNames: ["bootstrap.mjs", "bootstrap.mjs"] }), "BUNDLE_MODE_INVALID");
	throwsCode(() => assertActivationPreconditions({ ...base, executableNames: "bootstrap.mjs" }), "BUNDLE_MODE_INVALID");
});

test("assertActivationPreconditions rejects a non-object input", () => {
	for (const value of [undefined, null, "activation"]) {
		throwsCode(() => assertActivationPreconditions(value), "BOOTSTRAP_INPUT_INVALID");
	}
});

test("the exported stable codes stay stable and cover what the entry emits", () => {
	assert.deepEqual(Array.from(REMOTE_BOOTSTRAP_ERROR_CODES), ["BOOTSTRAP_INPUT_INVALID", "BUNDLE_MANIFEST_INVALID", "BUNDLE_FILE_MISMATCH", "BUNDLE_MODE_INVALID"]);
	for (const code of Array.from(REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES)) assert.match(code, /^[A-Z][A-Z0-9_]{2,63}$/);
	for (const code of ["BOOTSTRAP_INPUT_INVALID", "BOOTSTRAP_DEPLOY_ROOT_INVALID", "BOOTSTRAP_STAGING_INVALID", "BOOTSTRAP_ENTRY_OP_UNSUPPORTED", "BOOTSTRAP_INTERNAL", "DEPLOY_LOCK_HELD"]) {
		assert.ok(REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES.includes(code), code);
	}
});

test("the inline source stays quotable as a single template token", () => {
	// A newline or a NUL inside the entry would make the template unquotable, so this is a hard
	// precondition of the frozen command, not a style preference.
	assert.ok(!/[\u0000-\u001f\u007f]/.test(REMOTE_BOOTSTRAP_INLINE_SOURCE));
	assert.ok(!REMOTE_BOOTSTRAP_INLINE_SOURCE.includes("'"));
	assert.equal(quotePosixArgument(REMOTE_BOOTSTRAP_INLINE_SOURCE), `'${REMOTE_BOOTSTRAP_INLINE_SOURCE}'`);
	assert.ok(REMOTE_BOOTSTRAP_INLINE_SOURCE.length > 0 && REMOTE_BOOTSTRAP_INLINE_SOURCE.length < 32 * 1024);
});

test("the inline source keeps its fixed protocol vocabulary", () => {
	for (const token of [REMOTE_BOOTSTRAP_INLINE_ENTRY, '"use strict"', 'require("node:fs")', "process.env.HOME", ".pideck", "remote-host", ".staging-", ".deploy.lock", "0o700", "0o600", "wx", "DEPLOY_LOCK_HELD", "BOOTSTRAP_DEPLOY_ROOT_INVALID", "BOOTSTRAP_STAGING_INVALID", "BOOTSTRAP_ENTRY_OP_UNSUPPORTED"]) {
		assert.ok(REMOTE_BOOTSTRAP_INLINE_SOURCE.includes(token), token);
	}
	// stdout carries protocol frames only; no console logging may sneak in.
	assert.ok(!REMOTE_BOOTSTRAP_INLINE_SOURCE.includes("console."));
	// The finalize phase must stay inside the frozen frame vocabulary.
	for (const token of ['"finalize-begin"', '"finalize-file"', '"finalize-commit"', '"finalized"', '"aborted"', 'op:"error"', "BOOTSTRAP_FINALIZE_INCOMPLETE", "BOOTSTRAP_FILE_MISMATCH", "BOOTSTRAP_MODE_INVALID", "BOOTSTRAP_ACTIVE_CONFLICT", "renameSync", "fsyncSync", "lstatSync", "getuid"]) {
		assert.ok(REMOTE_BOOTSTRAP_INLINE_SOURCE.includes(token), token);
	}
	// Hashing a staged file must not widen the entry's module surface: only the two core modules it
	// already used are pulled in, and sha256 comes from the WebCrypto global instead of a new require.
	assert.equal((REMOTE_BOOTSTRAP_INLINE_SOURCE.match(/require\(/g) ?? []).length, 2, "the entry may only require node:fs and node:path");
	// The owner rule stays a hard gate and the mode is forced rather than trusted, so pin the sequence
	// with whitespace-tolerant patterns: owner check, the entry's own chmod to the declared mode, then a
	// second lstat that confirms the result. A refactor must neither drop the owner check nor chmod
	// without re-reading the mode it just set.
	assert.match(REMOTE_BOOTSTRAP_INLINE_SOURCE, /st\.uid\s*!==\s*process\.getuid\(\)/);
	assert.match(REMOTE_BOOTSTRAP_INLINE_SOURCE, /st\.uid\s*!==\s*process\.getuid\(\)[\s\S]{0,400}?chmodSync\(file\s*,\s*parseInt\(entry\.mode\s*,\s*8\)\)[\s\S]{0,400}?lstatSync\(file\)[\s\S]{0,400}?\(st\.mode\s*&\s*0o777\)\s*!==\s*parseInt\(entry\.mode\s*,\s*8\)/);
	// An already active bundle is re-verified read-only, so the forced mode must stay out of that branch:
	// every chmod in the entry belongs to the staging directory or to a staged file, both of which are
	// defined before `activeMatches`.
	const activeBranchStart = REMOTE_BOOTSTRAP_INLINE_SOURCE.search(/async\s+function\s+activeMatches\s*\(/);
	assert.notEqual(activeBranchStart, -1, "the read-only active-bundle branch must exist");
	assert.ok(!REMOTE_BOOTSTRAP_INLINE_SOURCE.slice(activeBranchStart).includes("chmodSync"), "an already active bundle must never be chmodded");
	assert.match(REMOTE_BOOTSTRAP_INLINE_SOURCE, /Buffer\.byteLength\(line\s*,\s*"utf8"\)\s*>\s*MAX_FRAME/);
	assert.match(REMOTE_BOOTSTRAP_INLINE_SOURCE, /Buffer\.byteLength\(buffered\s*,\s*"utf8"\)\s*>\s*MAX_FRAME/);
});

test("the inline entry is byte-frozen", () => {
	// This entry is the only code that runs on a remote before anything is deployed, so any edit must
	// be deliberate: update this digest in the same commit that changes REMOTE_BOOTSTRAP_INLINE_SOURCE.
	const digest = createHash("sha256").update(REMOTE_BOOTSTRAP_INLINE_SOURCE, "utf8").digest("hex");
	assert.equal(digest, "1702099f62ee1a57f4bfaedb14a004a9f115a4c058f203247908b967a5d0c495");
});

test("the frozen entry refuses a deploy root that is not a private real directory", async (t) => {
	const { spawn } = await import("node:child_process");
	const { mkdir, mkdtemp, rm, symlink } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const home = await mkdtemp(join(tmpdir(), "pideck-entry-home-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const realRoot = join(home, "real-pideck");
	await mkdir(realRoot);
	// A junction is enough to prove the entry follows the link instead of refusing it (Windows cannot
	// create directory symlinks without privileges, and a junction reports as a symlink to lstat).
	await symlink(realRoot, join(home, ".pideck"), "junction");
	const result = await new Promise((resolve) => {
		const child = spawn(process.execPath, ["-e", REMOTE_BOOTSTRAP_INLINE_SOURCE, "--", REMOTE_BOOTSTRAP_INLINE_ENTRY, "1", "a".repeat(64), "noncevalue0123456789"], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.on("close", (code) => resolve({ code, stdout }));
		child.stdin.end();
	});
	assert.notEqual(result.code, 0, "a symlinked deploy root must not be accepted");
	assert.match(result.stdout, /BOOTSTRAP_DEPLOY_ROOT_INVALID/);
});

/* --------------------------------------------------------------------------------------------------
 * Finalize phase (plan §168) against the real frozen entry.
 *
 * Every test below runs the actual frozen source through `node -e`, the way the remote command does:
 * the entry derives the deploy root from HOME, takes the deploy lock and creates the staging
 * directory, and only then does the test upload into that directory and speak the finalize protocol
 * on stdin. The test never half-closes stdin while a commit is in flight - EOF is the "the ssh
 * connection died" signal that aborts a run by design - the entry holds stdio open and exits on its
 * own after its single terminal frame.
 * ------------------------------------------------------------------------------------------------ */

const BUNDLE_SHA = "b".repeat(64);
/** Windows has no uid and synthesizes file modes, so the POSIX-only policy is asserted only there. */
const POSIX = typeof process.getuid === "function";

// The test builds the deployment paths from the frozen constants, not from literals: a segment, a
// directory name or a lock name that drifts in the contract must fail here, not silently pass.
const deployRootOf = (home) => join(home, ...REMOTE_BOOTSTRAP_DEPLOY_ROOT_SEGMENTS);
const stagingOf = (home, nonce = NONCE) => join(deployRootOf(home), `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${nonce}`);
const lockPathOf = (home) => join(deployRootOf(home), REMOTE_BOOTSTRAP_LOCK_FILE_NAME);
const bundlesOf = (home) => join(deployRootOf(home), REMOTE_BOOTSTRAP_BUNDLE_DIR_NAME);
const activeOf = (home, bundleSha256 = BUNDLE_SHA) => join(bundlesOf(home), bundleSha256);

/** One declared file: its staged bytes, plus the digest, byte count and mode the frames declare. */
function stagedFile(name, text, mode = "0600") {
	return { name, text, mode, sha256: createHash("sha256").update(text, "utf8").digest("hex"), bytes: Buffer.byteLength(text, "utf8") };
}

const beginFrame = (files, bundleSha256 = BUNDLE_SHA) => ({ v: 1, op: "finalize-begin", files, bundleSha256 });
const fileFrame = (file, overrides = {}) => ({ v: 1, op: "finalize-file", name: file.name, sha256: file.sha256, bytes: file.bytes, mode: file.mode, ...overrides });
const COMMIT_FRAME = { v: 1, op: "finalize-commit" };
const ABORT_FRAME = { v: 1, op: "abort" };

/** Pad a frame with JSON-legal trailing whitespace to an exact byte length (the frame-cap boundary). */
function paddedFrame(frame, bytes) {
	const base = JSON.stringify(frame);
	const padding = bytes - Buffer.byteLength(base, "utf8");
	assert.ok(padding >= 0, "the frame is already longer than the requested size");
	return `${base}${" ".repeat(padding)}`;
}

/** Launch the frozen entry against a throwaway HOME and collect the NDJSON frames it writes. */
async function startSession(home, { nonce = NONCE, bundleSha256 = BUNDLE_SHA } = {}) {
	const child = spawn(process.execPath, ["-e", REMOTE_BOOTSTRAP_INLINE_SOURCE, "--", REMOTE_BOOTSTRAP_INLINE_ENTRY, "1", bundleSha256, nonce], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
	const frames = [];
	const waiters = new Set();
	let buffered = "";
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		buffered += chunk;
		let index;
		while ((index = buffered.indexOf("\n")) >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			frames.push(line.length === 0 ? null : JSON.parse(line));
		}
		for (const waiter of [...waiters]) waiter();
	});
	child.stderr.on("data", (chunk) => (stderr += chunk));
	const closed = new Promise((resolve) => child.on("close", () => resolve()));
	return {
		child,
		frames,
		/** Wait for a specific frame, failing loudly instead of hanging when the entry never sends it. */
		async waitForFrame(predicate) {
			for (;;) {
				const found = frames.find((frame) => frame !== null && predicate(frame));
				if (found) return found;
				if (child.exitCode !== null) throw new Error(`the entry exited before that frame (code ${child.exitCode}, stdout ${stdout}, stderr ${stderr})`);
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						waiters.delete(waiter);
						reject(new Error(`timed out waiting for a frame (stdout ${stdout}, stderr ${stderr})`));
					}, 20_000);
					const waiter = () => {
						clearTimeout(timer);
						waiters.delete(waiter);
						resolve();
					};
					waiters.add(waiter);
				});
			}
		},
		/** One stdin write for one or more frames, so frames sent together arrive as one chunk. */
		write(...outbound) {
			child.stdin.write(`${outbound.map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame))).join("\n")}\n`);
		},
		/** Wait for the entry to exit on its own and report everything it said. */
		async finish() {
			const killer = setTimeout(() => child.kill(), 20_000);
			await closed;
			clearTimeout(killer);
			assert.notEqual(child.exitCode, null, `the entry must exit on its own (stdout ${stdout}, stderr ${stderr})`);
			return { code: child.exitCode, frames: [...frames], stdout, stderr };
		},
	};
}

/** Start the entry and wait for `ready`, the frame that announces where the upload has to land. */
async function startStagingSession(home, options = {}) {
	const session = await startSession(home, options);
	const ready = await session.waitForFrame((frame) => frame.op === "ready");
	assert.deepEqual(ready, { v: 1, op: "ready", protocolVersion: 1, bundleSha256: options.bundleSha256 ?? BUNDLE_SHA, nonce: options.nonce ?? NONCE, deployRoot: deployRootOf(home), staging: `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${options.nonce ?? NONCE}`, stagingMode: "0700" });
	return session;
}

async function temporaryHome(t) {
	const home = await mkdtemp(join(tmpdir(), "pideck-entry-home-"));
	t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
	return home;
}

/** Upload one declared file into the staging directory; `mode` is overridable for mismatch cases. */
async function stageFile(home, file, mode = file.mode) {
	const target = join(stagingOf(home), file.name);
	await writeFile(target, file.text, { mode: Number.parseInt(mode, 8) });
	return target;
}

async function modeText(path) {
	return ((await stat(path)).mode & 0o777).toString(8).padStart(4, "0");
}

/** A failed finalize leaves no bundle, no staging copy and no lock behind. */
async function pathExists(target) {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

async function assertNothingActivated(home, label) {
	await assert.rejects(lstat(bundlesOf(home)), /ENOENT/, `${label}: bundles must not exist before the commit point`);
	await assert.rejects(lstat(stagingOf(home)), /ENOENT/, `${label}: staging must be removed`);
	await assert.rejects(lstat(lockPathOf(home)), /ENOENT/, `${label}: the deploy lock must be released`);
}

test("the frozen entry finalizes a two-file bundle into an immutable active directory", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const files = [stagedFile("helper.mjs", "export const helper = 1;\n"), stagedFile("bootstrap.mjs", "#!/usr/bin/env node\nrun();\n", "0700")];
	for (const file of files) await stageFile(home, file);
	session.write(beginFrame(files.length), ...files.map((file) => fileFrame(file)), COMMIT_FRAME);
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "finalized"],
	);
	assert.deepEqual(result.frames[1], { v: 1, op: "finalized", active: `./bundles/${BUNDLE_SHA}`, files: 2 });
	// The activation target is the content-addressed directory and holds exactly the staged bytes.
	for (const file of files) {
		assert.equal(await readFile(join(activeOf(home), file.name), "utf8"), file.text);
		if (POSIX) assert.equal(await modeText(join(activeOf(home), file.name)), file.mode);
	}
	assert.deepEqual(await readdir(bundlesOf(home)), [BUNDLE_SHA]);
	// staging and the lock are gone: the activated directory is the only artifact left behind.
	await assert.rejects(lstat(stagingOf(home)), /ENOENT/);
	await assert.rejects(lstat(lockPathOf(home)), /ENOENT/);
});

test("finalize accepts a zero-byte declared file", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const file = stagedFile("empty.txt", "");
	assert.equal(file.bytes, 0);
	await stageFile(home, file);
	session.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "finalized"],
	);
	assert.equal(await readFile(join(activeOf(home), file.name), "utf8"), "");
});

test("finalize is idempotent for an already active bundle and never rewrites it", async (t) => {
	const home = await temporaryHome(t);
	const file = stagedFile("helper.mjs", "already-active-body\n");
	// Preset the active directory exactly as the declaration describes it, then stamp a fixed mtime: a
	// rewrite (a rename over it, or a re-upload of the bytes) would lose that timestamp.
	const active = await makePrivateActiveDirectory(home);
	const activeFile = join(active, file.name);
	await writeFile(activeFile, file.text, { mode: 0o600 });
	await utimes(activeFile, new Date(1_000_000), new Date(1_000_000));
	const before = await stat(activeFile);
	const session = await startStagingSession(home);
	await stageFile(home, file);
	session.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "finalized"],
	);
	assert.deepEqual(result.frames[1], { v: 1, op: "finalized", active: `./bundles/${BUNDLE_SHA}`, files: 1 });
	assert.equal(await readFile(activeFile, "utf8"), file.text);
	const after = await stat(activeFile);
	assert.equal(after.mtimeMs, before.mtimeMs, "an already active bundle must not be rewritten");
	// The re-verification is read-only, so it must not chmod either. On POSIX a chmod moves ctime even
	// when the mode value stays the same, which is what makes that timestamp able to catch one.
	assert.equal(after.mode, before.mode, "an already active bundle must not be chmodded");
	if (POSIX) assert.equal(after.ctimeMs, before.ctimeMs, "a read-only re-verification must not touch the active bundle metadata");
	// The redundant staging copy is still dropped and the lock released.
	await assert.rejects(lstat(stagingOf(home)), /ENOENT/);
	await assert.rejects(lstat(lockPathOf(home)), /ENOENT/);
});

/**
 * Pre-create the deploy hierarchy for a test that needs an existing bundle. The entry refuses a deploy
 * root that is not private, and a plain mkdir would inherit the umask (0755 on POSIX), so every level
 * gets its mode set explicitly — on some filesystems the mode passed to mkdir is ignored.
 */
async function makePrivateActiveDirectory(home) {
	const levels = [join(home, ".pideck"), deployRootOf(home), bundlesOf(home), activeOf(home)];
	for (const level of levels) {
		await mkdir(level, { recursive: true, mode: 0o700 });
		await chmod(level, 0o700);
	}
	return activeOf(home);
}

test("an already active directory with different content is never overwritten", async (t) => {
	const home = await temporaryHome(t);
	const file = stagedFile("helper.mjs", "declared-body\n");
	const active = await makePrivateActiveDirectory(home);
	const activeFile = join(active, file.name);
	await writeFile(activeFile, "somebody-elses-body\n", { mode: 0o600 });
	const before = await stat(activeFile);
	const session = await startStagingSession(home);
	await stageFile(home, file);
	session.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "error"],
	);
	assert.equal(result.frames[1].code, "BOOTSTRAP_ACTIVE_CONFLICT");
	assert.equal(await readFile(activeFile, "utf8"), "somebody-elses-body\n");
	assert.equal((await stat(activeFile)).mtimeMs, before.mtimeMs);
	await assert.rejects(lstat(stagingOf(home)), /ENOENT/);
	await assert.rejects(lstat(lockPathOf(home)), /ENOENT/);
});

test("a staged file that does not match the declaration fails closed with BOOTSTRAP_FILE_MISMATCH", async (t) => {
	const cases = [
		{ title: "same byte count, different bytes", declared: stagedFile("helper.mjs", "aaaa"), uploaded: "bbbb" },
		{ title: "different byte count", declared: stagedFile("helper.mjs", "aaaa"), uploaded: "aaaaa" },
		{ title: "a declared file that was never uploaded", declared: stagedFile("helper.mjs", "aaaa"), uploaded: null },
	];
	for (const item of cases) {
		const home = await temporaryHome(t);
		const session = await startStagingSession(home);
		if (item.uploaded !== null) await stageFile(home, { ...item.declared, text: item.uploaded });
		session.write(beginFrame(1), fileFrame(item.declared), COMMIT_FRAME);
		const result = await session.finish();
		assert.notEqual(result.code, 0, item.title);
		assert.deepEqual(
			result.frames.map((frame) => frame.op),
			["ready", "error"],
			item.title,
		);
		assert.equal(result.frames[1].code, "BOOTSTRAP_FILE_MISMATCH", item.title);
		await assertNothingActivated(home, item.title);
	}
});

test("a symlinked staged file is refused instead of followed", async (t) => {
	const home = await temporaryHome(t);
	const declared = stagedFile("helper.mjs", "helper-body\n");
	const session = await startStagingSession(home);
	// The link carries the declared name and points at a real file holding the declared bytes, so only
	// the "must be a regular file, not a symlink" rule can reject this run.
	const target = join(home, "elsewhere.mjs");
	await writeFile(target, declared.text, { mode: 0o600 });
	const link = join(stagingOf(home), declared.name);
	try {
		await symlink(target, link, "file");
	} catch (error) {
		// Windows without the symlink privilege cannot create file links; a junction is the same "not a
		// regular file" answer for the entry (lstat reports it as a symlink).
		if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error.code)) throw error;
		const directory = join(home, "junction-target");
		await mkdir(directory, { recursive: true });
		await symlink(directory, link, "junction");
	}
	session.write(beginFrame(1), fileFrame(declared), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "error"],
	);
	assert.equal(result.frames[1].code, "BOOTSTRAP_FILE_MISMATCH");
	await assertNothingActivated(home, "symlink");
});

test("a commit that covers fewer files than begin declared fails with BOOTSTRAP_FINALIZE_INCOMPLETE", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const first = stagedFile("helper.mjs", "helper\n");
	const second = stagedFile("runner.mjs", "runner\n");
	await stageFile(home, first);
	await stageFile(home, second);
	// begin declares two files, the commit arrives with one: the count is what must fail, not the bytes.
	session.write(beginFrame(2), fileFrame(first), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "error"],
	);
	assert.equal(result.frames[1].code, "BOOTSTRAP_FINALIZE_INCOMPLETE");
	await assertNothingActivated(home, "incomplete");
});

test("a staged mode that deviates from the declaration is forced to the declared mode", async (t) => {
	// The uploader is not trusted to preserve POSIX modes: a Windows host hands over the synthetic
	// 0644/0666 it made up, scp -p included, so a mismatching staged mode must be repaired rather than
	// rejected. Both frozen modes are covered so a hardcoded chmod target cannot pass.
	const cases = [
		{ declared: stagedFile("helper.mjs", "export const helper = 1;\n", "0600"), uploaded: "0644" },
		{ declared: stagedFile("bootstrap.mjs", "#!/usr/bin/env node\nrun();\n", "0700"), uploaded: "0600" },
	];
	for (const item of cases) {
		const home = await temporaryHome(t);
		const session = await startStagingSession(home);
		const staged = await stageFile(home, item.declared, item.uploaded);
		if (POSIX) {
			// writeFile is masked by umask, so pin the uploaded mode explicitly: the case only proves
			// anything while the staged file really deviates from the declaration.
			await chmod(staged, Number.parseInt(item.uploaded, 8));
			assert.equal(await modeText(staged), item.uploaded, item.declared.name);
		}
		session.write(beginFrame(1), fileFrame(item.declared), COMMIT_FRAME);
		const result = await session.finish();
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(
			result.frames.map((frame) => frame.op),
			["ready", "finalized"],
			item.declared.name,
		);
		const active = join(activeOf(home), item.declared.name);
		assert.equal(await readFile(active, "utf8"), item.declared.text);
		// Windows has no real mode (stat reports a synthetic value), so only POSIX can assert the result.
		if (POSIX) assert.equal(await modeText(active), item.declared.mode, item.declared.name);
	}
});

/**
 * A foreign-owned staged file can only be produced with chown, i.e. by a privileged run. The owner rule
 * is additionally pinned as a source-level sequence in "the inline source keeps its fixed protocol
 * vocabulary", so an unprivileged run still fails loudly if that gate is dropped.
 */
const CAN_STAGE_FOREIGN_OWNER = POSIX && process.getuid() === 0;

test("a staged file owned by another user is still refused with BOOTSTRAP_MODE_INVALID", { skip: CAN_STAGE_FOREIGN_OWNER ? false : "root only: chown is what stages a foreign-owned file" }, async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const declared = stagedFile("helper.mjs", "helper\n");
	const staged = await stageFile(home, declared);
	await chown(staged, 1, 1);
	session.write(beginFrame(1), fileFrame(declared), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "error"],
	);
	assert.equal(result.frames[1].code, "BOOTSTRAP_MODE_INVALID");
	await assertNothingActivated(home, "foreign owner");
});

test("an abort before the commit point cleans up and never activates anything", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const file = stagedFile("helper.mjs", "helper\n");
	await stageFile(home, file);
	session.write(beginFrame(1), fileFrame(file), ABORT_FRAME);
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "aborted"],
	);
	assert.deepEqual(result.frames[1], { v: 1, op: "aborted", reason: "requested" });
	await assertNothingActivated(home, "abort");
});

test("an abort that lands on the commit point still reports the deployment it cannot undo", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const files = [stagedFile("helper.mjs", "helper\n"), stagedFile("runner.mjs", "runner\n")];
	for (const file of files) await stageFile(home, file);
	// commit and abort travel in one stdin write: the abort is already queued while the commit is
	// underway. The rename cannot be undone, so the terminal frame has to report the deployment —
	// answering "aborted" would tell the caller nothing was deployed while the bundle sits there.
	session.write(beginFrame(files.length), ...files.map((file) => fileFrame(file)), COMMIT_FRAME, ABORT_FRAME);
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "finalized"],
	);
	assert.deepEqual(result.frames[1], { v: 1, op: "finalized", active: `./bundles/${BUNDLE_SHA}`, files: files.length });
	for (const file of files) assert.equal(await readFile(join(activeOf(home), file.name), "utf8"), file.text);
	await assert.rejects(lstat(stagingOf(home)), /ENOENT/);
	await assert.rejects(lstat(lockPathOf(home)), /ENOENT/);
});

test("stdin EOF (the ssh connection died) aborts without activating anything", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const file = stagedFile("helper.mjs", "helper\n");
	await stageFile(home, file);
	session.write(beginFrame(1), fileFrame(file));
	session.child.stdin.end();
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "aborted"],
	);
	assert.deepEqual(result.frames[1], { v: 1, op: "aborted", reason: "eof" });
	await assertNothingActivated(home, "eof");
});

test("malformed, oversized and out-of-order finalize frames all fail with BOOTSTRAP_INPUT_INVALID", async (t) => {
	const declared = stagedFile("helper.mjs", "helper\n");
	const other = stagedFile("runner.mjs", "runner\n");
	const cases = [
		{ title: "a line that is not JSON", lines: ["not json"] },
		{ title: "a frame that is not an object", lines: ["[]"] },
		{ title: "a frame with an unknown protocol version", lines: [{ ...beginFrame(1), v: 2 }] },
		{ title: "an oversized line", lines: ["x".repeat(REMOTE_BOOTSTRAP_MAX_FRAME_BYTES + 1)] },
		{ title: "a commit before begin", lines: [COMMIT_FRAME] },
		{ title: "a file frame before begin", lines: [fileFrame(declared)] },
		{ title: "a repeated begin", lines: [beginFrame(1), beginFrame(1)] },
		{ title: "a begin with a zero file count", lines: [beginFrame(0)] },
		{ title: "a begin above the file cap", lines: [beginFrame(REMOTE_BUNDLE_MAX_FILES + 1)] },
		{ title: "a begin with a malformed bundle hash", lines: [beginFrame(1, BUNDLE_SHA.toUpperCase())] },
		{ title: "a file name with a separator", lines: [beginFrame(1), fileFrame(declared, { name: "sub/helper.mjs" })] },
		{ title: "a file name with a traversal fragment", lines: [beginFrame(1), fileFrame(declared, { name: "a..b.mjs" })] },
		{ title: "a file name that is a parent directory", lines: [beginFrame(1), fileFrame(declared, { name: ".." })] },
		{ title: "a file name with a NUL byte", lines: [beginFrame(1), fileFrame(declared, { name: "helper\u0000.mjs" })] },
		{ title: "a file name with a newline", lines: [beginFrame(1), fileFrame(declared, { name: "helper\n.mjs" })] },
		{ title: "a malformed digest", lines: [beginFrame(1), fileFrame(declared, { sha256: declared.sha256.toUpperCase() })] },
		{ title: "a negative byte count", lines: [beginFrame(1), fileFrame(declared, { bytes: -1 })] },
		{ title: "a byte count above the per-file cap", lines: [beginFrame(1), fileFrame(declared, { bytes: REMOTE_BUNDLE_MAX_FILE_BYTES + 1 })] },
		{ title: "a mode outside the frozen pair", lines: [beginFrame(1), fileFrame(declared, { mode: "0644" })] },
		{ title: "a numeric mode", lines: [beginFrame(1), fileFrame(declared, { mode: 384 })] },
		{ title: "a duplicated file name", lines: [beginFrame(2), fileFrame(declared), fileFrame(declared)] },
		{ title: "more file frames than begin declared", lines: [beginFrame(1), fileFrame(declared), fileFrame(other)] },
		{ title: "an unknown field on a finalize frame", lines: [beginFrame(1), fileFrame(declared, { path: "/etc/passwd" })] },
	];
	// The frozen modes are the two the contract pins, so the table above cannot silently accept a third.
	assert.deepEqual(Array.from(REMOTE_BOOTSTRAP_FILE_MODES), ["0600", "0700"]);
	for (const item of cases) {
		const home = await temporaryHome(t);
		const session = await startStagingSession(home);
		await stageFile(home, declared);
		session.write(...item.lines);
		const result = await session.finish();
		assert.notEqual(result.code, 0, item.title);
		assert.deepEqual(
			result.frames.map((frame) => frame.op),
			["ready", "error"],
			item.title,
		);
		assert.equal(result.frames[1].code, "BOOTSTRAP_INPUT_INVALID", item.title);
		await assertNothingActivated(home, item.title);
	}
});

test("a well-formed frame outside the frozen operations is refused as unsupported", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	session.write({ v: 1, op: "upload-chunk", name: "helper.mjs" });
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "error"],
	);
	assert.equal(result.frames[1].code, "BOOTSTRAP_ENTRY_OP_UNSUPPORTED");
	await assertNothingActivated(home, "unsupported");
});

test("the frozen caps hold at the boundary and one past it", async (t) => {
	// A begin at exactly the file cap is accepted: the run only fails later, on the declarations that
	// never arrived, which is what proves the frame itself passed validation.
	const capHome = await temporaryHome(t);
	const capSession = await startStagingSession(capHome);
	capSession.write(beginFrame(REMOTE_BUNDLE_MAX_FILES), COMMIT_FRAME);
	const capResult = await capSession.finish();
	assert.notEqual(capResult.code, 0);
	assert.equal(capResult.frames[1].code, "BOOTSTRAP_FINALIZE_INCOMPLETE");
	await assertNothingActivated(capHome, "file count cap");

	// A declared byte count of exactly the per-file cap is accepted as well: the upload is missing, so
	// the run must fail on the content comparison rather than on the frame.
	const sizeHome = await temporaryHome(t);
	const sizeSession = await startStagingSession(sizeHome);
	sizeSession.write(beginFrame(1), fileFrame(stagedFile("helper.mjs", "helper\n"), { bytes: REMOTE_BUNDLE_MAX_FILE_BYTES }), COMMIT_FRAME);
	const sizeResult = await sizeSession.finish();
	assert.notEqual(sizeResult.code, 0);
	assert.equal(sizeResult.frames[1].code, "BOOTSTRAP_FILE_MISMATCH");
	await assertNothingActivated(sizeHome, "byte count cap");

	// One frame of exactly 4096 bytes is legal: the cap counts the frame without its newline, which is
	// the unit main's own encoder limits.
	const frameHome = await temporaryHome(t);
	const frameSession = await startStagingSession(frameHome);
	frameSession.write(paddedFrame(beginFrame(1), REMOTE_BOOTSTRAP_MAX_FRAME_BYTES), COMMIT_FRAME);
	const frameResult = await frameSession.finish();
	assert.notEqual(frameResult.code, 0);
	assert.equal(frameResult.frames[1].code, "BOOTSTRAP_FINALIZE_INCOMPLETE");
	await assertNothingActivated(frameHome, "frame byte cap");
});

test("every stable code the frozen entry can emit is declared in the frozen vocabulary", () => {
	const declared = new Set([...Array.from(REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES), ...Array.from(REMOTE_BOOTSTRAP_FINALIZE_ERROR_CODES)]);
	const emitted = new Set(REMOTE_BOOTSTRAP_INLINE_SOURCE.match(/BOOTSTRAP_[A-Z_]+|DEPLOY_LOCK_HELD/g) ?? []);
	assert.ok(emitted.size >= 8);
	for (const code of emitted) assert.ok(declared.has(code), code);
});

test("a legal burst larger than the frame cap still deploys the bundle", async (t) => {
	// The cap applies to one frame, not to whatever a single pipe read happens to merge: a bundle whose
	// frames all arrive together must still finalize. (The earlier revision capped the merged buffer and
	// therefore refused every realistic bundle.)
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const files = Array.from({ length: 40 }, (_value, index) => stagedFile(`module-${String(index).padStart(3, "0")}.mjs`, `export const value = ${index};\n`));
	for (const file of files) await stageFile(home, file);
	const outbound = [beginFrame(files.length), ...files.map((file) => fileFrame(file)), COMMIT_FRAME];
	const burst = outbound.map((frame) => JSON.stringify(frame)).join("\n");
	assert.ok(Buffer.byteLength(burst, "utf8") > REMOTE_BOOTSTRAP_MAX_FRAME_BYTES, `the burst must exceed the cap to be meaningful, was ${Buffer.byteLength(burst, "utf8")}`);
	for (const frame of outbound) assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") <= REMOTE_BOOTSTRAP_MAX_FRAME_BYTES);
	session.write(...outbound);
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(
		result.frames.map((frame) => frame.op),
		["ready", "finalized"],
	);
	const active = join(bundlesOf(home), BUNDLE_SHA);
	assert.equal((await readdir(active)).length, files.length);
});

test("the begin frame cannot re-address the bundle away from the argv hash", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const file = stagedFile("helper.mjs", "export const helper = 1;\n");
	await stageFile(home, file);
	// argv announced BUNDLE_SHA; the begin frame tries to name a different content address.
	session.write(beginFrame(1, "c".repeat(64)), fileFrame(file), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.equal(result.frames.at(-1).code, "BOOTSTRAP_INPUT_INVALID");
	assert.equal(await pathExists(join(bundlesOf(home), "c".repeat(64))), false);
	await assertNothingActivated(home, "re-addressed bundle");
});

test("an abort frame carrying extra fields is refused like any other malformed frame", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	session.write({ v: 1, op: "abort", path: "/etc/passwd", extra: true });
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.equal(result.frames.at(-1).code, "BOOTSTRAP_INPUT_INVALID");
	await assertNothingActivated(home, "abort with extra fields");
});

test("names that differ only by case are refused instead of collapsing onto one file", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	session.write(beginFrame(2), fileFrame(stagedFile("Helper.mjs", "export const a = 1;\n")), fileFrame(stagedFile("helper.mjs", "export const a = 1;\n")), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.equal(result.frames.at(-1).code, "BOOTSTRAP_INPUT_INVALID");
	await assertNothingActivated(home, "case-insensitive duplicate name");
});

test("a symlinked active directory is never accepted as the deployed bundle", async (t) => {
	const home = await temporaryHome(t);
	const file = stagedFile("helper.mjs", "export const helper = 1;\n");
	const first = await startStagingSession(home);
	await stageFile(home, file);
	first.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	assert.equal((await first.finish()).code, 0);
	const active = join(bundlesOf(home), BUNDLE_SHA);
	const elsewhere = join(deployRootOf(home), "elsewhere");
	await mkdir(elsewhere, { recursive: true });
	await rename(active, join(elsewhere, BUNDLE_SHA));
	// The path still holds byte-identical content, but it is a link to a directory we do not own.
	await symlink(join(elsewhere, BUNDLE_SHA), active, "junction");

	const second = await startStagingSession(home);
	await stageFile(home, file);
	second.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	const result = await second.finish();
	assert.notEqual(result.code, 0, "a linked active path must not count as an already-deployed bundle");
	assert.equal(result.frames.at(-1).code, "BOOTSTRAP_ACTIVE_CONFLICT");
});

test("closing stdin right after the commit frame does not destroy the commit", async (t) => {
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const file = stagedFile("helper.mjs", "export const helper = 1;\n");
	await stageFile(home, file);
	session.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	session.child.stdin.end();
	const result = await session.finish();
	assert.equal(result.code, 0, result.stderr);
	assert.equal(result.frames.at(-1).op, "finalized", "the commit already happened, so the terminal frame reports it");
	assert.equal(await pathExists(join(bundlesOf(home), BUNDLE_SHA, "helper.mjs")), true);
});

test("an undeclared file left in staging blocks the commit instead of riding into the bundle", async (t) => {
	// The whole directory is renamed, so an unverified leftover would become part of the content-addressed
	// bundle and every later idempotent run would then fail its entry-count comparison forever.
	const home = await temporaryHome(t);
	const session = await startStagingSession(home);
	const file = stagedFile("helper.mjs", "helper\n");
	await stageFile(home, file);
	await stageFile(home, stagedFile("leftover.mjs", "leftover\n"));
	session.write(beginFrame(1), fileFrame(file), COMMIT_FRAME);
	const result = await session.finish();
	assert.notEqual(result.code, 0);
	assert.equal(result.frames.at(-1).code, "BOOTSTRAP_FILE_MISMATCH");
	await assertNothingActivated(home, "undeclared staging entry");
});
