/** Convert prompts.chat named variables to Pi positional arguments for every installation target. */
export function convertStoreVarsToPiVars(content: string): { converted: string; argumentHint: string; varCount: number } {
	const variables = new Map<string, { index: number; defaultValue?: string }>();
	const converted = content.replace(/\$\{([a-zA-Z_]\w*)(?::(.*?))?\}/g, (_match, name: string, defaultValue?: string) => {
		let variable = variables.get(name);
		if (!variable) {
			variable = { index: variables.size + 1, defaultValue };
			variables.set(name, variable);
		}
		return defaultValue === undefined ? `$${variable.index}` : `\${${variable.index}:-${defaultValue}}`;
	});
	const argumentHint = [...variables].map(([name, variable]) => (variable.defaultValue === undefined ? `<${name}>` : `[${name}:${variable.defaultValue}]`)).join(" ");
	return { converted, argumentHint, varCount: variables.size };
}
