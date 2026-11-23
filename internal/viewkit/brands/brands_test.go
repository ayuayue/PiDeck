package brands

import (
	"io/fs"
	"strings"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
)

// TestEveryMarkParses is the vendor guard: a mark NSGo cannot read would draw
// nothing in the app, and nothing here would say so.
func TestEveryMarkParses(t *testing.T) {
	entries, err := fs.ReadDir(files, "svg")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 40 {
		t.Fatalf("the mark set holds %d files, want the full curated set", len(entries))
	}
	for _, entry := range entries {
		data, err := files.ReadFile("svg/" + entry.Name())
		if err != nil {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		if svg, err := core.ParseSVG(data); err != nil || svg == nil {
			t.Errorf("%s: NSGo cannot parse it: %v", entry.Name(), err)
		}
		// NSGo's SVG reader draws no mask and no filter, so a mark that needs
		// one would render as something other than the brand.
		body := strings.ToLower(string(data))
		for _, unsupported := range []string{"<mask", "<filter", "<image"} {
			if strings.Contains(body, unsupported) {
				t.Errorf("%s: uses %s, which NSGo does not draw", entry.Name(), unsupported)
			}
		}
	}
}

// TestAliasesResolve keeps the tables honest: an alias or a family pointing at
// a mark that is not vendored is a name that silently keeps its lucide icon.
func TestAliasesResolve(t *testing.T) {
	for name, mark := range aliases {
		if lookup(mark) == nil {
			t.Errorf("alias %q points at %q, which is not vendored", name, mark)
		}
	}
	for _, item := range prefixes {
		if lookup(item.mark) == nil {
			t.Errorf("prefix %q points at %q, which is not vendored", item.prefix, item.mark)
		}
	}
	for _, item := range families {
		if lookup(item.mark) == nil {
			t.Errorf("family %q points at %q, which is not vendored", item.prefix, item.mark)
		}
	}
}

func TestID(t *testing.T) {
	cases := []struct{ hint, want string }{
		{"openai", "openai"},
		{" OpenAI ", "openai"},
		{"anthropic", "anthropic"},
		{"google", "gemini"},
		{"google-vertex", "vertexai"},
		{"amazon-bedrock", "bedrock"},
		{"qwen-token-plan-cn", "qwen"},
		{"zai-coding-cn", "zai"},
		{"moonshotai-cn", "moonshot"},
		{"xiaomi-token-plan-ams", "xiaomi"},
		{"cursor-agent", "cursor"},
		{"dsh", "deepseek"},
		{"mimo", "xiaomimimo"},
		{"", ""},
		{"nonesuch", ""},
		{"../../etc/passwd", ""},
	}
	for _, c := range cases {
		if got := ID(c.hint); got != c.want {
			t.Errorf("ID(%q) = %q, want %q", c.hint, got, c.want)
		}
	}
}

// TestModelFamilyIsTheMaker pins the ordering: a Claude model routed through a
// reseller keeps Claude's mark, and only a model no family claims falls back to
// its provider's.
func TestModelFamilyIsTheMaker(t *testing.T) {
	cases := []struct{ model, provider, want string }{
		{"claude-sonnet-4-5", "openrouter", "claude"},
		{"anthropic/claude-opus-4-6", "openrouter", "claude"},
		{"sonnet-4-5", "anthropic", "claude"},
		{"gpt-5-codex", "openai", "openai"},
		{"codex-mini", "openai-codex", "codex"},
		{"gemini-2.5-pro", "google", "gemini"},
		{"meta-llama/llama-3.1-70b", "nvidia", "meta"},
		{"glm-4.7", "zai", "zai"},
		{"kimi-k2.7-code", "moonshotai-cn", "kimi"},
		{"qwen3-coder", "qwen-token-plan", "qwen"},
		{"some-custom-model", "mistral", "mistral"},
		{"some-custom-model", "nonesuch", ""},
	}
	for _, c := range cases {
		if got := Model(c.model, c.provider); got != c.want {
			t.Errorf("Model(%q, %q) = %q, want %q", c.model, c.provider, got, c.want)
		}
	}
}

// TestMarkDrawsNothingForUnknown keeps a row's alignment: a name without a
// brand returns no node at all, so nothing takes the mark's width.
func TestMarkDrawsNothingForUnknown(t *testing.T) {
	if node := Mark("nonesuch", 13, func() core.Color { return 0 }); node != nil {
		t.Fatalf("an unknown mark drew %T", node)
	}
	node, ok := Mark("openai", 13, func() core.Color { return 0 }).(core.Icon)
	if !ok {
		t.Fatalf("a known mark did not draw an icon")
	}
	if node.SVG == nil || node.Style.Width != core.Pt(13) {
		t.Fatalf("icon = %+v, want 13 points of openai", node)
	}
}
