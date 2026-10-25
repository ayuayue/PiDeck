/**
 * 渲染层 Shiki 精细 bundle。
 *
 * 顶层 `shiki` 默认 full（346 种语言），会把整份 `@shikijs/langs` 打进 renderer。
 * `@streamdown/code` 与 `@pierre/diffs` 都 `from "shiki"` 拉这份 full bundle，
 * 只改 agent-code 的 langs 白名单不够。Vite 把裸导入 `shiki` 精确指到本文件
 *（`/^shiki$/`，不碰 `shiki/core` / `shiki/wasm` / `shiki/engine/*`）。
 *
 * 语言 = web 常用集 + 编码会话常见 extras（diff/go/rust/docker/…）。
 * 导出名对齐 shiki 4 的 `bundle/web`：`createBundledHighlighter` 来自 `shiki/core`，
 * 不要用顶层 `@shikijs/core@2` 的旧拼写。
 */
import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages, type DynamicImportLanguageRegistration, type HighlighterGeneric } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledThemes, bundledThemesInfo } from "shiki/themes";

type LangInfo = {
	id: string;
	name: string;
	aliases?: string[];
	/** 必须走 shiki 4 的动态 grammar loader；顶层 `@shikijs/types@2` 没有同名契约。 */
	import: DynamicImportLanguageRegistration;
};

