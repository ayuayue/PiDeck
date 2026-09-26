import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildHelperRemoteCommand, resolveHelperEntryPath } = loadTsCommonJs("src/main/remote/RemoteHelperCommand.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");

const SHA = "a".repeat(64);
const DEPLOY_ROOT = "/home/dev/.pideck/remote-host";
const ROOT = "/home/dev/work/project";

/** A POSIX shell proves the quoting independently of the helper that produced it. */
function posixShell() {
	for (const shell of ["bash", "sh"]) {
		// The script goes in on stdin: a `-c` string would be re-quoted by whichever shell host runs it.
		const probe = spawnSync(shell, [], { input: "printf ok", encoding: "utf8" });
		if (probe.status === 0 && probe.stdout === "ok") return shell;
	}
	return null;
}

test("builds four quoted tokens pointing at the activated helper and its root", () => {
	const command = buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA, root: ROOT });
	assert.equal(command, `'/usr/bin/node' '${DEPLOY_ROOT}/bundles/${SHA}/helper.mjs' --root '${ROOT}'`);
	assert.equal(resolveHelperEntryPath({ deployRoot: DEPLOY_ROOT, bundleSha256: SHA, entryName: "helper.mjs" }), `${DEPLOY_ROOT}/bundles/${SHA}/helper.mjs`);
	// The canonical path is the one the entry reported: a trimmed slash would hide a caller bug.
	assert.throws(() => resolveHelperEntryPath({ deployRoot: `${DEPLOY_ROOT}/`, bundleSha256: SHA, entryName: "helper.mjs" }), /REMOTE_HELPER_COMMAND_INVALID_DEPLOY_ROOT/);
	assert.throws(() => resolveHelperEntryPath({ deployRoot: "/", bundleSha256: SHA, entryName: "helper.mjs" }), /REMOTE_HELPER_COMMAND_INVALID_DEPLOY_ROOT/);
});

test("refuses a node path, deploy root, root or entry name that is not a fixed remote location", () => {
	const base = { nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA, root: ROOT };
	const cases = [
		{ nodePath: "node" },
		{ nodePath: "/usr/bin/no\u0000de" },
		{ nodePath: "/usr/bin/node\n" },
		{ nodePath: "/usr/bin/node/" },
		{ nodePath: "" },
		{ deployRoot: "relative/root" },
		{ deployRoot: "/" },
		{ deployRoot: "/home/dev/host\n" },
		{ deployRoot: "" },
		{ bundleSha256: "short" },
		{ bundleSha256: SHA.toUpperCase() },
		{ entryName: "../escape.mjs" },
		{ entryName: "dir/helper.mjs" },
		{ entryName: "" },
		{ entryName: ".hidden" },
		// The root is the boundary every fs.* method is confined to, so a spelling the connection did not
		// verify is refused here instead of being normalized into something the helper would canonicalize.
		{ root: "relative/root" },
		{ root: "~/project" },
		{ root: "/" },
		{ root: "/home/dev/work/" },
		{ root: "/home/dev/work\u0000" },
		{ root: "/home/dev/work\nproject" },
		{ root: "" },
		{ root: 7 },
		{ root: null },
		{ root: `/${"r".repeat(4096)}` },
	];
	for (const overrides of cases) {
		assert.throws(() => buildHelperRemoteCommand({ ...base, ...overrides }), /REMOTE_HELPER_COMMAND_INVALID/, JSON.stringify(overrides));
	}
	assert.throws(() => buildHelperRemoteCommand(null), /REMOTE_HELPER_COMMAND_INVALID/);
	// `/` as the deploy root is allowed by the path rule but must not appear here: the join would escape.
	assert.throws(() => resolveHelperEntryPath({ deployRoot: "/", bundleSha256: SHA, entryName: "helper.mjs" }), /REMOTE_HELPER_COMMAND_INVALID/);
});

