/**
 * 可视化「设置」表单的落盘合并规则（纯函数，便于单测）。
 *
 * 为什么不能整份覆盖：设置表单表达的是「用户改了什么」，但它手里持有的是**打开页面时**的
 * 整份 settings.json 快照。资源类键（packages / extensions / skills / prompts / themes）的
 * 真值由 PiResourceConfigService 与 pi 原生规则并发维护（逐项开关、扩展商店安装、旧记录迁移、
 * pi TUI 都可能在我们打开页面之后改动它们）。整份写回会用页面里的旧快照静默回退这些并发
 * 修改——实测复现：安装/启用扩展后，在设置页保存一次就被盖回停用形态。
 *
 * 因此：资源类键一律以锁内重读的磁盘值为准，其余键（表单真正拥有的）用页面值覆盖。
 * 表单本就不提供这些键的编辑入口；将来若要在表单里提供，必须改走 PiResourceConfigService
 * 的定向写入，而不是把键加进这里。
 */

/**
 * 表单不拥有、保存时永远以磁盘当前值为准的键。
 * 直接列字面量而不 import PI_RESOURCE_KINDS：本模块要能被只做单文件转译的测试 harness 加载，
 * 保持零相对依赖（与 piResourceRules 内同类判定同一写法）。
 */
export const RESOURCE_OWNED_SETTINGS_KEYS: readonly string[] = ["packages", "extensions", "skills", "prompts", "themes"];

/**
 * 把设置表单的整份 payload 合并到磁盘当前内容上：
 * - 资源类键：磁盘优先（payload 里的旧值既不能覆盖，也不能凭空创建）；
 * - 其余键：payload 优先（含「payload 没有该键 = 用户删掉了」的整表单语义）。
 */
export function mergeSettingsFormPayload(current: Record<string, unknown>, payload: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...payload };
	for (const key of RESOURCE_OWNED_SETTINGS_KEYS) {
		if (key in current) next[key] = current[key];
		else delete next[key];
	}
	return next;
}
