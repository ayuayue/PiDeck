/**
 * PiDeck Web 端 Service Worker（PWA 基础）
 *
 * 策略刻意保守：
 * - 只处理同源 GET 且排除 /api/*（token 鉴权响应与 SSE 绝不能进缓存）；
 * - 静态资源 network-first：优先网络（保证发新版后立即拿到新 bundle），
 *   网络失败（离线/局域网主机下线）时回退缓存，让已安装的 PWA 至少能打开壳；
 * - 导航请求（HTML）离线时回退缓存的 /web.html 壳，由页面自身提示连接失败。
 * - 不做 push / background sync（pi 事件依赖在线 SSE）。
 */
const CACHE_NAME = "pideck-web-v1";
const OFFLINE_URLS = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(OFFLINE_URLS).catch(() => undefined)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
	self.clients.claim();
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	// /api/* 与 SSE（/stream）一律直连，不进 SW（鉴权 + 实时性）
	if (url.pathname.startsWith("/api/")) return;

	event.respondWith(
		fetch(request)
			.then((response) => {
				// 只缓存成功响应（基础类型，避免 opaque/redirect 语义混乱）
				if (response.ok && response.type === "basic") {
					const clone = response.clone();
					caches
						.open(CACHE_NAME)
						.then((cache) => cache.put(request, clone))
						.catch(() => undefined);
				}
				return response;
			})
			.catch(() =>
				caches.match(request).then((cached) => {
					if (cached) return cached;
					// 导航请求离线兜底：壳页面（页面内会提示连接失败）
					if (request.mode === "navigate") return caches.match("/");
					return Response.error();
				}),
			),
	);
});
