//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/assets"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestBrandDefaultsAndNormalization(t *testing.T) {
	for _, style := range []string{"", "bogus", "pi-tui"} {
		if got := resolveLogoStyle(style); got != logoStyleTUI {
			t.Fatalf("style %q resolved to %q", style, got)
		}
	}
	for _, name := range []string{"", "  ", strings.Repeat("名", brandNameMax+1)} {
		if got := resolveBrandName(name); got != brandNameDefault {
			t.Fatalf("name %q resolved to %q", name, got)
		}
	}
	if got := resolveBrandName("  我的工作台  "); got != "我的工作台" {
		t.Fatalf("trimmed name = %q", got)
	}
	c := config{LogoStyle: " unknown ", AppDisplayName: "  工作\n台  ", LogoCustomImage: "file:///missing.png"}
	if !normalizeConfig(&c) || c.LogoStyle != logoStyleTUI || c.AppDisplayName != "工作 台" || c.LogoCustomImage != "" {
		t.Fatalf("normalized branding = %q / %q / %q", c.LogoStyle, c.AppDisplayName, c.LogoCustomImage)
	}
	if normalizeConfig(&c) {
		t.Fatal("normalized branding changed a second time")
	}
}

// A wide transparent image shrinks proportionally and stays portable:
// deleting the source after saving must not affect the next launch.
func TestBrandImagePortableAndTransparent(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 1024, 512))
	source.SetNRGBA(512, 256, color.NRGBA{R: 255, A: 255})
	var input bytes.Buffer
	if err := png.Encode(&input, source); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "transparent.png")
	if err := os.WriteFile(path, input.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	value, asset, err := readBrandImage(core.File{Name: "transparent.png", Path: path})
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(asset.data))
	if err != nil {
		t.Fatal(err)
	}
	if got := img.Bounds().Size(); got != image.Pt(512, 256) {
		t.Fatalf("thumbnail size = %v", got)
	}
	if _, _, _, alpha := img.At(0, 0).RGBA(); alpha != 0 {
		t.Fatalf("transparent corner got alpha %d", alpha)
	}
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) {
		c.LogoStyle, c.LogoCustomImage, c.AppDisplayName = logoStyleCustom, value, "我的 Pi"
	})
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	again, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := again.config()
	if c.LogoStyle != logoStyleCustom || c.AppDisplayName != "我的 Pi" || c.LogoCustomImage != value {
		t.Fatal("saved branding did not survive a reload without its source file")
	}
	if restored, err := decodeBrandImage(c.LogoCustomImage); err != nil || !bytes.Equal(restored.data, asset.data) {
		t.Fatalf("restored image differs: %v", err)
	}
}

func TestBrandImageFormatsAndLimits(t *testing.T) {
	const svg = `<svg viewBox="0 0 40 20"><rect width="40" height="20" fill="#E48A7A"/></svg>`
	value, asset, err := readBrandImage(core.File{Name: "logo.svg", MIME: "image/svg+xml",
		Opener: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(svg)), nil }})
	if err != nil || asset.svg == nil || !strings.HasPrefix(value, "data:image/svg+xml;base64,") {
		t.Fatalf("SVG did not stay a vector: %v", err)
	}
	for _, value := range []string{
		"https://example.org/logo.png", "data:text/html;base64,PGh0bWw+", "data:image/png;base64,not base64",
		"data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not an image")),
		strings.Repeat("a", logoDataMax+1),
	} {
		if _, err := decodeBrandImage(value); err == nil {
			t.Fatal("invalid image was accepted")
		}
	}
	if _, _, err := readBrandImage(core.File{Size: logoSourceMax + 1}); err == nil {
		t.Fatal("oversized source was accepted")
	}
}

