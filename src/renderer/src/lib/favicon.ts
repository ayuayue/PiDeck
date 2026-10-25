export function getFaviconUrl(value: string) {
	try {
		return new URL("/favicon.ico", value).toString();
	} catch {
		return null;
	}
}
