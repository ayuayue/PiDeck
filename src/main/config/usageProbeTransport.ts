/**
 * 用量探针 HTTP 传输（主进程）—— `modelHttp/request.ts` 的探针形状适配器。
 *
 * 传输实现（net.fetch / Cookie 走 net.request / 显式代理 session / 超时与响应体上界）
 * 已统一到 `src/main/modelHttp/request.ts`，见那里的文件头注释。这里只保留探针需要的
 * 收窄结果形状 `{ status, raw } | { error }`，供 ConfigManager、TokenDance、Watcha、
 * Sub2API 面板等调用点使用。
 */
import { modelHttpRequest } from "../modelHttp/request";

export { hasCookieHeader } from "../modelHttp/request";

export type UsageProbeHttpResult = { status: number; raw: string } | { error: "timeout" | "network" };

export type UsageProbeRequestInit = {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	maxBytes: number;
};

/** 发送一次探针请求。失败只区分 timeout / network（探针不需要更细的分类）。 */
export async function usageProbeRequest(url: string, init: UsageProbeRequestInit): Promise<UsageProbeHttpResult> {
	const result = await modelHttpRequest(url, init);
	if ("error" in result) return { error: result.error };
	return { status: result.status, raw: result.raw };
}
