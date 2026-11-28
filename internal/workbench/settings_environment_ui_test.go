//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
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
			settingsRev: core.NewSignal(cx, 0), piUpdate: core.NewSignal(cx, piUpdateState{}),
			externalEditors: core.NewSignalFunc(cx, []extEditor(nil), nil),
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
	screen.WaitFor("id:editor-add", 5*time.Second)
	return screen, built
}

func TestSettingsEnvironmentRemainsReadable(t *testing.T) {
	for _, tt := range []struct {
		name, language string
		dark           bool
	}{{"light", apptext.LangZhCN, false}, {"dark-russian", apptext.LangRuRU, true}} {
		t.Run(tt.name, func(t *testing.T) {
			screen, _ := settingsEnvironmentFixture(t, tt.dark, tt.language)
			screen.Focus("id:editor-add")
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

func TestSettingsEnvironmentEditorDiscoveryKeepsInput(t *testing.T) {
	var calls atomic.Int32
	original := editorScan
	editorScan = func() []extEditor { calls.Add(1); return nil }
	t.Cleanup(func() { editorScan = original })
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	if got := calls.Load(); got != 0 {
		t.Fatalf("environment settings called the PATH scanner %d times", got)
	}
	screen.Press("id:editor-add")
	screen.Type("id:editor-command", "my-editor")
	screen.Post(func() { built.externalEditors.Set([]extEditor{{Name: "Zed", Command: "zed"}}) })
	screen.WaitFor("text:Zed", 5*time.Second)
	if field := screen.Find("id:editor-command"); !field.Focused || field.Text != "my-editor" {
		t.Fatalf("editor discovery interrupted the editor field: focused=%v text=%q", field.Focused, field.Text)
	}
}

func TestSettingsEnvironmentEditorsManage(t *testing.T) {
	program := runtimePiFixture(t, "fixture", false)
	zed := filepath.Join(t.TempDir(), "zed"+filepath.Ext(program))
	raw, err := os.ReadFile(program)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(zed, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	original := editorScan
	editorScan = func() []extEditor { return []extEditor{{"VS Code", program}, {"Zed", zed}} }
	t.Cleanup(func() { editorScan = original })
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	screen.Press("id:editor-detect")
	screen.WaitFor("text:VS Code", 5*time.Second)
	screen.Press("id:editor-default-" + editorKey(zed))
	screen.WaitUntil(5*time.Second, func() bool { return built.editorCommand() == zed })
	screen.Press("id:editor-remove-" + editorKey(zed))
	screen.WaitUntil(5*time.Second, func() bool { return built.editorCommand() == program })
	screen.Press("id:editor-remove-" + editorKey(program))
	screen.WaitFor("id:editors-empty", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(built.st.path)
		var saved config
		return err == nil && json.Unmarshal(raw, &saved) == nil && saved.ExternalEditors != nil && len(saved.ExternalEditors) == 0 && saved.EditorCommand == ""
	})
	screen.Press("id:editor-add")
	screen.Type("id:editor-command", "pideck-no-such-editor-xyz")
	screen.Press("id:editor-save")
	screen.WaitFor("text:"+apptext.T("找不到程序，请选择可执行文件；不要填写启动参数。"), 5*time.Second)
	if got := screen.Find("id:editor-command").Text; got != "pideck-no-such-editor-xyz" {
		t.Fatalf("invalid draft lost: %q", got)
	}
	screen.Clear("id:editor-command")
	screen.Type("id:editor-command", program)
	screen.Type("id:editor-name", "My editor")
	screen.Press("id:editor-save")
	screen.WaitFor("id:external-editor-"+editorKey(program), 5*time.Second)
	if built.editorCommand() != program {
		t.Fatalf("added editor is not used: %q", built.editorCommand())
	}
}

func TestSettingsEnvironmentPiStates(t *testing.T) {
	program := runtimePiFixture(t, "fixture-1.2.3", false)
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	screen.Post(func() { built.env.Set(envInfo{Probed: true, PiError: "pi is not installed"}) })
	screen.WaitFor("text:未找到 pi", 5*time.Second)
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-runtime-pi-missing")
	}
	screen.Press("id:pi-change")
	screen.Type("id:pi-executable", program)
	screen.Post(func() {
		info := built.env.GetUntracked()
		info.Probing = true
		built.env.Set(info)
	})
	if field := screen.Find("id:pi-executable"); !field.Focused || field.Text != program {
		t.Fatalf("probe interrupted pi draft: %+v", field)
	}
	screen.Press("id:pi-apply")
	screen.WaitFor("text:pi fixture-1.2.3", 5*time.Second)
	screen.WaitFor("text:使用自定义程序", 5*time.Second)
	if built.piPath() != program {
		t.Fatalf("custom pi not selected: %q", built.piPath())
	}
	screen.Post(func() {
		built.externalEditors.Set([]extEditor{{"VS Code", filepath.Join(filepath.Dir(program), "Code.exe")}, {"Zed", filepath.Join(filepath.Dir(program), "zed.exe")}})
	})
	screen.WaitFor("text:VS Code", 5*time.Second)
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-runtime-pi-custom")
	}
	screen.Press("id:pi-auto")
	screen.WaitFor("text:从 PATH 自动检测", 5*time.Second)
	screen.WaitFor("text:pi fixture-1.2.3", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool {
		raw, err := os.ReadFile(built.st.path)
		var saved config
		return err == nil && json.Unmarshal(raw, &saved) == nil && saved.PiExecutable == ""
	})
	if built.cfg.PiExecutable != "" {
		t.Fatal("automatic pi selection was not restored")
	}
	screen.Post(func() {
		info := built.env.GetUntracked()
		info.PiError = "Node.js could not start the selected runtime."
		built.env.Set(info)
		built.cx.SetAppearance(core.AppearanceDark)
	})
	screen.WaitFor("text:pi 无法运行", 5*time.Second)
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-runtime-pi-failed-dark")
	}
}

func TestSettingsEnvironmentEditsSurviveProbe(t *testing.T) {
	program := runtimePiFixture(t, "fixture", false)
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	screen.Press("id:editor-add")
	screen.Type("id:editor-name", "My editor")
	screen.Type("id:editor-command", program)
	screen.Post(func() {
		info := built.env.GetUntracked()
		info.PiVersion = "updated-probe"
		built.env.Set(info)
	})
	screen.WaitFor("text:pi updated-probe", 5*time.Second)
	if field := screen.Find("id:editor-command"); !field.Focused || field.Text != program {
		t.Fatalf("environment probe interrupted the editor field: focused=%v text=%q", field.Focused, field.Text)
	}
	screen.Press("id:editor-save")
	screen.WaitFor("id:external-editor-"+editorKey(program), 5*time.Second)
	for i, item := range []struct{ id, value string }{
		{"proxy-app", "http://127.0.0.1:7890"},
		{"proxy-agent", "http://127.0.0.1:7891"},
		{"proxy-bypass", "localhost,127.0.0.1,.example.test"},
	} {
		screen.Focus("id:" + item.id)
		screen.Type("id:"+item.id, item.value)
		if i == 2 {
			screen.Focus("id:editor-add")
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
		return json.Unmarshal(raw, &saved) == nil && len(saved.ExternalEditors) == 1 && saved.ExternalEditors[0].Command == program &&
			saved.ProxyApp == "http://127.0.0.1:7890" && saved.ProxyAgent == "http://127.0.0.1:7891" &&
			saved.ProxyBypass == "localhost,127.0.0.1,.example.test"
	})
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-environment-proxies")
	}
}
