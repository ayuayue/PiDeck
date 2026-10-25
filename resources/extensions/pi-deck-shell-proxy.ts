/**
 * PiDeck shell proxy scope.
 *
 * PiDeck injects proxy variables into the pi process so the model/API client can
 * reach configured gateways. Those variables are inherited by pi's built-in
 * bash/PowerShell tools as well, which unintentionally routes agent commands
 * through the same shared proxy exit. Keep the model proxy in pi, but make each
 * agent shell command direct by clearing the proxy variables in the command.
 *
 * The extension is inert for standalone pi sessions: PiDeck sets the marker only
 * when it owns the proxy environment. Commands are prefixed rather than rewritten
 * so quoting, pipes, redirections, and multiline scripts retain their semantics.
 */
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export const PI_PROXY_INJECTED_ENV = "PIDECK_PI_PROXY_SCOPE";
const MODEL_ONLY_SCOPE = "model-only";
const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"] as const;

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function unixPrefix(): string {
	return `unset ${PROXY_ENV_KEYS.map(shellQuote).join(" ")} ${PI_PROXY_INJECTED_ENV}`;
}

function powershellPrefix(): string {
	return PROXY_ENV_KEYS.concat(PI_PROXY_INJECTED_ENV).map((key) => `$env:${key} = $null`).join("\n");
}

/** Add a shell-native direct-connection prefix without changing the command body. */
export function scopeShellCommand(toolName: string, command: string): string {
	if (toolName === "powershell") return `${powershellPrefix()}\n${command}`;
	return `${unixPrefix()}\n${command}`;
}

export default function piDeckShellProxy(pi: ExtensionAPI): void {
	if (process.env[PI_PROXY_INJECTED_ENV] !== MODEL_ONLY_SCOPE) return;

	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
		const command = event.input.command;
		if (typeof command !== "string") return undefined;
		event.input.command = scopeShellCommand(event.toolName, command);
		return undefined;
	});
}
