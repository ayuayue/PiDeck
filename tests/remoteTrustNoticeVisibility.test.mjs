import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldShowRemoteTrustNotice } = loadTsCommonJs("src/renderer/src/components/session/remoteTrustNoticeVisibility.ts");

test("待决策和已失效时显示，信任或拒绝后立即隐藏", () => {
	for (const kind of ["undecided", "stale"]) {
		assert.equal(shouldShowRemoteTrustNotice(kind), true);
	}
	for (const kind of ["approved", "denied"]) {
		assert.equal(shouldShowRemoteTrustNotice(kind), false);
		assert.equal(shouldShowRemoteTrustNotice(kind, kind), false);
	}
});
