#!/usr/bin/env node
/**
 * price.mjs — 改海报价格 / 文案，并（默认）重新出图。零依赖，node 直接跑。
 *
 *   node price.mjs                       # 看当前价格表
 *   node price.mjs --json                # 看当前状态（JSON，给 agent 读）
 *   node price.mjs --plus 140 --pro5 700 --pro20 1300,1450 --claude 175
 *   node price.mjs --plus 140 --no-shot  # 只改数据不出图
 *   node price.mjs --shot                # 不改数据，只按当前 poster.html 出图
 *   node price.mjs --dry-run --plus 140  # 只打印将要写入的 DEFAULT_STATE，不落盘
 *
 * 改价一律走这个脚本或 poster.html 面板，别去手改 poster.html 里的数字——
 * 这个脚本会顺带同步 README 的价格表，并做一次读回校验。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(DIR, "poster.html");
const README_PATH = path.join(DIR, "README.md");
const BLOCK_RE = /const DEFAULT_STATE = \{[\s\S]*?\n\};/;

const VALUE_FLAGS = ["plus", "pro5", "pro20", "claude", "item", "add-item", "del-item", "title", "subtitle", "list-title", "footer-note", "state"];
const BOOL_FLAGS = ["json", "shot", "no-shot", "dry-run", "help", "h", "sync-readme"];
/** 可以重复给的参数（同一条命令里改/加/删多条） */
const MULTI_FLAGS = ["item", "add-item", "del-item"];

/** 允许出现在 DEFAULT_STATE 里的字段（多余字段会让海报渲染出问题，直接拦下而不是静默丢掉） */
const SCHEMA = {
	root: ["title", "subtitle", "hero", "tiers", "listTitle", "items", "footerNote"],
	hero: ["name", "price"],
	tier: ["name", "price", "variants"],
	variant: ["label", "price"],
	item: ["name", "price", "note"]
};

const HELP = `node price.mjs —— 改「GPT 充值价目海报」的价格并出图（改的是 poster.html 里的 DEFAULT_STATE）

读：
  node price.mjs                     看当前价格表
  node price.mjs --json              输出当前状态 JSON（含 poster.html / PNG 路径）

改价（可组合，改完默认自动出图）：
  --plus <n>                         GPT Plus 主价；填 null 或空 → 显示「询价」
  --pro5 <n>                         Pro ×5倍 价格
  --pro20 <a,b>                      Pro ×20倍 各分栏价，按顺序给（现在 2 个：如 1250,1400）
  --claude <n>                       Claude 成品号价（按名字含 claude 匹配）
  --item "<关键词>=<价>"             按关键词改任一列表条目价（可重复给多个）
  --add-item "<名称>=<价>"           加一行（插在「时价波动」之前，可重复）
  --del-item "<关键词>"              删一行（可重复）
  --title/--subtitle/--list-title    改大标题 / 副标题 / 底部区块小标题
  --footer-note "..."                改海报最底部那行小字（发票说明等）；给空串则不显示
  --state '<json>'                   其余字段的通用入口，深合并，如 --state '{"hero":{"name":"GPT Plus 成品号"}}'

出图 / 其它：
  --no-shot                          只改数据，不出图
  --shot                             不改数据，直接按当前 poster.html 出图
  --dry-run                          只打印将要写入的 DEFAULT_STATE，不落盘
  --no-sync-readme                   不同步 README 里的价格表
  --json                             输出机器可读 JSON（agent 用这个）
  -h, --help                         显示本帮助

例：
  node price.mjs --plus 140 --pro5 700 --pro20 1300,1450 --claude 175
  node price.mjs --item "claude=175" --no-shot
  node price.mjs --shot
`;

