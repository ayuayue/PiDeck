import { join } from "node:path";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

/** Load the production SessionScanner dependency graph with test-local Electron services. */
export function loadSessionScanner(homePath, options = {}) {
	return loadTsCommonJs("src/main/sessions/SessionScanner.ts", {
		stubs: {
			electron: {
				app: { getPath: (name) => (name === "home" ? homePath : join(homePath, String(name))) },
				shell: options.shell ?? { trashItem: async () => {} },
			},
			"../logging/sharedLogger": { getAppLogger: () => null },
			...options.stubs,
		},
		globals: options.globals,
	});
}
