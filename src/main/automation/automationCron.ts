const MINUTE_MS = 60_000;
const MAX_SEARCH_MINUTES = 5 * 366 * 24 * 60;

export type AutomationCronField = {
	values: ReadonlySet<number>;
	wildcard: boolean;
};

export type ParsedAutomationCron = {
	minute: AutomationCronField;
	hour: AutomationCronField;
	dayOfMonth: AutomationCronField;
	month: AutomationCronField;
	dayOfWeek: AutomationCronField;
};

type FieldDefinition = {
	name: string;
	min: number;
	max: number;
	normalize?: (value: number) => number;
};

const FIELD_DEFINITIONS: FieldDefinition[] = [
	{ name: "minute", min: 0, max: 59 },
	{ name: "hour", min: 0, max: 23 },
	{ name: "day of month", min: 1, max: 31 },
	{ name: "month", min: 1, max: 12 },
	// Cron accepts both 0 and 7 as Sunday; normalize to Date#getDay's 0.
	{ name: "day of week", min: 0, max: 7, normalize: (value) => (value === 7 ? 0 : value) },
];

/** Parse strict numeric five-field cron syntax: lists, ranges and step values are supported. */
export function parseAutomationCron(expression: string): ParsedAutomationCron {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== FIELD_DEFINITIONS.length) {
		throw new Error("Cron expression must contain exactly 5 fields");
	}
	const fields = parts.map((part, index) => parseField(part, FIELD_DEFINITIONS[index]));
	return {
		minute: fields[0],
		hour: fields[1],
		dayOfMonth: fields[2],
		month: fields[3],
		dayOfWeek: fields[4],
	};
}

/** Match in the machine's local timezone. DOM and DOW follow standard cron OR semantics. */
export function matchesAutomationCron(cron: ParsedAutomationCron, date: Date): boolean {
	if (!cron.minute.values.has(date.getMinutes())) return false;
	if (!cron.hour.values.has(date.getHours())) return false;
	if (!cron.month.values.has(date.getMonth() + 1)) return false;

	const matchesDayOfMonth = cron.dayOfMonth.values.has(date.getDate());
	const matchesDayOfWeek = cron.dayOfWeek.values.has(date.getDay());
	const matchesDay = cron.dayOfMonth.wildcard ? matchesDayOfWeek : cron.dayOfWeek.wildcard ? matchesDayOfMonth : matchesDayOfMonth || matchesDayOfWeek;
	return matchesDay;
}

/** Find the next local-time cron occurrence after `after`, rounded to the next minute. */
export function nextAutomationCronOccurrence(expression: string, after: Date): Date | undefined {
	const cron = parseAutomationCron(expression);
	let timestamp = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
	for (let index = 0; index < MAX_SEARCH_MINUTES; index += 1) {
		const candidate = new Date(timestamp);
		if (matchesAutomationCron(cron, candidate)) return candidate;
		timestamp += MINUTE_MS;
	}
	return undefined;
}

/** Return recent missed occurrences up to `untilInclusive`, newest first. */
export function missedAutomationCronOccurrences(expression: string, afterExclusive: Date, untilInclusive: Date, limit = 2): Date[] {
	if (untilInclusive.getTime() <= afterExclusive.getTime() || limit <= 0) return [];
	const cron = parseAutomationCron(expression);
	const occurrences: Date[] = [];
	let timestamp = Math.floor(untilInclusive.getTime() / MINUTE_MS) * MINUTE_MS;
	const minimumTimestamp = afterExclusive.getTime();
	let examined = 0;
	while (timestamp > minimumTimestamp && occurrences.length < limit && examined < MAX_SEARCH_MINUTES) {
		const candidate = new Date(timestamp);
		if (matchesAutomationCron(cron, candidate)) {
			occurrences.push(candidate);
		}
		timestamp -= MINUTE_MS;
		examined += 1;
	}
	return occurrences;
}

export function previewAutomationCron(expression: string, from: Date, count: number): Date[] {
	const runs: Date[] = [];
	let cursor = from;
	for (let index = 0; index < Math.max(0, count); index += 1) {
		const next = nextAutomationCronOccurrence(expression, cursor);
		if (!next) break;
		runs.push(next);
		cursor = next;
	}
	return runs;
}

function parseField(source: string, definition: FieldDefinition): AutomationCronField {
	if (!source) throw new Error(`Cron ${definition.name} field is empty`);
	const wildcard = source === "*";
	const values = new Set<number>();
	for (const segment of source.split(",")) {
		if (!segment) throw new Error(`Cron ${definition.name} contains an empty list item`);
		const [base, rawStep, ...extra] = segment.split("/");
		if (extra.length > 0) throw new Error(`Cron ${definition.name} has an invalid step`);
		const step = rawStep === undefined ? 1 : parseNumber(rawStep, 1, definition.max - definition.min + 1, definition.name);
		const [start, end] = parseRange(base, definition);
		for (let value = start; value <= end; value += step) {
			values.add(definition.normalize?.(value) ?? value);
		}
	}
	if (values.size === 0) throw new Error(`Cron ${definition.name} does not select any value`);
	return { values, wildcard };
}

function parseRange(source: string, definition: FieldDefinition): [number, number] {
	if (source === "*") return [definition.min, definition.max];
	const range = source.split("-");
	if (range.length === 1) {
		const value = parseNumber(range[0], definition.min, definition.max, definition.name);
		return [value, value];
	}
	if (range.length !== 2) throw new Error(`Cron ${definition.name} has an invalid range`);
	const start = parseNumber(range[0], definition.min, definition.max, definition.name);
	const end = parseNumber(range[1], definition.min, definition.max, definition.name);
	if (start > end) throw new Error(`Cron ${definition.name} range must be ascending`);
	return [start, end];
}

function parseNumber(source: string, min: number, max: number, name: string): number {
	if (!/^\d+$/.test(source)) throw new Error(`Cron ${name} must be numeric`);
	const value = Number(source);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`Cron ${name} must be between ${min} and ${max}`);
	}
	return value;
}
