//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"runtime/debug"
	"strings"
	"unicode"
	"unicode/utf16"

	"example.com/pideck/internal/appinfo"
	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/core"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	logoStyleTUI     = "pi-tui"
	logoStyleClassic = "classic"
	logoStyleCustom  = "custom"
	brandNameDefault = "PiDeck"
	brandNameMax     = 24
	logoSourceMax    = 12 << 20
	logoDataMax      = 1_500_000
	logoPixelsMax    = 40_000_000
	appRepoURL       = "https://github.com/ayuayue/PiDeck/tree/nsgo"
)

// These are pi's official 4×4 TUI pixels and fixed brand colors. Keep the
// aspect square: two rows of terminal half-block characters are four pixels.
// Source: badlogic/pi-mono, coding-agent/.../components/pi-logo.ts;
// PiDeck's piTuiLogoData.ts uses the same geometry and colors.
var piTUILogo = core.MustParseSVG([]byte(`<svg viewBox="0 0 4 4">
<path fill="#E48A7A" d="M0 0H3V2H2V1H0Z"/>
<path fill="#4F8EB3" d="M0 1H1V2H2V3H1V4H0Z"/>
<path fill="#EAB65D" d="M3 2H4V4H3Z"/>
</svg>`))

// piClassicLogo is the same geometry in a dark ink that stays legible on the
// white tile shared by the built-in logo presets.
var piClassicLogo = core.MustParseSVG([]byte(`<svg viewBox="0 0 4 4">
<path fill="#18181b" d="M0 0H3V2H2V1H0Z"/>
<path fill="#18181b" d="M0 1H1V2H2V3H1V4H0Z"/>
<path fill="#18181b" d="M3 2H4V4H3Z"/>
</svg>`))

// brandImage is decoded once when settings load or an image is chosen.
// SVGs stay vectors; raster images keep their alpha and aspect ratio.
type brandImage struct {
	data []byte
	svg  *core.SVG
}

func resolveLogoStyle(value string) string {
	switch strings.TrimSpace(value) {
	case logoStyleClassic:
		return logoStyleClassic
	case logoStyleCustom:
		return logoStyleCustom
	default:
		return logoStyleTUI
	}
}

func cleanBrandName(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return ' '
		}
		return r
	}, value)
	if len(utf16.Encode([]rune(value))) > brandNameMax {
		return ""
	}
	return value
}

func resolveBrandName(value string) string {
	if value = strings.TrimSpace(cleanBrandName(value)); value != "" {
		return value
	}
	return brandNameDefault
}

func normalizeBrandConfig(c *config) bool {
	changed := false
	style := strings.TrimSpace(c.LogoStyle)
	if style != "" {
		style = resolveLogoStyle(style)
	}
	if style != c.LogoStyle {
		c.LogoStyle = style
		changed = true
	}
	if name := strings.TrimSpace(cleanBrandName(c.AppDisplayName)); name != c.AppDisplayName {
		c.AppDisplayName = name
		changed = true
	}
	if c.LogoCustomImage != "" {
		if _, err := decodeBrandImage(c.LogoCustomImage); err != nil {
			c.LogoCustomImage = ""
			changed = true
		}
	}
	return changed
}

// decodeBrandImage accepts only inline image data, so a restored settings
// backup cannot leave the brand pointing at a missing local file.
func decodeBrandImage(value string) (brandImage, error) {
	if len(value) > logoDataMax {
		return brandImage{}, errors.New(apptext.T("Logo 图片过大，请选择较小的图片。"))
	}
	header, encoded, ok := strings.Cut(value, ",")
	if !ok {
		return brandImage{}, errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
	}
	switch header {
	case "data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64", "data:image/gif;base64", "data:image/svg+xml;base64":
	default:
		return brandImage{}, errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 {
		return brandImage{}, errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
	}
	if header == "data:image/svg+xml;base64" {
		svg, err := core.ParseSVG(data)
		if err != nil {
			return brandImage{}, errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
		}
		return brandImage{svg: svg}, nil
	}
	if err := checkLogoDimensions(data); err != nil {
		return brandImage{}, err
	}
	if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
		return brandImage{}, errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
	}
	return brandImage{data: data}, nil
}

func checkLogoDimensions(data []byte) error {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
	}
	if int64(cfg.Width)*int64(cfg.Height) > logoPixelsMax {
		return errors.New(apptext.T("Logo 图片尺寸过大，请选择不超过 4000 万像素的图片。"))
	}
	return nil
}

