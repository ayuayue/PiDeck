/**
 * web.html 静态出口的资源路径改写。
 *
 * 背景：electron-vite 构建产物里 web.html 引用资源用相对路径（./assets/...）——
 * 桌面 index.html 走 file:// 加载依赖这一点。但 web.html 只经 WebServiceManager 的
 * HTTP 服务出口，且 Web 端有 /s/<id> 会话路由：在 /s/abc12345 下，浏览器会把
 * ./assets/web-*.js 解析成 /s/assets/web-*.js（带扩展名 → 服务端按文件直出 → 404），
 * JS/CSS 全挂，整页白屏。服务时把相对引用改写为绝对路径即可；运行期 fetch("/api/...")
 * 本就是绝对路径，不受影响。
 */

/** 把 HTML 里 href/src 的 `./xxx` 引用改写为 `/xxx`（仅这两种属性；前置空白界定避免误伤 data-src 等同类尾级属性，其他内容不动）。 */
export function rewriteWebHtmlAssetUrls(html: string): string {
	return html.replace(/(\s(?:href|src))="\.\/([^"]*)"/g, '$1="/$2"');
}
