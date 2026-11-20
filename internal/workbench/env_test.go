//go:build !js && !android && !ios

package workbench

// The environment page shows what a probe found, including the child's own
// error text, which cmd.exe writes in the console code page.

import "testing"

// TestConsoleTextDecodesGBK guards the garbled `不是内部或外部命令` a Chinese
// Windows prints when a batch shim fails: GBK bytes read as UTF-8.
func TestConsoleTextDecodesGBK(t *testing.T) {
	gbk := []byte{0xb2, 0xbb, 0xca, 0xc7, 0xc4, 0xda, 0xb2, 0xbf, 0xbb, 0xf2, 0xcd, 0xe2, 0xb2, 0xbf, 0xc3, 0xfc, 0xc1, 0xee}
	if got, want := consoleText(gbk, true), "不是内部或外部命令"; got != want {
		t.Errorf("console text = %q, want %q", got, want)
	}
	// pi writes UTF-8, and a remote shell is not a console: both pass
	// through untouched.
	for _, c := range []struct {
		b       []byte
		console bool
	}{
		{[]byte("不是"), true},
		{gbk, false},
	} {
		if got := consoleText(c.b, c.console); got != string(c.b) {
			t.Errorf("console text = %q, want the bytes as they came (%v)", got, string(c.b))
		}
	}
}