/* ---------------- 参数解析 ---------------- */
function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i];
		if (!raw.startsWith("--") && raw !== "-h") throw new Error(`不认识的参数「${raw}」（参数都要写成 --xxx 形式，见 --help）`);
		const eq = raw.indexOf("=");
		const name = (eq > 0 ? raw.slice(2, eq) : raw.replace(/^--?/, "")).toLowerCase();
		if (name === "h" || name === "help") {
			flags.help = true;
			continue;
		}
		if (BOOL_FLAGS.includes(name)) {
			if (eq > 0) throw new Error(`--${name} 是开关，不接受值`);
			flags[name] = true;
			continue;
		}
		if (!VALUE_FLAGS.includes(name)) throw new Error(`不认识的参数「--${name}」（见 --help）`);
		let value;
		if (eq > 0) value = raw.slice(eq + 1);
		else {
			value = argv[++i];
			if (value === undefined || value.startsWith("--")) throw new Error(`--${name} 缺少值`);
		}
		if (MULTI_FLAGS.includes(name)) (flags[name] ||= []).push(value);
		else flags[name] = value;
	}
	if (flags.shot && flags["no-shot"]) throw new Error("--shot 与 --no-shot 不能同时给");
	return flags;
}

/* ---------------- 读 / 解析 / 写 poster.html ---------------- */
function readState() {
	const html = fs.readFileSync(HTML_PATH, "utf8");
	const hit = BLOCK_RE.exec(html);
	if (!hit) throw new Error(`在 poster.html 里找不到 DEFAULT_STATE 块（格式被改过了？）`);
	const literal = hit[0].slice("const DEFAULT_STATE = ".length, -1);
	let state;
	try {
		state = new Function(`return (${literal})`)();
	} catch (e) {
		throw new Error(`DEFAULT_STATE 不是合法的 JS 对象字面量：${e.message}`);
	}
	return { html, hit, state: normalize(structuredClone(state)) };
}

const str = (s) => JSON.stringify(String(s ?? ""));
const priceLit = (p) => (p === null || p === undefined || p === "" ? "null" : String(Math.round(Number(p))));

/** 补上早期文件里可能缺的字段（海报渲染时按空处理，这里先补齐便于序列化） */
function normalize(state) {
	if (typeof state.footerNote !== "string") state.footerNote = "";
	return state;
}

/** 把 state 写回成 poster.html 里那种带 tab 缩进的字面量（字段顺序固定，便于人看 diff） */
function serialize(state) {
	const L = ["const DEFAULT_STATE = {"];
	L.push(`\ttitle: ${str(state.title)},`);
	L.push(`\tsubtitle: ${str(state.subtitle)},`);
	L.push(`\thero: { name: ${str(state.hero.name)}, price: ${priceLit(state.hero.price)} },`);
	L.push("\ttiers: [");
	state.tiers.forEach((t, i) => {
		const comma = i === state.tiers.length - 1 ? "" : ",";
		const vars = Array.isArray(t.variants) ? t.variants : [];
		if (!vars.length) {
			L.push(`\t\t{ name: ${str(t.name)}, price: ${priceLit(t.price)}, variants: [] }${comma}`);
			return;
		}
		L.push(`\t\t{ name: ${str(t.name)}, price: ${priceLit(t.price)}, variants: [`);
		vars.forEach((v, j) => L.push(`\t\t\t{ label: ${str(v.label ?? "")}, price: ${priceLit(v.price)} }${j === vars.length - 1 ? "" : ","}`));
		L.push(`\t\t] }${comma}`);
	});
	L.push("\t],");
	L.push(`\tlistTitle: ${str(state.listTitle)},`);
	L.push("\titems: [");
	state.items.forEach((it, i) => {
		const note = it.note ? ", note: true" : "";
		L.push(`\t\t{ name: ${str(it.name)}, price: ${priceLit(it.price)}${note} }${i === state.items.length - 1 ? "" : ","}`);
	});
	L.push("\t],");
	L.push(`\tfooterNote: ${str(state.footerNote)}`);
	L.push("};");
	return L.join("\n");
}

