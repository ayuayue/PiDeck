import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadModule(filePath, sandboxExtra = {}) {
	const { outputText } = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, require, Buffer, TextDecoder, process, ...sandboxExtra };
	vm.runInNewContext(outputText, sandbox, { filename: filePath });
	return sandbox.exports;
}

// vm 沙箱与宿主不同 realm，strict deepEqual 会比较原型；统一转成宿主可比较的纯值
function eqDeep(actual, expected) {
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}

const probe = loadModule("src/main/wsl/wslPiProbe.ts");
const wslExe = loadModule("src/main/wsl/wslExe.ts");

// ── 探测脚本内容 ──────────────────────────────────────────────────────

test("probe script resolves pi through PATH before falling back to known install dirs", () => {
	const script = probe.buildWslPiProbeScript();
	// nvm/fnm 的 PATH 注入只在交互 shell 生效，L1 必须走 command -v
	assert.ok(script.includes("command -v pi"), "缺少 PATH 探测层");
	assert.ok(script.includes("command -v node"), "缺少 node 目录探测层");
});

test("probe script covers version managers and package manager global bins", () => {
	const script = probe.buildWslPiProbeScript();
	for (const dir of [
		".nvm/versions/node/*/bin",
		".fnm/node-versions/*/installation/bin",
		".local/share/fnm/node-versions/*/installation/bin",
		".volta/bin",
		".asdf/shims",
		".local/share/mise/shims",
		".local/share/mise/installs/node/*/bin",
		".npm-global/bin",
		".local/share/pnpm",
		".yarn/bin",
		".bun/bin",
		".deno/bin",
		".local/bin",
		"/usr/local/bin/pi",
		"/usr/bin/pi",
		"/home/linuxbrew/.linuxbrew/bin/pi",
	]) {
		assert.ok(script.includes(dir), "探测目录缺少 " + dir);
	}
	// HOME/PNPM_HOME must be quoted without quoting the wildcard itself.
	assert.ok(script.includes('"$HOME"/.nvm/versions/node/*/bin/pi'));
	assert.ok(script.includes('"$PNPM_HOME"/pi'));
});

test("probe script asks package managers for their prefix as a last resort", () => {
	const script = probe.buildWslPiProbeScript();
	assert.ok(script.includes("npm config get prefix"));
	assert.ok(script.includes("mise bin-paths"));
	assert.ok(script.includes("volta which pi"));
	assert.ok(script.includes("asdf which pi"));
});

test("probe script rejects windows interop hits so host pi is never mistaken for wsl pi", () => {
	const script = probe.buildWslPiProbeScript();
	// appendWindowsPath=true 时 PATH 带 /mnt/c/...，那里是 Windows 侧 shim
	assert.ok(script.includes('case "$1" in /mnt/*) return 1 ;; esac'));
	assert.ok(script.includes('case "$_d" in /mnt/*) continue ;; esac'));
});

test("probe script replaces the ephemeral fnm multishell path with the stable install bin", () => {
	const script = probe.buildWslPiProbeScript();
	// /run/user/<uid>/fnm_multishells/<pid>_<ts>/bin 每次 shell 都变，不能当缓存身份
	assert.ok(script.includes("/run/user/*"));
	assert.ok(script.includes('readlink -f "$_n"'));
});

test("probe script emits machine readable keys and always exits zero", () => {
	const script = probe.buildWslPiProbeScript();
	assert.ok(script.includes('printf \'PIDECK_PI=%s\\n\' "$1"'));
	assert.ok(script.includes('printf \'PIDECK_NODE_BIN=%s\\n\''));
	// node bin 缺省时由 pi 所在目录推导，不依赖调用方传第二参
	assert.ok(script.includes('_bin=$(dirname "$1")'));
	// 未命中也 exit 0：调用端要能区分「确实没装」与「bash 不存在 / spawn 失败」
	assert.ok(script.includes("PIDECK_MISS=1"));
	assert.ok(script.trimEnd().endsWith("exit 0"));
});

test("probe script appends caller supplied candidate dirs", () => {
	assert.ok(probe.buildWslPiProbeScript(["/opt/custom-pi/bin"]).includes("/opt/custom-pi/bin/pi"));
});

// ── 探测输出解析 ──────────────────────────────────────────────────────

