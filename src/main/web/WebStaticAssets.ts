/**
 * Web 服务的静态产物出口与 dev 代理（从 WebServiceManager 按域迁出）。
 *
 * 负责三件互相耦合的事：out/renderer 构建产物的路径安全出口、A1 兜底页回退、
 * dev 模式下到 vite dev server 的 HTTP/WebSocket 代理（HMR）。三者共享
 * rendererRoot / devRendererUrl / 改写缓存 / 被劫持 socket 四个状态，所以留在同一个类里。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { extname, join, normalize, sep } from "node:path";
import { rewriteWebHtmlAssetUrls } from "./webHtmlAssetUrls";
import { sendError, sendFile, sendHtml } from "./WebHttpResponders";
import { renderLegacyWebPage } from "./webPageTemplate";

export class WebStaticAssets {
	/** dev 模式渲染层 dev server 基址（无尾斜杠）；空串表示走构建产物。 */
	readonly devRendererUrl: string;
	private readonly rendererRoot: string;
	/** web.html 改写后的缓存（按文件 mtime 失效）：避免每次页面请求都重读重改写。 */
	private webEntryHtmlCache: { mtimeMs: number; html: string } | null = null;
	/** dev 模式被劫持的 upgrade socket 集合；stop() 时统一销毁。 */
	private readonly hijackedSockets = new Set<Duplex>();

	constructor(options: { devRendererUrl?: string; rendererRoot?: string }) {
		this.devRendererUrl = options.devRendererUrl?.trim() ? options.devRendererUrl.trim().replace(/\/$/, "") : "";
		this.rendererRoot = options.rendererRoot ?? join(__dirname, "../renderer");
	}

	async serve(url: URL, response: ServerResponse): Promise<void> {
		const requestedPath = decodeURIComponent(url.pathname);
		// ?view=legacy 强制回退到 A1 vanilla 内嵌页，便于对比新旧 Web 前端体验。
		const forceLegacy = url.searchParams.get("view") === "legacy";
		if (forceLegacy) {
			sendHtml(response, renderLegacyWebPage());
			return;
		}
		// dev 模式：静态资源一律代理到 vite dev server。
		// 否则 electron-vite dev 不产出 out/renderer 构建物，WebServiceManager 会
		// 回退到 A1 vanilla 内嵌页——外部端永远看不到重构后的 React 版（A2）。
		if (this.devRendererUrl) {
			await this.proxyDevRenderer(url, response);
			return;
		}
		// Web 服务根路径：优先 serve React 版 web.html（A2）；
		// 构建产物缺失时回退到内嵌 renderPage（A1 vanilla 页，保持兼容）。
		const webEntry = join(this.rendererRoot, "web.html");
		const relativePath = requestedPath === "/" || !extname(requestedPath) ? (existsSync(webEntry) ? "web.html" : "index.html") : requestedPath.replace(/^\/+/, "");
		const filePath = normalize(join(this.rendererRoot, relativePath));
		// 资源请求（带扩展名且非 .html）缺失时返回 404，不回退内嵌页：
		// 缺失资源若被 HTML 冒充，浏览器按 module script 解析报 MIME 错误白屏。
		const isResourceRequest = Boolean(extname(requestedPath)) && !requestedPath.endsWith(".html");
		// 路径逃逸检查 + 文件存在性；文档请求缺失时回退内嵌页，资源请求 404。
		// 前缀比对必须带分隔符边界：不带时会放行 rendererRoot 的兄弟目录
		// （如 root = /app/web 时 /app/web-other/... 也命中 startsWith）。
		const rendererRootPrefix = normalize(this.rendererRoot) + sep;
		const insideRendererRoot = normalize(filePath) === normalize(this.rendererRoot) || normalize(filePath).startsWith(rendererRootPrefix);
		if (!insideRendererRoot || !existsSync(filePath)) {
			if (isResourceRequest) {
				sendError(response, 404, "webError.apiNotFound", "Not found: " + requestedPath);
			} else {
				sendHtml(response, renderLegacyWebPage());
			}
			return;
		}
		// web.html 单独出口：相对资源引用改写为绝对路径（/s/<id> 路由下 ./assets 会解析成
		// /s/assets/... 而 404 白屏）；sendHtml 的 no-store 保证发版后壳不驻留。
		if (normalize(webEntry) === filePath) {
			sendHtml(response, this.loadWebEntryHtml(webEntry));
			return;
		}
		await sendFile(filePath, response);
	}

	/** web.html 服务出口：相对资源引用改写为绝对路径（/s/<id> 路由下 ./assets 会 404 白屏，见 webHtmlAssetUrls.ts）。按 mtime 缓存改写结果。 */
	private loadWebEntryHtml(webEntry: string): string {
		const mtimeMs = statSync(webEntry).mtimeMs;
		if (this.webEntryHtmlCache && this.webEntryHtmlCache.mtimeMs === mtimeMs) return this.webEntryHtmlCache.html;
		const html = rewriteWebHtmlAssetUrls(readFileSync(webEntry, "utf8"));
		this.webEntryHtmlCache = { mtimeMs, html };
		return html;
	}

	/**
	 * dev 模式静态资源代理：把请求转发到 vite dev server 对应路径，响应流式回传。
	 * 根路径/无扩展名路径映射到 /web.html（外部端入口，而非桌面端 index.html）。
	 */
	private async proxyDevRenderer(url: URL, response: ServerResponse) {
		const requestedPath = url.pathname;
		// 路径安全：仅允许站内相对路径，禁止 .. 逃逸与绝对路径之外的形式。
		if (!requestedPath.startsWith("/") || requestedPath.includes("..")) {
			sendError(response, 400, "webError.apiNotFound", "Invalid path");
			return;
		}
		// 无扩展名路径默认映射 /web.html；但 /@*（vite 内部模块）与 /api/* 必须原样转发——
		// 否则 /@vite/client 会被换成 web.html 的 HTML，浏览器按 module script 执行
		// 报 "MIME text/html" 错误，整个页面空白。query 也要保留：vite 依赖预构建/
		// HMR 模块 URL 依赖 ?v= / ?t= / ?import 参数，丢弃会 404 或失去缓存失效语义。
		const passthrough = requestedPath.startsWith("/@") || requestedPath.startsWith("/api/");
		const targetPath = passthrough ? `${requestedPath}${url.search}` : requestedPath === "/" || !extname(requestedPath) ? "/web.html" : `${requestedPath}${url.search}`;
		// 文档请求（HTML 页面）判定：根路径/无扩展名路径或 .html 结尾；
		// /@* 是 vite 内部模块（/@vite/client、/@fs/...），即便无扩展名也必须是模块请求，
		// 对模块请求绝不能回退/转发 HTML——浏览器按 module script 解析会报 "MIME text/html"，
		// 整页白屏且不自动恢复。
		const isDocumentRequest = !requestedPath.startsWith("/@") && (requestedPath === "/" || !extname(requestedPath) || requestedPath.endsWith(".html"));
		let upstream: Response;
		try {
			upstream = await fetch(`${this.devRendererUrl}${targetPath}`);
		} catch {
			// dev server 未就绪（如只启动了主进程）：文档请求回退内嵌页保证不白屏；
			// 模块/资源请求返回 503，避免把 HTML 冒充 JS 导致 MIME 报错。
			if (isDocumentRequest) {
				sendHtml(response, renderLegacyWebPage());
			} else {
				sendError(response, 503, "webError.internal", "Renderer dev server not ready");
			}
			return;
		}
		const status = upstream.status;
		const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
		// 上游非 200（如 vite 504 Outdated Optimize Dep——deps 重新优化期间旧 URL 失效）：
		// 文档请求回退 A1 内嵌页；模块请求透传上游状态。绝不能对模块请求回退 HTML。
		if (status !== 200 || !upstream.body) {
			if (isDocumentRequest) {
				sendHtml(response, renderLegacyWebPage());
			} else {
				response.writeHead(status, {
					"content-type": contentType,
					"cache-control": "no-store",
				});
				response.end();
			}
			return;
		}
		// vite 对不存在的路径按 SPA fallback 返回 200 + index.html：模块请求拿到 HTML
		// 说明资源不存在（旧 chunk 名/缓存过期），返回 404 而不是转发 HTML，避免 MIME 错误。
		if (!isDocumentRequest && contentType.includes("text/html")) {
			sendError(response, 404, "webError.apiNotFound", "Not found: " + requestedPath);
			return;
		}
		response.writeHead(status, {
			"content-type": contentType,
			"cache-control": "no-store",
		});
		// 流式转发 body，避免整包缓冲大体积 vendor chunk。
		// 上游中断（vite 重启/浏览器取消）时销毁响应而不是让 error 冒泡崩掉进程。
		const bodyStream = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
		bodyStream.on("error", () => response.destroy());
		response.on("error", () => bodyStream.destroy());
		bodyStream.pipe(response);
	}

	/**
	 * dev 模式 WebSocket 代理（vite HMR 热更新）：把浏览器的 upgrade 请求原样转发到
	 * dev server（含原始头，vite 会计算 Sec-WebSocket-Accept），拿到 101 后回写
	 * 状态行与响应头，再双向管道透传帧数据。失败时直接销毁 socket，浏览器侧
	 * 会自动重连（vite client 内置重连逻辑），不影响页面本身。
	 */
	proxyWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const devUrl = new URL(this.devRendererUrl);
		// 劫持 socket 追踪：客户端侧 socket 一进入代理就登记，stop() 统一销毁（见 hijackedSockets 注释）。
		this.hijackedSockets.add(socket);
		socket.on("close", () => this.hijackedSockets.delete(socket));
		// vite 会校验 HMR 握手的 Host/Origin：把两者改写为 dev server 自身，
		// 否则外部端口访问时 vite 按「跨源请求」拒绝 403，HMR 连不上。
		const headers = {
			...request.headers,
			host: devUrl.host,
			origin: devUrl.origin,
		};
		const upstream = httpRequest({
			hostname: devUrl.hostname,
			port: devUrl.port,
			path: request.url ?? "/",
			headers,
			method: "GET",
		});
		upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
			this.hijackedSockets.add(upstreamSocket);
			upstreamSocket.on("close", () => this.hijackedSockets.delete(upstreamSocket));
			const headerLines = Object.entries(upstreamResponse.headers)
				.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
				.join("\r\n");
			socket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${headerLines}\r\n\r\n`);
			// 双向管道；任一端异常时关闭另一端，避免悬挂连接。
			upstreamSocket.pipe(socket).pipe(upstreamSocket);
			upstreamSocket.on("error", () => socket.destroy());
			socket.on("error", () => upstreamSocket.destroy());
			if (upstreamHead?.length) socket.write(upstreamHead);
			if (head?.length) upstreamSocket.write(head);
		});
		upstream.on("error", () => socket.destroy());
		upstream.end();
	}

	/** 销毁被劫持的 upgrade socket（dev HMR 代理）：Node 的 closeAllConnections 不追踪
	 *  upgrade 后的 socket，不手动销毁会让 server.close() 永远等不到回调、stop() 挂死。 */
	destroyHijackedSockets(): void {
		for (const socket of this.hijackedSockets) {
			try {
				socket.destroy();
			} catch {
				// 已销毁的 socket 重复 destroy 是安全的，防御即可
			}
		}
		this.hijackedSockets.clear();
	}
}
