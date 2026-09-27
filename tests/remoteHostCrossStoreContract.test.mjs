import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { HOST_REFERENCE_SOURCES } = loadTsCommonJs("src/main/remote/RemoteHostReferenceRegistry.ts");

// Each typed or decoded host reference must have an owner in the registry's source vocabulary.
// Production provider registration is a separate gate and is not yet wired.
const COVERED_HOST_ID_FIELDS = new Map([
	["src/shared/types/project.ts:ProjectLocation", "projects"],
	["src/shared/types/project.ts:ProjectLocator", "projects"],
	["src/shared/types/session.ts:SessionLocator", "sessions"],
	["src/main/projects/projectStoreCodec.ts:readProjectLocator", "projects"],
	["src/main/sessions/SessionCatalog.ts:hostRebindTargetLocator", "sessions"],
]);

const TYPE_FILES = readdirSync("src/shared/types")
	.filter((name) => name.endsWith(".ts"))
	.map((name) => `src/shared/types/${name}`);
const CODEC_FILES = ["src/main/projects/projectStoreCodec.ts", "src/main/sessions/SessionCatalog.ts"];

function hostIdFields(filePath, content = readFileSync(filePath, "utf8")) {
	const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
	assert.equal(source.parseDiagnostics.length, 0, `${filePath} must parse before its references can be audited`);
	const fields = [];
	const isCodec = CODEC_FILES.includes(filePath);
	function visit(node) {
		const isTypedField = ts.isPropertySignature(node);
		const isField = isTypedField || (isCodec && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)));
		if (isField && node.name.text === "hostId") {
			let owner = node.parent;
			while (owner && !(isTypedField ? ts.isTypeAliasDeclaration(owner) || ts.isInterfaceDeclaration(owner) : ts.isFunctionDeclaration(owner))) owner = owner.parent;
			fields.push(`${filePath}:${owner?.name?.text ?? "<unscoped>"}`);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return fields;
}

function assertReferenceSourcesCovered(overrides = new Map()) {
	const fields = [...TYPE_FILES, ...CODEC_FILES].flatMap((filePath) => hostIdFields(filePath, overrides.get(filePath))).sort();
	const declared = [...COVERED_HOST_ID_FIELDS.keys()].sort();
	assert.deepEqual(fields, declared, "Every hostId field in shared types and store codecs needs an explicit reference-source owner");
	for (const source of COVERED_HOST_ID_FIELDS.values()) assert.ok(HOST_REFERENCE_SOURCES.includes(source), `${source} is not a registered reference-source kind`);
}

test("every typed or decoded hostId has a declared reference-source owner", () => {
	assertReferenceSourcesCovered();
});

test("a new hostId field without a reference-source owner fails the contract", () => {
	const typePath = "src/shared/types/session.ts";
	const mutatedType = `${readFileSync(typePath, "utf8")}\nexport type FuturePersistentEntry = { hostId: string };\n`;
	assert.throws(() => assertReferenceSourcesCovered(new Map([[typePath, mutatedType]])), /Every hostId field/);

	const codecPath = "src/main/sessions/SessionCatalog.ts";
	const mutatedCodec = `${readFileSync(codecPath, "utf8")}\nfunction futureDecoder() { return { hostId: "new-id" }; }\n`;
	assert.throws(() => assertReferenceSourcesCovered(new Map([[codecPath, mutatedCodec]])), /Every hostId field/);
});
