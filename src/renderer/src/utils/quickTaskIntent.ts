/** Main validates Windows paths; this comparison only decides whether to preserve the visible draft. */
export function sameQuickTaskPath(a: string, b: string): boolean {
	return a.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
}

/** Shell activation is never implicit consent to discard a task or send another prompt. */
export function quickTaskIntent(currentPath: string, requestedPath: string): "prepare" | "resume" | "offer-new" {
	if (!currentPath) return "prepare";
	return sameQuickTaskPath(currentPath, requestedPath) ? "resume" : "offer-new";
}
