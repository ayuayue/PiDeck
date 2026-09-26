import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { parseSshResolvedRoute, sshRouteDigest } = loadTsCommonJs("src/main/remote/SshRouteDigest.ts");

// Route lines captured from Windows OpenSSH 9.5p2 `ssh -G -F none example.invalid`.
const directConfig = "host example.invalid\nuser administrator\nhostname example.invalid\nport 22\ncanonicalizehostname false\n";
const jumpConfig = `${directConfig}proxyjump ops@jump:2222\n`;

function parsed(stdout, exitCode = 0) {
	return parseSshResolvedRoute({ exitCode, stdout });
}

test("extracts only endpoint identity fields from authenticated-route preflight output", () => {
	const route = parsed(`${jumpConfig}identityfile ~/.ssh/id_a\nidentityfile ~/.ssh/id_b\nforwardagent no\n`);
	assert.deepEqual(JSON.parse(JSON.stringify(route)), {
		hostName: "example.invalid",
		user: "administrator",
		port: 22,
		proxyJump: "ops@jump:2222",
		canonicalizeHostname: "false",
	});
	assert.match(sshRouteDigest(route), /^[0-9a-f]{64}$/);
	assert.equal(sshRouteDigest(route), sshRouteDigest(parsed(`${jumpConfig}identityfile ~/.ssh/new-key\n`)));
});

test("a changed endpoint or jump command changes the route digest", () => {
	const baseline = sshRouteDigest(parsed(directConfig));
	for (const changed of [
		directConfig.replace("hostname example.invalid", "hostname changed.invalid"),
		directConfig.replace("user administrator", "user admin"),
		directConfig.replace("port 22", "port 2222"),
		jumpConfig,
		`${directConfig}proxycommand ssh -W %h:%p bastion\n`,
		`${directConfig}hostkeyalias another-alias\n`,
		directConfig.replace("canonicalizehostname false", "canonicalizehostname yes"),
	]) {
		assert.notEqual(sshRouteDigest(parsed(changed)), baseline);
	}
});

test("missing and explicitly empty optional routes are distinct", () => {
	const absent = parsed(directConfig);
	const empty = parsed(`${directConfig}proxyjump\n`);
	assert.equal(absent.proxyJump, undefined);
	assert.equal(empty.proxyJump, "");
	assert.notEqual(sshRouteDigest(absent), sshRouteDigest(empty));
});

test("accepts real OpenSSH keyword casing while ignoring unrelated options", () => {
	// Captured from Windows OpenSSH 9.5p2: one keyword is printed with an internal capital.
	const route = parsed(`${directConfig}canonicalizePermittedcnames none\naddressfamily any\ncompression no\n`);
	assert.equal(route.hostName, "example.invalid");
	assert.equal(sshRouteDigest(route), sshRouteDigest(parsed(directConfig)));
	// A duplicated route key is still rejected even when spelled with different casing.
	assert.throws(() => parsed(`${directConfig}HostName changed.invalid\n`), /INVALID_SSH_ROUTE/);
});

test("refuses nonzero exit, incomplete config, duplicate route fields and malformed output", () => {
	assert.throws(() => parsed(directConfig, 255), /INVALID_SSH_ROUTE/);
	for (const config of [
		"",
		"hostname example.invalid\nuser administrator\n",
		directConfig.replace("port 22", "port 0"),
		directConfig.replace("port 22", "port 65536"),
		`${directConfig}hostname changed.invalid\n`,
		`${directConfig}proxyjump jump-a\nproxyjump jump-b\n`,
		`${directConfig}UNTRUSTED BANNER\n`,
		`${directConfig}proxyjump jump\0evil\n`,
	]) {
		assert.throws(() => parsed(config), /INVALID_SSH_ROUTE/);
	}
});
