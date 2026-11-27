/** 将显式 HTTP(S) 链接规范化为可交给内置浏览器的 URL。 */
export function normalizeBrowserWebLink(href: string | undefined): string | null {
	if (!href || !/^https?:\/\//i.test(href)) return null;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}
