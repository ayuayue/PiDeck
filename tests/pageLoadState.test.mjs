import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * 补页 loading 状态必须是「在飞请求数」的像，不能是「最新请求」的像。
 *
 * 2026-11 真机（636 轮会话）：顶部永久「加载中…」、消息加载不完整、跳转一路失败。
 * 成因是一处布尔被两个 sequence 抢：第二个请求发起后 getLatestLoad 变新，第一个请求的
 * finally 跳过复位，isLoadingMessagePage 永久 true；而 loadMoreMessages 开头的 in-flight
 * 守卫据此直接 return —— 之后每一次补页都被吞掉。
 *
 * 判据锁形状：复位必须无条件，且状态来自计数。
 */

const PATH = "src/renderer/src/hooks/session/timeline/useTimelineHistoryPaging.ts";
const raw = () => readFileSync(PATH, "utf8");
/** 去掉注释行：说明性注释会原样引用出错的旧写法，不能算命中。 */
const codeOnly = () =>
	raw()
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");

test("补页 loading：finally 里的复位不能被 sequence 守卫挡住", () => {
	assert.doesNotMatch(codeOnly(), /getLatestLoad\(sessionId\) === sequence\) setIsLoadingMessagePage\(false\)/, "带 sequence 守卫的复位会在并发时泄漏（永久「加载中…」）");
	assert.match(codeOnly(), /finally\(\(\) => \{\s*\n\t+endPageLoad\(\);/, "finally 必须无条件 endPageLoad()");
});

test("补页 loading：状态来自在飞计数，不是布尔开关", () => {
	assert.match(codeOnly(), /const pendingPageLoadsRef = useRef\(0\);/, "必须有在飞计数");
	assert.match(codeOnly(), /setIsLoadingMessagePage\(pendingPageLoadsRef\.current > 0\)/, "loading 必须由计数推出");
});

test("补页 loading：每个 start 都有对应 end", () => {
	const code = codeOnly();
	const starts = (code.match(/beginPageLoad\(\);/g) ?? []).length;
	const ends = (code.match(/endPageLoad\(\);/g) ?? []).length;
	assert.ok(starts >= 2, "至少两处发请求（disk 页 / runtime 页）");
	assert.equal(starts, ends, "beginPageLoad " + starts + " 次必须配 endPageLoad " + ends + " 次");
});
