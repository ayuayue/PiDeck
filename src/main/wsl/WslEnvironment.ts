import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWslEnvironment, type WslEnvironment } from "./WslPaths";

type ExecFile = typeof execFile;

type ResolveWslEnvironmentOptions = {
	execFile?: ExecFile;
	warn?: (message: string, details: Record<string, unknown>) => void;
	wslCommand?: string;
};

function resolveWslCommand(): string {
	if (process.platform !== "win32") return "wsl.exe";
	const systemRoot = process.env.SystemRoot || "C:\\Windows";
	const candidates = process.arch === "ia32"
		? [join(systemRoot, "Sysnative", "wsl.exe"), join(systemRoot, "System32", "wsl.exe")]
		: [join(systemRoot, "System32", "wsl.exe")];
	return candidates.find((candidate) => existsSync(candidate)) ?? "wsl.exe";
}

function fallbackHome(user: string): string {
	return user === "root" ? "/root" : `/home/${user}`;
}

export async function resolveWslEnvironment(
	distro: string,
	user: string,
	options: ResolveWslEnvironmentOptions = {},
): Promise<WslEnvironment> {
	const run = options.execFile ?? execFile;
	const command = options.wslCommand ?? resolveWslCommand();
	const linuxHome = await new Promise<string>((resolve) => {
		run(
			command,
			["-d", distro, "-u", user, "--exec", "printenv", "HOME"],
			{
				encoding: "utf8",
				timeout: 8_000,
				windowsHide: true,
			},
			(error, stdout) => {
				const output = typeof stdout === "string" ? stdout.trim() : "";
				if (!error && output.startsWith("/")) {
					resolve(output);
					return;
				}
				const fallback = fallbackHome(user);
				options.warn?.("Failed to resolve WSL HOME; using the compatibility fallback.", {
					distro,
					user,
					fallback,
					error: error instanceof Error ? error.message : output || "empty output",
				});
				resolve(fallback);
			},
		);
	});

	return createWslEnvironment(distro, user, linuxHome);
}
