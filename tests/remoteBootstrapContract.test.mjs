import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION, REMOTE_BUNDLE_MAX_FILES, REMOTE_BUNDLE_MAX_FILE_BYTES, REMOTE_BUNDLE_MAX_TOTAL_BYTES } = contract;
const {
	assertActivationPreconditions,
	buildBootstrapCommand,
	buildStagingIdentity,
	decodeBundleManifest,
	quotePosixArgument,
	resolveBootstrapDeployRoot,
	verifyBundleFiles,
	REMOTE_BOOTSTRAP_ENTRY_ERROR_CODES,
	REMOTE_BOOTSTRAP_ENTRY_FILE_MODE,
	REMOTE_BOOTSTRAP_ERROR_CODES,
	REMOTE_BOOTSTRAP_FILE_MODE,
	REMOTE_BOOTSTRAP_INLINE_ENTRY,
	REMOTE_BOOTSTRAP_INLINE_SOURCE,
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
});

test("the inline entry is byte-frozen", () => {
	// This entry is the only code that runs on a remote before anything is deployed, so any edit must
	// be deliberate: update this digest in the same commit that changes REMOTE_BOOTSTRAP_INLINE_SOURCE.
	const digest = createHash("sha256").update(REMOTE_BOOTSTRAP_INLINE_SOURCE, "utf8").digest("hex");
	assert.equal(digest, "97dc2b4d886223440fa26712ad8572ac6c4c43f59d9de5a360eb738a82da1acb");
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
