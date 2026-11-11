import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * WSL 配置目标（P1-1）输入校验与稳定码闭集。
 *
 * 渲染层传进来的 target 一律不可信：wsl 目标只允许 `{ kind: "wsl" }` 一个键。发行版与
 * Linux 用户在**主进程**从应用设置解析（开发设置里那一份），渲染层自报身份一律拒绝——
 * 否则一个构造出来的 payload 就能把配置写到另一个发行版的 HOME。
 */

const target = loadTsCommonJs("src/main/config/piConfigTarget.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const HOST = "11111111-1111-4111-8111-111111111111";

function codeOf(run) {
	try {
		run();
		return "ALLOWED";
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
}

test("wsl 目标只有 kind：身份由主进程从设置解析", () => {
	const parsed = target.readPiConfigTarget({ kind: "wsl" });
	assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { kind: "wsl" });
	assert.deepEqual(JSON.parse(JSON.stringify(target.readPiConfigReadOptions({ target: { kind: "wsl" } }))), { target: { kind: "wsl" } });
	// 本地/ssh 语义不变（兼容旧调用）。
	assert.deepEqual(JSON.parse(JSON.stringify(target.readPiConfigTarget(undefined))), { kind: "local" });
	assert.deepEqual(JSON.parse(JSON.stringify(target.readPiConfigTarget({ kind: "ssh", hostId: HOST }))), { kind: "ssh", hostId: HOST });
});

test("渲染层自报 wsl 身份（hostId/label/distro 等）一律回 WSL_CONFIG_TARGET_INVALID", () => {
	const invalid = [
		{ kind: "wsl", hostId: HOST },
		{ kind: "wsl", hostId: "" },
		{ kind: "wsl", distro: "Ubuntu" },
		{ kind: "wsl", label: "x" },
		{ kind: "wsl", kind2: 1 },
		{ kind: "wsl", user: "dev" },
	];
	for (const value of invalid) {
		assert.equal(
			codeOf(() => target.readPiConfigTarget(value)),
			shared.WSL_CONFIG_CODES.targetInvalid,
			JSON.stringify(value),
		);
	}
	// 未知 kind 仍然是共享契约里的 REMOTE_CONFIG_TARGET_INVALID（与 ssh 同口径）。
	assert.equal(
		codeOf(() => target.readPiConfigTarget({ kind: "bogus" })),
		shared.REMOTE_CONFIG_CODES.targetInvalid,
	);
});

test("wsl 保存与本地同语义：整文件写入，不接受 expectedVersion/patch", () => {
	const saved = target.readPiConfigWriteOptions({ target: { kind: "wsl" } });
	assert.deepEqual(JSON.parse(JSON.stringify(saved)), { target: { kind: "wsl" } });
	for (const extra of [{ expectedVersion: "c".repeat(64) }, { patch: {} }, { expectedVersion: "c".repeat(64), patch: {} }]) {
		assert.equal(
			codeOf(() => target.readPiConfigWriteOptions({ target: { kind: "wsl" }, ...extra })),
			shared.WSL_CONFIG_CODES.targetInvalid,
			JSON.stringify(extra),
		);
	}
	// 本地写入语义保持：有 expectedVersion 仍然是 targetInvalid。
	assert.equal(
		codeOf(() => target.readPiConfigWriteOptions({ target: { kind: "local" }, expectedVersion: "c".repeat(64) })),
		shared.REMOTE_CONFIG_CODES.targetInvalid,
	);
});

test("WSL 稳定码是闭集，且与共享契约逐条对齐", () => {
	const expected = ["WSL_CONFIG_TARGET_INVALID", "WSL_CONFIG_HOST_NOT_FOUND", "WSL_CONFIG_DISTRO_UNAVAILABLE", "WSL_CONFIG_PATH_UNREADABLE", "WSL_CONFIG_FILE_INVALID", "WSL_CONFIG_UNSUPPORTED", "WSL_CONFIG_UNAVAILABLE"];
	assert.deepEqual(Object.values(shared.WSL_CONFIG_CODES).sort(), [...expected].sort());
	for (const code of expected) assert.ok(shared.WSL_CONFIG_CODE_SET.has(code), code);
	// 渲染层从 IPC 错误里抓码：Electron 会给 message 加前缀，抓取必须容忍。
	const error = new Error("Error invoking remote method 'config:get-models': Error: WSL_CONFIG_HOST_NOT_FOUND");
	assert.equal(shared.wslPiConfigCodeFromError(error), "WSL_CONFIG_HOST_NOT_FOUND");
	assert.equal(shared.wslPiConfigCodeFromError(new Error("REMOTE_CONFIG_TARGET_INVALID")), undefined);
	// 快照判别只看主进程写下的 kind + 来源字段，不从本地数据推断。
	assert.equal(shared.isWslPiConfigSnapshot({ kind: "wsl", distro: "Ubuntu", user: "dev" }), true);
	assert.equal(shared.isWslPiConfigSnapshot({ kind: "wsl" }), false);
	assert.equal(shared.isWslPiConfigSnapshot({ kind: "remote", distro: "Ubuntu" }), false);
	assert.equal(shared.isWslPiConfigSnapshot(undefined), false);
});
