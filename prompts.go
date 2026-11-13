package main

// The prompt library: a folder of JSON or YAML packs the app seeds once
// with a starter set. A prompt is inserted into the composer; the library
// is read again when it opens, so a hand-edited pack shows up at once.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/oneo-me/nsgo/ui"
	"go.yaml.in/yaml/v3"
)

//go:embed assets/prompts/starter.json
var starterPrompts []byte

// promptItem is one prompt in the library.
type promptItem struct {
	ID       string
	Title    string
	Body     string
	Category string
	Tags     []string
	Source   string
}

// promptPack is one file's prompts.
type promptPack struct {
	Name    string `yaml:"name" json:"name"`
	Prompts []struct {
		Title    string   `yaml:"title" json:"title"`
		Body     string   `yaml:"body" json:"body"`
		Category string   `yaml:"category" json:"category"`
		Tags     []string `yaml:"tags" json:"tags"`
	} `yaml:"prompts" json:"prompts"`
}

// promptsDir is the folder the library lives in.
func (a *app) promptsDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "prompts")
}

// ensurePromptLibrary seeds the starter pack the first time only: after
// that the folder is the user's.
func (a *app) ensurePromptLibrary() {
	dir := a.promptsDir()
	if dir == "" {
		return
	}
	if _, err := os.Stat(dir); err == nil {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "starter.json"), starterPrompts, 0o644)
}

// loadPrompts reads every pack in the folder.
func (a *app) loadPrompts() []promptItem {
	dir := a.promptsDir()
	if dir == "" {
		return nil
	}
	entries, _ := os.ReadDir(dir)
	var out []promptItem
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(e.Name()))
		if ext != ".json" && ext != ".yaml" && ext != ".yml" {
			continue
		}
		path := filepath.Join(dir, e.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var pack promptPack
		if yaml.Unmarshal(raw, &pack) != nil {
			continue
		}
		base := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
		for i, p := range pack.Prompts {
			title := strings.TrimSpace(p.Title)
			body := strings.TrimSpace(p.Body)
			if title == "" || body == "" {
				continue
			}
			category := firstNonEmpty(strings.TrimSpace(p.Category), pack.Name, base)
			out = append(out, promptItem{
				ID:       fmt.Sprintf("%s:%d", base, i),
				Title:    title,
				Body:     body,
				Category: category,
				Tags:     p.Tags,
				Source:   path,
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Category != out[j].Category {
			return out[i].Category < out[j].Category
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	return out
}

// openPromptLibrary reads the packs and shows the dialog.
func (a *app) openPromptLibrary() {
	if a.st == nil {
		return
	}
	a.ensurePromptLibrary()
	a.prompts.Set(a.loadPrompts())
	a.promptQuery.Set("")
	a.promptCat.Set("")
	a.promptOpen.Set(true)
}

// insertPrompt puts a prompt in the active composer, or the clipboard
// when no session is open.
func (a *app) insertPrompt(p promptItem) {
	s := a.active()
	if s == nil {
		a.copyText(p.Body, "提示词")
		a.promptOpen.Set(false)
		return
	}
	s.draft.Set(p.Body)
	a.promptOpen.Set(false)
	a.toast(ui.ToastInfo, "提示词已放进输入框", p.Title)
}

// saveDraftPrompt keeps the active draft as a prompt in the user's pack.
func (a *app) saveDraftPrompt() {
	s := a.active()
	if s == nil {
		return
	}
	body := strings.TrimSpace(s.draft.GetUntracked())
	if body == "" {
		a.toast(ui.ToastInfo, "输入框是空的", "先写一段想留下的提示词。")
		return
	}
	dir := a.promptsDir()
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		a.toast(ui.ToastError, "保存提示词失败", err.Error())
		return
	}
	path := filepath.Join(dir, "user.json")
	var pack promptPack
	if raw, err := os.ReadFile(path); err == nil {
		if yaml.Unmarshal(raw, &pack) != nil {
			a.toast(ui.ToastError, "user.json 不是有效的提示词文件", "")
			return
		}
	}
	if pack.Name == "" {
		pack.Name = "我的提示词"
	}
	var entry struct {
		Title    string   `yaml:"title" json:"title"`
		Body     string   `yaml:"body" json:"body"`
		Category string   `yaml:"category" json:"category"`
		Tags     []string `yaml:"tags" json:"tags"`
	}
	entry.Title = firstLine(body, 40)
	entry.Body = body
	entry.Category = "我的"
	pack.Prompts = append(pack.Prompts, entry)
	raw, err := json.MarshalIndent(pack, "", "  ")
	if err != nil {
		a.toast(ui.ToastError, "保存提示词失败", err.Error())
		return
	}
	raw = append(raw, '\n')
	if err := writeFileAtomic(path, raw, 0o644); err != nil {
		a.toast(ui.ToastError, "保存提示词失败", err.Error())
		return
	}
	a.prompts.Set(a.loadPrompts())
	a.toast(ui.ToastSuccess, "已保存提示词", entry.Title)
}

// promptCategories lists the categories in the library, sorted.
func promptCategories(list []promptItem) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range list {
		if !seen[p.Category] {
			seen[p.Category] = true
			out = append(out, p.Category)
		}
	}
	sort.Strings(out)
	return out
}

// filterPrompts keeps the prompts matching a category and a query.
func filterPrompts(list []promptItem, category, query string) []promptItem {
	query = strings.ToLower(strings.TrimSpace(query))
	var out []promptItem
	for _, p := range list {
		if category != "" && p.Category != category {
			continue
		}
		if query != "" {
			hay := strings.ToLower(p.Title + "\n" + p.Body + "\n" + strings.Join(p.Tags, " "))
			if !strings.Contains(hay, query) {
				continue
			}
		}
		out = append(out, p)
	}
	return out
}
