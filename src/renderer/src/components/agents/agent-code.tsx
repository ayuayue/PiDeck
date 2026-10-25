"use client";

import { type CSSProperties, Fragment, useEffect, useState } from "react";
import type { Highlighter } from "shiki";
import { cacheTokens, getCachedTokens, type AgentCodeToken, type AgentCodeTokenLines } from "./agentCodeTokenCache";
import { cn } from "@/lib/utils";

export type AgentCodeLanguage = "bash" | "diff" | "json" | "text" | "tsx" | "typescript";

export type { AgentCodeToken, AgentCodeTokenLines } from "./agentCodeTokenCache";
export interface AgentCodeProps {
	code: string;
	language?: AgentCodeLanguage;
	className?: string;
}

export interface AgentCodeLineProps {
	code: string;
	tokens?: AgentCodeToken[];
	className?: string;
}

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";
let agentCodeHighlighter: Promise<Highlighter> | null = null;

function getAgentCodeHighlighter() {
	if (!agentCodeHighlighter) {
		// 动态 import shiki：它是 WASM 重库（~1MB 量级），只在首次渲染代码块时才加载，
		// 避免进首屏初始 chunk——升级前 index chunk 5.96MB 里 shiki 占了可观比例。
		// import type 的 Highlighter 是纯类型，运行时无依赖。
		agentCodeHighlighter = import("shiki").then(({ createHighlighter }) =>
			createHighlighter({
				themes: [LIGHT_THEME, DARK_THEME],
				langs: ["bash", "diff", "json", "tsx", "typescript"],
			}),
		);
	}
	return agentCodeHighlighter;
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
	return `${language}\u0000${code}`;
}

export function useAgentCodeTokens(code: string, language: AgentCodeLanguage) {
	const key = tokenCacheKey(code, language);
	const cached = getCachedTokens(key);
	const [result, setResult] = useState<{
		key: string;
		code: string;
		language: AgentCodeLanguage;
		lines: AgentCodeTokenLines;
	} | null>(cached ? { key, code, language, lines: cached } : null);

	useEffect(() => {
		const current = getCachedTokens(key);
		if (current) {
			setResult({ key, code, language, lines: current });
			return;
		}

		let cancelled = false;
		getAgentCodeHighlighter().then((highlighter) => {
			if (cancelled) return;
			const lines = highlighter
				.codeToTokensWithThemes(code, {
					lang: language,
					themes: {
						light: LIGHT_THEME,
						dark: DARK_THEME,
					},
				})
				.map((line) =>
					line.map((token) => ({
						content: token.content,
						offset: token.offset,
						light: token.variants.light?.color,
						dark: token.variants.dark?.color,
					})),
				);
			cacheTokens(key, lines);
			setResult({ key, code, language, lines });
		});
		return () => {
			cancelled = true;
		};
	}, [code, key, language]);

	if (result?.key === key) return result.lines;
	if (result?.language === language && code.startsWith(result.code)) {
		return result.lines;
	}
	return null;
}

export function AgentCodeLine({ code, tokens, className }: AgentCodeLineProps) {
	return (
		<span className={className}>
			{tokens
				? tokens.map((token) => (
						<span
							key={`${token.offset}-${token.content}`}
							style={
								{
									"--agent-code-light": token.light ?? "currentColor",
									"--agent-code-dark": token.dark ?? token.light ?? "currentColor",
								} as CSSProperties
							}
							className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
						>
							{token.content}
						</span>
					))
				: code}
		</span>
	);
}

export function AgentCode({ code, language = "bash", className }: AgentCodeProps) {
	const tokens = useAgentCodeTokens(code, language);
	let offset = 0;
	const lines = code.split("\n").map((content) => {
		const line = { content, offset };
		offset += content.length + 1;
		return line;
	});

	return (
		<pre className={cn("m-0 overflow-x-auto whitespace-pre font-mono text-xs leading-5 text-foreground/85", className)}>
			<code>
				{lines.map((line, index) => (
					<Fragment key={line.offset}>
						<AgentCodeLine code={line.content} tokens={tokens?.[index]} />
						{index < lines.length - 1 ? "\n" : null}
					</Fragment>
				))}
			</code>
		</pre>
	);
}
