import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// config/hiddenModels：AppSettings.hiddenModels（`provider/modelId` 条目）的统一读写。
// 四个消费方（卡片眼睛 / 供应商页隐藏集合 / 保存前清孤儿 / 供应商改名替换）共用这一份纯逻辑。
const { hiddenModelKey, pickProviderHiddenIds, toggleHiddenModelKey, replaceProviderHiddenIds, sameHiddenModelEntries, pruneHiddenModelOrphans } = loadTsCommonJs("src/renderer/src/config/hiddenModels.ts");

// vm 独立 realm 里创建的数组原型不同，deepEqual 会误报；JSON 往返归一到宿主 realm。
const plain = (value) => JSON.parse(JSON.stringify(value));
const index = (entries) => new Map(entries.map(([provider, ids]) => [provider, new Set(ids)]));
const pick = (...args) => plain(pickProviderHiddenIds(...args));
const toggle = (...args) => plain(toggleHiddenModelKey(...args));
const replace = (...args) => plain(replaceProviderHiddenIds(...args));
const prune = (...args) => plain(pruneHiddenModelOrphans(...args));

test("hiddenModelKey：按 provider/modelId 拼键（模型 id 可含斜杠）", () => {
	assert.equal(hiddenModelKey("relay", "deepseek-v4.1-flash"), "relay/deepseek-v4.1-flash");
	assert.equal(hiddenModelKey("relay", "qd/qfmodel"), "relay/qd/qfmodel");
});

test("pickProviderHiddenIds：只取该 provider 的模型 id（保序去重）", () => {
	const list = ["relay/a", "other/b", "relay/c", "relay/a", "relay2/d"];
	assert.deepEqual(pick(list, "relay"), ["a", "c"]);
	// 前缀整段匹配：relay 不吃 relay2
	assert.deepEqual(pick(list, "relay2"), ["d"]);
	assert.deepEqual(pick(list, ""), []);
	assert.deepEqual(pick(undefined, "relay"), []);
});

test("toggleHiddenModelKey：单条切换（卡片眼睛 / 已隐藏区恢复），不动其它条目", () => {
	const list = ["relay/a", "other/b"];
	assert.deepEqual(toggle(list, "relay", "c"), ["relay/a", "other/b", "relay/c"]);
	assert.deepEqual(toggle(list, "relay", "a"), ["other/b"]);
	// 不可变：原数组不被改写
	assert.deepEqual(list, ["relay/a", "other/b"]);
});

test("replaceProviderHiddenIds：该 provider 换成新集合，其它 provider 原样保留（含改名清旧名）", () => {
	const list = ["relay/a", "other/b", "relay/c"];
	assert.deepEqual(replace(list, "relay", "relay", ["c"]), ["other/b", "relay/c"]);
	// 改名：旧名字下的条目一并清掉，改由新名字承载
	assert.deepEqual(replace(list, "relay", "relay2", ["a"]), ["other/b", "relay2/a"]);
	// 新增供应商（没有旧名字）：只追加
	assert.deepEqual(replace([], "", "fresh", ["x", "y"]), ["fresh/x", "fresh/y"]);
	// 空集合 = 该 provider 不再隐藏任何模型（其它 provider 不受影响）
	assert.deepEqual(replace(list, "relay", "relay", []), ["other/b"]);
});

test("sameHiddenModelEntries：逐项比较（写盘前的脏判断）", () => {
	assert.equal(sameHiddenModelEntries(["a", "b"], ["a", "b"]), true);
	assert.equal(sameHiddenModelEntries(["a"], ["a", "b"]), false);
	assert.equal(sameHiddenModelEntries(["a", "b"], ["b", "a"]), false);
	assert.equal(sameHiddenModelEntries([], []), true);
});

test("pruneHiddenModelOrphans：只清「provider 在 models.json、模型 id 不在其列表」的孤儿", () => {
	const list = ["relay/a", "relay/gone", "other/b", "other/gone", "builtin/model"];
	// relay 与 other 都在配置里；builtin 不在（pi 内置 provider，一律不碰）
	assert.deepEqual(
		prune(
			list,
			index([
				["relay", ["a"]],
				["other", ["b"]],
			]),
		),
		["relay/a", "other/b", "builtin/model"],
	);
	// 脏条目（没有斜杠）原样保留
	assert.deepEqual(prune(["relay/a", "junk"], index([["relay", ["a"]]])), ["relay/a", "junk"]);
});
