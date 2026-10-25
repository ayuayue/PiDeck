import { readdirSync, readFileSync } from "node:fs";

const entryPath = "src/main/index.ts";
const ipcDirectory = "src/main/ipc";

export const mainIpcSources = [
	{ path: entryPath, source: readFileSync(entryPath, "utf8") },
	...readdirSync(ipcDirectory)
		.filter((name) => name.endsWith(".ts"))
		.sort()
		.map((name) => {
			const path = `${ipcDirectory}/${name}`;
			return { path, source: readFileSync(path, "utf8") };
		}),
];

export const mainIpcSource = mainIpcSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");
