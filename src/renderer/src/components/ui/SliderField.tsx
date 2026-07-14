import type { ReactNode } from "react";

export function SliderField(props: {
	label: ReactNode;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
	className?: string;
	description?: ReactNode;
	valueFormatter?: (value: number) => ReactNode;
	disabled?: boolean;
}) {
	const displayValue = props.valueFormatter
		? props.valueFormatter(props.value)
		: props.value;
	return (
		<div
			className={["ui-field ui-slider-field", props.className]
				.filter(Boolean)
				.join(" ")}
		>
			<div className="ui-slider-header">
				<span className="ui-field-label">{props.label}</span>
				<span className="ui-slider-value">{displayValue}</span>
			</div>
			<input
				type="range"
				min={props.min}
				max={props.max}
				step={props.step}
				value={props.value}
				disabled={props.disabled}
				onChange={(event) => props.onChange(Number(event.target.value))}
			/>
			{props.description && (
				<small className="ui-field-description">{props.description}</small>
			)}
		</div>
	);
}
