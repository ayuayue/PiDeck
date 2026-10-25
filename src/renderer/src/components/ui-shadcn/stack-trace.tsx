import { useMemo, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "./button";

type StackFrame = {
	raw: string;
	location?: string;
	path?: string;
	line?: string;
	column?: string;
	internal: boolean;
};

function parseFrame(raw: string): StackFrame {
	const match = raw.match(/\(?((?:[A-Za-z]:[\\/]|file:\/\/|\/|\.\.\/|\.\/)[^():]+):(\d+):(\d+)\)?$/);
	const path = match?.[1];
	return {
		raw,
		location: match ? `${match[2]}:${match[3]}` : undefined,
		path,
		line: match?.[2],
		column: match?.[3],
		internal: /(?:node_modules|node:|internal\/)/.test(raw),
	};
}

/**
 * AI Elements 风格的 StackTrace 展示器：只负责错误详情的阅读交互，
 * 不解析或修改错误来源，确保主进程已有的脱敏结果原样展示。
 */
export function StackTrace(props: { trace: string; defaultOpen?: boolean; onOpenFile?: (path: string) => void; className?: string }) {
	const [open, setOpen] = useState(props.defaultOpen ?? false);
	const [copied, setCopied] = useState(false);
	const frames = useMemo(() => {
		const lines = props.trace.split(/\r?\n/).filter(Boolean);
		return lines.slice(1).map(parseFrame);
	}, [props.trace]);
	const firstLine = props.trace.split(/\r?\n/, 1)[0] || props.trace;
	const errorMatch = firstLine.match(/^([\w.]+Error|Error|Exception):?\s*(.*)$/);
	const errorType = errorMatch?.[1] ?? "Error";
	const errorMessage = errorMatch?.[2] ?? firstLine;

	async function copyTrace() {
		try {
			await navigator.clipboard.writeText(props.trace);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		} catch {
			setCopied(false);
		}
	}

	return (
		<section className={cn("overflow-hidden rounded-md border border-border-subtle bg-bg-panel", props.className)}>
			<div className="flex min-w-0 items-center gap-2 px-2 py-1.5">
				<button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
					<ChevronDown className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")} aria-hidden="true" />
					<span className="shrink-0 font-mono text-caption font-semibold text-danger">{errorType}</span>
					<span className="min-w-0 truncate text-caption text-text-secondary">{errorMessage}</span>
				</button>
				<Button variant="ghost" size="icon" onClick={() => void copyTrace()} aria-label={t("common.copy")} title={t("common.copy")}>
					{copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
				</Button>
			</div>
			{open ? (
				<div className="border-t border-border-subtle bg-bg-muted p-1">
					<div className="flex max-h-[280px] flex-col overflow-auto font-mono text-micro leading-relaxed">
						{frames.length > 0 ? (
							frames.map((frame, index) => (
								<div key={`${frame.raw}:${index}`} className={cn("flex min-w-0 gap-2 px-2 py-1", frame.internal && "text-text-tertiary/55")}>
									<span className="select-none text-text-tertiary/55">{index + 1}</span>
									{frame.path && props.onOpenFile ? (
										<button type="button" className="min-w-0 truncate text-left text-text-secondary underline decoration-border-subtle underline-offset-2 hover:text-foreground" onClick={() => props.onOpenFile?.(frame.path ?? "")}>
											{frame.raw}
										</button>
									) : (
										<span className="min-w-0 break-all">{frame.raw}</span>
									)}
								</div>
							))
						) : (
							<pre className="m-0 whitespace-pre-wrap break-words px-2 py-1 text-text-secondary">{props.trace}</pre>
						)}
					</div>
				</div>
			) : null}
		</section>
	);
}
