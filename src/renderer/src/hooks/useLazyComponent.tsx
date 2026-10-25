/**
 * 懒加载组件 Hook
 * 使用 Intersection Observer 实现组件的延迟渲染
 */
import { useState, useEffect, useRef, type ReactNode } from "react";

interface LazyComponentOptions {
	/**
	 * 是否启用懒加载
	 */
	enabled?: boolean;
	/**
	 * 触发加载的阈值（0-1，表示可见比例）
	 */
	threshold?: number;
	/**
	 * 根元素边距，提前加载
	 */
	rootMargin?: string;
	/**
	 * 占位符内容
	 */
	placeholder?: ReactNode;
}

export function useLazyComponent(options: LazyComponentOptions = {}) {
	const { enabled = true, threshold = 0, rootMargin = "100px", placeholder = null } = options;

	const [isVisible, setIsVisible] = useState(!enabled);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!enabled) {
			setIsVisible(true);
			return;
		}

		const element = ref.current;
		if (!element) return;

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						setIsVisible(true);
						observer.disconnect();
					}
				});
			},
			{
				threshold,
				rootMargin,
			},
		);

		observer.observe(element);

		return () => observer.disconnect();
	}, [enabled, threshold, rootMargin]);

	return {
		ref,
		isVisible,
		placeholder,
	};
}

/**
 * 懒加载包装组件
 */
interface LazyWrapperProps extends LazyComponentOptions {
	children: ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

export function LazyWrapper({ children, className = "", style, ...options }: LazyWrapperProps) {
	const { ref, isVisible, placeholder } = useLazyComponent(options);

	return (
		<div ref={ref} className={className} style={style}>
			{isVisible ? children : placeholder}
		</div>
	);
}