function checkSchema(obj, allowed, where) {
	for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${where} 出现脚本不认识的字段「${k}」：请手工改 poster.html，或先把这个字段告知作者`);
}

function validate(state) {
	if (typeof state.title !== "string" || typeof state.subtitle !== "string" || typeof state.listTitle !== "string") throw new Error("title / subtitle / listTitle 必须是字符串");
	if (typeof state.footerNote !== "string") throw new Error("footerNote 必须是字符串（不要就给空串）");
	if (!state.hero || typeof state.hero !== "object") throw new Error("hero 必须是对象");
	if (!Array.isArray(state.tiers) || !state.tiers.length || state.tiers.length > 2) throw new Error("tiers 只支持 1~2 个卡（海报第二排是两栏）");
	if (!Array.isArray(state.items)) throw new Error("items 必须是数组");
	checkSchema(state, SCHEMA.root, "DEFAULT_STATE");
	checkSchema(state.hero, SCHEMA.hero, "hero");
	for (const t of state.tiers) {
		checkSchema(t, SCHEMA.tier, `tiers「${t.name}」`);
		if (typeof t.name !== "string") throw new Error("每个 tier 都要有字符串 name");
		if (!Array.isArray(t.variants)) throw new Error(`tiers「${t.name}」的 variants 必须是数组`);
		if (t.variants.length > 3) throw new Error(`tiers「${t.name}」最多 3 个分栏`);
		for (const v of t.variants) checkSchema(v, SCHEMA.variant, `tiers「${t.name}」的分栏`);
	}
	for (const it of state.items) {
		checkSchema(it, SCHEMA.item, `items「${it.name}」`);
		if (typeof it.name !== "string" || !it.name.trim()) throw new Error("每个条目都要有名字");
	}
}

/* ---------------- 值处理 ---------------- */
const money = (raw, label) => {
	const t = String(raw).trim();
	if (t === "" || t === "null" || t === "none" || t === "询价") return null;
	const n = Number(t.replace(/[¥￥,\s]/g, ""));
	if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error(`${label} 的价「${raw}」看着不对（要 0~1000000 的数字，或 null / 询价）`);
	return Math.round(n);
};
const show = (p) => (p === null || p === undefined || p === "" ? "询价" : `¥${p}`);

function findItem(state, key, where) {
	const k = String(key).trim();
	if (!k) throw new Error(`${where} 的关键词不能为空`);
	const lower = k.toLowerCase();
	const match = (name) => {
		const n = name.toLowerCase();
		return n === lower || n.includes(lower);
	};
	const exact = state.items.findIndex((it) => it.name === k);
	if (exact >= 0) return exact;
	const hits = state.items.map((it, i) => (match(it.name) ? i : -1)).filter((i) => i >= 0);
	if (!hits.length) throw new Error(`列表里没有名字含「${k}」的条目；现有：${state.items.map((it) => it.name).join(" / ")}`);
	if (hits.length > 1) throw new Error(`「${k}」匹配到多条：${hits.map((i) => state.items[i].name).join(" / ")}，请写全一点`);
	return hits[0];
}

const each = (v, fn) => {
	for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) fn(x);
};

const splitPair = (raw, flag) => {
	const i = String(raw).indexOf("=");
	if (i < 0) throw new Error(`${flag} 要写成「名称=价格」，收到「${raw}」`);
	return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()];
};

function applyFlags(state, flags) {
	const changes = [];
	const setPrice = (label, obj, key, raw) => {
		const next = money(raw, label);
		if (obj[key] === next) return;
		changes.push(`${label}：${show(obj[key])} → ${show(next)}`);
		obj[key] = next;
	};
	const setText = (label, obj, key, raw) => {
		const next = String(raw);
		if (obj[key] === next) return;
		changes.push(`${label}：${obj[key]} → ${next}`);
		obj[key] = next;
	};

	if (flags.plus !== undefined) setPrice(`主价 ${state.hero.name}`, state.hero, "price", flags.plus);
	if (flags.pro5 !== undefined) {
		const t = state.tiers[0];
		if (t.variants.length) throw new Error(`「${t.name}」是分栏卡，请用 --pro20 那种多值写法或 --state 改`);
		setPrice(t.name, t, "price", flags.pro5);
	}
	if (flags.pro20 !== undefined) {
		const t = state.tiers[1];
		if (!t) throw new Error("没有第二张分栏卡（tiers[1]）可用 --pro20");
		if (!t.variants.length) {
			setPrice(t.name, t, "price", flags.pro20);
		} else {
			const vals = String(flags.pro20).split(/[,，/、\s]+/).filter(Boolean);
			if (vals.length !== t.variants.length) throw new Error(`「${t.name}」有 ${t.variants.length} 个分栏价，要按顺序给 ${t.variants.length} 个值（如 --pro20 ${t.variants.map((v) => v.price ?? 0).join(",")}），现在给了 ${vals.length} 个`);
			t.variants.forEach((v, j) => setPrice(`${t.name} 第 ${j + 1} 栏`, v, "price", vals[j]));
		}
	}
	if (flags.claude !== undefined) {
		const i = findItem(state, "claude", "--claude");
		setPrice(state.items[i].name, state.items[i], "price", flags.claude);
	}
	each(flags.item, (raw) => {
		const [key, val] = splitPair(raw, "--item");
		const i = findItem(state, key, "--item");
		setPrice(state.items[i].name, state.items[i], "price", val);
	});
	each(flags["add-item"], (raw) => {
		const [name, val] = splitPair(raw, "--add-item");
		if (!name) throw new Error("--add-item 的名称不能为空");
		if (state.items.some((it) => it.name === name)) throw new Error(`列表里已经有「${name}」了`);
		const row = { name, price: money(val, name) };
		const noteAt = state.items.findIndex((it) => it.note);
		if (noteAt >= 0) state.items.splice(noteAt, 0, row);
		else state.items.push(row);
		changes.push(`加条目：${name} ${show(row.price)}`);
	});
	each(flags["del-item"], (raw) => {
		const i = findItem(state, raw, "--del-item");
		changes.push(`删条目：${state.items[i].name}`);
		state.items.splice(i, 1);
	});
	if (flags.title !== undefined) setText("大标题", state, "title", flags.title);
	if (flags.subtitle !== undefined) setText("副标题", state, "subtitle", flags.subtitle);
	if (flags["list-title"] !== undefined) setText("底部小标题", state, "listTitle", flags["list-title"]);
	if (flags["footer-note"] !== undefined) setText("底部小字", state, "footerNote", flags["footer-note"]);
	if (flags.state !== undefined) {
		let patch;
		try {
			patch = JSON.parse(flags.state);
		} catch (e) {
			throw new Error(`--state 不是合法 JSON：${e.message}`);
		}
		merge(state, patch);
		changes.push(`--state 合并了：${Object.keys(patch).join(", ")}`);
	}
	return changes;
}

function merge(target, patch) {
	for (const [k, v] of Object.entries(patch)) {
		const deep = v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k]);
		if (deep) merge(target[k], v);
		else target[k] = v;
	}
}

/* ---------------- README 价格表同步 ---------------- */
const priceCell = (p, monthly) => (p === null || p === undefined || p === "" ? "询价" : monthly ? `${p} / 月` : `${p}`);

function syncReadme(state) {
	if (!fs.existsSync(README_PATH)) return false;
	const md = fs.readFileSync(README_PATH, "utf8");
	const re = /<!-- PRICES:BEGIN[\s\S]*?<!-- PRICES:END -->/;
	if (!re.test(md)) return false;
	const rows = [`> ${state.title} — ${state.subtitle}；底部区块：${state.listTitle}${state.footerNote ? `；底部小字：${state.footerNote}` : ""}`, "", "| 档位 | 售价 |", "|------|------|", `| ${state.hero.name} | ${priceCell(state.hero.price, true)} |`];
	for (const t of state.tiers) {
		const cell = t.variants.length ? t.variants.map((v) => priceCell(v.price, true)).join("、") : priceCell(t.price, true);
		rows.push(`| ${t.name} | ${cell} |`);
	}
	for (const it of state.items) rows.push(`| ${it.name} | ${priceCell(it.price, false)} |`);
	const block = ["<!-- PRICES:BEGIN 由 price.mjs 自动写入，别手改这一块 -->", ...rows, "<!-- PRICES:END -->"].join("\n");
	fs.writeFileSync(README_PATH, md.replace(re, block), "utf8");
	return true;
}

/* ---------------- 出图 ---------------- */
function runShot() {
	return spawnSync(process.execPath, ["shot.cjs"], { cwd: DIR, stdio: "inherit" });
}

/* ---------------- 主流程 ---------------- */
function main() {
	let flags;
	try {
		flags = parseArgs(process.argv.slice(2));
	} catch (e) {
		console.error(`✗ ${e.message}`);
		process.exit(1);
	}
	if (flags.help) {
		console.log(HELP);
		return;
	}

	const png = path.join(DIR, "GPT充值价目表.png");
	const json = Boolean(flags.json);
	const say = (...a) => {
		if (!json) console.log(...a);
	};

	let cur;
	try {
		cur = readState();
	} catch (e) {
		console.error(`✗ ${e.message}`);
		process.exit(1);
	}
	const state = cur.state;
	const mutating = VALUE_FLAGS.some((f) => flags[f] !== undefined);

	// 只看不改
	if (!mutating) {
		if (json) {
			console.log(JSON.stringify({ changed: [], shot: false, png: fs.existsSync(png) ? png : null, state }, null, 2));
			return;
		}
		console.log(`${state.title} — ${state.subtitle}`);
		console.log(`  主价 ${state.hero.name}：${show(state.hero.price)}/月`);
		for (const t of state.tiers) {
			const v = t.variants.length ? t.variants.map((x) => `${x.label ? `${x.label} ` : ""}${show(x.price)}`).join(" / ") : `${show(t.price)}/月`;
			console.log(`  ${t.name}：${v}`);
		}
		console.log(`  ${state.listTitle}：`);
		for (const it of state.items) console.log(`    · ${it.name} ${show(it.price)}`);
		if (state.footerNote) console.log(`  底部小字：${state.footerNote}`);
		if (flags.shot) {
			say("\n按当前 poster.html 出图…");
			process.exit(runShot().status ?? 1);
		}
		say("\n改价：node price.mjs --plus 140 --pro5 700 --pro20 1300,1450 --claude 175（详见 --help）");
		return;
	}

	// 改数据
	let changes;
	try {
		changes = applyFlags(state, flags);
		validate(state);
	} catch (e) {
		console.error(`✗ ${e.message}\n  （poster.html 未改动）`);
		process.exit(1);
	}

	const nextBlock = serialize(state);
	let written = false;
	if (changes.length && !flags["dry-run"]) {
		const out = cur.html.slice(0, cur.hit.index) + nextBlock + "\n" + cur.html.slice(cur.hit.index + cur.hit[0].length);
		fs.writeFileSync(HTML_PATH, out, "utf8");
		// 读回校验：写进去的东西必须能被重新解析成同一个 state，不成立就还原
		let back = state;
		let backErr = "";
		try {
			back = readState().state;
		} catch (e) {
			back = null;
			backErr = e.message;
		}
		if (!back || JSON.stringify(back) !== JSON.stringify(state)) {
			fs.writeFileSync(HTML_PATH, cur.html, "utf8");
			console.error(`✗ 写入后读回校验失败，已还原 poster.html（这是脚本的 bug，请把这段发给作者）：${backErr || "内容不一致"}`);
			process.exit(1);
		}
		written = true;
	}

	let readmeSynced = false;
	if (written && !flags["no-sync-readme"]) readmeSynced = syncReadme(state);

	if (flags["dry-run"]) {
		say(changes.length ? changes.map((c) => `  ~ ${c}`).join("\n") : "  （没有变化）");
		console.log(nextBlock);
		return;
	}
	if (!changes.length) {
		say("没有变化。");
	} else {
		say("已改 poster.html：");
		for (const c of changes) say(`  · ${c}`);
		if (readmeSynced) say("  · 已同步 README 价格表");
	}

	let shot = false;
	const wantShot = flags["no-shot"] ? false : flags.shot === true || changes.length > 0;
	if (wantShot) {
		say("\n正在出图…");
		const r = runShot();
		shot = r.status === 0;
		if (!shot) {
			console.error("✗ 海报数据已写入，但出图失败（上面是 shot.cjs 的输出）。图片被占用时关掉看图软件再跑一次：node shot.cjs");
			if (json) console.log(JSON.stringify({ changed: changes, shot, png: null, state }, null, 2));
			process.exit(1);
		}
	} else if (changes.length) {
		say("（--no-shot：图还没重出，要出图跑 node shot.cjs 或 node price.mjs --shot）");
	}

	if (json) console.log(JSON.stringify({ changed: changes, readmeSynced, shot, png: shot && fs.existsSync(png) ? png : null, state }, null, 2));
	else if (shot) console.log(`\n✓ 完成：价格已更新，成品图已重出 → ${png}`);
	else if (!changes.length) console.log("✓ 完成：没有改动。");
}

main();
