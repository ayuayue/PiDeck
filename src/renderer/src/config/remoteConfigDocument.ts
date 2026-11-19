import { REMOTE_CONFIG_CODES, type RemoteConfigDocument, type RemoteConfigSecretSource } from "../../../shared/piConfig";
import { parseMergePatchText } from "./remoteConfigModel";

/** Validate a complete editable JSON document; null retains its normal JSON meaning. */
export function remoteConfigDocument(document: unknown, secretSources: RemoteConfigSecretSource[] = []): RemoteConfigDocument {
	const parsed = parseMergePatchText(JSON.stringify(document));
	if (!parsed.ok) throw new Error(REMOTE_CONFIG_CODES.fileInvalid);
	return { data: parsed.patch, secretSources: structuredClone(secretSources) };
}
