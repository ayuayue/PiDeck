export type ComposerCollapseInput = {
	mobileViewport: boolean;
	draft: string;
	imageCount: number;
	streaming: boolean;
	focused: boolean;
	busy: boolean;
	attachError: boolean;
	planMode: boolean;
};

export function resolveComposerCollapsed(input: ComposerCollapseInput): boolean {
	if (!input.mobileViewport) return false;
	if (input.draft !== "") return false;
	if (input.imageCount > 0) return false;
	if (input.streaming) return false;
	if (input.focused) return false;
	if (input.busy) return false;
	if (input.attachError) return false;
	if (input.planMode) return false;
	return true;
}

export type ComposerHiddenInput = {
	headerHidden: boolean;
	nearBottom: boolean;
	streaming: boolean;
	engaged: boolean;
};

export function resolveComposerHidden(input: ComposerHiddenInput): boolean {
	if (!input.headerHidden) return false;
	if (input.nearBottom) return false;
	if (input.streaming) return false;
	if (input.engaged) return false;
	return true;
}
