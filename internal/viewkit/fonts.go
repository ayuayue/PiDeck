package viewkit

// Text sizes shared by every build: the transcript's reading size and line
// height, and the composer's size. Config values of 0 keep the defaults.

const (
	// chatFontMin and chatFontMax bound the reading size in points.
	ChatFontMin = 11.0
	ChatFontMax = 20.0
	// ChatFontDefault matches PiDeck's reading baseline. Explicit user
	// sizes are independent of this default.
	ChatFontDefault = 16.0
	// chatLineMin and chatLineMax bound the line height, as a multiple of
	// the reading size; chatLineDefault is PiDeck's 1.6 (25.6 points at the
	// default size).
	ChatLineMin     = 1.3
	ChatLineMax     = 2.2
	ChatLineDefault = 1.6
	// inputFontDefault is the composer's size until the user picks one.
	InputFontDefault = ChatFontDefault
)

// PiDeck's system stacks include CJK fallbacks before the generic family:
// Windows' monospace fallback otherwise renders Chinese in SimSun.
const (
	SansFamily = `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif`
	MonoStack  = `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", monospace`
)

// monoFamily is the family monospaced text is drawn in: the one the user
// named, else the theme's, else the platform's. It is set as the theme is
// applied, so a family change reaches every built view on the next pass.
var MonoFamily = MonoStack

// monoFont is monoFamily, for a style's FontFamily.
func MonoFont() string { return MonoFamily }
