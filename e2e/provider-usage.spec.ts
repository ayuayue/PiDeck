import { test, expect } from "./fixtures";
import type { ElectronApplication, Page } from "@playwright/test";
import { openSettings } from "./open-session";

/**
 * 供应商用量链路 E2E（cc-switch 风格统一显示）：
 * - 设置模型卡片 inline 用量 + 展开详情（TierBar/余额行）
 * - 探针配置弹窗闭环：per-provider 开关 + 模板 pill → 测试（成功即写缓存，三处立显）→ 保存 → 回显
 * - 失败态：inline 不渲染、详情出「用量暂时不可用 + 去配置」
 * - （认证页/auth tab）认证行 inline 用量
 *
 * 主进程 IPC 经 app.evaluate 重注册为确定性 stub——e2e 不访问真实网络、
 * 不读写真实 ~/.pi/agent（模型/探针数据全部内联种子）。
 */

type UsageStubSeed = {
	modelsResult: unknown;
	authResult?: unknown;
	usageByProvider: Record<string, unknown>;
	/** provider → 内置模板识别结果（弹窗「已内置」pill 数据源）。 */
	recognizedByProvider: Record<string, { templateId: string; category: string }>;
	testResult: unknown;
};

/** 在主进程把配置域 IPC 换成确定性 stub；保存的探针配置记录在 main 全局（跨 evaluate 可读）。 */
async function stubUsageIpc(app: ElectronApplication, seed: UsageStubSeed): Promise<void> {
	await app.evaluate((electron, { modelsResult, authResult, usageByProvider, recognizedByProvider, testResult }) => {
		// 注意：app.evaluate 只把函数体序列化到主进程执行——闭包里的模块导入
		// （如 shared/ipc 的通道常量）在目标环境不存在，通道名必须就地字面量；
		// 参数位解构也会被 TS 编译出临时变量，只能在函数体内解构。
		const { ipcMain } = electron;
		const g = globalThis as unknown as {
			__usageE2E?: { saved: Record<string, unknown>; saveCount: number };
		};
		g.__usageE2E = { saved: {}, saveCount: 0 };
		ipcMain.removeHandler("config:get-models");
		ipcMain.handle("config:get-models", () => modelsResult);
		ipcMain.removeHandler("config:get-auth");
		ipcMain.handle("config:get-auth", () => authResult ?? { parsed: {}, raw: "{}", diagnostic: null });
		ipcMain.removeHandler("config:fetch-usage");
		ipcMain.handle("config:fetch-usage", (_event, payload: { provider?: string }) => {
			const hit = payload?.provider ? usageByProvider[payload.provider] : undefined;
			return hit ?? { success: false, error: "unsupported provider (e2e stub)" };
		});
		ipcMain.removeHandler("config:get-usage-probes");
		ipcMain.handle("config:get-usage-probes", (_event, payload: { provider?: string }) => ({
			config: payload?.provider ? g.__usageE2E?.saved[payload.provider] : undefined,
			recognized: payload?.provider ? (recognizedByProvider[payload.provider] ?? null) : null,
			templates: [],
			errors: [],
		}));
		ipcMain.removeHandler("config:save-usage-probes");
		ipcMain.handle("config:save-usage-probes", (_event, payload: { provider?: string; config?: unknown }) => {
			if (g.__usageE2E && payload?.provider) {
				g.__usageE2E.saved[payload.provider] = payload.config ?? {};
				g.__usageE2E.saveCount += 1;
			}
			return { ok: true };
		});
		ipcMain.removeHandler("config:test-usage-probe");
		ipcMain.handle("config:test-usage-probe", () => testResult);
	}, seed);
}

/** 打开设置 → 配置管理分区 → 模型页（无 pi 环境下由 stub 提供供应商列表）。 */
async function openModelsTab(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 侧栏齿轮打开设置窗口 → 顶部「配置管理」分区 → 左栏「模型」
	await openSettings(window);
	await window.getByRole("tab", { name: "配置管理" }).click();
	const modal = window.locator(".config-layout");
	await expect(modal).toBeVisible({ timeout: 10_000 });
	await modal.getByRole("tab", { name: "模型", exact: true }).click();
	await expect(window.locator(".config-provider-card").first()).toBeVisible({ timeout: 10_000 });
	return modal;
}

/** 展开指定供应商的卡片（点击卡片头）。 */
async function expandProviderCard(window: Page, providerName: string) {
	const card = window.locator(".config-provider-card", { hasText: providerName });
	await card.locator("div").first().click();
	await expect(card.locator('[data-testid="provider-usage-details"]')).toBeVisible({ timeout: 10_000 });
	return card;
}

