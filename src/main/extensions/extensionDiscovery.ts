import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";

/** pi 0.85 treats only TypeScript and JavaScript files as direct extension entries. */
export function isExtensionFileName(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve one extension directory exactly like pi: manifest entries first, then index.ts/index.js.
 * A malformed manifest or one with no existing entries falls back to the conventional index files.
 */
export function resolveExtensionEntryPoints(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8").replace(/^\uFEFF/, ""));
			const pi = isRecord(parsed) && isRecord(parsed.pi) ? parsed.pi : null;
			const declared = pi?.extensions;
			if (Array.isArray(declared) && declared.every((entry): entry is string => typeof entry === "string")) {
				const paths = declared.map((entry) => resolve(dir, entry)).filter(existsSync);
				if (paths.length > 0) return paths;
			}
		} catch {
			// A damaged package manifest falls back to index.ts/index.js, matching pi.
		}
	}
	for (const index of ["index.ts", "index.js"]) {
		const path = join(dir, index);
		if (existsSync(path)) return [path];
	}
	return null;
}

/**
 * Discover one level of local extensions using pi's automatic discovery rules.
 * Symlinked files/directories are retained because pi also follows them at load time.
 */
export function discoverExtensionEntries(dir: string): string[] {
	if (!existsSync(dir)) return [];
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const discovered: string[] = [];
	for (const entry of entries) {
		const name = entry.name;
		if (name.startsWith(".") || name === "node_modules" || name.endsWith(".d.ts")) continue;
		const entryPath = join(dir, name);
		if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFileName(name)) {
			discovered.push(entryPath);
			continue;
		}
		let isDirectory = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDirectory = statSync(entryPath).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDirectory) continue;
		const entryPoints = resolveExtensionEntryPoints(entryPath);
		if (entryPoints) discovered.push(...entryPoints);
	}
	return discovered;
}
