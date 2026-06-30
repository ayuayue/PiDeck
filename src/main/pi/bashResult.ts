type BashToolMessageInput = {
	command: string;
	output: string;
	exitCode: number;
	excludeFromContext: boolean;
};

export function formatBashToolMessage(input: BashToolMessageInput) {
	const isSilentLauncherResult =
		input.excludeFromContext &&
		input.exitCode !== 0 &&
		input.output.trim().length === 0;
	// `!!` is explicitly a local side-effect command whose output is excluded from
	// the model context. GUI launchers such as `code .` can return a non-zero code
	// while still completing the user-visible action, often with no stdout/stderr.

	const isError = input.exitCode !== 0 && !isSilentLauncherResult;
	const statusIcon = isError ? "✗" : "✓";
	const detailSections = [
		`命令：${input.command}`,
		`退出码：${input.exitCode}`,
		input.output ? `输出：\n${input.output}` : "(无输出)",
	].filter(Boolean);

	return {
		text: `${statusIcon} ${input.command}`,
		meta: {
			status: isError ? "error" as const : "done" as const,
			toolName: "bash",
			args: { command: input.command },
			result: { output: input.output, exitCode: input.exitCode },
			isError,
			detailText: detailSections.join("\n\n"),
		},
	};
}
