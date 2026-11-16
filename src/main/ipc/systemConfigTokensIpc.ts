/**
 * 内置 TokenDance / 「请作者喝咖啡」付费入口 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、
 * 日志与文案逐字未改）。通道：config:get-tokendance-models / config:get-tokendance-price-tags /
 * config:tokendance-auth-* / config:install-tokendance / config:tokendance-top-up-* /
 * config:watcha-open-alipay / config:watcha-access。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { TokendanceAuthMode, TokendanceAuthStore } from "../config/tokendanceAuth";
import type { TokendanceCatalogStore } from "../config/tokendanceCatalog";
import type { TokendanceInstallResult } from "../config/tokendanceInstaller";
import type { TokendancePaymentStore } from "../config/tokendancePayment";
import type { TokendancePricingStore } from "../config/tokendancePricing";
import type { WatchaEntitlementStore } from "../config/watchaEntitlement";
import type { AppLogger } from "../logging/AppLogger";
import type { PiModelCapabilityCache } from "../pi/PiModelCapabilityCache";

export type SystemConfigTokensIpcDeps = {
	appLogger: AppLogger;
	modelCapabilityCache: PiModelCapabilityCache;
	/** 内置 TokenDance 模型目录（live fetch + userData 缓存）；未装配 = 列表不注入。 */
	tokendanceCatalog?: TokendanceCatalogStore;
	/** TokenDance 公开报价派生的折扣/免费徽章表（模型选择器展示用）；未装配 = 不显示徽章。 */
	tokendancePricing?: TokendancePricingStore;
	/** 内置 TokenDance OAuth 授权流程（PKCE verifier 内存持有）；未装配 = 授权入口不可用。 */
	tokendanceAuth?: TokendanceAuthStore;
	/** 内置 TokenDance 充值会话（创建 + 状态查询，Key 不出主进程）；未装配 = 充值入口不可用。 */
	tokendancePayment?: TokendancePaymentStore;
	/** 「请作者喝咖啡」按次付费（只调自家边缘代理）；未装配 = 该入口不可用。 */
	watchaEntitlement?: WatchaEntitlementStore;
	/** TokenDance 一键安装（写入 pi models.json + DSH llm-pi-ai）；未装配 = 配置入口不可用。 */
	tokendanceInstall?: (apiKey?: string) => Promise<TokendanceInstallResult>;
};

