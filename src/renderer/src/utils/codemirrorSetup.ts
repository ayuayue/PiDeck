import { StreamLanguage, HighlightStyle, syntaxHighlighting, type Language, type LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// 官方语言包：常用语言用 Lezer 解析器，高亮质量与折叠能力最好。
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { sass } from "@codemirror/lang-sass";
import { less } from "@codemirror/lang-less";
import { html } from "@codemirror/lang-html";
import { yaml } from "@codemirror/lang-yaml";
import { xml } from "@codemirror/lang-xml";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { sql } from "@codemirror/lang-sql";

// legacy-modes：冷门语言用经典 CodeMirror 5 模式（StreamLanguage 包装）。
// 官方 Lezer 包没有 shell/ruby/toml/dockerfile 等，legacy-modes 一个包覆盖，避免引入多个社区包。
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { ruby as rubyMode } from "@codemirror/legacy-modes/mode/ruby";
import { dockerFile as dockerfileMode } from "@codemirror/legacy-modes/mode/dockerfile";
import { protobuf as protobufMode } from "@codemirror/legacy-modes/mode/protobuf";
import { toml as tomlMode } from "@codemirror/legacy-modes/mode/toml";
import { properties as propertiesMode } from "@codemirror/legacy-modes/mode/properties";

const shell = StreamLanguage.define(shellMode);
const ruby = StreamLanguage.define(rubyMode);
const dockerfile = StreamLanguage.define(dockerfileMode);
const protobuf = StreamLanguage.define(protobufMode);
const toml = StreamLanguage.define(tomlMode);
const properties = StreamLanguage.define(propertiesMode);

/** 语言包类型：官方包返回 LanguageSupport，legacy-modes 的 StreamLanguage 返回 Language，
 * 两者都能直接作为 extension 安装，统一用联合类型避免各自强转。 */
export type EditorLanguage = Language | LanguageSupport;

/** 扩展名 → 语言。null 表示无对应模式（降级纯文本）。
 * 说明：graphql/makefile/dotenv 等冷门类型无官方/稳定包，先降级 plaintext，
 * 后续需要时再补社区包（如 codemirror-lang-graphql）。 */
const EXT_LANGUAGES: Record<string, EditorLanguage | null> = {
  ts: javascript({ typescript: true }), tsx: javascript({ jsx: true, typescript: true }),
  js: javascript(), jsx: javascript({ jsx: true }), mjs: javascript(), cjs: javascript(),
  json: json(), jsonc: json(),
  md: markdown(), mdx: markdown(),
  css: css(), scss: sass({ indented: false }), less: less(),
  html: html(), htm: html(),
  yaml: yaml(), yml: yaml(),
  xml: xml(), svg: xml(),
  sh: shell, bash: shell, zsh: shell,
  py: python(), rb: ruby,
  go: go(), rs: rust(), java: java(),
  c: cpp(), "c++": cpp(), cpp: cpp(), h: cpp(), hpp: cpp(),
  sql: sql(), proto: protobuf,
  toml: toml, ini: properties, cfg: properties, env: properties,
  dockerfile: dockerfile, makefile: null,
  graphql: null, gql: null,
};

/** 旧 Monaco 语言 id 兼容表：历史调用点可能传 "markdown"/"typescript" 等 id。 */
const ID_LANGUAGES: Record<string, EditorLanguage | null> = {
  markdown: markdown(), typescript: javascript({ typescript: true }), javascript: javascript(),
  json: json(), css: css(), scss: sass({ indented: false }), less: less(),
  html: html(), yaml: yaml(), xml: xml(), shell: shell,
  python: python(), ruby: ruby, go: go(), rust: rust(), java: java(),
  cpp: cpp(), c: cpp(), sql: sql(), plaintext: null,
};

/** 解析编辑器语言：优先按扩展名，再按语言 id，最后降级纯文本（null）。 */
export function resolveEditorLanguage(input?: string): EditorLanguage | null {
  if (!input) return null;
  const ext = input.trim().toLowerCase();
  if (ext in EXT_LANGUAGES) return EXT_LANGUAGES[ext] ?? null;
  if (ext in ID_LANGUAGES) return ID_LANGUAGES[ext] ?? null;
  return null;
}

/** 编辑器 UI 主题：全部引用应用 CSS 变量，随 data-theme 明暗自动切换，
 * 与侧栏/弹框等 shadcn token 保持一致，不写死色值。 */
const editorThemeSpec = {
  "&": {
    backgroundColor: "var(--color-bg-panel)",
    color: "var(--color-text-primary)",
    fontSize: "13px",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-family-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--color-accent)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--color-accent-soft)",
  },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--color-text-tertiary)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--color-bg-active)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--color-bg-active)", color: "var(--color-text-primary)" },
  ".cm-foldGutter .cm-gutterElement": { cursor: "pointer" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--color-bg-muted)", border: "none", color: "var(--color-text-tertiary)" },
  ".cm-tooltip": { backgroundColor: "var(--color-bg-panel)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-sm)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--color-bg-active)", color: "var(--color-text-primary)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { color: "var(--color-text-secondary)" },
  ".cm-searchMatch": { backgroundColor: "var(--color-accent-soft)", outline: "1px solid var(--color-accent-strong)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--color-accent)", color: "var(--color-text-inverse)" },
  ".cm-panels": { backgroundColor: "var(--color-bg-panel)", color: "var(--color-text-primary)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-border-subtle)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-border-subtle)" },
  ".cm-button": { backgroundImage: "none", background: "var(--color-bg-muted)", border: "1px solid var(--color-border-default)", borderRadius: "var(--radius-sm)", color: "var(--color-text-primary)" },
  ".cm-textfield": { background: "var(--color-bg-input)", border: "1px solid var(--color-border-default)", borderRadius: "var(--radius-sm)", color: "var(--color-text-primary)" },
  ".cm-selectionMatch": { backgroundColor: "var(--color-accent-soft)" },
  ".cm-mergeView": { height: "100%", overflow: "auto", backgroundColor: "var(--color-bg-panel)" },
  ".cm-mergeView .cm-merge-pane": { backgroundColor: "var(--color-bg-panel)" },
  ".cm-mergeView .cm-merge-gap": { backgroundColor: "var(--color-bg-muted)" },
  ".cm-mergeView .cm-merge-chunk": { backgroundColor: "var(--color-accent-soft)" },
  ".cm-mergeView .cm-merge-chunk.cm-merge-chunk-start, .cm-mergeView .cm-merge-chunk.cm-merge-chunk-end": { backgroundColor: "var(--color-bg-active)" },
  ".cm-mergeView .cm-merge-chunk-vertical": { background: "var(--color-bg-active)" },
  ".cm-mergeView .cm-merge-collapsed": { background: "var(--color-bg-muted)", color: "var(--color-text-tertiary)", cursor: "pointer" },
  ".cm-mergeView .cm-merge-collapsed-widget": { background: "var(--color-bg-muted)", color: "var(--color-text-tertiary)", border: "1px dashed var(--color-border-strong)", borderRadius: "var(--radius-sm)", cursor: "pointer" },
} as const;

