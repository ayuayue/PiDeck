/** PiDeck's model-only refresh. No reload, transcript entry, or model request. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export const command = "pideck-model-options";
export const statusKey = "pideck:model-options";

export default function register(pi: ExtensionAPI): void {
	pi.registerCommand(command, {
		description: "Refresh PiDeck's available models and thinking levels",
		handler: async (_args, ctx) => {
			await ctx.modelRegistry.refresh({ allowNetwork: false });
			const error = ctx.modelRegistry.getError();
			if (error) throw new Error(error);
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			const models = ctx.modelRegistry.getAvailable().map(model => ({
				id: model.id,
				name: model.name,
				provider: model.provider,
				reasoning: model.reasoning,
				contextWindow: model.contextWindow,
				levels: getSupportedThinkingLevels(model),
				clamped: Object.fromEntries(levels.map(level => [level, clampThinkingLevel(model, level)])),
			}));
			// RPC's status notification is out-of-band and never stores model
			// credentials or the complete provider objects in the transcript.
			ctx.ui.setStatus(statusKey, JSON.stringify({ models }));
		},
	});
}
