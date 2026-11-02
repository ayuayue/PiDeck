import {
	Aperture,
	BookOpen,
	Bot,
	Brain,
	Briefcase,
	Bug,
	Calculator,
	Camera,
	Cloud,
	Code,
	Compass,
	Cpu,
	Database,
	Feather,
	FileText,
	Flame,
	FlaskConical,
	GitBranch,
	Globe,
	GraduationCap,
	Heart,
	Languages,
	Lightbulb,
	Megaphone,
	MessageSquare,
	Microscope,
	Music,
	Network,
	Palette,
	PenLine,
	Puzzle,
	Rocket,
	Scale,
	Search,
	ShieldCheck,
	Sparkles,
	Star,
	Terminal,
	TestTube,
	WandSparkles,
	Workflow,
	Wrench,
	Zap,
	type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { parseAgentIcon } from "./agentIconCodec";

/**
 * 内置图标目录：`id` 落盘进 AgentProfile.icon（`lucide:<id>`），顺序即选择器展示顺序。
 * 新增/替换图标只改这一处；删除某个 id 时旧数据会回退成机器人图标，不会报错。
 */
const AGENT_ICON_LUCIDE_MAP: Record<string, LucideIcon> = {
	bot: Bot,
	sparkles: Sparkles,
	brain: Brain,
	rocket: Rocket,
	zap: Zap,
	flame: Flame,
	star: Star,
	heart: Heart,
	lightbulb: Lightbulb,
	compass: Compass,
	palette: Palette,
	pen: PenLine,
	code: Code,
	terminal: Terminal,
	bug: Bug,
	wrench: Wrench,
	cpu: Cpu,
	database: Database,
	network: Network,
	cloud: Cloud,
	flask: FlaskConical,
	test: TestTube,
	microscope: Microscope,
	calculator: Calculator,
	scale: Scale,
	shield: ShieldCheck,
	search: Search,
	book: BookOpen,
	graduation: GraduationCap,
	languages: Languages,
	file: FileText,
	message: MessageSquare,
	megaphone: Megaphone,
	briefcase: Briefcase,
	git: GitBranch,
	workflow: Workflow,
	puzzle: Puzzle,
	wand: WandSparkles,
	camera: Camera,
	music: Music,
	globe: Globe,
	feather: Feather,
	aperture: Aperture,
};

/** 选择器用：按目录顺序给出 id。 */
export const AGENT_ICON_LUCIDE_IDS: readonly string[] = Object.keys(AGENT_ICON_LUCIDE_MAP);

/**
 * 智能体图标的统一渲染：emoji 走文本、内置图标走 lucide 组件、空/未知 id 回退机器人图标。
 * 尺寸用 `1em` 跟随调用方字号，替换原来直接渲染字符串的写法后各上下文大小不变。
 */
export function AgentIcon({ icon, className }: { icon: string; className?: string }) {
	const parsed = parseAgentIcon(icon);
	if (parsed.kind === "lucide") {
		const Icon = AGENT_ICON_LUCIDE_MAP[parsed.id];
		if (Icon) return <Icon className={cn("size-[1em]", className)} aria-hidden="true" />;
	}
	if (parsed.kind === "text") {
		return (
			<span className={className} aria-hidden="true">
				{parsed.text}
			</span>
		);
	}
	return <Bot className={cn("size-[1em] text-muted-foreground", className)} aria-hidden="true" />;
}
