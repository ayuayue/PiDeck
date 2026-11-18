import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { PiDesktopApi } from "../src/preload";
import { test, expect } from "./mock-pi-fixture";

/** 发版前核心链路：真实 Electron / IPC / 子进程，模型调用仅走本机 HTTP 替身。 */
const acpScript = resolve(__dirname, "fixtures", "release-mock-acp.mjs");

async function sendAndExpect(window: Page, prompt: string, reply: string) {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type(prompt);
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(reply, { timeout: 45_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 45_000 });
}

test.describe("release core: pi", () => {
	test.use({ seedSettings: { defaultAgentBackend: "pi", defaultAgentBackendManual: true, agentMemoryEnabled: false, checkUpdateOnStartup: false } });

	test("pi: 首发与续发均完成，真实 mock CLI 返回不同回复", async ({ window }) => {
		test.setTimeout(120_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await sendAndExpect(window, "pi 冒烟第一轮", "Mock 回复：「pi 冒烟第一轮」流式渲染验证完成");
		await sendAndExpect(window, "pi 冒烟第二轮", "Mock 回复：「pi 冒烟第二轮」流式渲染验证完成");
	});
});

test.describe("release core: ACP", () => {
	test.use({
		seedSettings: {
			defaultAgentBackend: "pi",
			defaultAgentBackendManual: true,
			agentMemoryEnabled: false,
			checkUpdateOnStartup: false,
			acpEnabled: true,
			acpTools: [{ id: "release-smoke-acp", name: "Release Smoke ACP", command: process.execPath, args: [acpScript], enabled: true }],
		},
	});

	test("ACP: 从输入框切换工具，握手并完成两轮 stdio 消息", async ({ window }) => {
		test.setTimeout(120_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await window.locator(".composer-bar-btn.backend").click();
		await window.getByRole("option", { name: "Release Smoke ACP" }).click();
		await expect(window.locator(".composer-bar-btn.backend")).toHaveAttribute("aria-label", "Release Smoke ACP");
		await sendAndExpect(window, "ACP 冒烟第一轮", "ACP 冒烟回复：ACP 冒烟第一轮");
		await sendAndExpect(window, "ACP 冒烟第二轮", "ACP 冒烟回复：ACP 冒烟第二轮");
	});
});

test.describe("release core: DSH", () => {
	// seedSettings 在启动前创建本机模型服务与隔离的 DSH_HOME，避免读取真实 ~/.dsh/凭据。
	test.use({
		seedSettings: async ({}, use) => {
			const home = mkdtempSync(join(tmpdir(), "pideck-release-dsh-"));
			const originalSmokeKey = process.env.PIDECK_RELEASE_SMOKE_KEY;
			const prompts: string[] = [];
			const server = createServer(async (request, response) => {
				if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
					response.writeHead(404).end();
					return;
				}
				try {
					const chunks: Buffer[] = [];
					for await (const chunk of request) chunks.push(Buffer.from(chunk));
					const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; messages?: Array<{ role?: string; content?: string }> };
					if (body.model !== "release-smoke-model") throw new Error("DSH selected a different model");
					const userText =
						body.messages
							?.filter((message) => message.role === "user")
							.map((message) => JSON.stringify(message.content))
							.join("\n") ?? "";
					// host 会在回合前插入时间上下文，也会另发标题生成请求；只在模型上下文确实含用户输入时才回匹配标记。
					const prompt = ["DSH 冒烟第二轮", "DSH 冒烟第一轮"].find((candidate) => userText.includes(candidate));
					if (prompt && !userText.includes("Generate the session title")) prompts.push(prompt);
					const answer = prompt && !userText.includes("Generate the session title") ? `DSH 冒烟回复：${prompt}` : "测试内部请求";
					response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
					response.write(`data: ${JSON.stringify({ id: "release-smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`);
					response.end(`data: ${JSON.stringify({ id: "release-smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
				} catch {
					response.writeHead(400).end();
				}
			});
			try {
				await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Local DSH model endpoint did not start");
				mkdirSync(join(home, "sessions"), { recursive: true });
				writeFileSync(
					join(home, "settings.yaml"),
					[
						"llm-pi-ai:",
						"  providers:",
						"    release-smoke:",
						"      apiKeyEnv: PIDECK_RELEASE_SMOKE_KEY",
						"      api: openai-completions",
						`      baseURL: http://127.0.0.1:${address.port}/v1`,
						"      models:",
						"        - id: release-smoke-model",
						"          reasoningEfforts:",
						"            off: null",
						"            high: high",
						"agent-default-model:",
						"  provider: release-smoke",
						"  model: release-smoke-model",
						"  reasoningEffort: off",
						"",
					].join("\n"),
				);
				// DSH host 从启动环境取测试专用凭证；只发给 127.0.0.1，不读取用户密钥。
				process.env.PIDECK_RELEASE_SMOKE_KEY = "local-smoke-only";
				await use({ dshHomeDir: home, defaultAgentBackend: "dsh", defaultAgentBackendManual: true, agentMemoryEnabled: false, checkUpdateOnStartup: false });
				expect(prompts).toEqual(expect.arrayContaining(["DSH 冒烟第一轮", "DSH 冒烟第二轮"]));
			} finally {
				if (originalSmokeKey === undefined) delete process.env.PIDECK_RELEASE_SMOKE_KEY;
				else process.env.PIDECK_RELEASE_SMOKE_KEY = originalSmokeKey;
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				rmSync(home, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
			}
		},
	});

	test("DSH: 导入离线 runtime，host 启动并完成两轮本机模型请求", async ({ app, window }) => {
		test.setTimeout(300_000);
		const archive = resolve("dist-runtime", `dsh-runtime-${process.platform}-${process.arch}.tgz`);
		expect(existsSync(archive), "先运行 npm run runtime:pack 生成本平台 DSH runtime 归档").toBe(true);
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, archive);
		const installed = await window.evaluate(() => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.sessions.importDshRuntimeFile());
		expect(installed).toMatchObject({ ok: true });
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await expect(window.locator(".composer-bar-btn.backend")).toHaveAttribute("aria-label", "DSH", { timeout: 30_000 });
		await sendAndExpect(window, "DSH 冒烟第一轮", "DSH 冒烟回复：DSH 冒烟第一轮");
		await sendAndExpect(window, "DSH 冒烟第二轮", "DSH 冒烟回复：DSH 冒烟第二轮");
	});
});
