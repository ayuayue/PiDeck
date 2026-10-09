import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 相对 sessionFile 归一化（toAbsoluteSessionPath）的跨平台回归测试。
 *
 * 2026-10-08 现场（Linux + 项目级 sessionDir=".pi/sessions"）：pi 的 get_state 回传
 * 相对路径 `.pi/sessions/<stem>.jsonl`，归一化把 native 一律当 Windows 处理——用 `/`
 * 拼接后把全部分隔符替换成 `\`，产出 `\home\zhadainian\PiDeck\.pi\sessions\x.jsonl`。
 * 该串在 Linux 上不是绝对路径（path.isAbsolute === false），于是：
 *   - 历史读取永远 ENOENT（被「会话文件尚未创建」兜底吞成空历史 → 时间线卡骨架）；
 *   - fork/copy 的 (fork)/copy 改名永远失败（ENOENT），后缀写不进文件；
 *   - 标题扫描找不到文件，fork/copy 会话只能吃首句兜底并被锁死。
 * 结果就是「fork/复制后命名错误 + 一直显示正在加载会话历史」。Windows 因盘符路径天然
 * 命中绝对路径分支而免疫，所以本测试必须覆盖两个平台的基址形态。
 */

const { toAbsoluteSessionPath, canonicalizeSessionPath, buildSessionOriginKey } = loadTsCommonJs("src/shared/sessionIdentity.ts");

// 归一化结果必须是「本平台」的合法绝对路径：Linux 上 posix、Windows 上 win32。
// 只用一个平台的 path.isAbsolute 判断会把另一平台的正确结果误判为相对路径，
// 因此按输入基址的形态选择语义。
const WINDOWS_BASE_RE = /^[A-Za-z]:[\\/]/;
function assertAbsoluteForBase(resolved, base) {
	if (WINDOWS_BASE_RE.test(base)) {
		assert.match(resolved, /^[A-Za-z]:[\\/]/, `expected a Windows absolute path, got ${resolved}`);
		return;
	}
	assert.ok(resolved.startsWith("/"), `expected a POSIX absolute path, got ${resolved}`);
	// POSIX 语义下 `\` 是普通文件名字符：路径分隔符必须是 `/`，否则文件必然打不开。
	assert.ok(!resolved.includes("\\"), `POSIX session path must not contain backslashes: ${resolved}`);
}

test("resolves a POSIX relative sessionFile against a POSIX project base", () => {
	const base = "/home/zhadainian/PiDeck";
	const resolved = toAbsoluteSessionPath(".pi/sessions/2026-10-08T07-35-20-802Z_abc.jsonl", base, "native");
	assert.equal(resolved, "/home/zhadainian/PiDeck/.pi/sessions/2026-10-08T07-35-20-802Z_abc.jsonl");
	assertAbsoluteForBase(resolved, base);
	// 曾经的坏产物：Windows 式根前缀 + 反斜杠分隔符。
	assert.notEqual(resolved, "\\home\\zhadainian\\PiDeck\\.pi\\sessions\\2026-10-08T07-35-20-802Z_abc.jsonl");
});

test("resolves a POSIX relative sessionFile with a trailing slash base", () => {
	const resolved = toAbsoluteSessionPath(".pi/sessions/a.jsonl", "/home/dev/proj/", "native");
	assert.equal(resolved, "/home/dev/proj/.pi/sessions/a.jsonl");
});

test("resolved POSIX relative paths are addressable absolute paths on this platform", () => {
	const resolved = toAbsoluteSessionPath(".pi/sessions/a.jsonl", "/home/dev/proj", "native");
	// 判定标准不是平台，而是「解析出的串在**本机**是否可寻址」：类 POSIX 结果必须被
	// node:path.isAbsolute 认可（即在 Linux/macOS 上真的能 open）。旧产物永远不满足。
	assert.equal(isAbsolute(resolved), true, `${resolved} must be addressable`);
	// Windows 形态仍产出 Windows 绝对路径（不在本机判定，只比字面契约）。
	assert.equal(toAbsoluteSessionPath(".pi/sessions/a.jsonl", "C:\\proj", "native"), "C:\\proj\\.pi\\sessions\\a.jsonl");
});

test("keeps Windows relative resolution byte-identical to the documented contract", () => {
	assert.equal(toAbsoluteSessionPath(".pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl", "D:\\Project\\PiDeck", "native"), "D:\\Project\\PiDeck\\.pi\\sessions\\2026-08-08T10-47-19-239Z_abc.jsonl");
	assert.equal(toAbsoluteSessionPath(".pi/sessions/session.jsonl", "D:/Project/PiDeck", "native"), "D:\\Project\\PiDeck\\.pi\\sessions\\session.jsonl");
});

test("passes through already-absolute paths for both platforms", () => {
	assert.equal(toAbsoluteSessionPath("C:\\Users\\dev\\.pi\\sessions\\a.jsonl", "D:\\Project", "native"), "C:\\Users\\dev\\.pi\\sessions\\a.jsonl");
	assert.equal(toAbsoluteSessionPath("/home/dev/.pi/sessions/a.jsonl", "/home/dev/proj", "native"), "/home/dev/.pi/sessions/a.jsonl");
	assert.equal(toAbsoluteSessionPath("/mnt/d/Project/.pi/sessions/a.jsonl", "D:\\Project", "wsl"), "/mnt/d/Project/.pi/sessions/a.jsonl");
});

test("resolves a WSL relative sessionFile against the /mnt/<drive> project base", () => {
	assert.equal(toAbsoluteSessionPath(".pi/sessions/session.jsonl", "D:\\Project\\PiDeck", "wsl"), "/mnt/d/Project/PiDeck/.pi/sessions/session.jsonl");
	// WSL 下 POSIX 基址不能被盘符换算破坏。
	assert.equal(toAbsoluteSessionPath(".pi/sessions/session.jsonl", "/home/dev/proj", "wsl"), "/home/dev/proj/.pi/sessions/session.jsonl");
});

test("relative and absolute POSIX forms canonicalize to the same origin key", () => {
	const base = "/home/dev/proj";
	const relative = buildSessionOriginKey({
		source: "pi",
		environment: "native",
		filePath: toAbsoluteSessionPath(".pi/sessions/session.jsonl", base, "native"),
	});
	const absolute = buildSessionOriginKey({
		source: "pi",
		environment: "native",
		filePath: "/home/dev/proj/.pi/sessions/session.jsonl",
	});
	assert.equal(relative, absolute);
});

test("the mangled Windows-shaped product is no longer reachable by any resolution input", () => {
	// 历史脏数据形态：以 `\` 开头的伪 UNC。它必须被判为「非本平台绝对路径」并被重新解析，
	// 而不是原样透传（透传 = 永远打不开的 filePath）。
	const mangled = "\\home\\zhadainian\\PiDeck\\.pi\\sessions\\x.jsonl";
	const resolved = toAbsoluteSessionPath(mangled, "/home/dev/proj", "native");
	assert.ok(resolved.startsWith("/home/dev/proj/"), `mangled POSIX path must be re-rooted, got ${resolved}`);
	// 真·UNC（\\server\share）在 native 下仍按绝对路径透传，不能把网络盘写坏。
	assert.equal(toAbsoluteSessionPath("\\\\server\\share\\a.jsonl", "/home/dev/proj", "native"), "\\\\server\\share\\a.jsonl");
});

test("canonicalization keeps POSIX paths case-sensitive and separator-stable", () => {
	assert.equal(canonicalizeSessionPath("/home/dev/Proj/.pi/sessions/a.jsonl", "native"), "/home/dev/Proj/.pi/sessions/a.jsonl");
	assert.notEqual(canonicalizeSessionPath("/home/dev/Proj/a.jsonl", "native"), canonicalizeSessionPath("/home/dev/proj/a.jsonl", "native"));
});

test("sessionIdentity source documents the platform-split contract", () => {
	const source = readFileSync("src/shared/sessionIdentity.ts", "utf8");
	// 契约守卫：解析语义必须由「基址形态」决定（而不是 environment==="native" 一刀切当 Windows）。
	assert.match(source, /resolveSessionPathPlatform/);
	// 不允许再出现「native 就无条件把 / 换成 \ 分隔符」的全局替换写法。
	assert.doesNotMatch(source, /environment === "wsl" \? joined : joined/);
});
