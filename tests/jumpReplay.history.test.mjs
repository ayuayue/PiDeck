import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * 回灌：拿真实历史会话跑整条定位 + 取页链路。
 *
 * 为什么走子进程：这条链路 import 的 SessionHistoryReader / AgentMessageProjector 里用了
 * parameter property（constructor(private x: T)），Node 的 strip-only 模式不支持这种语法：
 *   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode
 * 所以不能像纯函数那样直接加载，得让 tsx（完整 transform）起一个真进程跑探针。
 * 为什么这是唯一能发现真问题的判据：单测只验代码形状，真文件才回答「这一条取不取得到」。
 * 「小样本全绿、真机 722 轮全红」在这条链上发生过不止一次。
 */
test("回灌：真实历史会话逐位置验证定位与页覆盖", (t) => {
	const result = spawnSync("npx", ["tsx", "scripts/jumpReplay.probe.ts"], {
		encoding: "utf8",
		timeout: 180000,
		shell: true,
	});
	const out = (result.stdout ?? "") + (result.stderr ?? "");
	if (out.includes("SKIP")) {
		// 这台机器没有历史会话目录：判据没有被验证，如实 skip，不算通过。
		t.skip("没有历史会话目录");
		return;
	}
	assert.equal(result.status, 0, "回灌探针没跑通：\n" + out.slice(0, 2000));
	assert.match(out, /PASS/, "探针必须打出 PASS：\n" + out.slice(0, 2000));
});
