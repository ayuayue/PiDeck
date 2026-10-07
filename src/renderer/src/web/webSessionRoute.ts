/**
 * Web 端会话路由（URL ↔ 会话 id）：
 * - 选中/新建会话时 pushState 到 /s/<id>，浏览器回退/前进、刷新、分享链接都能回到同一会话；
 * - 服务端对无扩展名路径一律回落 web.html（WebServiceManager 静态映射），故 /s/* 无需服务端路由改动；
 * - SW 是 network-first（离线才回缓存 "/"），不影响 /s/* 导航。
 * 纯函数模块，tests/webSessionRoute.test.mjs 覆盖解析与序列化边界。
 */

export const SESSION_ROUTE_PREFIX = "/s/";

/**
 * 从 pathname 解析会话 id。
 * 前缀不符、id 为空或含非法字符（路径穿越/查询串残留）一律返回 ""（视为无会话路由）。
 * 尾部多余路径段（/s/abc/）容忍并取第一段，避免手工加斜杠的链接失效。
 */
export function sessionFromPath(pathname: string): string {
	if (!pathname.startsWith(SESSION_ROUTE_PREFIX)) return "";
	const id = pathname.slice(SESSION_ROUTE_PREFIX.length).split("/")[0];
	return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

/** 会话 id → URL 路径；空 id 返回根路径（回到落地页）。 */
export function sessionPath(sessionId: string): string {
	return sessionId ? `${SESSION_ROUTE_PREFIX}${encodeURIComponent(sessionId)}` : "/";
}