test("parses pi path and node bin dir from probe output", () => {
	const result = probe.parseWslPiProbeOutput(
		"PIDECK_PI=/home/u/.local/share/fnm/node-versions/v24.20.0/installation/bin/pi\n" +
			"PIDECK_NODE_BIN=/home/u/.local/share/fnm/node-versions/v24.20.0/installation/bin\n",
	);
	eqDeep(result, {
		piPath: "/home/u/.local/share/fnm/node-versions/v24.20.0/installation/bin/pi",
		nodeBinDir: "/home/u/.local/share/fnm/node-versions/v24.20.0/installation/bin",
	});
});

test("ignores shell rc noise printed before the probe keys", () => {
	const result = probe.parseWslPiProbeOutput(
		[
			"\x1b]0;/home/u\x07Welcome to Ubuntu",
			"PIDECK_MISS=1",
			"PIDECK_PI=/usr/local/bin/pi",
			"PIDECK_NODE_BIN=/usr/local/bin",
		].join("\n"),
	);
	assert.equal(result.piPath, "/usr/local/bin/pi");
	assert.equal(result.nodeBinDir, "/usr/local/bin");
});

test("falls back to the pi directory when node bin dir is missing or unusable", () => {
	assert.equal(
		probe.parseWslPiProbeOutput("PIDECK_PI=/home/u/.nvm/versions/node/v22/bin/pi\nPIDECK_NODE_BIN=\n").nodeBinDir,
		"/home/u/.nvm/versions/node/v22/bin",
	);
	assert.equal(
		probe.parseWslPiProbeOutput("PIDECK_PI=/home/u/.volta/bin/pi\nPIDECK_NODE_BIN=relative/path\n").nodeBinDir,
		"/home/u/.volta/bin",
	);
});

test("treats a windows interop pi path as not installed", () => {
	assert.equal(probe.parseWslPiProbeOutput("PIDECK_PI=/mnt/c/Users/dev/AppData/Roaming/npm/pi\n"), null);
	// node bin 落在 /mnt 时同样不可信，回退到 pi 自身目录
	assert.equal(
		probe.parseWslPiProbeOutput(
			"PIDECK_PI=/usr/local/bin/pi\nPIDECK_NODE_BIN=/mnt/c/Program Files/nodejs\n",
		).nodeBinDir,
		"/usr/local/bin",
	);
});

test("returns null when nothing was found", () => {
	assert.equal(probe.parseWslPiProbeOutput("PIDECK_MISS=1\n"), null);
	assert.equal(probe.parseWslPiProbeOutput(""), null);
	assert.equal(probe.parseWslPiProbeOutput("pi not found\n"), null);
});

test("tolerates utf-16 nul bytes leaking into wsl stdout", () => {
	const spaced = "P\x00I\x00D\x00E\x00C\x00K\x00_\x00P\x00I\x00=\x00/\x00u\x00s\x00r\x00/\x00b\x00i\x00n\x00/\x00p\x00i\x00";
	assert.equal(probe.parseWslPiProbeOutput(spaced + "\n").piPath, "/usr/bin/pi");
});

// ── 启动参数：探测与启动必须共用同一份结果 ─────────────────────────

test("builds wsl exec args that exec the absolute pi path with node bin injected into PATH", () => {
	const args = probe.buildWslPiExecArgs({
		distro: "Ubuntu-24.04",
		user: "dev",
		piCommand: "/home/dev/.nvm/versions/node/v22.14.0/bin/pi",
		nodeBinDir: "/home/dev/.nvm/versions/node/v22.14.0/bin",
		args: ["--version"],
	});
	eqDeep(args, [
		"-d",
		"Ubuntu-24.04",
		"-u",
		"dev",
		// -e：不让 wsl.exe 把参数交给默认 shell 二次解析
		"-e",
		"/usr/bin/env",
		"PATH=/home/dev/.nvm/versions/node/v22.14.0/bin:" + probe.WSL_PI_BASE_PATH,
		"/home/dev/.nvm/versions/node/v22.14.0/bin/pi",
		"--version",
	]);
});

