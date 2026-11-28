import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runtimeEntryPositions } = loadTsCommonJs("src/main/pi/runtimeEntryPositionIndex.ts");

test("runtime entryId 索引：首次建表，原数组追加只索引新尾段", () => {
	let indexedReads = 0;
	const raw = [{ meta: { entryId: "a" } }, { meta: { entryId: "b" } }];
	const list = new Proxy(raw, {
		get(target, key, receiver) {
			if (typeof key === "string" && /^\d+$/.test(key)) indexedReads += 1;
			return Reflect.get(target, key, receiver);
		},
	});
	const positions = runtimeEntryPositions(list);
	assert.equal(positions.get("b"), 1);
	assert.equal(indexedReads, 2);
	raw.push({ meta: { entryId: "c" } });
	indexedReads = 0;
	assert.equal(runtimeEntryPositions(list).get("c"), 2);
	assert.equal(indexedReads, 1, "追加后只能索引新尾项");
});

test("runtime entryId 索引：缩短后重建位置，重复 id 保留首个命中", () => {
	const list = [{ meta: { entryId: "same" } }, { meta: { entryId: "same" } }, { meta: { entryId: "tail" } }];
	assert.equal(runtimeEntryPositions(list).get("same"), 0);
	list.length = 2;
	const positions = runtimeEntryPositions(list);
	assert.equal(positions.get("same"), 0);
	assert.equal(positions.has("tail"), false);
});
