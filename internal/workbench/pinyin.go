//go:build !js && !android && !ios

package workbench

import (
	_ "embed"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// Unicode 17.0.0 Unihan kMandarin. Each fixed-width line is a Unicode
// scalar in hex followed by its first reading, stripped of tone marks.
// Keeping it sorted avoids loading a large map when the workbench opens.
//
//go:embed data/unihan_mandarin.txt
var mandarinData string

func mandarinReading(r rune) string {
	const row = 16
	codeAt := func(i int) rune {
		var code rune
		for _, b := range []byte(mandarinData[i*row : i*row+6]) {
			code *= 16
			if b >= 'A' {
				code += rune(b - 'A' + 10)
			} else {
				code += rune(b - '0')
			}
		}
		return code
	}
	count := len(mandarinData) / row
	i := sort.Search(count, func(i int) bool { return codeAt(i) >= r })
	if i == count || codeAt(i) != r {
		return ""
	}
	return strings.TrimRight(mandarinData[i*row+7:(i+1)*row-1], "_")
}

func pinyinQuery(query string) string {
	var b strings.Builder
	for _, r := range norm.NFD.String(strings.ReplaceAll(strings.ToLower(query), "ü", "v")) {
		switch {
		case 'a' <= r && r <= 'z', '0' <= r && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '\'' || r == '_' || r >= 0x0300 && r <= 0x036f:
		default:
			return ""
		}
	}
	return b.String()
}

func pinyinForms(text string) (full, initials string) {
	var words, letters strings.Builder
	translated := false
	for _, r := range strings.ToLower(text) {
		switch {
		case r >= 0x3400:
			if reading := mandarinReading(r); reading != "" {
				words.WriteString(reading)
				letters.WriteByte(reading[0])
				translated = true
			}
		case 'a' <= r && r <= 'z', '0' <= r && r <= '9':
			words.WriteRune(r)
			letters.WriteRune(r)
		}
	}
	if !translated {
		return "", ""
	}
	return words.String(), letters.String()
}

func matchesPinyin(text, query string) bool {
	if query == "" {
		return false
	}
	full, initials := pinyinForms(text)
	return strings.Contains(full, query) || strings.Contains(initials, query)
}

func containsQuery(text, query string) bool {
	return strings.Contains(strings.ToLower(text), query) || matchesPinyin(text, pinyinQuery(query))
}
