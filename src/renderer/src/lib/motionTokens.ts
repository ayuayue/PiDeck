/**
 * JS 侧动效 token 孪生：唯一真源在 styles/tailwind.css（@utility duration-* 与
 * --ease-out-quint）。Web Animations API（el.animate）等拿不到 CSS utility 的场景
 * 从这里取值；与 tailwind.css 的数值同步由 tests/motionTokenDiscipline.test.mjs
 * 钉住（改一处不改另一处会红灯）。
 *
 * 注意与 lib/ease.ts 的分工：ease.ts 是 beUI 官方曲线（motion/react 组件族使用，
 * 禁止私改）；本模块镜像的是仓库自己的 CSS token 体系（tw-animate/transition 用），
 * 两套各自内部一致，不互相改写。
 */

/** 微反馈（hover/active）。 */
export const DURATION_FAST_MS = 120;

/** 常规（弹层/展开）。 */
export const DURATION_BASE_MS = 200;

/** 面板级（切会话/抽屉）。 */
export const DURATION_SLOW_MS = 320;

/** 进场曲线，与 tailwind.css --ease-out-quint 同值。 */
export const EASE_OUT_QUINT_CSS = "cubic-bezier(0.22, 1, 0.36, 1)";
