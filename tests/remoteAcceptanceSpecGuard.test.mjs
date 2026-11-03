import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F4 independent verification of the Electron acceptance spec (task-27, J1).
 *
 * An acceptance suite is only evidence if it can fail. This file therefore does three things:
 * 1. exercises the spec's exported pure helpers (credential gating, fingerprint normalization) directly;
 * 2. pins the structural guarantees that make the spec evidence - a gate that skips before any session,
 *    no credential literals under e2e/, one expect per step, and an assertion for each flow step;
 * 3. runs the spec for real, twice: with no credentials (all-skipped, never passed) and with a wrong
 *    fingerprint (genuinely failing at the pin check rather than at a timeout).
 */

const SPEC = "e2e/remoteHostAcceptance.spec.ts";
const FIXTURES = "e2e/remote-fixtures.ts";
const PLAYWRIGHT_CLI = "node_modules/@playwright/test/cli.js";
const CREDENTIAL_VARS = ["PIDECK_E2E_REMOTE_HOST", "PIDECK_E2E_REMOTE_USER", "PIDECK_E2E_REMOTE_FINGERPRINT"];

function specSource(relativePath) {
	return readFileSync(relativePath, "utf8");
}

function fixturesModule() {
	return loadTsCommonJs(FIXTURES, {
		stubs: {
			"@playwright/test": { test: { extend: () => ({}) }, expect: () => undefined },
			"./fixtures": {},
		},
	});
}

test("the credential gate refuses everything that is not a complete credential set", () => {
	const { readRemoteAcceptanceCredentials } = fixturesModule();
	const full = {
		PIDECK_E2E_REMOTE_HOST: "example.invalid",
		PIDECK_E2E_REMOTE_USER: "tester",
		PIDECK_E2E_REMOTE_FINGERPRINT: "SHA256:" + "A".repeat(43),
	};
	const parsed = readRemoteAcceptanceCredentials(full);
	assert.ok(parsed !== undefined, "a complete set must produce credentials");
	assert.equal(parsed.host, "example.invalid");
	assert.equal(parsed.user, "tester");
	assert.equal(parsed.port, 22, "the port must default to 22");
	assert.equal(readRemoteAcceptanceCredentials(Object.assign({}, full, { PIDECK_E2E_REMOTE_PORT: "2222" })).port, 2222);

	const rejected = [
		["an empty environment", {}],
		["a missing user", Object.assign({}, full, { PIDECK_E2E_REMOTE_USER: undefined })],
		["a missing fingerprint", Object.assign({}, full, { PIDECK_E2E_REMOTE_FINGERPRINT: undefined })],
		["an empty host", Object.assign({}, full, { PIDECK_E2E_REMOTE_HOST: "" })],
		["a whitespace-only user", Object.assign({}, full, { PIDECK_E2E_REMOTE_USER: "   " })],
		["a whitespace-only fingerprint", Object.assign({}, full, { PIDECK_E2E_REMOTE_FINGERPRINT: "  " })],
		["a non-numeric port", Object.assign({}, full, { PIDECK_E2E_REMOTE_PORT: "ssh" })],
	];
	for (const pair of rejected) {
		assert.equal(readRemoteAcceptanceCredentials(pair[1]), undefined, pair[0] + " must mean no credentials");
	}
});

test("fingerprint normalization canonicalizes the prefix and keeps the body verbatim", () => {
	const { normalizeRemoteFingerprint } = fixturesModule();
	const body = "a/qeVMKmlbe47KuxZlAzT2rcUTwtHPNNPqnS5uij/DM";
	assert.equal(normalizeRemoteFingerprint("SHA256:" + body), "SHA256:" + body);
	assert.equal(normalizeRemoteFingerprint("  SHA256:" + body + "  "), "SHA256:" + body, "surrounding whitespace is trimmed");
	// The prefix is user-typed, so its case is not a reason to fail a real-host run; the body is not touched.
	assert.equal(normalizeRemoteFingerprint("sha256:" + body), "SHA256:" + body, "a lowercase prefix must be canonicalized, not rejected");
	assert.equal(normalizeRemoteFingerprint("Sha256:" + body), "SHA256:" + body, "mixed case too");
	for (const pair of [
		["an empty segment", "SHA256:"],
		["a doubled prefix", "SHA256:SHA256:" + body],
		["no prefix at all", body],
		["an empty value", ""],
		["a whitespace-only value", "   "],
	]) {
		assert.equal(normalizeRemoteFingerprint(pair[1]), "", pair[0] + " must not normalize to a usable fingerprint");
	}
});

