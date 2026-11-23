import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * 远端 Git 失败审计：面板只把未入词典的稳定码折成一句通用文案，所以「是哪个码失败了」只能靠主进程日志
 * （2026-11-22 图谱空白就是靠它定位到冷启动 SSH_HOST_NOT_READY）。
 * 这里验行为：每个失败信封都记一次（只记码），并且日志口自己坏掉不能改变调用方看到的失败。
 */

const logger = {
	warns: [],
	throwOnWarn: false,
	warn(scope, message, detail) {
		if (this.throwOnWarn) throw new Error("logger exploded");
		this.warns.push({ scope, message, detail });
	},
};
const { failureEnvelope } = loadTsCommonJs("src/main/ipc/remoteGitFailureEnvelope.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => logger } },
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const reset = () => {
	logger.warns = [];
	logger.throwOnWarn = false;
};

test("失败信封把稳定码记进日志，并且只记码", () => {
	reset();
	const error = Object.assign(new Error("SSH_HOST_NOT_READY"), { code: "SSH_HOST_NOT_READY" });
	assert.deepEqual(plain(failureEnvelope(error)), { ok: false, code: "SSH_HOST_NOT_READY" });
	assert.deepEqual(plain(logger.warns), [{ scope: "git", message: "remote git request failed", detail: { code: "SSH_HOST_NOT_READY" } }]);
});

test("带 helper 原文时信封照常透传原文，日志仍然只记码", () => {
	reset();
	const error = Object.assign(new Error("GIT_COMMAND_FAILED"), { code: "GIT_COMMAND_FAILED", detail: "fatal: bad revision" });
	assert.equal(failureEnvelope(error).message, "fatal: bad revision");
	assert.deepEqual(plain(logger.warns.map((entry) => entry.detail)), [{ code: "GIT_COMMAND_FAILED" }]);
});

test("日志口抛错不改变调用方看到的失败", () => {
	reset();
	logger.throwOnWarn = true;
	const error = Object.assign(new Error("GIT_RESULT_INVALID"), { code: "GIT_RESULT_INVALID" });
	assert.deepEqual(plain(failureEnvelope(error)), { ok: false, code: "GIT_RESULT_INVALID" });
});