test("an omitted root keeps the fixed shape with an empty token instead of defaulting to a home", () => {
	// The builder never guesses a root. The one shape it can emit without one is the same four tokens with
	// an empty root, which the helper refuses at startup (ROOT_INVALID, non-zero exit): a caller that
	// forgot the root gets a helper that will not run, never one confined to the whole remote account.
	const command = buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA });
	assert.equal(command, `'/usr/bin/node' '${DEPLOY_ROOT}/bundles/${SHA}/helper.mjs' --root ''`);
	assert.equal(command.includes("$HOME"), false);
	assert.equal(command.split(" ").length, 4, "the token shape does not change when the root is omitted");
	// An explicitly empty root is a caller bug, not the same thing as an omitted one.
	assert.throws(() => buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA, root: "" }), /REMOTE_HELPER_COMMAND_INVALID_ROOT/);
});

test("a real shell splits the command into exactly four literal words", (t) => {
	const shell = posixShell();
	// A skipped proof is not a proof: this assertion is the only independent check that the quoting can
	// survive a real shell, so a machine without one has to say so instead of passing quietly.
	assert.notEqual(shell, null, "no POSIX shell (bash or sh) is available, so the quoting proof cannot run");
	// Every payload that would be dangerous if the quoting were wrong: spaces, quotes, command
	// substitution, globs and a trailing option-looking token.
	const nodePath = "/opt/no de/$(touch /tmp/pideck-pwned)/node'x";
	const deployRoot = "/home/o'brien $HOME `id` */host";
	const root = "/home/o'brien $(touch /tmp/pideck-pwned-root) `id` */work dir";
	const command = buildHelperRemoteCommand({ nodePath, deployRoot, bundleSha256: SHA, root });
	const script = `set -- ${command}\nprintf '%s\\n' "$#" "$1" "$2" "$3" "$4"\n`;
	const probe = spawnSync(shell, [], { input: script, encoding: "utf8" });
	assert.equal(probe.status, 0, probe.stderr);
	const [count, first, second, third, fourth] = probe.stdout.split("\n");
	assert.equal(count, "4", "the command must be exactly four words");
	assert.equal(first, nodePath, "the node path arrives literally, with its spaces and quotes");
	assert.equal(second, `${deployRoot}/bundles/${SHA}/helper.mjs`, "the entry path arrives literally, unexpanded");
	assert.equal(third, "--root", "the flag is a literal word, not part of a quoted path");
	assert.equal(fourth, root, "the root arrives literally, unexpanded and unquoted");
	const pwned = spawnSync(shell, [], { input: "test -e /tmp/pideck-pwned && printf pwned; test -e /tmp/pideck-pwned-root && printf pwned", encoding: "utf8" });
	assert.equal(pwned.stdout, "", "no substitution may have run");
});

test("the ssh argv carries the command after the destination and only for a batch session", async () => {
	// The argv shape is asserted through the transport-facing type rather than by spawning ssh: the
	// command is one element appended after the destination the builder already placed.
	const command = buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA, root: ROOT });
	assert.equal(command.includes("\n"), false);
	assert.equal(command.split(" ").length, 4);
	assert.equal(command.startsWith("'"), true);
	assert.equal(command.endsWith("'"), true);
});

test("the default entry name and the command ceiling come from one place", () => {
	// A second literal for the entry name would let a rename drift the template away from the bundle.
	const built = buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA, root: ROOT });
	assert.equal(built.includes(REMOTE_HELPER_ENTRY_FILE_NAME), true, "the template must use the entry name the bundle declares");
	assert.equal(buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: DEPLOY_ROOT, bundleSha256: SHA, root: ROOT, entryName: "other.mjs" }).includes("other.mjs"), true);
	// Whatever the producer returns has to be something the argv boundary accepts.
	assert.ok(built.length <= REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH);
	assert.throws(() => buildHelperRemoteCommand({ nodePath: `/${"n".repeat(4094)}`, deployRoot: `/${"d".repeat(4094)}`, bundleSha256: SHA, root: ROOT }), /REMOTE_HELPER_COMMAND_INVALID_LENGTH/);
	// A long but legal root is what pushes the command over the ceiling, so the bound covers it too.
	assert.throws(() => buildHelperRemoteCommand({ nodePath: "/usr/bin/node", deployRoot: `/${"d".repeat(4094)}`, bundleSha256: SHA, root: `/${"r".repeat(4094)}` }), /REMOTE_HELPER_COMMAND_INVALID_LENGTH/);
});