test("a fingerprint comparison is an exact normalized match against the offered set", () => {
	const { matchesRemoteFingerprint } = fixturesModule();
	const good = "SHA256:" + "B".repeat(43);
	assert.equal(matchesRemoteFingerprint(good, [good]), true);
	assert.equal(matchesRemoteFingerprint(good, ["SHA256:" + "C".repeat(43)]), false, "a different key must not match");
	assert.equal(matchesRemoteFingerprint(good, ["SHA256:" + "C".repeat(43), good]), true, "the match may be anywhere in the offered set");
	assert.equal(matchesRemoteFingerprint("", [good]), false, "an unusable expectation must never match");
});

test("the spec gates on credentials before any Electron session can start", () => {
	const source = specSource(SPEC);
	assert.match(source, /test\.skip\(\s*[A-Za-z0-9_.]*credentials\s*===\s*undefined/, "the spec must skip when the credential set is absent");
	assert.ok(!source.includes("test.fixme"), "a fixme would hide the spec instead of gating it");
	assert.ok(!/test\.describe\.skip/.test(source), "a static describe.skip would not be a conditional gate");
	const gateIndex = source.indexOf("test.skip(");
	const firstBodyIndex = source.search(/test\(\s*"/);
	assert.ok(gateIndex >= 0, "the gate must exist");
	assert.ok(firstBodyIndex < 0 || gateIndex < firstBodyIndex, "the gate must be evaluated before the first test body runs");
	assert.ok(!/EXPECT_FAIL|ALLOW_FAILURE|PIDECK_E2E_ACCEPT_ANY/i.test(source), "no environment value may flip the spec to passing");
});

test("the remote oracle closes stdin and retries only a local timeout", () => {
	const source = specSource(FIXTURES);
	assert.match(source, /\["-n", "-o", "BatchMode=yes"/, "the oracle must not leave Windows OpenSSH waiting on local stdin");
	assert.match(source, /const timedOut = failure\.killed === true \|\| failure\.code === "ETIMEDOUT"/, "a killed oracle must be distinguishable from a remote command result");
	assert.match(source, /if \(!timedOut && failure\.code !== 255/, "timeouts and dropped connections share exactly one retry path");
});

test("no credential is committed anywhere under e2e/", () => {
	for (const name of readdirSync("e2e")) {
		if (!name.endsWith(".ts")) continue;
		const source = specSource("e2e/" + name);
		assert.ok(!source.includes("10.81.2.15"), "e2e/" + name + " must not contain the real host");
		assert.ok(!source.includes("zhadainian"), "e2e/" + name + " must not contain the real user");
		assert.ok(!source.includes("a/qeVMKmlbe47KuxZlAzT2rcUTwtHPNNPqnS5uij"), "e2e/" + name + " must not contain the real fingerprint");
		assert.ok(!/SHA256:[A-Za-z0-9+/]{43}/.test(source), "e2e/" + name + " must not contain a literal fingerprint");
	}
});

test("every acceptance step asserts something, and the whole flow is covered", () => {
	const source = specSource(SPEC);
	const steps = source.match(/test\.step\(/g) ?? [];
	const expects = source.match(/expect\(/g) ?? [];
	assert.ok(steps.length >= 4, "the flow should be split into explicit steps, found " + steps.length);
	assert.ok(expects.length >= steps.length, "every step needs at least one assertion: " + expects.length + " expects for " + steps.length + " steps");
	const required = [
		["the credential environment variables", /PIDECK_E2E_REMOTE_HOST[\s\S]{0,120}PIDECK_E2E_REMOTE_USER[\s\S]{0,120}PIDECK_E2E_REMOTE_FINGERPRINT/],
		["the pin fingerprint check", /fingerprint/i],
		["the ready state", /"ready"|'ready'/],
		["the remote sessions list", /remoteSessions|remote-sessions/i],
		["the provisional title rule", /authoritative/],
		["the needs-attention tag", /remote-project-needs-attention/],
		["the neighbour stays healthy", /needs-attention[\s\S]{0,600}?\bok\b/],
		["no new session is created", /data-session-id/],
		["the repeated import receipt", /created/],
	];
	for (const pair of required) assert.match(source, pair[1], "the spec must assert " + pair[0]);
	// The pin step must assert the very predicate this guard injects against, so "a wrong key makes that
	// predicate false" really is about the acceptance spec's own assertion and not a lookalike.
	assert.match(source, /expect\(\s*matchesRemoteFingerprint\([\s\S]{0,240}?\)[\s\S]{0,80}?\.toBe\(true\)/, "the pin step must assert the exact fingerprint comparison");
});

/* 3. Real runs: the point of an acceptance spec is that it can fail. */

/**
 * All error messages in a Playwright JSON report, wherever the reporter nested them.
 *
 * A failure can surface as `results[].errors[].message` (with a `location`), as `results[].error.message`
 * (with a `stack`) or on a failed step; spec/test nodes are the only ones that carry a `title`, so titles
 * are the one thing excluded here. Looking only for location-less messages silently missed every real
 * acceptance failure — the wrong-fingerprint control then "failed" with an empty message list.
 */
function errorMessages(report) {
	const messages = [];
	const walk = (node) => {
		if (node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (typeof node.message === "string" && node.title === undefined) messages.push(node.message);
		for (const key of ["suites", "specs", "tests", "results", "errors", "steps", "error"]) if (node[key] !== undefined) walk(node[key]);
	};
	walk(report);
	return messages;
}

function runSpec(env, timeoutMs, specPath = SPEC) {
	const result = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "test", specPath, "--reporter=json"], {
		cwd: process.cwd(),
		env: env,
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
	const text = (result.stdout ?? "") + (result.stderr ?? "");
	const start = text.indexOf("{");
	let report;
	if (start >= 0) {
		try {
			report = JSON.parse(text.slice(start));
		} catch {
			report = undefined;
		}
	}
	return { status: result.status, text: text, report: report, stats: report?.stats };
}

test("without credentials the spec is skipped, never passed", { timeout: 300000 }, () => {
	const env = Object.assign({}, process.env);
	for (const name of CREDENTIAL_VARS) delete env[name];
	const run = runSpec(env, 240000);
	assert.ok(run.report !== undefined, "the JSON reporter must produce a report:\n" + run.text.slice(-2000));
	const collected = run.stats.expected + run.stats.skipped + run.stats.unexpected;
	assert.ok(collected >= 1, "the spec collected no tests at all (syntax error or empty spec), so it is not evidence yet:\n" + run.text.slice(-2000));
	assert.ok(run.stats.skipped >= 1, "the spec must report at least one skipped case, got " + JSON.stringify(run.stats));
	assert.equal(run.stats.expected, 0, "nothing may report as passed without credentials");
	assert.equal(run.stats.unexpected, 0, "nothing may fail without credentials either");
	assert.equal(run.status, 0, "a fully skipped run exits zero");
});

test("with a wrong fingerprint the spec really fails at the pin check", { timeout: 900000 }, (t) => {
	const host = process.env.PIDECK_E2E_REMOTE_HOST;
	const user = process.env.PIDECK_E2E_REMOTE_USER;
	if (!host || !user) {
		t.skip("no real-host credentials in this environment; the wrong-fingerprint control was not executed here");
		return;
	}
	const env = Object.assign({}, process.env, {
		PIDECK_E2E_REMOTE_HOST: host,
		PIDECK_E2E_REMOTE_USER: user,
		PIDECK_E2E_REMOTE_FINGERPRINT: "SHA256:" + "A".repeat(43),
		PIDECK_E2E_REMOTE_CONNECT_TIMEOUT_MS: process.env.PIDECK_E2E_REMOTE_CONNECT_TIMEOUT_MS ?? "30000",
	});
	const run = runSpec(env, 840000);
	assert.ok(run.report !== undefined, "the JSON reporter must produce a report:\n" + run.text.slice(-2000));
	const messages = errorMessages(run.report);
	const launchFailure = messages.some((message) => /Process failed to launch|electron\.launch/i.test(message)) || /Process failed to launch/i.test(run.text);
	if (launchFailure) {
		// Electron itself is fine (`electron.exe --version` works); it is the piped launch under this
		// execution sandbox that fails. Prove it is environmental before skipping: the pre-existing smoke
		// spec has to fail in exactly the same way, otherwise this would be hiding a real regression.
		const baseline = runSpec(env, 240000, "e2e/smoke.spec.ts");
		assert.ok(/Process failed to launch|electron\.launch/i.test(baseline.text), "if the acceptance spec cannot launch Electron, the baseline smoke spec must fail identically");
		t.skip("Electron cannot be launched from this execution sandbox (baseline e2e/smoke.spec.ts fails identically with 'Process failed to launch!'); the wrong-fingerprint control was NOT executed here");
		return;
	}
	assert.equal(run.stats.skipped, 0, "a complete but wrong credential set must not be skipped");
	assert.ok(run.stats.unexpected >= 1, "the spec must fail against a host key it was not told to expect");
	// The failure must be the pin comparison itself - not a timeout, and not some later step.
	assert.ok(
		messages.some((message) => /指纹|fingerprint/i.test(message)),
		"the failing assertion must be the pin fingerprint comparison, got: " + JSON.stringify(messages).slice(0, 1500),
	);
	assert.ok(!messages.some((message) => /timeout of \d+ms exceeded/i.test(message)), "a timeout must not be mistaken for the pin refusal");
});