export const editorTheme = EditorView.theme(editorThemeSpec, {
  dark: typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark",
});

/** 语法高亮配色：引用 --code-* CSS 变量（styles/ 里按 data-theme 定义明暗两套），
 * 高亮颜色随应用主题联动。 */
export const editorHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
  { tag: [t.comment, t.blockComment, t.lineComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.number, t.integer, t.float], color: "var(--code-number)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--code-variable)" },
  { tag: [t.typeName, t.className, t.definition(t.typeName)], color: "var(--code-type)" },
  { tag: [t.function(t.variableName), t.definition(t.function(t.variableName)), t.function(t.propertyName)], color: "var(--code-function)" },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator], color: "var(--code-operator)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--code-constant)" },
  { tag: [t.regexp, t.escape], color: "var(--code-string)" },
  { tag: [t.heading, t.strong], color: "var(--code-keyword)", fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--code-string)", textDecoration: "underline" },
  { tag: [t.quote, t.emphasis], color: "var(--code-comment)" },
  { tag: [t.meta, t.annotation, t.invalid], color: "var(--code-operator)" },
  { tag: t.invalid, textDecoration: "underline wavy var(--color-danger)" },
]);

/** 供 CodemirrorEditor 组合基础扩展：行号/折叠/历史/补全/查找/括号匹配等，
 * 等价于 Monaco 常用 options 集合（minimap 不需要，CM6 无此概念）。 */
export function baseEditorExtensions(opts: {
  readOnly?: boolean;
  wordWrap?: boolean;
  language?: EditorLanguage | null;
} = {}) {
  const { readOnly = false, wordWrap = false, language } = opts;
  return [
    editorTheme,
    syntaxHighlighting(editorHighlightStyle, { fallback: true }),
    ...(wordWrap ? [EditorView.lineWrapping] : []),
    ...(language ? [language] : []),
    ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
  ];
}