export function registerSystemConfigTokensIpc(deps: SystemConfigTokensIpcDeps): void {
	const { appLogger, modelCapabilityCache, tokendanceCatalog, tokendancePricing, tokendanceAuth, tokendancePayment, watchaEntitlement, tokendanceInstall } = deps;

	ipcMain.handle(ipcChannels.configGetTokendanceModels, async (_event, force: unknown) => {
		// force 必须为布尔（渲染层入参不可信）；目录拉取/缓存错误统一兜底空结果。
		const forceArg = force === true;
		try {
			if (!tokendanceCatalog) return { models: [], fromCache: false, at: 0 };
			const result = forceArg ? await tokendanceCatalog.refresh() : await tokendanceCatalog.getModels();
			return result ?? { models: [], fromCache: false, at: 0 };
		} catch (error) {
			void appLogger.warn("config", "TokenDance catalog load failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { models: [], fromCache: false, at: 0 };
		}
	});
	ipcMain.handle(ipcChannels.configGetTokendancePriceTags, async () => {
		// 徽章是装饰信息：没有装配/拉取失败都返回空表，模型列表照常显示（不阻塞选择器）。
		if (!tokendancePricing) return { tags: {}, at: 0 };
		try {
			const result = await tokendancePricing.getTags();
			return { tags: result.tags, at: result.at };
		} catch (error) {
			void appLogger.warn("config", "TokenDance price tags load failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { tags: {}, at: 0 };
		}
	});
	ipcMain.handle(ipcChannels.configTokendanceAuthStart, async (_event, payload: unknown) => {
		// 未装配 = 主进程没注册授权能力（预览/测试壳），返回失败不抛异常。
		if (!tokendanceAuth) return { ok: false, error: "TokenDance auth unavailable" };
		const mode = typeof payload === "object" && payload ? (payload as { mode?: unknown }).mode : undefined;
		// 枚举白名单：只认 headless，其余（含缺失/非法）一律取默认 callback。
		const requested: TokendanceAuthMode = mode === "headless" ? "headless" : "callback";
		try {
			// callback 模式要绑定本地端口（异步），失败时 store 内部降级为 headless 并带 fallbackReason。
			return { ok: true, ...(await tokendanceAuth.start({ mode: requested })) } as const;
		} catch (error) {
			void appLogger.warn("config", "TokenDance auth start failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { ok: false, error: "TokenDance auth start failed" };
		}
	});
	ipcMain.handle(ipcChannels.configTokendanceAuthAwait, async (_event, payload: unknown) => {
		// callback 模式主路径：挂起等待浏览器把 code 送回本地，拿到就当场交换成 Key。
		const flowId = typeof payload === "object" && payload ? (payload as { flowId?: unknown }).flowId : undefined;
		if (typeof flowId !== "string" || !flowId) {
			return { ok: false, error: "Invalid auth await input" };
		}
		if (!tokendanceAuth) return { ok: false, error: "TokenDance auth unavailable" };
		const result = await tokendanceAuth.awaitKey(flowId);
		if (result.ok) {
			void appLogger.info("config", "TokenDance API key exchanged via callback");
			return { ok: true, key: result.key } as const;
		}
		void appLogger.warn("config", "TokenDance callback auth failed", { error: result.error });
		return { ok: false, error: result.error } as const;
	});
	ipcMain.handle(ipcChannels.configTokendanceAuthCancel, async (_event, payload: unknown) => {
		// 生命周期配对：弹窗关闭/取消必须释放回环端口，否则端口随流程泄漏到过期清理为止。
		const flowId = typeof payload === "object" && payload ? (payload as { flowId?: unknown }).flowId : undefined;
		if (typeof flowId !== "string" || !flowId) return { ok: false, error: "Invalid auth cancel input" };
		tokendanceAuth?.cancel(flowId);
		return { ok: true } as const;
	});
	ipcMain.handle(ipcChannels.configTokendanceAuthExchange, async (_event, payload: unknown) => {
		// 边界校验：flowId/code 必须是非空字符串（渲染层入参不可信）；code 不写日志。
		const flowId = typeof payload === "object" && payload ? (payload as { flowId?: unknown }).flowId : undefined;
		const code = typeof payload === "object" && payload ? (payload as { code?: unknown }).code : undefined;
		if (typeof flowId !== "string" || !flowId || typeof code !== "string" || !code) {
			return { ok: false, error: "Invalid auth exchange input" };
		}
		if (!tokendanceAuth) return { ok: false, error: "TokenDance auth unavailable" };
		const result = await tokendanceAuth.complete(flowId, code);
		if (result.ok) {
			void appLogger.info("config", "TokenDance API key exchanged");
			return { ok: true, key: result.key } as const;
		}
		void appLogger.warn("config", "TokenDance auth exchange failed", { error: result.error });
		return { ok: false, error: result.error } as const;
	});
	ipcMain.handle(ipcChannels.configInstallTokendance, async (_event, payload: unknown) => {
		// 边界校验：apiKey 为可选字符串（渲染层入参不可信）；Key 不写日志。
		if (!tokendanceInstall) {
			return { ok: false, modelCount: 0, piSaved: false, dshSaved: false, error: "TokenDance install unavailable" };
		}
		const apiKey = payload && typeof payload === "object" ? (payload as { apiKey?: unknown }).apiKey : undefined;
		if (typeof apiKey !== "undefined" && typeof apiKey !== "string") {
			return { ok: false, modelCount: 0, piSaved: false, dshSaved: false, error: "Invalid install input" };
		}
		try {
			const result = await tokendanceInstall(typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined);
			void appLogger.info("config", "TokenDance provider installed", {
				ok: result.ok,
				modelCount: result.modelCount,
				piSaved: result.piSaved,
				dshSaved: result.dshSaved,
				dshWroteViaHost: result.dshWroteViaHost,
				// 失败原因仅诊断用（DSH schema 拒绝等），不含任何 Key 内容
				dshError: result.dshError,
			});
			if (result.ok) {
				// 写盘后立即失效 model capability 快照：watcher（250ms debounce）会接管刷新
				// hydration；这里只清快照不 hydration，避免与 watcher 重复 spawn 临时 pi。
				// 若 watcher 异常未触发，下次 ensure() 也会以新 generation 惰性 hydrate。
				modelCapabilityCache.invalidate();
			}
			return result;
		} catch (error) {
			void appLogger.warn("config", "TokenDance install failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { ok: false, modelCount: 0, piSaved: false, dshSaved: false, error: "TokenDance install failed" };
		}
	});
	ipcMain.handle(ipcChannels.configTokendanceTopUpCreate, async (_event, payload: unknown) => {
		// 用赋值与开支付接口同一个 Key（该 Key 所属账户）；未装配 = 主进程无充值能力（预览/测试壳）。
		if (!tokendancePayment) return { ok: false, code: "not-configured" } as const;
		// 边界校验：amount 必须是整数元（渲染层入参不可信）；范围判定与渲染层提示共用同一份常量。
		const amount = payload && typeof payload === "object" ? (payload as { amount?: unknown }).amount : undefined;
		const result = await tokendancePayment.createSession(amount);
		if (result.ok) {
			// 只记金额与到期时间，不记会话 ID / payment_url（含渠道参数，无诊断价值）。
			void appLogger.info("config", "TokenDance top-up session created", { amount: result.session.amount, expiredAt: result.session.expiredAt });
		} else {
			void appLogger.warn("config", "TokenDance top-up session failed", { code: result.code, detail: result.detail });
		}
		return result;
	});
	ipcMain.handle(ipcChannels.configTokendanceTopUpStatus, async (_event, payload: unknown) => {
		if (!tokendancePayment) return { ok: false, code: "not-configured" } as const;
		// 边界校验：statusUrl 必须是非空字符串；同源 + 路径前缀白名单在 store 内判定（不信任渲染层）。
		const statusUrl = payload && typeof payload === "object" ? (payload as { statusUrl?: unknown }).statusUrl : undefined;
		if (typeof statusUrl !== "string" || !statusUrl) {
			return { ok: false, code: "bad-status-url" } as const;
		}
		const result = await tokendancePayment.fetchSession(statusUrl);
		// 轮询是常态（每 3s 一次），失败只在主进程记 warn，不刷 info 日志。
		if (!result.ok) void appLogger.warn("config", "TokenDance top-up status failed", { code: result.code, detail: result.detail });
		return result;
	});
	ipcMain.handle(ipcChannels.configTokendanceTopUpOpenAlipay, async (_event, payload: unknown) => {
		// 浏览器支付宝深链：只允许 alipays://（渲染层入参不可信），否则 shell.openExternal
		// 会变成任意协议启动器；必须在用户点击后调用，不得由渲染层自动触发。
		const url = payload && typeof payload === "object" ? (payload as { url?: unknown }).url : undefined;
		if (typeof url !== "string" || url.length > 4096 || !/^alipays:\/\/\S+$/i.test(url)) {
			return { ok: false, error: "Invalid alipay deep link" } as const;
		}
		try {
			await shell.openExternal(url);
			return { ok: true } as const;
		} catch (error) {
			// 未安装支付宝/浏览器拦截：返回失败让渲染层提示改用扫码，不抛异常。
			void appLogger.warn("config", "TokenDance alipay deep link failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { ok: false, error: "TokenDance alipay deep link failed" } as const;
		}
	});
	ipcMain.handle(ipcChannels.configWatchaOpenAlipay, async (_event, payload: unknown) => {
		// 正式环境的 purchase.url 是 alipays:// 深链（不是网页），通用 openExternal 只放行
		// http/https 会静默丢弃。这里单独开一条，协议白名单收紧到 alipays://，且必须用户点击触发。
		const url = payload && typeof payload === "object" ? (payload as { url?: unknown }).url : undefined;
		if (typeof url !== "string" || url.length > 4096 || !/^alipays:\/\/\S+$/i.test(url)) {
			return { ok: false, error: "Invalid alipay deep link" } as const;
		}
		try {
			await shell.openExternal(url);
			return { ok: true } as const;
		} catch (error) {
			// 未装支付宝/被系统拦截：返回失败让渲染层提示改用扫码，不抛异常。
			void appLogger.warn("config", "Watcha alipay deep link failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { ok: false, error: "Watcha alipay deep link failed" } as const;
		}
	});
	ipcMain.handle(ipcChannels.configWatchaAccess, async (_event, payload: unknown) => {
		// 只读：查支付入口，不扣减、不改本地状态。
		// force=true 只用于到账轮询（绕过 5 分钟缓存）；渲染层入参只认布尔 true。
		if (!watchaEntitlement) return { ok: false, code: "not-configured" } as const;
		const force = payload && typeof payload === "object" ? (payload as { force?: unknown }).force === true : false;
		const result = await watchaEntitlement.access({ force });
		// 静默失败是常态（离线/代理未部署），只记码不记用户标识。
		if (!result.ok) void appLogger.warn("config", "Watcha access failed", { code: result.code, detail: result.detail });
		return result;
	});
}
