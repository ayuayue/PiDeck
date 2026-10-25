import { test, expect } from "./fixtures";
import { mkdirSync, mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

/**
 * DSH 模型能力端到端验证（真实 DSH host 走 utilityProcess 深融合链路）：
 * 1. 模型列表：打开模型选择器应加载 host 级 llm.models 目录（deepseek-official / opencode-go 两组），
 *    而不是 pi 的 models.json —— 会话 record.backend === "dsh" 决定加载源；
 * 2. 模型切换：点击模型行 → setRuntimeModel → host session.selectModel（草稿期写 catalog，
 *    激活时 applyPreferences 套到 host）；
 * 3. 思考档位过滤：思考选择器按当前模型 reasoningEfforts 过滤（glm-5.2 只支持 high/max）；
 * 4. 发送激活后 runtime state 反映新模型与新档位（host 侧真实选择）。
 *
 * 隔离：settings.dshHomeDir 指向临时 DSH_HOME（复制真实 settings.yaml，不带凭证），
 * 不触碰用户真实 ~/.dsh 配置与会话。
 */
test("DSH 模型列表、切换与思考档位（草稿 → 激活全链路）", async ({ window }) => {
	test.setTimeout(240_000);
	// ── 1. 隔离 DSH_HOME ──────────────────────────────────────────────────────
	const dshHome = mkdtempSync(join(tmpdir(), "pideck-e2e-dsh-"));
	mkdirSync(join(dshHome, "sessions"), { recursive: true });
	mkdirSync(join(dshHome, "storages"), { recursive: true });
	const realSettings = join(homedir(), ".dsh", "settings.yaml");
	if (existsSync(realSettings)) {
		copyFileSync(realSettings, join(dshHome, "settings.yaml"));
	}
	await window.evaluate(async (dir) => {
		await (window as unknown as { piDesktop: { settings: { update: (patch: { dshHomeDir?: string }) => Promise<unknown> } } }).piDesktop.settings.update({ dshHomeDir: dir });
	}, dshHome);

	// ── 2. 新建 DSH 会话草稿（新会话默认 DSH 后端）────────────────────────────
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const newDsh = window.getByRole("button", { name: "新会话", exact: true });
	await expect(newDsh).toBeVisible({ timeout: 15_000 });
	await newDsh.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// ── 2.5 部署默认模型/思考档位展示（settings.yaml agent-default-model）─────
	// 草稿未激活时底栏模型按钮应显示默认模型名（deepseek-v4-flash），思考按钮应显示
	// 默认档位（max）——这是「没有渲染出来默认的模型和思考级别的显示」bug 的回归保护。
	const modelBtn = window.locator(".composer-bar-btn.model");
	const thinkingBtn = window.locator(".composer-bar-btn.thinking");
	await expect(modelBtn).toBeVisible();
	await expect(modelBtn).toContainText("deepseek-v4-flash", { timeout: 10_000 });
	await expect(thinkingBtn).toBeVisible();
	await expect(thinkingBtn).toContainText("max", { timeout: 10_000 });

	// ── 3. 模型列表：必须来自 DSH host 目录（两组 provider）──────────────────
	await modelBtn.click();
	const picker = window.locator(".model-picker");
	await expect(picker).toBeVisible();
	// llm-pi-ai（opencode-go，来自 settings.yaml）+ llm-deepseek（deepseek-official 官方路由）
	await expect(picker.locator('[data-picker-value="opencode-go/deepseek-v4-flash"]')).toBeVisible({ timeout: 30_000 });
	await expect(picker.locator('[data-picker-value="deepseek-official/deepseek-v4-pro"]')).toBeVisible();
	// 反面：DSH 会话不得展示 pi 的 models.json 专属模型（例如 anthropic 组）
	await expect(picker.locator('[data-picker-value^="anthropic/"]')).toHaveCount(0);

	// ── 4. 切换模型：opencode-go/glm-5.2 ──────────────────────────────────────
	await picker.locator('[data-picker-value="opencode-go/glm-5.2"]').click();
	await expect(picker).toHaveCount(0, { timeout: 5_000 });
	await expect(modelBtn).toContainText("glm-5.2", { timeout: 5_000 });

	// ── 5. 思考档位过滤：glm-5.2 只支持 high/max，不得出现 off ──────────────
	await thinkingBtn.click();
	const thinking = window.locator(".thinking-picker");
	await expect(thinking).toBeVisible();
	await expect(thinking.locator('[data-picker-value="high"]')).toBeVisible();
	await expect(thinking.locator('[data-picker-value="max"]')).toBeVisible();
	await expect(thinking.locator('[data-picker-value="off"]')).toHaveCount(0);
	await expect(thinking.locator('[data-picker-value="minimal"]')).toHaveCount(0);
	await thinking.locator('[data-picker-value="high"]').click();
	await expect(thinking).toHaveCount(0, { timeout: 5_000 });

	// ── 6. 发送激活：applyPreferences 把选中的模型/档位套到 host 会话 ────────
	await composer.click();
	await window.keyboard.type("回复两个字：收到");
	await window.keyboard.press("Enter");

	// 等 runtime 激活并完成偏好应用（无凭证回合会失败，但 selectModel 已应用）。
	// 注意：用固定间隔轮询而非 expect.poll——实测 poll 首轮立即求值会与发送竞态
	// （Playwright evaluate 等待渲染主线程让出，轮询窗口内一直拿不到 runtime）。
	const readDshRuntimeState = () =>
		window.evaluate(async () => {
			const pi = (
				window as unknown as {
					piDesktop: {
						sessions: {
							listRuntimes: () => Promise<Array<{ sessionId: string; agentId: string; runtimeGeneration: number }>>;
							getRuntimeState: (target: unknown) => Promise<{ ok: boolean; value: { value?: { modelId?: string; provider?: string; thinkingLevel?: string } } }>;
						};
					};
				}
			).piDesktop;
			const runtimes = await pi.sessions.listRuntimes();
			const dsh = runtimes.find((runtime) => runtime.agentId.startsWith("dsh:"));
			if (!dsh) return null;
			// getRuntimeState 返回 SessionTargetedValue：{ target, value: AgentRuntimeState }
			const result = await pi.sessions.getRuntimeState(dsh);
			return result.ok ? (result.value.value ?? null) : null;
		});
	let state: { modelId?: string; provider?: string; thinkingLevel?: string } | null = null;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		state = await readDshRuntimeState();
		if (state?.modelId === "glm-5.2") break;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	expect(state?.modelId).toBe("glm-5.2");
	expect(state?.provider).toBe("opencode-go");
	expect(state?.thinkingLevel).toBe("high");

	// ── 7. 底栏实时反映 host 侧生效模型 ───────────────────────────────────────
	await expect(modelBtn).toContainText("glm-5.2", { timeout: 10_000 });
	// levelLabel.high 的文案就是 "high"（zh-CN/en-US 一致展示档位名）
	await expect(thinkingBtn).toContainText("high", { timeout: 10_000 });

	// ── 8. 运行中会话再次切换模型（走 setRuntimeModel → host selectModel）─────
	await modelBtn.click();
	await expect(picker).toBeVisible();
	await expect(picker.locator('[data-picker-value="deepseek-official/deepseek-v4-pro"]')).toBeVisible({ timeout: 10_000 });
	await picker.locator('[data-picker-value="deepseek-official/deepseek-v4-pro"]').click();
	await expect(picker).toHaveCount(0, { timeout: 5_000 });
	for (let attempt = 0; attempt < 15; attempt += 1) {
		state = await readDshRuntimeState();
		if (state?.modelId === "deepseek-v4-pro") break;
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	expect(state?.modelId).toBe("deepseek-v4-pro");
	expect(state?.provider).toBe("deepseek-official");
	expect(state?.thinkingLevel).toBe("high");

	// deepseek-v4-pro 只支持 off/high/max：思考选择器应同步过滤
	await thinkingBtn.click();
	await expect(thinking).toBeVisible();
	await expect(thinking.locator('[data-picker-value="high"]')).toBeVisible();
	await expect(thinking.locator('[data-picker-value="max"]')).toBeVisible();
	await expect(thinking.locator('[data-picker-value="off"]')).toBeVisible();
	await expect(thinking.locator('[data-picker-value="minimal"]')).toHaveCount(0);
});
