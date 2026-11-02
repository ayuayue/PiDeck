export const RENDERER_VIRTUAL_SESSION_ID_PREFIX = "renderer:";

export function isRendererVirtualSessionId(sessionId: string | undefined | null): boolean {
	return typeof sessionId === "string" && sessionId.startsWith(RENDERER_VIRTUAL_SESSION_ID_PREFIX);
}
