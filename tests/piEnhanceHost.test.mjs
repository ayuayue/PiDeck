import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

/** 真实助手进程 + 假 pi SDK；只走本地 NDJSON，不读用户配置、不调用供应商。 */
async function hostHarness(t) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-enhance-host-"));
	const sdk = join(dir, "sdk.mjs");
	await writeFile(
		sdk,
		`
		let revision = 0;
		export const ModelRuntime = { create: async () => ({
			refresh: async ({ allowNetwork, signal }) => {
				if (allowNetwork !== false) throw new Error("network discovery must stay off");
				await new Promise((resolve) => setTimeout(resolve, 80));
				if (signal.aborted) throw new Error("aborted");
				revision++;
			},
			getModel: (provider, modelId) => provider === "pi-fixed" && modelId === "model" ? { revision } : undefined,
			streamSimple: async function* (model, context) {
				yield { type: "done", message: { content: [{ type: "text", content: JSON.stringify({ revision: model.revision, context }) }] } };
			},
		}) };
	`,
	);
	const child = spawn(process.execPath, [resolve("resources/pi-enhance-host.mjs")], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PIDECK_PI_SDK_ENTRY: sdk },
	});
	const records = [];
	const waiters = [];
	let stderr = "";
	let failure;
	const rejectAll = (error) => {
		failure = error;
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	};
	child.once("error", rejectAll);
	child.once("exit", (code) => rejectAll(new Error(`helper exited ${code}: ${stderr}`)));
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		const record = JSON.parse(line);
		records.push(record);
		for (const waiter of [...waiters])
			if (waiter.matches(record)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(record);
			}
	});
	t.after(async () => {
		lines.close();
		if (child.exitCode === null)
			await new Promise((resolveExit) => {
				child.once("exit", resolveExit);
				child.kill();
			});
		await rm(dir, { recursive: true, force: true });
	});
	const wait = (matches) => {
		const existing = records.find(matches);
		if (existing) return Promise.resolve(existing);
		if (failure) return Promise.reject(failure);
		return new Promise((resolveWait, rejectWait) => {
			const timer = setTimeout(() => rejectWait(new Error(`protocol timeout: ${stderr}`)), 3_000);
			waiters.push({
				matches,
				resolve: (value) => {
					clearTimeout(timer);
					resolveWait(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					rejectWait(error);
				},
			});
		});
	};
	await wait((record) => record.type === "ready");
	return {
		wait,
		send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
		complete: async (id, extra = {}) => {
			child.stdin.write(`${JSON.stringify({ cmd: "complete", id, provider: "pi-fixed", modelId: "model", userText: "草稿", systemPrompt: "rewrite only", ...extra })}\n`);
			return wait((record) => record.id === id && (record.type === "done" || record.type === "error"));
		},
	};
}

test("同一增强进程每次读新 pi 配置；默认不带前文，开启后只作为参考数据", { timeout: 10_000 }, async (t) => {
	const h = await hostHarness(t);
	const first = JSON.parse((await h.complete("first")).text);
	assert.equal(first.revision, 1);
	assert.deepEqual(
		first.context.messages.map(({ role, content }) => ({ role, content })),
		[
			{ role: "system", content: "rewrite only" },
			{ role: "user", content: "草稿" },
		],
	);
	const context = [
		{ role: "user", text: "先前需求" },
		{ role: "assistant", text: "已有回答" },
	];
	const second = JSON.parse((await h.complete("second", { context })).text);
	assert.equal(second.revision, 2);
	assert.equal(second.context.messages.at(-1).content, "草稿");
	const background = second.context.messages[1];
	assert.equal(background.role, "user");
	assert.ok(background.content.includes(JSON.stringify(context)));
	assert.ok(second.context.messages[0].content.includes("参考"));
});

test("DSH 独有模型明确报 model-not-found，不回退其他模型", { timeout: 10_000 }, async (t) => {
	const h = await hostHarness(t);
	const result = await h.complete("dsh", { provider: "builtin:dsh-only" });
	assert.equal(result.type, "error");
	assert.equal(result.errorKind, "model-not-found");
});

test("本地模型配置刷新期间取消，不能继续创建付费流", { timeout: 10_000 }, async (t) => {
	const h = await hostHarness(t);
	const pending = h.complete("cancelled");
	await h.wait((record) => record.id === "cancelled" && record.type === "started");
	h.send({ cmd: "cancel", id: "cancelled" });
	const result = await pending;
	assert.equal(result.type, "error");
	assert.equal(result.errorKind, "aborted");
});
