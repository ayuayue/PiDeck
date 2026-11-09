#!/usr/bin/env node
/** New releases stay drafts until every asset is ready; retries never hide a published release. */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function resolveReleaseDraft(repo, tag, run = spawnSync) {
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error("Invalid release repository or tag");
	const result = run("gh", ["api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], { encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (/HTTP 404/.test(result.stderr ?? "")) return true;
		throw new Error(`Cannot inspect release visibility (${result.status}); refusing to change it`);
	}
	const release = JSON.parse(result.stdout);
	if (typeof release.draft !== "boolean") throw new Error("GitHub returned no release draft state");
	return release.draft;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const draft = resolveReleaseDraft(process.env.GITHUB_REPOSITORY ?? "", process.env.TAG ?? "");
		if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
		appendFileSync(process.env.GITHUB_OUTPUT, `draft=${draft}\n`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