func readBrandImage(file core.File) (string, brandImage, error) {
	if file.Size > logoSourceMax {
		return "", brandImage{}, errors.New(apptext.T("Logo 图片超过 12 MB，请选择较小的图片。"))
	}
	r, err := file.Open()
	if err != nil {
		return "", brandImage{}, err
	}
	defer r.Close()
	data, err := io.ReadAll(io.LimitReader(r, logoSourceMax+1))
	if err != nil {
		return "", brandImage{}, err
	}
	if len(data) > logoSourceMax {
		return "", brandImage{}, errors.New(apptext.T("Logo 图片超过 12 MB，请选择较小的图片。"))
	}
	if file.MIME == "image/svg+xml" || strings.HasSuffix(strings.ToLower(file.Name), ".svg") {
		value := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString(data)
		asset, err := decodeBrandImage(value)
		return value, asset, err
	}
	if err := checkLogoDimensions(data); err != nil {
		return "", brandImage{}, err
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", brandImage{}, errors.New(apptext.T("无法读取 Logo，请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。"))
	}
	for _, edge := range []int{512, 256, 128} {
		b := source.Bounds()
		w, h := b.Dx(), b.Dy()
		if longest := max(w, h); longest > edge {
			w, h = max(1, w*edge/longest), max(1, h*edge/longest)
		}
		thumb := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(thumb, thumb.Bounds(), source, b, draw.Src, nil)
		var out bytes.Buffer
		if err := png.Encode(&out, thumb); err != nil {
			return "", brandImage{}, err
		}
		value := "data:image/png;base64," + base64.StdEncoding.EncodeToString(out.Bytes())
		if len(value) <= logoDataMax {
			return value, brandImage{data: out.Bytes()}, nil
		}
	}
	return "", brandImage{}, errors.New(apptext.T("Logo 图片过大，请选择较小的图片。"))
}

func (a *app) brandChanged() {
	if a.brandRev != nil {
		a.brandRev.Update(func(n int) int { return n + 1 })
	}
}

func (a *app) brandNameChanged() {
	if a.brandNameRev != nil {
		a.brandNameRev.Update(func(n int) int { return n + 1 })
	}
}

func (a *app) brandNameReloaded() {
	a.brandNameChanged()
	if a.brandInputRev != nil {
		a.brandInputRev.Update(func(n int) int { return n + 1 })
	}
}

// applyBrand reloads the cached image after startup or a settings restore.
// A pending file read belongs to the previous settings and must not win.
func (a *app) applyBrand() {
	a.brandImageSeq++
	a.customBrand, _ = decodeBrandImage(a.cfg.LogoCustomImage)
	a.brandBusy.Set(false)
	a.brandError.Set("")
	a.brandChanged()
	a.brandNameReloaded()
}

func (a *app) setLogoStyle(style string) {
	a.brandImageSeq++
	a.brandBusy.Set(false)
	a.brandError.Set("")
	a.cfg.LogoStyle = resolveLogoStyle(style)
	if a.st != nil {
		a.st.change(func(c *config) { c.LogoStyle = a.cfg.LogoStyle })
		a.saveConfigAsync()
	}
	a.brandChanged()
}

func (a *app) setBrandName(value string) {
	a.cfg.AppDisplayName = cleanBrandName(value)
	if a.st != nil {
		a.st.change(func(c *config) { c.AppDisplayName = a.cfg.AppDisplayName })
	}
	a.brandNameChanged()
}

func (a *app) clearBrandImage() {
	a.brandImageSeq++
	a.cfg.LogoCustomImage = ""
	a.customBrand = brandImage{}
	a.brandError.Set("")
	a.brandBusy.Set(false)
	if a.st != nil {
		a.st.change(func(c *config) { c.LogoCustomImage = "" })
		a.saveConfigAsync()
	}
	a.brandChanged()
}

func (a *app) resetBrand() {
	a.brandImageSeq++
	a.cfg.LogoStyle, a.cfg.AppDisplayName, a.cfg.LogoCustomImage = "", "", ""
	a.customBrand = brandImage{}
	a.brandError.Set("")
	a.brandBusy.Set(false)
	if a.st != nil {
		a.st.change(func(c *config) { c.LogoStyle, c.AppDisplayName, c.LogoCustomImage = "", "", "" })
		a.saveConfigAsync()
	}
	a.brandChanged()
	a.brandNameReloaded()
}

func (a *app) pickBrandImage() {
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"}, Limit: 1},
		func(files []core.File, err error) {
			if err != nil {
				a.brandError.Set(apptext.T("选择图片失败") + "：" + err.Error())
				return
			}
			if len(files) == 0 {
				return
			}
			a.brandError.Set("")
			a.brandBusy.Set(true)
			a.brandImageSeq++
			seq := a.brandImageSeq
			go func() {
				value, asset, err := readBrandImage(files[0])
				a.cx.Post(func() {
					if seq != a.brandImageSeq {
						return
					}
					a.brandBusy.Set(false)
					if err != nil {
						a.brandError.Set(err.Error())
						return
					}
					a.cfg.LogoCustomImage, a.cfg.LogoStyle = value, logoStyleCustom
					a.customBrand = asset
					if a.st != nil {
						a.st.change(func(c *config) { c.LogoCustomImage, c.LogoStyle = value, logoStyleCustom })
						a.saveConfigAsync()
					}
					a.brandChanged()
				})
			}()
		})
}

func brandVersion() string {
	if version := core.App().Version; version != "" {
		return version
	}
	return appinfo.Version
}

// build details come from Go's embedded metadata; absent fields stay out
// of the panel rather than guessing dates or a development branch.
type brandBuild struct{ Revision, Time string }

func readBrandBuild() brandBuild {
	var out brandBuild
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return out
	}
	modified := false
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			out.Revision = setting.Value
		case "vcs.time":
			out.Time = setting.Value
		case "vcs.modified":
			modified = setting.Value == "true"
		}
	}
	if out.Revision != "" {
		out.Revision = fmt.Sprintf("%.12s", out.Revision)
		if modified {
			out.Revision += " +"
		}
	}
	return out
}
