import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveReleaseDraft } from "../scripts/release-staging.mjs";

test("new releases are drafts; rerunning uploads retains published or draft visibility", () => {
	assert.equal(
		resolveReleaseDraft("example/app", "v1.2.3", () => ({ status: 1, stderr: "gh: Not Found (HTTP 404)" })),
		true,
	);
	for (const draft of [true, false])
		assert.equal(
			resolveReleaseDraft("example/app", "v1.2.3-beta.1", () => ({ status: 0, stdout: JSON.stringify({ draft }) })),
			draft,
		);
});

test("permission/network errors do not turn an existing published release into a draft", () => {
	for (const stderr of ["HTTP 401", "HTTP 403", "HTTP 429", "network timeout"]) assert.throws(() => resolveReleaseDraft("example/app", "v1.2.3", () => ({ status: 1, stderr })), /refusing/);
	assert.throws(() => resolveReleaseDraft("example/app", "v1.2.3", () => ({ status: 0, stdout: "{}" })), /draft state/);
});

test("stable and dev publish workflows stage uploads and require the merged mac manifest", () => {
	for (const name of ["release.yml", "build-dev.yml"]) {
		const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
		assert.match(source, /id: release-staging/);
		assert.match(source, /run: node scripts\/release-staging\.mjs/);
		assert.match(source, /draft: \$\{\{ steps\.release-staging\.outputs\.draft == 'true' \}\}/);
		assert.match(source, /PIDECK_MAC_REQUIRE_NOTARIZATION:.*1/);
		const finalizer = source.slice(source.indexOf(name === "release.yml" ? "  finalize-release:" : "  publish-dev-release:"));
		assert.match(finalizer, /needs: \[[^\n]*merge-mac-update-manifest/);
		assert.match(finalizer, /gh release edit[^\n]*--draft=false/);
	}
});

test("Intel mac packages install native dependencies on an Intel runner", () => {
	for (const name of ["release.yml", "build-dev.yml"]) {
		const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
		const runner = source.match(/name: macOS x64\s+os: ([^\n]+)/)?.[1];
		assert.match(runner ?? "", /^macos-\d+-intel$/, `${name}: x64 must not inherit arm64 macos-latest native packages`);
	}
	const manual = readFileSync(new URL("../.github/workflows/build-macos.yml", import.meta.url), "utf8");
	assert.match(manual, /runs-on:.*matrix.arch == 'x64'.*macos-\d+-intel/);
});
