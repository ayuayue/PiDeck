import type { ReactNode } from "react";

export type GitInlineErrorNoticeProps = {
	message: string;
	className: string;
	testId?: string;
	variant?: "compact" | "changes";
	icon?: ReactNode;
};

/** Shared role/title/truncation contract for Git errors with different visual placements. */
export function GitInlineErrorNotice({ message, className, testId, variant = "compact", icon }: GitInlineErrorNoticeProps) {
	if (variant === "changes") {
		return (
			<div role="alert" data-testid={testId} className={className}>
				{icon}
				<span className="min-w-0 flex-1 truncate" title={message}>
					{message}
				</span>
			</div>
		);
	}
	return (
		<p role="alert" data-testid={testId} className={className}>
			{message}
		</p>
	);
}
