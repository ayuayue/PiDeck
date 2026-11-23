package viewkit

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMarkdownReadingScale(t *testing.T) {
	for _, size := range []core.Points{0, 16, 20} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				cx.SetTheme(Theme())
				return core.View{Style: core.Style{FontFamily: cx.Theme().Sans}, Children: []core.Node{
					MarkdownSized("## A heading\n\nA paragraph with `session.ID`.", func() bool { return false }, false, size, 0, core.Style{}),
				}}
			}, nsgotest.Size(800, 600))
			want := size
			if want == 0 {
				want = ChatFontDefault
			}
			body := screen.SpanStyle("text:A paragraph with ")
			code := screen.SpanStyle("text:session.ID")
			heading := screen.SpanStyle("text:A heading")
			if math.Abs(float64(body.Font.Size-want)) > 0.1 {
				t.Errorf("body size = %v, want %v", body.Font.Size, want)
			}
			wantCode := want * 0.875
			if math.Abs(float64(code.Font.Size-wantCode)) > 0.1 {
				t.Errorf("code size = %v, want %v", code.Font.Size, wantCode)
			}
			if math.Abs(float64(heading.Font.Size-want*1.15)) > 0.1 {
				t.Errorf("h2 size = %v, want reference scale %v", heading.Font.Size, want*1.15)
			}
			if !strings.Contains(body.Font.Family, "Microsoft YaHei UI") || !strings.Contains(code.Font.Family, "Microsoft YaHei UI") {
				t.Errorf("missing CJK fallbacks: body=%q code=%q", body.Font.Family, code.Font.Family)
			}
		})
	}
}
