import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSshConfigQueryArgs } = loadTsCommonJs("src/main/remote/SshCommandBuilder.ts");

test("builds a candidate config query without pinning a not-yet-verified endpoint", () => {
	assert.deepEqual(Array.from(buildSshConfigQueryArgs({ sshHost: "work-server", user: "deploy", port: 2222, proxyJump: "ops@bastion:2200,[2001:db8::2]:2222" })), [
		"-G",
		"-o",
		"BatchMode=yes",
		"-o",
		"PermitLocalCommand=no",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ClearAllForwardings=yes",
		"-l",
		"deploy",
		"-p",
		"2222",
		"-J",
		"ops@bastion:2200,[2001:db8::2]:2222",
		"work-server",
	]);
	assert.equal(buildSshConfigQueryArgs({ sshHost: "2001:db8::1" }).at(-1), "2001:db8::1");
});

test("rejects host and user text that could alter SSH argument or config semantics", () => {
	for (const sshHost of ["-oProxyCommand=evil", "user@host", "work server", "host\nproxycommand evil", "host\0name", "host;touch /tmp/file", "%h", ""]) {
		assert.throws(() => buildSshConfigQueryArgs({ sshHost }), /INVALID_SSH_HOST/);
	}
	for (const user of ["-o", "user name", "user\nPermitLocalCommand yes", "user@host", ""]) {
		assert.throws(() => buildSshConfigQueryArgs({ sshHost: "example", user }), /INVALID_SSH_USER/);
	}
});

test("rejects invalid SSH ports instead of coercing or passing them to OpenSSH", () => {
	for (const port of [0, -1, 65536, 1.5, Number.NaN, "22", "22 -o StrictHostKeyChecking=no"]) {
		assert.throws(() => buildSshConfigQueryArgs({ sshHost: "example", port }), /INVALID_SSH_PORT/);
	}
});

test("rejects unsafe or ambiguous jump syntax before creating argv", () => {
	for (const proxyJump of ["-oProxyCommand=evil", "jump,-oProxyCommand=evil", "jump,,other", "user@", "jump:0", "jump:65536", "jump:22;id", "jump\n-oStrictHostKeyChecking=no", "user name@jump", "[not-ipv6]:22", "none", "jump%h", "a".repeat(254)]) {
		assert.throws(() => buildSshConfigQueryArgs({ sshHost: "example", proxyJump }), /INVALID_SSH_PROXY_JUMP/);
	}
});
