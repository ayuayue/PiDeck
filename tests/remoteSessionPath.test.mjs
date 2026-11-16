import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端 pi 上报的会话文件路径归一化（相对 sessionDir 的坑）。
 *
 * 现场：远端项目 `.pi/settings.json` 写 `"sessionDir": ".pi/sessions"` 时，pi 的 `normalizePath`
 * 不做绝对化，`get_state.sessionFile` 回来就是相对 cwd 的 `.pi/sessions/<file>.jsonl`。远端链路
 * （catalog 身份、`--session` 重启、换绑比较）只接受绝对 POSIX 路径，所以必须按 pi 自己的 cwd
 * （= 远端项目根）解析。
 */

const { resolveRemoteReportedSessionPath, isAbsoluteRemoteSessionPath } = loadTsCommonJs("src/main/pi/remoteSessionPath.ts");

const CWD = "/home/dev/project";

test("相对路径按远端 cwd 解析成绝对 POSIX 路径", () => {
	assert.equal(resolveRemoteReportedSessionPath(".pi/sessions/a.jsonl", CWD), "/home/dev/project/.pi/sessions/a.jsonl");
	assert.equal(resolveRemoteReportedSessionPath("./x/../.pi/sessions/b.jsonl", CWD), "/home/dev/project/.pi/sessions/b.jsonl");
});

test("绝对路径只做规范化，不改定根", () => {
	assert.equal(resolveRemoteReportedSessionPath("/home/dev/.pi/agent/sessions/--x--/a.jsonl", CWD), "/home/dev/.pi/agent/sessions/--x--/a.jsonl");
	// `.`/空段被折叠，`..` 在根之上被拒绝（不产生「看起来正常」的路径）。
	assert.equal(resolveRemoteReportedSessionPath("/home/dev//x/./y.jsonl", CWD), "/home/dev/x/y.jsonl");
	assert.equal(resolveRemoteReportedSessionPath("/../../etc/passwd", CWD), undefined);
});

test("拒绝控制字节与反斜杠（POSIX 主机上不该出现，混进来只会产生第二种写法）", () => {
	assert.equal(resolveRemoteReportedSessionPath("a\u0000b.jsonl", CWD), undefined);
	assert.equal(resolveRemoteReportedSessionPath(".pi\\sessions\\a.jsonl", CWD), undefined);
	assert.equal(resolveRemoteReportedSessionPath("/home/dev/\u007fa.jsonl", CWD), undefined);
});

test("解析基址必须是绝对 POSIX 路径：装配错误不产生猜测结果", () => {
	assert.equal(resolveRemoteReportedSessionPath("a.jsonl", "C:\\projects\\x"), undefined);
	assert.equal(resolveRemoteReportedSessionPath("a.jsonl", ""), undefined);
	// 已经是绝对路径时不需要基址仍然可用。
	assert.equal(resolveRemoteReportedSessionPath("/home/dev/a.jsonl", "C:\\projects\\x"), "/home/dev/a.jsonl");
});

test("isAbsoluteRemoteSessionPath 只认规范形状（调用方据此决定是否还要解析）", () => {
	assert.equal(isAbsoluteRemoteSessionPath("/home/dev/a.jsonl"), true);
	assert.equal(isAbsoluteRemoteSessionPath("a.jsonl"), false);
	assert.equal(isAbsoluteRemoteSessionPath("/home/dev//a.jsonl"), false);
	assert.equal(isAbsoluteRemoteSessionPath("/home/dev/../dev/a.jsonl"), false);
	assert.equal(isAbsoluteRemoteSessionPath(42), false);
});
