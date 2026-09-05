import { useId } from "react";
import type { AgentBackend, SessionSource } from "../../../../shared/types";
import { ImageIcon } from "lucide-react";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Badge } from "../ui-shadcn/badge";

const SOURCE_LABELS: Record<SessionSource, string> = {
  pi: t("sessionSource.pi"),
  codex: t("sessionSource.codex"),
  claude: t("sessionSource.claude"),
  opencode: t("sessionSource.opencode"),
  zcode: t("sessionSource.zcode"),
};

const SOURCE_TONES: Record<SessionSource, string> = {
  pi: "border-cyan-300/70 text-cyan-700 dark:border-cyan-700/70 dark:text-cyan-300",
  codex: "border-indigo-300/70 text-indigo-700 dark:border-indigo-700/70 dark:text-indigo-300",
  claude: "border-amber-300/70 text-amber-700 dark:border-amber-700/70 dark:text-amber-300",
  // opencode 官方品牌为黑白单色，不用品牌色（避免绿色观感）；中性灰随主题自适应
  opencode: "border-muted-foreground/40 text-muted-foreground",
  // zcode（z.ai CLI）无公开品牌图形资源，用中性色 + 自绘 Z 标记，避免错误品牌色
  zcode: "border-muted-foreground/40 text-muted-foreground",
};

