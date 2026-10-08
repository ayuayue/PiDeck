import { build } from "esbuild";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** A sandbox preload cannot require Rollup's shared chunks, so emit it as one independent CJS asset. */
export function hostPluginPreloadPlugin(): Plugin {
	return {
		name: "pideck-standalone-host-plugin-preload",
		async generateBundle() {
			const result = await build({ entryPoints: [resolve("src/preload/hostPlugin.ts")], bundle: true, platform: "node", format: "cjs", target: "es2022", external: ["electron"], write: false, metafile: true });
			for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(resolve(input));
			this.emitFile({ type: "asset", fileName: "hostPlugin.js", source: result.outputFiles[0].text });
		},
	};
}
