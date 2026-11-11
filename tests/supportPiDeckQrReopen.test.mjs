import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripCodeComments } from "./_sourceContract.mjs";

/**
 * 「请作者喝咖啡」弹窗重开不能空白（2026-11 实测：第一次打开有二维码，关掉再打开只剩空框）。
 *
 * 成因：二维码由 purchaseUrl 本地渲染，effect 只依赖 `snapshot?.purchaseUrl`；而打开 effect
 * 每次都先 `setQrDataUrl("")`。关掉再打开时主进程快照缓存（5 分钟）返回**同一个字符串**，
 * 依赖没变 → 画码的 effect 不重跑 → 二维码永远是空的。
 *
 * 约定：清空与重画都由画码的 effect 负责，且它的依赖必须包含 `props.open`。
 * 这里用源码断言钉住，去掉 props.open 或把清空挪回打开 effect，测试即红。
 */
const SOURCE_PATH = "src/renderer/src/components/app/SupportPiDeckDialog.tsx";

/** 取出包含 needle 的那个 useEffect 块（body + 依赖数组）。 */
function effectBlock(source, needle) {
	const at = source.indexOf(needle);
	assert.notEqual(at, -1, `SupportPiDeckDialog 里应存在包含 ${needle} 的 useEffect`);
	const start = source.lastIndexOf("useEffect(", at);
	const tail = source.indexOf("}, [", at);
	const depsEnd = source.indexOf("]", tail);
	assert.ok(start !== -1 && tail !== -1 && depsEnd !== -1, `无法解析 ${needle} 所在 effect 的依赖数组`);
	return { body: source.slice(start, tail), deps: source.slice(tail + 3, depsEnd + 1) };
}

const code = stripCodeComments(readFileSync(SOURCE_PATH, "utf8"));

test("画二维码的 effect 依赖 props.open（重开时同一张票也要重画）", () => {
	const { deps } = effectBlock(code, "QRCode.toDataURL");
	assert.match(deps, /props\.open/, "依赖缺 props.open：快照缓存 5 分钟内重开拿到同一个 purchaseUrl，effect 不重跑，二维码框会一直空着");
	assert.match(deps, /snapshot\?\.purchaseUrl/, "依赖缺 snapshot?.purchaseUrl：换票据后二维码不会更新");
});

test("关闭弹窗后丢弃二维码内容（url 受 open 约束）", () => {
	const { body } = effectBlock(code, "QRCode.toDataURL");
	assert.match(body, /props\.open \? snapshot\?\.purchaseUrl : undefined/, "画码 effect 应在关闭时取 undefined 并清空，短期票据不留在内存里");
});

test("打开 effect 不再清空 qrDataUrl（否则重开闪一次空框）", () => {
	const { body } = effectBlock(code, "cancelledRef.current = false");
	assert.doesNotMatch(body, /setQrDataUrl\s*\(\s*""\s*\)/, "清空 qrDataUrl 必须由画码 effect 统一负责：打开时先清空会让重开瞬间出现空框");
});
