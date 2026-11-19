package assets

// The artwork the app embeds: the packaged icon for the app's mark, and
// the mark alone for a menu bar that paints its own icons.

import (
	"bytes"
	"image/png"
	"testing"
)

func TestArtwork(t *testing.T) {
	logo, err := png.Decode(bytes.NewReader(LogoPNG))
	if err != nil {
		t.Fatalf("logo: %v", err)
	}
	if b := logo.Bounds(); b.Dx() != 512 || b.Dy() != 512 {
		t.Fatalf("logo = %dx%d, want 512x512", b.Dx(), b.Dy())
	}
	if _, _, _, a := logo.At(256, 256).RGBA(); a == 0 {
		t.Fatal("the logo's middle should be drawn")
	}

	glyph, err := png.Decode(bytes.NewReader(TrayGlyphPNG))
	if err != nil {
		t.Fatalf("tray: %v", err)
	}
	b := glyph.Bounds()
	if b.Dx() != 44 || b.Dy() != 44 {
		t.Fatalf("tray = %dx%d, want 44x44", b.Dx(), b.Dy())
	}
	// A template image is its alpha: the tile must be gone, or the menu bar
	// draws a solid block where an icon should be.
	for _, corner := range [][2]int{{0, 0}, {b.Dx() - 1, 0}, {0, b.Dy() - 1}, {b.Dx() - 1, b.Dy() - 1}} {
		if _, _, _, a := glyph.At(corner[0], corner[1]).RGBA(); a != 0 {
			t.Errorf("corner %v is opaque: the tile came back", corner)
		}
	}
	drawn := 0
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			if _, _, _, a := glyph.At(x, y).RGBA(); a > 0 {
				drawn++
			}
		}
	}
	if drawn < 100 {
		t.Fatalf("the glyph covers %d pixels, too few to read", drawn)
	}
}
