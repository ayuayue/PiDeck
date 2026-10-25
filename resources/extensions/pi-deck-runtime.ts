/**
 * PiDeck runtime control adapter.
 *
 * RPC mode does not execute pi's built-in `/reload`; the builtin command is only
 * wired in the interactive TUI. pi exposes the same operation to extensions as
 * `ctx.reload()`, so this extension registers a command with the same name and
 * semantics. The host sends `/reload` through the RPC prompt path (see
 * `AgentManager.reloadResources`), which keeps the session transcript untouched.
 *
 * Scope is deliberately tiny: one command, no tools, no other host control.
 * The desktop pre-checks idle/compacting before sending; the guard below is the
 * in-process safety net for direct callers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piDeckRuntime(pi: ExtensionAPI): void {
	pi.registerCommand("reload", {
		description: "Reload extensions, skills, prompts, themes, and context files",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				throw new Error("Wait for the current response to finish before reloading.");
			}
			// Reload replaces the extension runtime. Treat this as terminal for the
			// handler: do not touch `ctx` or module state after the await.
			await ctx.reload();
		},
	});
}
