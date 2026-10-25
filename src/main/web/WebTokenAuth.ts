/**
 * Web 服务访问令牌鉴权（从 WebServiceManager 按域迁出）。
 *
 * 只持有令牌三元组（令牌值 / 生成时刻 / 有效期）与比对逻辑：服务可绑 0.0.0.0
 * 对外暴露，比对必须常数时间；持久化交回设置层（hooks.persistToken），运行态
 * 广播交回 manager（hooks.onChange），本模块不碰 current 与 SSE。
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** 令牌策略的最小形状（applySettings/restart → start 传递，避免 start 依赖完整设置） */
export type WebTokenPolicy = { token?: string; generatedAt?: number; expiresIn?: number };

export type WebTokenAuthHooks = {
	/** 回写设置层；PiDeck 不自己存令牌，只把值交给设置。 */
	persistToken?: (state: { token: string; generatedAt: number; expiresIn: number }) => void;
	/** 令牌值/过期时刻实际变化后通知（刷新 current 与广播状态）。 */
	onChange?: () => void;
};

export class WebTokenAuth {
	/** 访问令牌：持久化固定（hooks.persistToken 回写设置），重启不换新，见 applyPolicy。 */
	private authToken = "";
	/** 令牌生成/最后修改时刻（epoch ms），持久化不随重启重置 */
	private tokenGeneratedAt = 0;
	/** 令牌有效期（ms）；0 = 永不过期 */
	private tokenExpiresInMs = 0;

	constructor(private readonly hooks: WebTokenAuthHooks) {}

	get token(): string {
		return this.authToken;
	}

	/** expiresIn > 0 时的绝对过期时刻；0/未设置 → null（永不过期）。 */
	expiresAt(): number | null {
		return this.tokenExpiresInMs > 0 ? this.tokenGeneratedAt + this.tokenExpiresInMs : null;
	}

	/**
	 * 应用令牌策略（返回是否变化）：
	 * - 有持久化令牌 → 沿用（重启不换新，远程设备已保存的链接不失效）；
	 * - 无持久化令牌 → 自动生成 UUID 并回写（首次启用）；
	 * - expiresIn 从 generatedAt 起算，0 = 永不过期；generatedAt 缺省视为 now。
	 */
	applyPolicy(policy: WebTokenPolicy): boolean {
		const persisted = policy.token?.trim();
		const nextToken = persisted && persisted === this.authToken ? this.authToken : persisted || randomUUID();
		const nextGeneratedAt = policy.generatedAt && policy.generatedAt > 0 ? policy.generatedAt : Date.now();
		const nextExpiresIn = policy.expiresIn && policy.expiresIn > 0 ? policy.expiresIn : 0;
		// 新生成的令牌没有持久值可沿用，立即回写（首次启用场景）。
		if (!persisted) this.hooks.persistToken?.({ token: nextToken, generatedAt: nextGeneratedAt, expiresIn: nextExpiresIn });
		if (nextToken === this.authToken && nextGeneratedAt === this.tokenGeneratedAt && nextExpiresIn === this.tokenExpiresInMs) return false;
		this.authToken = nextToken;
		this.tokenGeneratedAt = nextGeneratedAt;
		this.tokenExpiresInMs = nextExpiresIn;
		this.hooks.onChange?.();
		return true;
	}

	/**
	 * 设置页手动修改令牌 / 过期策略（web:set-token IPC）：立即热生效 + 持久化，
	 * 不重启服务（远程设备仅旧令牌失效，服务本身不断）；服务未运行时仅持久化。
	 */
	setPolicy(input: { token?: string; expiresIn?: number }): void {
		const nextToken = input.token?.trim() || this.authToken;
		const nextExpiresIn = input.expiresIn !== undefined ? (input.expiresIn > 0 ? input.expiresIn : 0) : this.tokenExpiresInMs;
		// 手动修改令牌 → 过期计时重新起算；仅改过期策略 → 沿用原 generatedAt。
		const tokenChanged = nextToken !== this.authToken;
		const nextGeneratedAt = tokenChanged ? Date.now() : this.tokenGeneratedAt || Date.now();
		if (input.token !== undefined || input.expiresIn !== undefined) this.hooks.persistToken?.({ token: nextToken, generatedAt: nextGeneratedAt, expiresIn: nextExpiresIn });
		this.authToken = nextToken;
		this.tokenGeneratedAt = nextGeneratedAt;
		this.tokenExpiresInMs = nextExpiresIn;
		this.hooks.onChange?.();
	}

	/**
	 * 轮换访问令牌（设置页「重新生成令牌」）：立即换新并广播状态。
	 * 旧令牌下一个请求即 401；已建立的 SSE 连接不主动断（下次事件写入失败自然回收），
	 * Web 端由 401 兜底 UX 引导重新扫码。未运行时无操作。
	 */
	rotate(): void {
		const nextToken = randomUUID();
		const nextGeneratedAt = Date.now();
		// 轮换后持久化新令牌并重置计时（否则旧 generatedAt 会让新令牌一出生就临近过期）；未运行时仅持久化，下次启动生效。
		this.hooks.persistToken?.({ token: nextToken, generatedAt: nextGeneratedAt, expiresIn: this.tokenExpiresInMs });
		this.authToken = nextToken;
		this.tokenGeneratedAt = nextGeneratedAt;
		this.hooks.onChange?.();
	}

	/**
	 * 鉴权：Authorization: Bearer 对所有方法生效；?token= 查询参数仅限 GET/SSE
	 * （EventSource 无法携带 header），写操作必须走 Bearer，避免令牌进代理/访问日志。
	 */
	isAuthorized(request: IncomingMessage, url: URL): boolean {
		// 过期检查先于令牌比对：过期后即使令牌匹配也拒绝（用户显式设置了有效期，到期应强制重新分发）。
		if (this.tokenExpiresInMs > 0 && Date.now() > this.tokenGeneratedAt + this.tokenExpiresInMs) return false;
		// 常数时间比较：服务可绑 0.0.0.0 对外暴露，`===` 早退构成时序侧信道（逐字节猜令牌）；
		// 长度不等先返回 false 只是泄漏长度（UUID 定长，无泄漏面），内容比对必须 timingSafeEqual。
		const auth = request.headers.authorization;
		if (typeof auth === "string" && auth.startsWith("Bearer ") && this.safeTokenEqual(auth.slice("Bearer ".length), this.authToken)) return true;
		if (request.method !== "GET") return false;
		const queryToken = url.searchParams.get("token");
		return queryToken !== null && this.safeTokenEqual(queryToken, this.authToken);
	}

	/** 令牌常数时间比对：长度不等直接 false（不抛 timingSafeEqual 的长度错），内容差异不泄漏耗时。 */
	private safeTokenEqual(candidate: string, expected: string): boolean {
		const a = Buffer.from(candidate, "utf8");
		const b = Buffer.from(expected, "utf8");
		if (a.length !== b.length || a.length === 0) return false;
		return timingSafeEqual(a, b);
	}
}
