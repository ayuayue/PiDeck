/**
 * Remote upload boundary after the legacy direct-write path was removed.
 *
 * The jobful SFTP transaction has its own adapter/job tests; this file keeps the shared input
 * contract and reserved-name behavior that other remote readers still consume.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { REMOTE_UPLOAD_TEMP_NAME } = loadTsCommonJs("src/main/remote/RemoteProjectUploadNames.ts");
const { isUserVisibleRemoteEntry } = loadTsCommonJs("src/main/remote/RemoteProjectNameRules.ts");
const { parseLocalUploadPaths, REMOTE_UPLOAD_MAX_FILES } = loadTsCommonJs("src/main/ipc/remoteUploadPaths.ts");

test("the retired direct upload/download channels no longer exist", () => {
	assert.equal("remoteProjectUpload" in ipcChannels, false);
	assert.equal("remoteProjectUploadPaths" in ipcChannels, false);
	assert.equal("remoteProjectDownload" in ipcChannels, false);
	assert.equal(ipcChannels.remoteProjectTransferStart, "remote:project-transfer-start");
	assert.equal(ipcChannels.remoteProjectTransferCancel, "remote:project-transfer-cancel");
	assert.equal(ipcChannels.remoteProjectTransferEvent, "remote:project-transfer-event");
});

test("only PiDeck's exact upload staging name is hidden from user-visible entries", () => {
	assert.equal(REMOTE_UPLOAD_TEMP_NAME.test(".0123456789abcdef0123456789abcdef.pideck-put"), true);
	for (const name of [".env", ".gitignore", "my.pideck-put", ".short.pideck-put", ".0123456789abcdef0123456789abcdef.pideck-put.bak"]) {
		assert.equal(REMOTE_UPLOAD_TEMP_NAME.test(name), false, name);
	}
	assert.equal(isUserVisibleRemoteEntry(".pideck-trash/old.txt"), false);
	assert.equal(isUserVisibleRemoteEntry("src/.0123456789abcdef0123456789abcdef.pideck-put"), false);
	assert.equal(isUserVisibleRemoteEntry("src/main.ts"), true);
});

test("picker and drop sources accept only bounded absolute local paths", () => {
	for (const paths of [["/etc/hosts"], [String.raw`C:\tmp\a.txt`], ["C:/tmp/a.txt"], [String.raw`\\server\share\x`]]) {
		assert.equal(parseLocalUploadPaths(paths).ok, true, JSON.stringify(paths));
	}
	assert.equal(parseLocalUploadPaths([" /tmp/a "]).ok, false);
	assert.equal(parseLocalUploadPaths(["relative.txt"]).ok, false);
	assert.equal(parseLocalUploadPaths([""]).ok, false);
	assert.equal(parseLocalUploadPaths(["/tmp/a" + String.fromCharCode(0) + "b"]).ok, false);
	assert.equal(parseLocalUploadPaths([1]).ok, false);
	assert.equal(parseLocalUploadPaths([]).ok, false);
	assert.equal(parseLocalUploadPaths(Array.from({ length: REMOTE_UPLOAD_MAX_FILES + 1 }, (_, index) => `/tmp/${index}`)).ok, false);
	assert.equal(parseLocalUploadPaths(Array.from({ length: REMOTE_UPLOAD_MAX_FILES }, (_, index) => `/tmp/${index}`)).ok, true);
});