test("places the linux cwd before the exec separator", () => {
	const args = probe.buildWslPiExecArgs({
		distro: "Ubuntu-24.04",
		user: "root",
		piCommand: "/root/.volta/bin/pi",
		wslCwd: "/root/ba cli",
		args: ["--mode", "rpc"],
	});
	eqDeep(args.slice(0, 7), ["-d", "Ubuntu-24.04", "-u", "root", "--cd", "/root/ba cli", "-e"]);
	eqDeep(args.slice(-3), ["/root/.volta/bin/pi", "--mode", "rpc"]);
});

test("derives the node bin dir from the pi path when the probe did not report one", () => {
	const args = probe.buildWslPiExecArgs({
		distro: "Ubuntu",
		user: "dev",
		piCommand: "/usr/local/bin/pi",
		args: [],
	});
	assert.equal(args[6], "PATH=/usr/local/bin:" + probe.WSL_PI_BASE_PATH);
});

test("keeps the inherited wsl path for a bare pi command name", () => {
	const args = probe.buildWslPiExecArgs({
		distro: "Ubuntu",
		user: "dev",
		piCommand: "pi",
		nodeBinDir: "/home/dev/.nvm/versions/node/v22/bin",
		args: ["--mode", "rpc"],
	});
	// 裸命令名说明 PATH 已经能解析，注入反而会丢掉用户环境
	eqDeep(args, ["-d", "Ubuntu", "-u", "dev", "pi", "--mode", "rpc"]);
});

test("ignores a windows interop node bin dir when injecting PATH", () => {
	const args = probe.buildWslPiExecArgs({
		distro: "Ubuntu",
		user: "dev",
		piCommand: "/usr/bin/pi",
		nodeBinDir: "/mnt/c/Program Files/nodejs",
		args: [],
	});
	assert.equal(args[6], "PATH=/usr/bin:" + probe.WSL_PI_BASE_PATH);
});

// ── wsl:// 标记 ───────────────────────────────────────────────────────

test("wsl marker round-trips an absolute linux pi path", () => {
	const marker = probe.buildWslCommandMarker("Ubuntu-24.04", "dev", "/home/dev/.nvm/versions/node/v22/bin/pi");
	assert.equal(marker, "wsl://Ubuntu-24.04/dev//home/dev/.nvm/versions/node/v22/bin/pi");
	eqDeep(probe.parseWslCommandMarker(marker), {
		distro: "Ubuntu-24.04",
		user: "dev",
		piCommand: "/home/dev/.nvm/versions/node/v22/bin/pi",
	});
});

test("parseWslCommandMarker rejects malformed and host-interoperability markers", () => {
	assert.equal(probe.parseWslCommandMarker("wsl://Ubuntu/dev"), null);
	assert.equal(probe.parseWslCommandMarker("wsl://Ubuntu/dev/"), null);
	assert.equal(probe.parseWslCommandMarker("wsl://Ubuntu/dev/-e"), null);
	assert.equal(probe.parseWslCommandMarker("wsl://Ubuntu/dev//mnt/c/Users/dev/pi.cmd"), null);
	assert.equal(probe.parseWslCommandMarker("pi"), null);
});

// ── wsl.exe 输出解码（UTF-16LE）──────────────────────────────────────

test("decodes utf-16le wsl -l -q output into a distro list", () => {
	const utf16 = Buffer.from("Ubuntu-26.04\r\n", "utf16le");
	eqDeep(wslExe.parseWslDistroList(utf16), ["Ubuntu-26.04"]);
});

test("decodes utf-16le output with bom", () => {
	const bom = Buffer.from([0xff, 0xfe]);
	const body = Buffer.from("Debian\r\nUbuntu-24.04\r\n", "utf16le");
	eqDeep(wslExe.parseWslDistroList(Buffer.concat([bom, body])), ["Debian", "Ubuntu-24.04"]);
});

test("decodes plain utf-8 output", () => {
	eqDeep(wslExe.parseWslDistroList(Buffer.from("Ubuntu\r\n", "utf8")), ["Ubuntu"]);
	eqDeep(wslExe.parseWslDistroList("Ubuntu-26.04\r\n"), ["Ubuntu-26.04"]);
});

test("drops empty and legacy default-distro marker lines", () => {
	eqDeep(wslExe.parseWslDistroList("Ubuntu\r\n\r\nD:\\wsl\\base\r\n"), ["Ubuntu"]);
});
