import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const browser = loadTsCommonJs("src/main/wsl/WslDirectoryBrowser.ts");

function recordingExec(code, stdout = Buffer.alloc(0)) {
	const calls = [];
	return {
		calls,
		async exec(args, options) {
			calls.push({ args, options });
			return { code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, "utf8") };
		},
	};
}

const nul = (lines) => Buffer.from(lines.map((line) => `${line}\0`).join(""), "utf8");
const CONTROL = String.fromCharCode(0);

test("passes distro, user and path as argv and never into the shell script", () => {
	const args = browser.buildWslDirectoryListArgs({ distro: "Debian", user: "root", path: "/root/ba;cli $(rm -rf /)" });
	assert.deepEqual(Array.from(args.slice(0, 7)), ["-d", "Debian", "-u", "root", "--exec", "/bin/sh", "-c"]);
	assert.equal(args[8], "pideck-dir");
	// 路径是独立 argv：脚本只引用 "$1"，任何字符都不会变成命令语法。
	assert.ok(args[7].includes('dir="$1"'));
	assert.ok(!args[7].includes("ba;cli"));
	assert.equal(args[9], "/root/ba;cli $(rm -rf /)");
});

test("normalizes a requested Linux path without trimming legal characters", () => {
	assert.equal(browser.normalizeWslListPath("/root/ba_cli/"), "/root/ba_cli");
	assert.equal(browser.normalizeWslListPath("//tmp//root//x"), "/tmp/root/x");
	assert.equal(browser.normalizeWslListPath("/"), "/");
	// 目录名可以以空格结尾：trim 会指向别处。
	assert.equal(browser.normalizeWslListPath("/root/agent "), "/root/agent ");
	assert.equal(browser.normalizeWslListPath("root/relative"), null);
	assert.equal(browser.normalizeWslListPath(""), null);
	assert.equal(browser.normalizeWslListPath("/root" + String.fromCharCode(7) + "x"), null);
	assert.equal(browser.normalizeWslListPath("/root" + CONTROL + "x"), null);
	assert.equal(browser.normalizeWslListPath("/" + "a".repeat(5000)), null);
});

test("parses -print0 output into sorted directory names", () => {
	const parsed = browser.parseWslDirectoryListing(nul(["./ba_cli", "./.pi", "./zeta"]));
	assert.equal(parsed.truncated, false);
	assert.deepEqual(Array.from(parsed.entries.map((entry) => entry.name)), [".pi", "ba_cli", "zeta"]);
	// 只回名字：父级与拼接由渲染层按 POSIX 字符串规则做，与 SSH 浏览器共用同一组件。
	assert.equal("path" in parsed.entries[0], false);
});

test("drops the byte-capped tail record and reports truncation explicitly", () => {
	const capped = Buffer.from("./alpha\0./beta\0./gamm", "utf8");
	const parsed = browser.parseWslDirectoryListing(capped);
	assert.equal(parsed.truncated, true);
	assert.deepEqual(Array.from(parsed.entries.map((entry) => entry.name)), ["alpha", "beta"]);
	// 名字数超出页上限时同样显式带出，不靠「刚好等于上限」猜。
	const many = browser.parseWslDirectoryListing(nul(Array.from({ length: browser.WSL_DIRECTORY_LIST_LIMIT + 3 }, (_unused, index) => `./d${index}`)));
	assert.equal(many.entries.length, browser.WSL_DIRECTORY_LIST_LIMIT);
	assert.equal(many.truncated, true);
});

test("maps in-distro exit codes to stable read failures", async () => {
	const cases = [
		[2, "WSL_DIRECTORY_NOT_A_DIRECTORY"],
		[4, "WSL_DIRECTORY_NOT_FOUND"],
		[5, "WSL_DIRECTORY_UNREADABLE"],
		[1, "WSL_DIRECTORY_DISTRO_UNAVAILABLE"],
	];
	for (const [code, expected] of cases) {
		const runner = recordingExec(code);
		const result = await browser.listWslDirectory({ distro: "Debian", user: "root", path: "/root" }, { exec: runner.exec });
		assert.equal(result.ok, false);
		assert.equal(result.code, expected);
		// 只读操作的 outcome 恒为 rejected：重试不会重复执行任何东西。
		assert.equal(result.outcome, "rejected");
	}
});

test("answers a listing with the normalized path and its entries", async () => {
	const runner = recordingExec(0, nul(["./ba_cli", "./notes"]));
	const result = await browser.listWslDirectory({ distro: "Debian", user: "root", path: "/root/" }, { exec: runner.exec });
	assert.equal(result.ok, true);
	assert.equal(result.value.path, "/root");
	assert.equal(result.value.truncated, false);
	assert.deepEqual(Array.from(result.value.entries.map((entry) => entry.name)), ["ba_cli", "notes"]);
	assert.equal(runner.calls[0].args[9], "/root");
});

test("refuses before spawning when the request is not usable or WSL is not the host", async () => {
	const runner = recordingExec(0);
	const badPath = await browser.listWslDirectory({ distro: "Debian", user: "root", path: "relative/x" }, { exec: runner.exec });
	assert.equal(badPath.code, "WSL_DIRECTORY_PATH_INVALID");
	const otherPlatform = await browser.listWslDirectory({ distro: "Debian", user: "root", path: "/root" }, { exec: runner.exec, platform: "darwin" });
	assert.equal(otherPlatform.code, "WSL_DIRECTORY_DISTRO_UNAVAILABLE");
	assert.equal(runner.calls.length, 0);
});

test("a spawn failure is an unavailable distro, not an empty folder", async () => {
	const result = await browser.listWslDirectory(
		{ distro: "Debian", user: "root", path: "/root" },
		{
			exec: async () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		},
	);
	assert.equal(result.ok, false);
	assert.equal(result.code, "WSL_DIRECTORY_DISTRO_UNAVAILABLE");
});