const seedModels = {
	parsed: {
		providers: {
			ds: {
				baseUrl: "https://api.deepseek.com",
				api: "openai-completions",
				apiKey: "sk-e2e",
				models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
			},
			or: {
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
				apiKey: "sk-e2e-or",
				models: [{ id: "or-model", name: "OR Model" }],
			},
		},
	},
	raw: "{}",
	diagnostic: null,
};

const seedRecognized = {
	ds: { templateId: "deepseek-balance", category: "balance" },
	or: { templateId: "openrouter-credits", category: "balance" },
};

test("usage: provider card shows cc-switch inline usage and details rows", async ({ app, window }) => {
	test.setTimeout(90_000);
	await stubUsageIpc(app, {
		modelsResult: seedModels,
		// ds=余额（绿色）；or=多窗口 credits（5h 窗 92% 红、周窗 10% 绿）
		usageByProvider: {
			ds: { success: true, kind: "balance", balance: { value: 5.34, currency: "CNY" }, at: Date.now() },
			or: {
				success: true,
				kind: "credits",
				credits: {
					windows: [
						{ key: "fiveHour", total: 100, used: 92 },
						{ key: "weekly", total: 100, used: 10 },
					],
				},
				at: Date.now(),
			},
		},
		recognizedByProvider: seedRecognized,
		testResult: { success: false, error: "no test in this case" },
	});

	await openModelsTab(window);

	// 卡头 inline：ds 余额（灰「剩」+ 绿色数值），or 百分比（92% 红）
	const dsInline = window.locator('[data-testid="provider-usage-inline"][data-provider="ds"]');
	await expect(dsInline).toContainText("剩", { timeout: 10_000 });
	await expect(dsInline).toContainText("¥5.34");
	await expect(window.locator('[data-testid="provider-usage-row"][data-provider="ds"]')).toBeVisible();
	const orInline = window.locator('[data-testid="provider-usage-inline"][data-provider="or"]');
	await expect(orInline).toContainText("92%");
	// inline 带相对更新时间 + 刷新按钮（cc-switch 卡头同款）
	await expect(orInline.locator('[data-testid="provider-usage-inline-refresh"]')).toBeVisible();

	// 展开卡片：详情 = TierBar 行（label + 进度条 + 彩色百分比 + 剩余小字）
	const card = await expandProviderCard(window, "or");
	const details = card.locator('[data-testid="provider-usage-details"]');
	await expect(details).toBeVisible();
	await expect(details).toContainText("5小时");
	await expect(details).toContainText("92%");
	await expect(details).toContainText("10%");
	// 刷新按钮存在（手动重查入口）
	await expect(details.locator('[data-testid="provider-usage-refresh"]')).toBeVisible();
});

