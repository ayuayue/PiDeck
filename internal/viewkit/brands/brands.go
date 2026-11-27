// Package brands draws the mark of the AI provider, model or agent behind a
// name, so a list of names reads as a list of brands. It also holds the
// marks of the editors the app opens files with, for the menu that picks
// one.
//
// The marks are the monochrome variants of the AI Logo collection, copied
// unmodified into svg/: plain paths in currentColor, so one set serves both
// themes and both hosts, and a mark takes the color of the row it draws in.
// A name the set does not know draws nothing, which keeps a row's alignment
// whether or not its brand is known.
//
// The names come from outside the app — pi's provider ids, ACP preset ids, a
// model's own id — so lookup is aliases first, then an exact file, then a
// family prefix. See LICENSE and NOTICE.md: the marks are MIT-licensed
// trademarks of their owners, used only to identify them.
package brands

import (
	"embed"
	"strings"
	"sync"

	"github.com/nsgo-dev/nsgo/core"
)

//go:embed svg
var files embed.FS

// marks caches a parse, a miss included: a name costs one file read in the
// life of the process, not one per row.
var marks sync.Map // map[string]*core.SVG, nil for a name with no file

// aliases are the names the set files under another mark: what providers and
// CLIs call themselves, and the vendor behind a family.
var aliases = map[string]string{
	"google":            "gemini",   // pi's Google provider
	"google-vertex":     "vertexai", // its Vertex sibling
	"amazon-bedrock":    "bedrock",
	"github-copilot":    "copilot",
	"copilot-cli":       "copilot",
	"vercel-ai-gateway": "vercel",
	"claude-agent":      "claudecode",
	"codex-cli":         "codex",
	"cursor-agent":      "cursor",
	"cline-cli":         "cline",
	"kilo":              "kilocode",
	"dsh":               "deepseek", // DeepSeek's ACP harness
	"mimo":              "xiaomimimo",
	"chatglm":           "zhipu",
	"bigmodel":          "zhipu",
	"glm":               "zai",
	"tencent":           "tencentcloud",
	"lm-studio":         "lmstudio",
	"meta-llama":        "meta",
	"ant":               "antgroup",
}

// prefixes resolve the ids a provider suffixes for its own plans and regions,
// such as "qwen-token-plan-cn" or "zai-coding-cn".
var prefixes = []struct{ prefix, mark string }{
	{"qwen", "qwen"},
	{"zai", "zai"},
	{"moonshotai", "moonshot"},
	{"kimi", "kimi"},
	{"minimax", "minimax"},
	{"xiaomi", "xiaomi"},
	{"cloudflare", "cloudflare"},
	{"opencode", "opencode"},
	{"vertex", "vertexai"},
}

// families are the model names whose mark is their maker's however the model
// is routed: a Claude model is Claude's under any reseller.
var families = []struct{ prefix, mark string }{
	{"claude", "claude"},
	{"sonnet", "claude"},
	{"opus", "claude"},
	{"haiku", "claude"},
	{"gpt", "openai"},
	{"chatgpt", "openai"},
	{"codex", "codex"},
	{"o1", "openai"},
	{"o3", "openai"},
	{"o4", "openai"},
	{"gemini", "gemini"},
	{"gemma", "gemma"},
	{"deepseek", "deepseek"},
	{"qwen", "qwen"},
	{"qwq", "qwen"},
	{"kimi", "kimi"},
	{"moonshot", "moonshot"},
	{"glm", "zai"},
	{"grok", "xai"},
	{"mistral", "mistral"},
	{"codestral", "mistral"},
	{"devstral", "mistral"},
	{"magistral", "mistral"},
	{"ministral", "mistral"},
	{"llama", "meta"},
	{"nemotron", "nvidia"},
	{"minimax", "minimax"},
	{"doubao", "doubao"},
	{"ernie", "baidu"},
	{"mimo", "xiaomimimo"},
}

// ID is the mark that stands for hint — a provider id, an ACP preset id, a
// vendor's name — with the aliases above resolved. It is "" when the set has
// no mark for it, which callers treat as "draw nothing".
func ID(hint string) string {
	name := strings.ToLower(strings.TrimSpace(hint))
	if name == "" {
		return ""
	}
	if mark, ok := aliases[name]; ok {
		return mark
	}
	if slug(name) && lookup(name) != nil {
		return name
	}
	for _, item := range prefixes {
		if strings.HasPrefix(name, item.prefix) && lookup(item.mark) != nil {
			return item.mark
		}
	}
	return ""
}

// Model is the mark that stands for a model: its family first, so a
// "claude-sonnet-4" answers with Claude's mark however it is routed, then its
// provider's. It is "" when neither is known.
func Model(model, provider string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	for _, item := range families {
		if strings.HasPrefix(name, item.prefix) && lookup(item.mark) != nil {
			return item.mark
		}
	}
	return ID(provider)
}

// SVG is the mark hint resolves to as a drawing, or nil when the set has
// none: a caller that puts it in its own row keeps the row's alignment.
func SVG(hint string) *core.SVG { return lookup(ID(hint)) }

// Mark draws the mark hint resolves to, size points square in tint, or nothing
// when the set has no such mark.
func Mark(hint string, size core.Points, tint func() core.Color) core.Node {
	svg := lookup(ID(hint))
	if svg == nil {
		return nil
	}
	return core.Icon{SVG: svg, Style: core.Style{Width: core.Pt(size), Height: core.Pt(size)},
		StyleFunc: func() core.Style { return core.Style{Color: tint()} }}
}

// lookup parses one mark file, once. A missing or unparsable file is nil: a
// mark the collection does not draw is a row without a picture, not an error
// the app has to handle while rendering.
func lookup(id string) *core.SVG {
	if value, ok := marks.Load(id); ok {
		return value.(*core.SVG)
	}
	var svg *core.SVG
	if slug(id) {
		if data, err := files.ReadFile("svg/" + id + ".svg"); err == nil {
			svg, _ = core.ParseSVG(data)
		}
	}
	actual, _ := marks.LoadOrStore(id, svg)
	return actual.(*core.SVG)
}

// slug guards the file name: the embedded tree holds nothing else, and an id
// from outside the app may not reach past it.
func slug(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if r != '-' && (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}
