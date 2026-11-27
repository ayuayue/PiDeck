//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func replyTile(t *testing.T, width, height int, fill color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			img.SetRGBA(x, y, fill)
		}
	}
	var data bytes.Buffer
	if err := png.Encode(&data, img); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestReplyImageJoinsEveryPage(t *testing.T) {
	red, blue := color.RGBA{R: 255, A: 255}, color.RGBA{B: 255, A: 255}
	data, err := stitchReplyImages([][]byte{replyTile(t, 4, 7, red), replyTile(t, 4, 3, blue)})
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 4 || img.Bounds().Dy() != 10 {
		t.Fatalf("joined bounds = %v, want 4x10", img.Bounds())
	}
	for y := range 10 {
		want := red
		if y >= 7 {
			want = blue
		}
		if got := color.RGBAModel.Convert(img.At(2, y)); got != want {
			t.Fatalf("joined pixel at row %d = %v, want %v", y, got, want)
		}
	}
}

func TestReplyImageRejectsIncompleteOrOversizedPages(t *testing.T) {
	large := replyTile(t, 1000, 1000, color.RGBA{A: 255})
	oversized := make([][]byte, maxReplyImagePixels/1_000_000+1)
	for i := range oversized {
		oversized[i] = large
	}
	for name, tiles := range map[string][][]byte{
		"empty": nil, "invalid": {[]byte("not an image")},
		"width changed": {replyTile(t, 4, 4, color.RGBA{}), replyTile(t, 5, 4, color.RGBA{})},
		"oversized":     oversized,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := stitchReplyImages(tiles); err == nil {
				t.Fatal("invalid image pages unexpectedly succeeded")
			}
		})
	}
}

func TestReplyImageShareUsesPNGAttachment(t *testing.T) {
	a, screen, _ := replyContentFixture(t)
	data := replyTile(t, 4, 4, color.RGBA{A: 255})
	screen.Post(func() { a.finishReplyImage(data, true) })
	screen.WaitUntil(5*time.Second, func() bool { return len(screen.Shares) == 1 })
	got := screen.Shares[0]
	if got.Text != "" || len(got.Files) != 1 || got.Files[0].MIME != "image/png" || !bytes.Equal(got.Files[0].Data, data) {
		t.Fatalf("image share = %+v", got)
	}
}

func TestNativeReplyLongImagesIncludeProcess(t *testing.T) {
	if nsgotest.Target() == "" {
		t.Skip("native capture requires rendered pixels")
	}
	_, screen, s := replyContentFixture(t)
	screen.Post(func() {
		tt := s.turns.GetUntracked()[0]
		tt.Steps = nil
		for i := range 18 {
			tt.Steps = append(tt.Steps, turnStep{ID: fmt.Sprintf("long-step-%d", i),
				Text:     fmt.Sprintf("Part %d. %s", i, strings.Repeat("A complete paragraph of the answer. ", 6)),
				Thinking: strings.Repeat("Thinking about this part. ", 8)})
		}
		s.turns.Set([]turn{tt})
	})
	screen.Settle()
	var heights []int
	for _, id := range []string{"turn-copy-image", "turn-copy-image-all"} {
		screen.ClipboardImage = nil
		screen.Press("id:turn-copy-menu")
		screen.Press("id:" + id)
		screen.WaitUntil(15*time.Second, func() bool { return len(screen.ClipboardImage) > 0 || strings.Contains(screen.Dump(), "操作失败") })
		cfg, err := png.DecodeConfig(bytes.NewReader(screen.ClipboardImage))
		if err != nil {
			t.Fatalf("%s did not produce a PNG: %v\n%s", id, err, screen.Dump())
		}
		if cfg.Height <= screen.Capture().Bounds().Dy() {
			t.Fatalf("%s was clipped to the window: %dx%d", id, cfg.Width, cfg.Height)
		}
		heights = append(heights, cfg.Height)
	}
	if heights[1] <= heights[0] {
		t.Fatalf("process image height %d <= answer-only image %d", heights[1], heights[0])
	}
	screen.Press("id:turn-share-menu")
	screen.Press("id:turn-share-image-all")
	screen.WaitUntil(15*time.Second, func() bool { return len(screen.Shares) == 1 || strings.Contains(screen.Dump(), "操作失败") })
	if len(screen.Shares) != 1 || len(screen.Shares[0].Files) != 1 {
		t.Fatal("sharing the process image did not attach a file")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(screen.Shares[0].Files[0].Data))
	if err != nil || cfg.Height <= heights[0] {
		t.Fatalf("shared process image is incomplete: config %+v, error %v", cfg, err)
	}
}
