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

	// 工具调用成功执行就显示成功状态，不根据退出码判断
	// 退出码是命令的业务结果，应该让模型自己判断
	// 例如：grep 没匹配（exitCode=1）、ls 文件不存在（exitCode=2）都是正常的业务结果
	const isError = false;
	const statusIcon = "✓";
	const detailSections = [
		`命令：${input.command}`,
		`退出码：${input.exitCode}`,
		input.output ? `输出：\n${input.output}` : "(无输出)",
	].filter(Boolean);

	return {
		text: `${statusIcon} ${input.command}`,
		meta: {
			status: "done" as const,
			toolName: "bash",
			args: { command: input.command },
			result: { output: input.output, exitCode: input.exitCode },
			isError,
			detailText: detailSections.join("\n\n"),
		},
	};
}