function SourceLogo(props: { source: SessionSource }) {
  // 品牌路径内联到渲染层，保证离线会话列表也能显示 Logo，不依赖远程图片或字体资源。
  if (props.source === "codex") {
    return (
      <svg viewBox="0 0 256 260" className="size-3.5" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z"
        />
      </svg>
    );
  }

  if (props.source === "claude") {
    return (
      <svg viewBox="0 0 256 176" className="size-3.5" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="m147.487 0 70.081 175.78H256L185.919 0zM66.183 106.221l23.98-61.774 23.98 61.774zM70.07 0 0 175.78h39.18l14.33-36.914h73.308l14.328 36.914h39.179L110.255 0z"
        />
      </svg>
    );
  }

  if (props.source === "opencode") {
    return (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
      </svg>
    );
  }

  if (props.source === "zcode") {
    // z.ai ZCode 无公开品牌 SVG，用等宽「Z」字形作为可辨识标记；
    // 与 opencode 一样走中性色，名称经 title/aria-label 保留。
    return (
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M4 3h16v3.2L10.8 16H20v5H4v-3.2L13.2 8H4z" />
      </svg>
    );
  }

  return (
    <svg viewBox="140 140 520 520" className="size-3.5" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400v117.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

/** pi 官方 logo（品牌窗口标记，来源徽章同款）。 */
export function PiLogo(props: { className?: string }) {
  return (
    <svg viewBox="140 140 520 520" className={props.className ?? "size-3.5"} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400v117.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

/** DSH 官方 logo（DeepSeek 鲸鱼，取自 @deepseek-ai/dsh-web-frontend favicon.svg）。 */
export function DshLogo(props: { className?: string }) {
  return (
    <svg viewBox="0 0 50 50" className={props.className ?? "size-3.5"} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="nonzero"
        d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"
      />
    </svg>
  );
}

/**
 * Agent 预设官方 logo（三个圆点绕环，取自 dsh-web 的 IconAgentPresetOutline16）。
 * mask 用 useId 保证多实例不冲突。
 */
export function AgentPresetLogo(props: { className?: string }) {
  const maskId = useId();
  return (
    <svg viewBox="0 0 16 16" className={props.className ?? "size-3.5"} aria-hidden="true" focusable="false">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="white" />
          <circle cx="7.9995" cy="3.28319" r="1.712" fill="black" />
          <circle cx="3.51122" cy="11.3855" r="1.712" fill="black" />
          <circle cx="12.4878" cy="11.3855" r="1.712" fill="black" />
        </mask>
      </defs>
      <path
        mask={`url(#${maskId})`}
        fill="currentColor"
        d="M12.2881 11.0425C12.6002 11.3723 13.0413 11.5786 13.5312 11.5786L13.5342 11.5776C13.1476 12.3233 12.6119 12.9785 11.9639 13.5005C10.9327 14.3309 9.6199 14.8286 8.19336 14.8286C7.29864 14.8285 6.45056 14.6313 5.6875 14.2808C6.08309 14.0281 6.36707 13.6189 6.45215 13.1392C6.99022 13.3561 7.57767 13.476 8.19336 13.4761C9.30019 13.4761 10.3157 13.0915 11.1152 12.4478C11.5935 12.0626 11.9924 11.5848 12.2881 11.0425ZM4.14746 4.36475C4.25569 4.83228 4.55488 5.2247 4.95898 5.4585C4.07956 6.30639 3.53144 7.49605 3.53125 8.81396C3.53125 9.69534 3.77613 10.5202 4.20117 11.2231C3.74959 11.3817 3.38395 11.7232 3.19531 12.1597C2.5541 11.2032 2.17969 10.052 2.17969 8.81396C2.17989 7.05087 2.93868 5.4646 4.14746 4.36475ZM8.19336 2.80029C8.85717 2.80029 9.49784 2.90834 10.0967 3.10791C12.3237 3.85044 13.9725 5.86061 14.1846 8.28369C13.9832 8.20048 13.7627 8.15382 13.5312 8.15381C13.2802 8.15381 13.042 8.20907 12.8271 8.30615C12.6281 6.47264 11.3666 4.95616 9.66895 4.39014C9.2063 4.236 8.70989 4.15186 8.19336 4.15186C7.96112 4.15189 7.7329 4.16981 7.50977 4.20264C7.51947 4.12886 7.52637 4.05348 7.52637 3.97705C7.52628 3.56604 7.3811 3.18914 7.13965 2.89404C7.48183 2.83352 7.83381 2.80033 8.19336 2.80029Z"
      />
      <path
        fill="currentColor"
        d="M9.1123 3.28271C9.11205 2.66858 8.61322 2.17041 7.99902 2.17041C7.38504 2.17067 6.88697 2.66874 6.88672 3.28271C6.88672 3.89691 7.38489 4.39574 7.99902 4.396C8.61338 4.396 9.1123 3.89707 9.1123 3.28271ZM10.3115 3.28271C10.3115 4.55981 9.27612 5.59521 7.99902 5.59521C6.72214 5.59496 5.6875 4.55965 5.6875 3.28271C5.68776 2.00599 6.7223 0.971447 7.99902 0.971191C9.27596 0.971191 10.3113 2.00584 10.3115 3.28271Z"
      />
      <path
        fill="currentColor"
        d="M4.62402 11.385C4.62377 10.7709 4.12494 10.2727 3.51074 10.2727C2.89676 10.273 2.39869 10.771 2.39844 11.385C2.39844 11.9992 2.89661 12.498 3.51074 12.4983C4.1251 12.4983 4.62402 11.9994 4.62402 11.385ZM5.82324 11.385C5.82324 12.6621 4.78784 13.6975 3.51074 13.6975C2.23386 13.6973 1.19922 12.6619 1.19922 11.385C1.19947 10.1083 2.23402 9.07374 3.51074 9.07349C4.78768 9.07349 5.82299 10.1081 5.82324 11.385Z"
      />
      <path
        fill="currentColor"
        d="M13.6006 11.385C13.6003 10.7709 13.1015 10.2727 12.4873 10.2727C11.8733 10.273 11.3753 10.771 11.375 11.385C11.375 11.9992 11.8732 12.498 12.4873 12.4983C13.1017 12.4983 13.6006 11.9994 13.6006 11.385ZM14.7998 11.385C14.7998 12.6621 13.7644 13.6975 12.4873 13.6975C11.2104 13.6973 10.1758 12.6619 10.1758 11.385C10.176 10.1083 11.2106 9.07374 12.4873 9.07349C13.7642 9.07349 14.7995 10.1081 14.7998 11.385Z"
      />
    </svg>
  );
}

/** 后端文本标记：DSH=短文本；生图=图片图标+短文本/仅图标，避免与来源徽标重复。 */
export function SessionBackendBadge(props: { backend?: AgentBackend; className?: string }) {
  const backend = props.backend ?? "dsh";
  const isImageGen = backend === "imagegen";
  const label = isImageGen ? t("sessionBackend.imagegen") : t("sessionBackend.dsh");
  return (
    <Badge
      variant="outline"
      aria-label={label}
      title={label}
      data-backend={backend}
      className={cn(
        "h-4 rounded px-1 text-[9px] font-semibold leading-none tracking-wide",
        isImageGen
          ? "border-violet-300/70 text-violet-700 dark:border-violet-700/70 dark:text-violet-300"
          : "border-muted-foreground/40 text-muted-foreground",
        props.className,
      )}
    >
      {isImageGen && <ImageIcon className="mr-0.5 size-2.5" aria-hidden="true" />}
      {label}
    </Badge>
  );
}

/**
 * 后端标识统一入口：Pi 是默认运行时，不额外显示 logo；只有非默认后端需要提示用户。
 * 这样保留来源信息的同时，避免每个普通 Pi 会话都增加一个视觉噪点。
 */
export function SessionBackendMark(props: { backend?: AgentBackend; className?: string }) {
  if (props.backend === "dsh" || props.backend === "imagegen") {
    return <SessionBackendBadge backend={props.backend} className={props.className} />;
  }
  return null;
}

/**
 * 统一渲染会话来源标记：Badge 只承载品牌 Logo，不显示文字；名称通过 title 和 aria-label
 * 保留给悬停提示及辅助技术，避免用户无法区分相似 Logo。
 */
export function SessionSourceBadge(props: {
  source: SessionSource;
  label?: string;
  className?: string;
}) {
  const label = props.label ?? SOURCE_LABELS[props.source];
  return (
    <Badge
      variant="outline"
      aria-label={label}
      title={label}
      data-source={props.source}
      className={cn(
        "size-5 rounded-md p-0",
        SOURCE_TONES[props.source],
        props.className,
      )}
    >
      <SourceLogo source={props.source} />
    </Badge>
  );
}

/**
 * 生图过滤徽标（来源过滤菜单用）：与来源徽标同款描边徽标，但用图片图标而非品牌 logo，
 * 因为是独立后端而非品牌来源；tone 取紫色与 pi/dsh 区分。
 */
export function ImageGenSourceBadge(props: { className?: string }) {
  const label = t("sessionBackend.imagegen");
  return (
    <Badge
      variant="outline"
      aria-label={label}
      title={label}
      data-source="imagegen"
      className={cn(
        "size-5 rounded-md p-0 border-violet-300/70 text-violet-700 dark:border-violet-700/70 dark:text-violet-300",
        props.className,
      )}
    >
      <ImageIcon className="size-3" aria-hidden="true" />
    </Badge>
  );
}
export function DshSourceBadge(props: { className?: string }) {
  const label = t("sessionBackend.dsh");
  return (
    <Badge
      variant="outline"
      aria-label={label}
      title={label}
      data-source="dsh"
      className={cn(
        "size-5 rounded-md p-0 border-sky-300/70 text-sky-700 dark:border-sky-700/70 dark:text-sky-300",
        props.className,
      )}
    >
      <DshLogo />
    </Badge>
  );
}
