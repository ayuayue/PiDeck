import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const require = createRequire(import.meta.url);

test("certificate import and private-key ACL use their respective certificate/keychain passwords", async () => {
	const calls = [];
	let keychainPassword;
	const certificatePasswords = ["application-export-password", "installer-export-password"];
	const { createKeychain } = loadTsCommonJs(require.resolve("app-builder-lib/out/codeSign/macCodeSign.js"), {
		globals: { process: { env: { TRAVIS: "true" } } },
		stubs: {
			"./codesign": { importCertificate: async (link) => `/fixtures/${link}.p12` },
			"builder-util": {
				exec: async (command, input) => {
					assert.equal(command, "/usr/bin/security");
					const args = Array.from(input);
					calls.push(args);
					if (args[0] === "create-keychain") keychainPassword = args[args.indexOf("-p") + 1];
					if (args[0] === "unlock-keychain") assert.equal(args[args.indexOf("-p") + 1], keychainPassword);
					if (args[0] === "set-key-partition-list") {
						assert.equal(args[args.indexOf("-k") + 1], keychainPassword, "ACL authentication must use the generated keychain password, not a .p12 export password");
						assert.equal(args[args.indexOf("-S") + 1], "apple-tool:,apple:", "keep the signing-tool ACL");
						assert.ok(args.includes("-s"));
					}
					return "";
				},
				unlinkIfExists: async () => {},
			},
		},
	});
	await createKeychain({ tmpDir: {}, currentDir: "/fixtures/project", cscLink: "application", cscKeyPassword: certificatePasswords[0], cscILink: "installer", cscIKeyPassword: certificatePasswords[1] });
	assert.equal(typeof keychainPassword, "string");
	assert.ok(!certificatePasswords.includes(keychainPassword));
	const imports = calls.filter((args) => args[0] === "import");
	assert.deepEqual(
		imports.map((args) => args[args.indexOf("-P") + 1]),
		certificatePasswords,
	);
	for (const args of imports) {
		assert.ok(args.includes("/usr/bin/codesign"));
		assert.ok(args.includes("/usr/bin/productbuild"));
	}
	assert.equal(calls.filter((args) => args[0] === "set-key-partition-list").length, 2);
});
