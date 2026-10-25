/**
 * 问题反馈「新建会话分析」项目上下文的有界读源码契约：
 * AGENTS.md 是用户项目里的任意大小文件，读取必须走 readTextBounded 的 head 模式
 * （stat 预检 + 64KB 上限 + 行对齐），不得退回整读后截断的旧形态。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("projectsIpc：AGENTS.md 读取走 head 有界读，无裸 readFile", () => {
	const src = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
	assert.match(src, /import \{ readTextBounded \} from "\.\.\/fs\/boundedTextRead"/);
	assert.match(src, /readTextBounded\(join\(hostPath, "AGENTS\.md"\), FEEDBACK_AGENTS_MD_MAX_BYTES, "head"\)/);
	assert.match(src, /FEEDBACK_AGENTS_MD_MAX_BYTES = 64 \* 1024/);
	assert.doesNotMatch(src, /readFile\(join\(hostPath, "AGENTS\.md"\)/, "不得整读 AGENTS.md");
});

test("日志域：RpcLogger/ModelTrace/AppLogger 不再裸读大文件", () => {
	const rpc = readFileSync("src/main/logging/RpcLogger.ts", "utf8");
	assert.match(rpc, /readTextBounded\(filePath, RPC_TAIL_READ_BYTES, "tail"\)/);
	assert.match(rpc, /readTextBounded\(join\(this\.dir, file\), RPC_TAIL_READ_BYTES, "tail"\)/);
	assert.doesNotMatch(rpc, /await readFile\(/, "RpcLogger 不得再有裸整读");
	const trace = readFileSync("src/main/logging/ModelTrace.ts", "utf8");
	assert.match(trace, /readTextBounded\(join\(this\.rootDir, this\.fileName\(agentId, traceId\)\), MAX_TRACE_READ_BYTES, "tail"\)/);
	assert.doesNotMatch(trace, /await readFile\(/, "ModelTrace 不得再有裸整读");
	const appLogger = readFileSync("src/main/logging/AppLogger.ts", "utf8");
	assert.match(appLogger, /readFileTail: \(p, bytes\) => readTextBounded\(p, bytes, "tail"\)/);
});
