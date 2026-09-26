import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createConnectionDiagnostic, createDiagnosticHistory, diagnosticCodeFromError, formatConnectionDiagnostic } = loadTsCommonJs("src/main/remote/SshConnectionDiagnostics.ts");

const hostId = "01234567-89ab-4def-8123-456789abcdef";

function entry(overrides = {}) {
	return { hostId, generation: 1, state: "connecting", phase: "openssh", code: "SSH_CONNECTION_ATTEMPT", at: "2027-01-02T03:04:05.678Z", ...overrides };
}

test("keeps only enumerable fields and rejects anything that could carry free text", () => {
	const accepted = createConnectionDiagnostic(entry({ exitCode: 255 }));
	assert.equal(accepted.exitCode, 255);
	// A rejected field is a programming error, not a silent drop: streaming a command line into the
	// diagnostic history must fail loudly.
	const rejected = [{ hostId: "not-a-uuid" }, { generation: -1 }, { generation: 1.5 }, { state: "connected" }, { phase: "shell" }, { code: "ssh client unavailable: C:\\Users\\me\\.ssh\\id_ed25519" }, { code: "lower_case" }, { at: "2027-01-02 03:04:05" }, { at: "2027-13-02T03:04:05.678Z" }, { exitCode: 300 }];
	for (const override of rejected) assert.throws(() => createConnectionDiagnostic(entry(override)), /SSH_DIAGNOSTIC_INVALID/, JSON.stringify(override));
	// Unknown extra fields are dropped rather than persisted.
	const trimmed = createConnectionDiagnostic({ ...entry(), commandLine: "ssh -i /secret/key work" });
	assert.deepEqual(Object.keys(trimmed).sort(), ["at", "code", "generation", "hostId", "phase", "state"]);
});

test("maps arbitrary errors to stable codes without leaking their text", () => {
	assert.equal(diagnosticCodeFromError(new Error("SSH_CLIENT_MISSING")), "SSH_CLIENT_MISSING");
	assert.equal(diagnosticCodeFromError(new Error("spawn C:\\Program Files\\OpenSSH\\ssh.exe ENOENT")), "SSH_CONNECTION_FAILED");
	assert.equal(diagnosticCodeFromError("random string"), "SSH_CONNECTION_FAILED");
	assert.equal(diagnosticCodeFromError(undefined), "SSH_CONNECTION_FAILED");
	assert.equal(diagnosticCodeFromError(Object.assign(new Error("boom"), { code: 255 })), "SSH_CONNECTION_FAILED");
});

test("history is bounded, per-host filterable and defensive against later mutation", () => {
	const history = createDiagnosticHistory({ limit: 3 });
	for (let index = 0; index < 5; index += 1) history.record(entry({ generation: index, code: `SSH_ATTEMPT_${index}` }));
	const all = Array.from(history.list());
	assert.equal(all.length, 3);
	assert.deepEqual(
		all.map((item) => item.generation),
		[2, 3, 4],
	);
	const other = history.list("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
	assert.equal(other.length, 0);
	all[0].code = "MUTATED";
	assert.equal(Array.from(history.list())[0].code, "SSH_ATTEMPT_2");
	history.clear();
	assert.equal(Array.from(history.list()).length, 0);
});

test("formatted lines expose ids, phases and codes only", () => {
	const line = formatConnectionDiagnostic(entry({ state: "reconnecting", phase: "authenticate", code: "SSH_HOST_ROUTE_CHANGED", generation: 7, exitCode: 255 }));
	assert.equal(line, `ssh host=${hostId} gen=7 phase=authenticate state=reconnecting code=SSH_HOST_ROUTE_CHANGED exit=255 at=2027-01-02T03:04:05.678Z`);
	assert.equal(/\\\\|\/|ssh -|ProxyCommand/.test(line), false);
	assert.throws(() => formatConnectionDiagnostic(entry({ code: "bad code" })), /SSH_DIAGNOSTIC_INVALID/);
});
