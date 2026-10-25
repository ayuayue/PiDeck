import { parse, TomlError, type TomlTableWithoutBigInt } from "smol-toml";

export type TomlParseResult = { value: TomlTableWithoutBigInt; error?: string };

/** Parse Codex config with the spec-compliant TOML parser used by the app. */
export function parseCodexToml(raw: string): TomlParseResult {
	try {
		return { value: parse(raw, { integersAsBigInt: false }) };
	} catch (error) {
		return { value: {}, error: error instanceof TomlError ? error.message : String(error) };
	}
}
