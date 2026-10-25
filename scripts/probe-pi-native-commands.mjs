/**
 * pi 原生资源规则「真实生效」探针（手工验收的机器判据）。
 *
 * 为什么需要：技能/扩展/内置扩展的开关现在写进 pi 原生 settings.json 的 `+/-` 规则，
 * 界面上的「已停用」只证明写盘成功，不证明 pi 真的不加载。本脚本用真实 HOME 的 pi
 * 跑一次 RPC `get_commands`，直接看目标命令在不在。
 *
 * 只读：`--no-session`（不建会话文件）、`--offline`（不发网络请求）、不触发模型调用。
 *
 * 用法：
 *   node scripts/probe-pi-native-commands.mjs                       # 打印当前 HOME 的全部命令
 *   node scripts/probe-pi-native-commands.mjs --filter skill:       # 只看匹配的
 *   node scripts/probe-pi-native-commands.mjs --has skill:image-gen --missing mcp
 *   node scripts/probe-pi-native-commands.mjs --cwd <项目目录> --pi <pi二进制>
 *
 * 判据：--has 的命令必须在列表里，--missing 的必须不在；任一不满足退出码 1。
 * 断言只认「指定命令在不在」，不要断言总数（扩展注册存在时序噪声）。
 */

import { spawn } from "node:child_process";

function parseArgs(argv) {
	const options = { pi: process.env.PI_BIN ?? "pi", cwd: process.cwd(), filter: "", has: [], missing: [] };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--pi") options.pi = value;
		else if (flag === "--cwd") options.cwd = value;
		else if (flag === "--filter") options.filter = value;
		else if (flag === "--has") options.has.push(value);
		else if (flag === "--missing") options.missing.push(value);
		else continue;
		i += 1;
	}
	return options;
}

/** 启动一次 RPC 会话，发 get_commands，返回命令名数组（排序后）。 */
function getCommandNames(options) {
	return new Promise((resolve, reject) => {
		const args = ["--mode", "rpc", "--no-session", "--offline", "--no-themes"];
		const child = spawn(options.pi, args, { cwd: options.cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`RPC 超时（30s）。stderr: ${stderr.slice(-600)}`));
		}, 30_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			let idx;
			while ((idx = stdout.indexOf("\n")) !== -1) {
				const line = stdout.slice(0, idx).trim();
				stdout = stdout.slice(idx + 1);
				if (!line) continue;
				let response;
				try {
					response = JSON.parse(line);
				} catch {
					continue;
				}
				if (response?.type !== "response" || response?.command !== "get_commands") continue;
				clearTimeout(timer);
				child.stdin.end();
				if (!response.success) {
					child.kill("SIGTERM");
					reject(new Error(`get_commands 失败: ${JSON.stringify(response).slice(0, 300)}`));
					return;
				}
				const names = (response.data?.commands ?? []).map((command) => command.name).sort();
				child.kill("SIGTERM");
				resolve(names);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin.write(`${JSON.stringify({ id: "probe", type: "get_commands" })}\n`);
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const names = await getCommandNames(options);
	console.log(`pi=${options.pi} cwd=${options.cwd} 命令总数=${names.length}`);
	if (options.filter) {
		const hit = names.filter((name) => name.includes(options.filter));
		console.log(`匹配 "${options.filter}"：${hit.length ? hit.join(", ") : "（无）"}`);
	} else {
		console.log(names.join("\n"));
	}
	let failed = 0;
	for (const name of options.has) {
		const ok = names.includes(name);
		if (!ok) failed += 1;
		console.log(`${ok ? "✔" : "✖"} --has ${name}`);
	}
	for (const name of options.missing) {
		const ok = !names.includes(name);
		if (!ok) failed += 1;
		console.log(`${ok ? "✔" : "✖"} --missing ${name}`);
	}
	if (options.has.length || options.missing.length) console.log(`结果：${options.has.length + options.missing.length - failed} 通过 / ${failed} 失败`);
	if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error("探针异常：", error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
