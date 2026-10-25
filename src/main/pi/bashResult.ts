type BashToolMessageInput = {
	command: string;
	output: string;
	exitCode: number;
	excludeFromContext: boolean;
	translate?: (key: BashCopyKey, params?: Record<string, string | number>) => string;
};

type BashCopyKey = "mainTool.command" | "mainTool.exitCode" | "mainTool.output" | "mainTool.noOutput";

const defaultBashCopy: Record<BashCopyKey, string> = {
	"mainTool.command": "Command: {command}",
	"mainTool.exitCode": "Exit code: {exitCode}",
	"mainTool.output": "Output:\n{output}",
	"mainTool.noOutput": "(no output)",
};

function bashCopy(input: BashToolMessageInput, key: BashCopyKey, params: Record<string, string | number> = {}): string {
	const template = input.translate?.(key, params) ?? defaultBashCopy[key];
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match));
}

export function formatBashToolMessage(input: BashToolMessageInput) {
	const isSilentLauncherResult = input.excludeFromContext && input.exitCode !== 0 && input.output.trim().length === 0;
	// `!!` is explicitly a local side-effect command whose output is excluded from
	// the model context. GUI launchers such as `code .` can return a non-zero code
	// while still completing the user-visible action, often with no stdout/stderr.

	const isError = input.exitCode !== 0 && !isSilentLauncherResult;
	const statusIcon = isError ? "✗" : "✓";
	const detailSections = [bashCopy(input, "mainTool.command", { command: input.command }), bashCopy(input, "mainTool.exitCode", { exitCode: input.exitCode }), input.output ? bashCopy(input, "mainTool.output", { output: input.output }) : bashCopy(input, "mainTool.noOutput")].filter(Boolean);

	return {
		text: `${statusIcon} ${input.command}`,
		meta: {
			status: isError ? ("error" as const) : ("done" as const),
			toolName: "bash",
			args: { command: input.command },
			result: { output: input.output, exitCode: input.exitCode },
			isError,
			detailText: detailSections.join("\n\n"),
		},
	};
}
