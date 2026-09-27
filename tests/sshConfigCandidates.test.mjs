import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * `~/.ssh/config` 候选解析。
 *
 * 这份解析器喂给「添加主机」的候选列表，因此两条纪律必须成立：
 * 1. 只列出**具体主机**——通配块是默认值，不是主机；
 * 2. 无法忠实展开的指令（Match/Include/Proxy*）宁可整块跳过，也不给出半套语义的目标。
 */

const { parseSshConfig, describeSshConfigCandidate } = loadTsCommonJs("src/main/remote/SshConfigCandidates.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a plain host block becomes one candidate", () => {
	const { candidates, skipped } = plain(
		parseSshConfig(`Host serve
    HostName 10.81.2.15
    User zhadainian
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
`),
	);
	assert.deepEqual(candidates, [{ alias: "serve", hostName: "10.81.2.15", user: "zhadainian", port: 2222, identityFile: "~/.ssh/id_ed25519" }]);
	assert.deepEqual(skipped, []);
});

test("omitted fields fall back the way OpenSSH does", () => {
	// HostName 缺省 = 别名；User 缺省 = 当前用户；Port 缺省 = 22。这里只断言解析层，
	// 显示层的缺省由 describeSshConfigCandidate 统一负责。
	const { candidates } = plain(parseSshConfig("Host gitee.com\n"));
	assert.deepEqual(candidates, [{ alias: "gitee.com", hostName: "gitee.com", user: "", port: null, identityFile: null }]);
	assert.deepEqual(plain(describeSshConfigCandidate(candidates[0], "localuser")), { target: "gitee.com", user: "localuser", port: 22 });
});

test("the first occurrence of a directive wins within a block", () => {
	// OpenSSH 首个匹配生效；后写的同名值不该覆盖（否则解析出的目标与 ssh 实际连的不是同一台）。
	const { candidates } = plain(parseSshConfig("Host h\n  HostName first.example\n  HostName second.example\n  Port 22\n  Port 2200\n"));
	assert.equal(candidates[0].hostName, "first.example");
	assert.equal(candidates[0].port, 22);
});

test("wildcard blocks are not offered as hosts", () => {
	// `Host *` 是默认值块。把它列成主机等于让用户添加一台叫「*」的机器。
	const { candidates, skipped } = plain(
		parseSshConfig(`Host *
    ServerAliveInterval 60

Host *.example.com
    User deploy

Host real.example.com
    User ops
`),
	);
	assert.deepEqual(
		candidates.map((c) => c.alias),
		["real.example.com"],
	);
	assert.deepEqual(skipped, [
		{ alias: "*", reason: "wildcard" },
		{ alias: "*.example.com", reason: "wildcard" },
	]);
});

test("blocks carrying directives we cannot expand faithfully are skipped, not guessed", () => {
	// 静默按半套语义解析出的目标比不解析更危险：用户会以为「连上了我配的那台」。
	const { candidates, skipped } = plain(
		parseSshConfig(`Host via-jump
    HostName internal.corp
    ProxyJump bastion

Host with-match
    Match host x
    HostName m.example

Host with-include
    Include ~/.ssh/other.conf

Host fine
    HostName ok.example
`),
	);
	assert.deepEqual(
		candidates.map((c) => c.alias),
		["fine"],
	);
	assert.deepEqual(
		skipped.map((s) => s.reason),
		["unsupported-directive", "unsupported-directive", "unsupported-directive"],
	);
});

test("an invalid port invalidates the whole block rather than silently defaulting to 22", () => {
	// 回退 22 会连到**错误的端口**：用户配的是 99999，我们却去连 22，失败还会被当成网络问题。
	const { candidates, skipped } = plain(parseSshConfig("Host badport\n  HostName h.example\n  Port 99999\n\nHost okport\n  HostName o.example\n  Port 2200\n"));
	assert.deepEqual(
		candidates.map((c) => c.alias),
		["okport"],
	);
	assert.deepEqual(skipped, [{ alias: "badport", reason: "invalid" }]);
});

test("aliases with control characters are rejected, but space-separated aliases are just two aliases", () => {
	// 已用本机 ssh 核对（`ssh -G -F <file> one` 也解析到 ok.example）：`Host a b` 是**两个别名**，
	// 不是「名字里带空格的别名」。所以这里不能把空格当非法字符。
	const multi = plain(parseSshConfig("Host evil one\n    HostName ok.example\n"));
	assert.deepEqual(
		multi.candidates.map((c) => c.alias),
		["evil", "one"],
	);

	// 真正不安全的是控制字符与超长值：它们会被送进 SSH argv 与 known_hosts 别名。
	const { candidates, skipped } = plain(parseSshConfig("Host bad\u0000name\n  HostName ok.example\n\nHost good\n  HostName ok.example\n"));
	assert.deepEqual(
		candidates.map((c) => c.alias),
		["good"],
	);
	assert.deepEqual(skipped, [{ alias: "bad\u0000name", reason: "invalid" }]);
});

test("one Host line with multiple aliases yields one candidate each, sharing the block fields", () => {
	const { candidates } = plain(parseSshConfig("Host a.example b.example\n  User shared\n  Port 2200\n"));
	assert.deepEqual(
		candidates.map((c) => ({ alias: c.alias, user: c.user, port: c.port })),
		[
			{ alias: "a.example", user: "shared", port: 2200 },
			{ alias: "b.example", user: "shared", port: 2200 },
		],
	);
});

test("comments, blank lines and inline Key=Value forms are handled", () => {
	const { candidates } = plain(
		parseSshConfig(`# a comment
Host eq-form
  HostName=eq.example
  User=deploy
  Port=2200

   # indented comment

Host space-form
  HostName space.example
`),
	);
	assert.deepEqual(
		candidates.map((c) => ({ alias: c.alias, hostName: c.hostName, user: c.user, port: c.port })),
		[
			{ alias: "eq-form", hostName: "eq.example", user: "deploy", port: 2200 },
			{ alias: "space-form", hostName: "space.example", user: "", port: null },
		],
	);
});

test("duplicate aliases are collapsed and later blocks do not override the first", () => {
	const { candidates } = plain(parseSshConfig("Host dup\n  HostName first.example\n\nHost dup\n  HostName second.example\n"));
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].hostName, "first.example");
});

test("garbage input yields an empty result instead of throwing", () => {
	// 渲染层/文件读取可能给出任意值；解析器不能因此抛异常影响设置页。
	for (const input of ["", null, undefined, 42, {}, []]) assert.deepEqual(plain(parseSshConfig(input)), { candidates: [], skipped: [] });
	// 只有指令、没有 Host 块。
	assert.deepEqual(plain(parseSshConfig("HostName orphan.example\nUser orphan\n")), { candidates: [], skipped: [] });
});

test("the candidate list is bounded", () => {
	const text = Array.from({ length: 700 }, (_, index) => `Host host${index}.example\n  HostName h${index}.example\n`).join("\n");
	const { candidates } = plain(parseSshConfig(text));
	assert.equal(candidates.length, 512, "a config that large is not a host list, but parsing it must stay bounded");
});

test("IPv6 literals and bracketed hosts survive parsing", () => {
	const { candidates } = plain(parseSshConfig("Host v6\n  HostName ::1\n\nHost bracketed\n  HostName [fe80::1]\n"));
	assert.deepEqual(
		candidates.map((c) => c.hostName),
		["::1", "[fe80::1]"],
	);
});