func TestBrandPopoverAndSettings(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless picker and persistence coverage")
	}
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", dir)
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	t.Cleanup(built.closeDiag)
	screen.Press("id:rail-brand")
	screen.WaitFor("id:brand-info", 5*time.Second)
	screen.Find("id:brand-app-version")
	screen.Find("id:brand-pi-version")
	screen.Key("escape")
	screen.WaitForGone("id:brand-info", 5*time.Second)
	screen.Press("id:rail-brand")
	screen.Press("id:brand-customize")
	screen.WaitFor("id:brand-display-name", 5*time.Second)
	screen.WaitForGone("id:brand-info", 5*time.Second)
	inputID := screen.Find("id:brand-display-name").ID
	screen.Type("id:brand-display-name", "我的 Pi 工作台")
	if screen.Find("id:brand-display-name").ID != inputID {
		t.Fatal("typing rebuilt the focused field")
	}
	if got := screen.Find("id:rail-brand-name").Text; got != "我的 Pi 工作台" {
		t.Fatalf("rail name = %q", got)
	}
	screen.Press("id:brand-logo-classic")
	if !bytes.Equal(screen.Find("id:rail-brand-logo").Image.Source.Data, assets.LogoPNG) {
		t.Fatal("classic preset did not reach the rail")
	}
	screen.Press("id:brand-logo-custom")
	screen.WaitFor("id:brand-image-choose", 5*time.Second)
	screen.PickFiles = func(core.FilesRequest) []core.File {
		return []core.File{{Name: "logo.png", Opener: func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(assets.LogoPNG)), nil
		}}}
	}
	screen.Press("id:brand-image-choose")
	screen.WaitUntil(5*time.Second, func() bool { return built.cfg.LogoCustomImage != "" && !built.brandBusy.GetUntracked() })
	savedImage := built.cfg.LogoCustomImage
	screen.PickFiles = func(core.FilesRequest) []core.File {
		return []core.File{{Name: "invalid.png", Opener: func() (io.ReadCloser, error) {
			return io.NopCloser(strings.NewReader("not an image")), nil
		}}}
	}
	screen.Press("id:brand-image-choose")
	screen.WaitFor("id:brand-image-error", 5*time.Second)
	if built.cfg.LogoCustomImage != savedImage {
		t.Fatal("invalid image replaced the existing logo")
	}
	screen.WaitUntil(5*time.Second, func() bool {
		c := readConfig(t, dir)
		return c.LogoCustomImage == savedImage && c.AppDisplayName == "我的 Pi 工作台"
	})
	if c := readConfig(t, dir); c.LogoCustomImage != savedImage || c.AppDisplayName != "我的 Pi 工作台" {
		t.Fatal("custom branding was not saved")
	}
	backupPath := filepath.Join(dir, "branding.zip")
	if err := built.writeSettingsZip(backupPath); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:brand-image-clear")
	screen.WaitForGone("id:brand-image-error", 5*time.Second)
	if len(screen.Find("id:rail-brand-logo").Image.Source.Data) != 0 || built.cfg.LogoCustomImage != "" {
		t.Fatal("clearing an image did not fall back to TUI")
	}
	screen.Press("id:brand-reset")
	screen.WaitUntil(5*time.Second, func() bool {
		c := readConfig(t, dir)
		return c.LogoStyle == "" && c.LogoCustomImage == "" && c.AppDisplayName == ""
	})
	if c := readConfig(t, dir); c.LogoStyle != "" || c.LogoCustomImage != "" || c.AppDisplayName != "" {
		t.Fatal("reset did not restore all brand defaults")
	}
	if screen.Find("id:rail-brand-name").Text != brandNameDefault {
		t.Fatal("reset name did not reach the rail")
	}
	built.importSettings(backupPath)
	screen.WaitFor("id:confirm-ok", 5*time.Second)
	screen.Press("id:confirm-ok")
	screen.WaitUntil(5*time.Second, func() bool {
		return screen.Find("id:rail-brand-name").Text == "我的 Pi 工作台" &&
			len(screen.Find("id:rail-brand-logo").Image.Source.Data) > 0
	})
	if built.cfg.LogoCustomImage != savedImage || len(built.customBrand.data) == 0 {
		t.Fatal("restoring settings did not refresh the custom logo cache")
	}
}

// The name field saves when it is left, so quitting from inside it would
// drop the edit; the exit path saves once more.
func TestQuitSavesNameStillTypedInTheField(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless quit and persistence coverage")
	}
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_HOME", dir)
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	t.Cleanup(built.closeDiag)
	screen.Press("id:rail-brand")
	screen.Press("id:brand-customize")
	screen.WaitFor("id:brand-display-name", 5*time.Second)
	const typed = "离开输入框前退出"
	screen.Type("id:brand-display-name", typed)
	if got := built.st.config().AppDisplayName; got != typed {
		t.Fatalf("typing did not reach the in-memory config: %q", got)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "config.json")); err == nil && strings.Contains(string(raw), typed) {
		t.Fatal("the focused field saved before the quit, so the test proves nothing")
	}
	Shutdown()
	if c := readConfig(t, dir); c.AppDisplayName != typed {
		t.Fatalf("quitting from the focused field saved %q, want %q", c.AppDisplayName, typed)
	}
}

// This is also the native screenshot fixture: a long name at the smallest
// rail width, the version panel, and both shipped appearances.
func TestBrandScreens(t *testing.T) {
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	var built *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		built = newApp(cx)
		return built.view()
	}, nsgotest.Size(1200, 800))
	t.Cleanup(built.closeDiag)
	screen.Press("id:rail-brand")
	screen.WaitFor("id:brand-info", 5*time.Second)
	shot(screen, "brand/01-light-info")
	screen.Press("id:brand-customize")
	screen.WaitFor("id:brand-display-name", 5*time.Second)
	screen.WaitFor("id:theme-system", 5*time.Second)
	shot(screen, "brand/02-light-settings")
	screen.Focus("id:brand-display-name")
	const longName = "My Personal Pi Workspace"
	screen.Type("id:brand-display-name", longName)
	screen.WaitUntil(5*time.Second, func() bool { return screen.Find("id:rail-brand-name").Text == longName })
	built.setRailWidth(240)
	screen.Settle()
	screen.Press("id:rail-brand")
	screen.WaitFor("id:brand-info", 5*time.Second)
	name, trigger := screen.Find("id:rail-brand-name"), screen.Find("id:rail-brand")
	if name.Frame.Size.Width > trigger.Frame.Size.Width {
		t.Fatal("long brand name escaped its trigger")
	}
	shot(screen, "brand/03-long-name")
	screen.Key("escape")
	screen.WaitForGone("id:brand-info", 5*time.Second)
	built.setTheme("dark")
	screen.Settle()
	screen.Press("id:rail-brand")
	screen.WaitFor("id:brand-info", 5*time.Second)
	shot(screen, "brand/04-dark-info")
	screen.Press("id:brand-customize")
	screen.Press("id:brand-logo-custom")
	screen.WaitFor("id:brand-image-choose", 5*time.Second)
	shot(screen, "brand/05-custom-settings")
	screen.Press("id:settings-tab-general")
	screen.Press("id:language-select")
	screen.Press("text:English")
	screen.Press("id:settings-tab-look")
	screen.Resize(960, 640)
	screen.WaitFor("id:brand-display-name", 5*time.Second)
	screen.Find("text:Logo style")
	screen.Find("text:App display name")
	if len(screen.Query("text:应用显示名称")) != 0 {
		t.Fatal("brand settings did not translate")
	}
	shot(screen, "brand/06-english-narrow")
}
