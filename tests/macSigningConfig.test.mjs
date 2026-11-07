import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "app-builder-lib";
import { MacPackager } from "app-builder-lib/out/macPackager.js";
import { resolveFunction } from "app-builder-lib/out/util/resolve.js";
import { buildDevConfig } from "../scripts/dist-dev.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Exercise the configured hook against electron-builder's actual macOS options. */
async function configure({ config = structuredClone(pkg.build), env = {}, platform = "darwin" } = {}) {
	const packager = new MacPackager({ metadata: { ...pkg, ...config.extraMetadata }, config });
	const hook = await resolveFunction("commonjs", config.beforePack, "beforePack", root);
	if (hook) await hook({ packager, electronPlatformName: platform }, { env });
	return packager;
}

test("mac packaging keeps explicit ad-hoc signing when no certificate is configured (#347)", async () => {
	const packager = await configure();
	assert.equal(packager.platformSpecificBuildOptions.identity, "-");
	assert.equal(packager.forceCodeSigning, false);
});

for (const env of [{ CSC_LINK: "/temporary/signing.p12" }, { CSC_NAME: "PiDeck Publisher" }, { CSC_LINK: "/temporary/signing.p12", CSC_NAME: "PiDeck Publisher" }]) {
	test(`configured ${Object.keys(env).join(" + ")} enables certificate selection instead of ad-hoc`, async () => {
		const packager = await configure({ env });
		assert.equal(packager.platformSpecificBuildOptions.identity, undefined, "the '-' qualifier prevents electron-builder from selecting the supplied certificate");
		assert.equal(packager.platformSpecificBuildOptions.type, "distribution");
		assert.equal(packager.forceCodeSigning, true, "an unavailable certificate must fail packaging rather than silently skip signing");
	});
}

test("a caller-supplied certificate identity is retained and signing is mandatory", async () => {
	const config = structuredClone(pkg.build);
	config.mac.identity = "Explicit Publisher";
	const packager = await configure({ config, env: { CSC_NAME: "Environment Publisher" } });
	assert.equal(packager.platformSpecificBuildOptions.identity, "Explicit Publisher");
	assert.equal(packager.forceCodeSigning, true);
});

test("certificate signing cannot silently proceed with identity explicitly disabled", async () => {
	const config = structuredClone(pkg.build);
	config.mac.identity = null;
	await assert.rejects(configure({ config, env: { CSC_LINK: "/temporary/signing.p12" } }), /identity.*null/i);
});

test("explicitly disabled signing is respected when no certificate was requested", async () => {
	const config = structuredClone(pkg.build);
	config.mac.identity = null;
	const packager = await configure({ config });
	assert.equal(packager.platformSpecificBuildOptions.identity, null);
});

test("whitespace-only credentials do not disable the ad-hoc fallback", async () => {
	const packager = await configure({ env: { CSC_LINK: " ", CSC_NAME: "\t" } });
	assert.equal(packager.platformSpecificBuildOptions.identity, "-");
});

test("dev channel inherits the signing hook and keeps its separate bundle identity", async () => {
	const config = buildDevConfig();
	const packager = await configure({ config, env: { CSC_LINK: "/temporary/signing.p12" } });
	assert.equal(packager.platformSpecificBuildOptions.identity, undefined);
	assert.equal(packager.forceCodeSigning, true);
	assert.equal(packager.appInfo.id, config.appId);
	assert.notEqual(packager.appInfo.id, pkg.build.appId);
});

test("Windows and Linux targets are unaffected by macOS signing credentials", async () => {
	for (const platform of ["win32", "linux"]) {
		const packager = await configure({ platform, env: { CSC_LINK: "/temporary/signing.p12", CSC_NAME: "PiDeck Publisher" } });
		assert.equal(packager.platformSpecificBuildOptions.identity, "-");
		assert.equal(packager.forceCodeSigning, false);
	}
});