test("usage: probe dialog closes the loop (New API template -> test writes cache -> save)", async ({ app, window }) => {
	test.setTimeout(90_000);
	await stubUsageIpc(app, {
		modelsResult: seedModels,
		usageByProvider: {
			ds: { success: true, kind: "balance", balance: { value: 5.34, currency: "CNY" }, at: Date.now() },
		},
		recognizedByProvider: {},
		// 测试固定返回成功（$42 余额）——验证写缓存后卡头立刻更新
		testResult: { success: true, kind: "balance", balance: { value: 42, currency: "USD" }, at: Date.now() },
	});

	await openModelsTab(window);
	await expandProviderCard(window, "ds");

	// 打开探针配置弹窗
	await window.getByRole("button", { name: "用量查询", exact: true }).first().click();
	const dialog = window.locator(".config-usage-probe-dialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });

	// 默认选中「通用模板」（未识别到内置）；切到 New API：只填令牌 + 用户 ID 两项
	await expect(dialog.getByText("通用模板")).toBeVisible();
	await dialog.getByTestId("usage-probe-template-newapi").click();
	await dialog.getByPlaceholder("在 New API 网站「个人设置 → 安全」里生成").fill("sk-e2e-newapi-token");
	await dialog.getByPlaceholder("例如 114514").fill("114514");

	// 测试：成功 → 内联摘要 + toast + 写缓存（卡头 inline 立即变成 $42，等价 cc-switch setQueryData）
	await dialog.getByRole("button", { name: "测试", exact: true }).click();
	await expect(dialog).toContainText("$42", { timeout: 10_000 });
	await expect(window.locator('[data-testid="provider-usage-inline"][data-provider="ds"]')).toContainText("$42", { timeout: 10_000 });

	// 保存：成功 → 弹窗关闭（缓存已全量失效，三处会重查）
	await dialog.getByRole("button", { name: "保存", exact: true }).click();
	await expect(dialog).toBeHidden({ timeout: 10_000 });

	// 重新打开：New API 模板与已填字段回显（主进程 stub 记录了保存的 per-provider 配置；
	// accessToken 输入框存在即说明 newapi 模板被选中，值回填验证配置闭环）
	await window.getByRole("button", { name: "用量查询", exact: true }).first().click();
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await expect(dialog.getByPlaceholder("在 New API 网站「个人设置 → 安全」里生成")).toHaveValue("sk-e2e-newapi-token");
});

test("usage: failed probe keeps header clean and offers configure entry", async ({ app, window }) => {
	test.setTimeout(90_000);
	await stubUsageIpc(app, {
		modelsResult: seedModels,
		usageByProvider: {
			ds: { success: false, error: "boom (e2e)" },
		},
		recognizedByProvider: {},
		testResult: { success: false, error: "boom (e2e)" },
	});

	await openModelsTab(window);

	// 失败 → 卡头 inline 与整个底部用量行都不渲染（「查不到就不显示」）
	await expect(window.locator('[data-testid="provider-usage-inline"][data-provider="ds"]')).toHaveCount(0, { timeout: 10_000 });
	await expect(window.locator('[data-testid="provider-usage-row"][data-provider="ds"]')).toHaveCount(0, { timeout: 10_000 });

	// 展开卡片 → 失败详情 + 「去配置」小入口 → 打开配置弹窗
	const card = await expandProviderCard(window, "ds");
	const details = card.locator('[data-testid="provider-usage-details"]');
	await expect(details).toContainText("用量暂时不可用", { timeout: 10_000 });
	await details.locator('[data-testid="provider-usage-configure"]').click();
	await expect(window.locator(".config-usage-probe-dialog")).toBeVisible({ timeout: 10_000 });
});

test("usage: builtin template shows as recognized pill with zero fields", async ({ app, window }) => {
	test.setTimeout(90_000);
	await stubUsageIpc(app, {
		modelsResult: seedModels,
		usageByProvider: {
			ds: { success: true, kind: "balance", balance: { value: 5.34, currency: "CNY" }, at: Date.now() },
		},
		recognizedByProvider: seedRecognized,
		testResult: { success: false, error: "no test in this case" },
	});

	await openModelsTab(window);
	await expandProviderCard(window, "ds");
	await window.getByRole("button", { name: "用量查询", exact: true }).first().click();
	const dialog = window.locator(".config-usage-probe-dialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });

	// 识别命中：只显示「已内置：官方余额」+ 通用模板 + New API（不全量摆 5 类）。
	await expect(dialog.getByText("已内置：官方余额")).toBeVisible();
	// 预制模板差异化：显示已识别供应商徽标（cc-switch DeepSeek 蓝标同款）。
	await expect(dialog.getByTestId("usage-probe-recognized-badge")).toContainText("ds");
	// 无字段（无 API Key/请求地址输入框），开关默认开。
	await expect(dialog.getByTestId("usage-probe-enable")).toBeChecked();
	await expect(dialog.getByPlaceholder("留空则使用供应商的 API Key")).toHaveCount(0);
});

test("usage: auth tab shows provider balance inline", async ({ app, window }) => {
	test.setTimeout(90_000);
	await stubUsageIpc(app, {
		modelsResult: seedModels,
		// 认证页数据：一条 ds 认证（models.json 里同名供应商有 baseUrl，可查用量）
		authResult: {
			parsed: { ds: { key: "sk-e2e-1234567890abcd", type: "api_key" } },
			raw: "{}",
			diagnostic: null,
		},
		usageByProvider: {
			ds: { success: true, kind: "balance", balance: { value: 5.34, currency: "CNY" }, at: Date.now() },
		},
		recognizedByProvider: seedRecognized,
		testResult: { success: false, error: "no test in this case" },
	});

	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openSettings(window);
	await window.getByRole("tab", { name: "配置管理" }).click();
	const modal = window.locator(".config-layout");
	await expect(modal).toBeVisible({ timeout: 10_000 });
	await modal.getByRole("tab", { name: "认证", exact: true }).click();

	// 认证行右侧出现该供应商的余额（与模型页/圆球同一份数据源）
	const inline = window.locator('[data-testid="provider-usage-inline"][data-provider="ds"]');
	await expect(inline).toBeVisible({ timeout: 15_000 });
	await expect(inline).toContainText("¥5.34");
	await expect(window.locator('[data-testid="provider-usage-row"][data-provider="ds"]')).toBeVisible();
	await expect(inline).toContainText("剩");
});
