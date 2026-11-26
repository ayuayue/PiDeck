//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func settingsEnvironmentFixture(t *testing.T, dark bool, language string) (*nsgotest.App, *app) {
	t.Helper()
	home := t.TempDir()
	previous := apptext.CurrentLanguage()
	apptext.SetLanguage(language)
	t.Cleanup(func() { apptext.SetLanguage(previous) })
	t.Cleanup(configWrites.Wait)
	t.Cleanup(func() { appProxy.set("", ""); agentProxy.set("", "") })
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(viewkit.Theme())
		if dark {
			cx.SetAppearance(core.AppearanceDark)
		} else {
			cx.SetAppearance(core.AppearanceLight)
		}
		cfg := config{Language: language}
		built = &app{cx: cx, cfg: cfg,
			st:          &store{dir: home, path: filepath.Join(home, "config.json"), c: &cfg},
			settingsRev: core.NewSignal(cx, 0), piUpdateBusy: core.NewSignal(cx, false),
			env: core.NewSignalFunc(cx, envInfo{PiPath: "pi", PiVersion: "test", SessionsDir: home,
				WSL: []wslDistro{
					{Name: "Ubuntu-workspace", PiPath: "/opt/" + strings.Repeat("workspace/", 12) + "pi-path-tail"},
					{Name: "Ubuntu-" + strings.Repeat("工作区", 20), Error: strings.Repeat("找不到可执行文件。", 12) + "wsl-error-tail"},
				},
				SSH: []sshHost{{Name: "build-host", Error: strings.Repeat("Connection timed out. ", 8) + "ssh-error-tail"}},
			}, nil),
		}
		return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans, Padding: core.All(20)}),
			StyleFunc: ui.Filled(ui.ColorsOf(cx).Background), Children: []core.Node{
				core.View{Style: core.Style{Width: core.Pt(420), MaxWidth: core.Pct(100), FlexGrow: 1, FlexShrink: 1},
					Children: []core.Node{built.settingsEnv()}},
			}}
	}, nsgotest.Size(960, 640), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
	screen.WaitFor("id:editor-command", 5*time.Second)
	return screen, built
}

func TestSettingsEnvironmentRemainsReadable(t *testing.T) {
	for _, tt := range []struct {
		name, language string
		dark           bool
	}{{"light", apptext.LangZhCN, false}, {"dark-russian", apptext.LangRuRU, true}} {
		t.Run(tt.name, func(t *testing.T) {
			screen, _ := settingsEnvironmentFixture(t, tt.dark, tt.language)
			screen.Focus("id:editor-command")
			screen.Scroll("id:settings-page", 3000)
			if nsgotest.Target() != "" {
				screen.Screenshot("settings-environment-targets-" + tt.name)
			}
			page := screen.Find("id:settings-page")
			if page.Content.Width > page.Bounds().Size.Width+1 {
				t.Errorf("environment content overflows its column: content=%v viewport=%+v", page.Content, page.Bounds())
			}
			for _, tail := range []string{"pi-path-tail", "wsl-error-tail", "ssh-error-tail"} {
				if len(screen.QueryMounted("text:"+tail)) == 0 {
					t.Errorf("target details are truncated before %q", tail)
				}
			}
			for _, label := range []string{"应用请求代理", "Agent 代理", "直连名单"} {
				if len(screen.QueryMounted("label:"+apptext.T(label))) != 1 {
					t.Errorf("proxy field is missing its localized accessible label: %s", label)
				}
			}
			for _, label := range []string{"添加 WSL 工作区", "添加 SSH 工作区"} {
				screen.Focus("role:button " + apptext.T(label))
				button := screen.Find("role:button " + apptext.T(label))
				bounds := button.Bounds()
				viewport := page.Bounds()
				if bounds.Origin.X < viewport.Origin.X || bounds.Origin.X+bounds.Size.Width > viewport.Origin.X+viewport.Size.Width+1 {
					t.Errorf("workspace action overflows: label=%s bounds=%+v viewport=%+v", label, bounds, viewport)
				}
			}
		})
	}
}

func TestSettingsEnvironmentEditsSurviveProbe(t *testing.T) {
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	screen.Type("id:editor-command", "code --wait")
	screen.Post(func() {
		info := built.env.GetUntracked()
		info.PiVersion = "updated-probe"
		built.env.Set(info)
	})
	screen.WaitFor("text:pi updated-probe", 5*time.Second)
	if field := screen.Find("id:editor-command"); !field.Focused || field.Text != "code --wait" {
		t.Fatalf("environment probe interrupted the editor field: focused=%v text=%q", field.Focused, field.Text)
	}
	screen.Submit("id:editor-command")
	for i, item := range []struct{ id, value string }{
		{"proxy-app", "http://127.0.0.1:7890"},
		{"proxy-agent", "http://127.0.0.1:7891"},
		{"proxy-bypass", "localhost,127.0.0.1,.example.test"},
	} {
		screen.Focus("id:" + item.id)
		screen.Type("id:"+item.id, item.value)
		if i == 2 {
			screen.Focus("id:editor-command")
		} else {
			screen.Submit("id:" + item.id)
		}
	}
	screen.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(built.st.path)
		if err != nil {
			return false
		}
		var saved config
		return json.Unmarshal(raw, &saved) == nil && saved.EditorCommand == "code --wait" &&
			saved.ProxyApp == "http://127.0.0.1:7890" && saved.ProxyAgent == "http://127.0.0.1:7891" &&
			saved.ProxyBypass == "localhost,127.0.0.1,.example.test"
	})
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-environment-proxies")
	}
}