/** web 常用语言（对齐 shiki/bundle/web），动态 import 让 Rollup 按需拆 chunk。 */
const webLanguagesInfo: LangInfo[] = [
	{ id: "angular-html", name: "Angular HTML", import: () => import("@shikijs/langs/angular-html") },
	{ id: "angular-ts", name: "Angular TypeScript", import: () => import("@shikijs/langs/angular-ts") },
	{ id: "astro", name: "Astro", import: () => import("@shikijs/langs/astro") },
	{ id: "blade", name: "Blade", import: () => import("@shikijs/langs/blade") },
	{ id: "c", name: "C", import: () => import("@shikijs/langs/c") },
	{ id: "coffee", name: "CoffeeScript", aliases: ["coffeescript"], import: () => import("@shikijs/langs/coffee") },
	{ id: "cpp", name: "C++", aliases: ["c++"], import: () => import("@shikijs/langs/cpp") },
	{ id: "css", name: "CSS", import: () => import("@shikijs/langs/css") },
	{ id: "csv", name: "CSV", import: () => import("@shikijs/langs/csv") },
	{ id: "glsl", name: "GLSL", import: () => import("@shikijs/langs/glsl") },
	{ id: "graphql", name: "GraphQL", aliases: ["gql"], import: () => import("@shikijs/langs/graphql") },
	{ id: "haml", name: "Ruby Haml", import: () => import("@shikijs/langs/haml") },
	{ id: "handlebars", name: "Handlebars", aliases: ["hbs"], import: () => import("@shikijs/langs/handlebars") },
	{ id: "html", name: "HTML", import: () => import("@shikijs/langs/html") },
	{ id: "html-derivative", name: "HTML (Derivative)", import: () => import("@shikijs/langs/html-derivative") },
	{ id: "http", name: "HTTP", import: () => import("@shikijs/langs/http") },
	{ id: "hurl", name: "Hurl", import: () => import("@shikijs/langs/hurl") },
	{ id: "imba", name: "Imba", import: () => import("@shikijs/langs/imba") },
	{ id: "java", name: "Java", import: () => import("@shikijs/langs/java") },
	{ id: "javascript", name: "JavaScript", aliases: ["js", "cjs", "mjs"], import: () => import("@shikijs/langs/javascript") },
	{ id: "jinja", name: "Jinja", import: () => import("@shikijs/langs/jinja") },
	{ id: "jison", name: "Jison", import: () => import("@shikijs/langs/jison") },
	{ id: "json", name: "JSON", import: () => import("@shikijs/langs/json") },
	{ id: "json5", name: "JSON5", import: () => import("@shikijs/langs/json5") },
	{ id: "jsonc", name: "JSON with Comments", import: () => import("@shikijs/langs/jsonc") },
	{ id: "jsonl", name: "JSON Lines", import: () => import("@shikijs/langs/jsonl") },
	{ id: "jsx", name: "JSX", import: () => import("@shikijs/langs/jsx") },
	{ id: "julia", name: "Julia", aliases: ["jl"], import: () => import("@shikijs/langs/julia") },
	{ id: "less", name: "Less", import: () => import("@shikijs/langs/less") },
	{ id: "markdown", name: "Markdown", aliases: ["md"], import: () => import("@shikijs/langs/markdown") },
	{ id: "marko", name: "Marko", import: () => import("@shikijs/langs/marko") },
	{ id: "mdc", name: "MDC", import: () => import("@shikijs/langs/mdc") },
	{ id: "mdx", name: "MDX", import: () => import("@shikijs/langs/mdx") },
	{ id: "php", name: "PHP", import: () => import("@shikijs/langs/php") },
	{ id: "postcss", name: "PostCSS", import: () => import("@shikijs/langs/postcss") },
	{ id: "pug", name: "Pug", aliases: ["jade"], import: () => import("@shikijs/langs/pug") },
	{ id: "python", name: "Python", aliases: ["py"], import: () => import("@shikijs/langs/python") },
	{ id: "r", name: "R", import: () => import("@shikijs/langs/r") },
	{ id: "regexp", name: "RegExp", aliases: ["regex"], import: () => import("@shikijs/langs/regexp") },
	{ id: "sass", name: "Sass", import: () => import("@shikijs/langs/sass") },
	{ id: "scss", name: "SCSS", import: () => import("@shikijs/langs/scss") },
	{ id: "shellscript", name: "Shell", aliases: ["bash", "sh", "shell", "zsh"], import: () => import("@shikijs/langs/shellscript") },
	{ id: "smithy", name: "Smithy", import: () => import("@shikijs/langs/smithy") },
	{ id: "sql", name: "SQL", import: () => import("@shikijs/langs/sql") },
	{ id: "stylus", name: "Stylus", aliases: ["styl"], import: () => import("@shikijs/langs/stylus") },
	{ id: "svelte", name: "Svelte", import: () => import("@shikijs/langs/svelte") },
	{ id: "ts-tags", name: "TypeScript with Tags", aliases: ["lit"], import: () => import("@shikijs/langs/ts-tags") },
	{ id: "tsx", name: "TSX", import: () => import("@shikijs/langs/tsx") },
	{ id: "typescript", name: "TypeScript", aliases: ["ts", "cts", "mts"], import: () => import("@shikijs/langs/typescript") },
	{ id: "vue", name: "Vue", import: () => import("@shikijs/langs/vue") },
	{ id: "vue-html", name: "Vue HTML", import: () => import("@shikijs/langs/vue-html") },
	{ id: "vue-vine", name: "Vue Vine", import: () => import("@shikijs/langs/vue-vine") },
	{ id: "wasm", name: "WebAssembly", import: () => import("@shikijs/langs/wasm") },
	{ id: "wgsl", name: "WGSL", import: () => import("@shikijs/langs/wgsl") },
	{ id: "wit", name: "WebAssembly Interface Types", import: () => import("@shikijs/langs/wit") },
	{ id: "xml", name: "XML", import: () => import("@shikijs/langs/xml") },
	{ id: "yaml", name: "YAML", aliases: ["yml"], import: () => import("@shikijs/langs/yaml") },
];

/**
 * web bundle 没有、但会话/diff 里常见的语言。
 * 每条必须是静态 `import("@shikijs/langs/…")`：模板字符串会让 Rollup 打进全部 langs。
 */
const extraLanguagesInfo: LangInfo[] = [
	{ id: "cmake", name: "CMake", import: () => import("@shikijs/langs/cmake") },
	{ id: "clojure", name: "Clojure", aliases: ["clj"], import: () => import("@shikijs/langs/clojure") },
	{ id: "csharp", name: "C#", aliases: ["cs"], import: () => import("@shikijs/langs/csharp") },
	{ id: "dart", name: "Dart", import: () => import("@shikijs/langs/dart") },
	{ id: "diff", name: "Diff", import: () => import("@shikijs/langs/diff") },
	{ id: "dockerfile", name: "Dockerfile", aliases: ["docker"], import: () => import("@shikijs/langs/dockerfile") },
	{ id: "elixir", name: "Elixir", import: () => import("@shikijs/langs/elixir") },
	{ id: "erlang", name: "Erlang", aliases: ["erl"], import: () => import("@shikijs/langs/erlang") },
	{ id: "git-commit", name: "Git Commit Message", import: () => import("@shikijs/langs/git-commit") },
	{ id: "git-rebase", name: "Git Rebase Message", import: () => import("@shikijs/langs/git-rebase") },
	{ id: "go", name: "Go", import: () => import("@shikijs/langs/go") },
	{ id: "groovy", name: "Groovy", import: () => import("@shikijs/langs/groovy") },
	{ id: "haskell", name: "Haskell", aliases: ["hs"], import: () => import("@shikijs/langs/haskell") },
	{ id: "hcl", name: "HashiCorp HCL", import: () => import("@shikijs/langs/hcl") },
	{ id: "ini", name: "INI", import: () => import("@shikijs/langs/ini") },
	{ id: "kotlin", name: "Kotlin", aliases: ["kt", "kts"], import: () => import("@shikijs/langs/kotlin") },
	{ id: "lua", name: "Lua", import: () => import("@shikijs/langs/lua") },
	{ id: "makefile", name: "Makefile", aliases: ["make"], import: () => import("@shikijs/langs/makefile") },
	{ id: "nginx", name: "Nginx", import: () => import("@shikijs/langs/nginx") },
	{ id: "objective-c", name: "Objective-C", aliases: ["objc"], import: () => import("@shikijs/langs/objective-c") },
	{ id: "perl", name: "Perl", import: () => import("@shikijs/langs/perl") },
	{ id: "powershell", name: "PowerShell", aliases: ["ps", "ps1", "pwsh"], import: () => import("@shikijs/langs/powershell") },
	{ id: "protobuf", name: "Protocol Buffers", aliases: ["proto"], import: () => import("@shikijs/langs/protobuf") },
	{ id: "rust", name: "Rust", aliases: ["rs"], import: () => import("@shikijs/langs/rust") },
	{ id: "scala", name: "Scala", import: () => import("@shikijs/langs/scala") },
	{ id: "ssh-config", name: "SSH Config", import: () => import("@shikijs/langs/ssh-config") },
	{ id: "swift", name: "Swift", import: () => import("@shikijs/langs/swift") },
	{ id: "toml", name: "TOML", import: () => import("@shikijs/langs/toml") },
	{ id: "zig", name: "Zig", import: () => import("@shikijs/langs/zig") },
];

export const bundledLanguagesInfo: LangInfo[] = [...webLanguagesInfo, ...extraLanguagesInfo];

const bundledLanguagesBase = Object.fromEntries(bundledLanguagesInfo.map((item) => [item.id, item.import]));
const bundledLanguagesAlias = Object.fromEntries(bundledLanguagesInfo.flatMap((item) => (item.aliases ?? []).map((alias) => [alias, item.import])));
export const bundledLanguages = {
	...bundledLanguagesBase,
	...bundledLanguagesAlias,
};

export { bundledLanguagesAlias, bundledLanguagesBase, bundledThemes, bundledThemesInfo };

export const createHighlighter = createBundledHighlighter({
	langs: bundledLanguages,
	themes: bundledThemes,
	engine: () => createOnigurumaEngine(import("shiki/wasm")),
});

const shorthands = createSingletonShorthands(createHighlighter, { guessEmbeddedLanguages });
export const { codeToHtml, codeToHast, codeToTokensBase, codeToTokens, codeToTokensWithThemes, getSingletonHighlighter, getLastGrammarState } = shorthands;

export type BundledLanguage = string;
export type Highlighter = HighlighterGeneric<string, string>;

// @pierre/diffs / @streamdown/code 只从裸 `shiki` 取 highlighter、语言表和两个引擎。
// 不要 `export * from "shiki/core"`：core 的 codeToHtml 会和上面的 shorthand 撞名。
export { createJavaScriptRegexEngine, createOnigurumaEngine };
