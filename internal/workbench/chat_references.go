//go:build !js && !android && !ios

package workbench

import (
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/nsgo-dev/nsgo/base/textview"
)

// chatReference is presentation data only. Files are resolved and checked
// off the UI thread when pressed, never while streaming Markdown is parsed.
type chatReference struct {
	target string
	web    bool
	line   int
	code   bool
}

func chatWebURL(raw string) (string, bool) {
	if strings.HasPrefix(strings.ToLower(raw), "www.") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Hostname() == "" || strings.ContainsAny(raw, "\r\n\t\\") ||
		(!strings.EqualFold(u.Scheme, "http") && !strings.EqualFold(u.Scheme, "https")) {
		return "", false
	}
	return u.String(), true
}

func chatFileLocation(raw string) (string, int) {
	path, line := raw, 0
	if i := strings.LastIndex(path, "#L"); i > 0 {
		if n, err := strconv.Atoi(path[i+2:]); err == nil && n > 0 {
			return path[:i], n
		}
	}
	// One or two numeric suffixes are line[:column], never a drive colon.
	for range 2 {
		i := strings.LastIndexByte(path, ':')
		if i <= 1 {
			break
		}
		n, err := strconv.Atoi(path[i+1:])
		if err != nil || n < 1 {
			break
		}
		line, path = n, path[:i]
	}
	return path, line
}

func chatFileReference(raw string, known map[string]bool, explicit bool) (chatReference, bool) {
	if raw == "" || len(raw) > 4096 || strings.ContainsAny(raw, "\x00\r\n\t<>|*?\"`") ||
		strings.HasPrefix(raw, `\\`) || strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, "@") {
		return chatReference{}, false
	}
	if strings.HasPrefix(strings.ToLower(raw), "file:") {
		var err error
		raw, err = droppedFilePath(raw)
		if err != nil {
			return chatReference{}, false
		}
	}
	if strings.Contains(raw, "://") {
		return chatReference{}, false
	}
	path, line := chatFileLocation(raw)
	normal := strings.ReplaceAll(path, `\`, "/")
	absolute := strings.HasPrefix(normal, "/") || (len(normal) > 2 && normal[1] == ':' && normal[2] == '/')
	if !absolute && strings.Contains(normal, ":") {
		return chatReference{}, false
	}
	indexed := known[strings.TrimPrefix(normal, "./")]
	if !explicit && !indexed {
		// A slash by itself is also division, a command, or prose. Require
		// a file-shaped basename unless the project index confirms it.
		ext := filepath.Ext(normal)
		if !strings.Contains(normal, "/") || len(ext) < 2 || len(ext) > 16 || strings.HasSuffix(normal, "/") {
			return chatReference{}, false
		}
		if !absolute && strings.ContainsAny(normal, "=+$%;&") {
			return chatReference{}, false
		}
	}
	if !absolute && !strings.Contains(normal, "/") && !indexed && !explicit {
		return chatReference{}, false
	}
	return chatReference{target: path, line: line}, true
}

func chatReferenceNode(label string, ref chatReference, original []textview.Inline) textview.Custom {
	return textview.Custom{Name: "pideck-reference", Text: label, Data: ref, Content: original}
}

func chatReferenceText(text string, known map[string]bool, code bool) []textview.Inline {
	// Inline code and quoted paths may contain spaces. Only take the
	// whole value when it is a path, not a shell command with arguments.
	if code && !strings.ContainsAny(text, "\r\n") {
		if ref, ok := chatFileReference(text, known, false); ok && (!strings.Contains(text, " ") || strings.HasPrefix(ref.target, "/") || filepath.IsAbs(ref.target)) {
			ref.code = true
			return []textview.Inline{chatReferenceNode(text, ref, []textview.Inline{textview.Code{Code: text}})}
		}
	}
	plain := func(s string) textview.Inline {
		if code {
			return textview.Code{Code: s}
		}
		return textview.Text{Text: s}
	}
	var out []textview.Inline
	last := 0
	for start := 0; start < len(text); {
		for start < len(text) {
			r := rune(text[start])
			if r < 128 && (unicode.IsSpace(r) || strings.ContainsRune("\"'`<>[]{}()", r)) {
				start++
				continue
			}
			break
		}
		if start == len(text) {
			break
		}
		end := start
		for _, r := range text[start:] {
			if unicode.IsSpace(r) || strings.ContainsRune("\"'`<>[]{}，。；！？、", r) {
				break
			}
			end += len(string(r))
		}
		if end == start {
			_, width := utf8.DecodeRuneInString(text[start:])
			start += width
			continue
		}
		candidate := strings.TrimRight(text[start:end], ".,;:!?，。；！？")
		for _, pair := range []string{"()", "[]", "{}"} {
			for strings.HasSuffix(candidate, pair[1:]) && strings.Count(candidate, pair[1:]) > strings.Count(candidate, pair[:1]) {
				candidate = strings.TrimSuffix(candidate, pair[1:])
			}
		}
		ref, ok := chatReference{}, false
		if target, web := chatWebURL(candidate); web {
			ref, ok = chatReference{target: target, web: true}, true
		} else {
			ref, ok = chatFileReference(candidate, known, false)
		}
		if ok {
			if last < start {
				out = append(out, plain(text[last:start]))
			}
			ref.code = code
			original := []textview.Inline{plain(candidate)}
			out = append(out, chatReferenceNode(candidate, ref, original))
			last = start + len(candidate)
		}
		start = end
	}
	if last < len(text) {
		out = append(out, plain(text[last:]))
	}
	return out
}

func chatReferenceInlines(in []textview.Inline, known map[string]bool) []textview.Inline {
	var out []textview.Inline
	for _, node := range in {
		switch n := node.(type) {
		case textview.Text:
			out = append(out, chatReferenceText(n.Text, known, false)...)
			continue
		case textview.Code:
			decorated := chatReferenceText(n.Code, known, true)
			found := false
			for _, v := range decorated {
				if _, ok := v.(textview.Custom); ok {
					found = true
				}
			}
			if found {
				out = append(out, decorated...)
				continue
			}
		case textview.Link:
			label := textview.PlainText(n.Content)
			if target, ok := chatWebURL(n.URL); ok {
				out = append(out, chatReferenceNode(label, chatReference{target: target, web: true}, n.Content))
				continue
			}
			if ref, ok := chatFileReference(n.URL, known, true); ok && !strings.HasPrefix(n.URL, "#") {
				out = append(out, chatReferenceNode(label, ref, n.Content))
				continue
			}
		case textview.Strong:
			n.Content = chatReferenceInlines(n.Content, known)
			node = n
		case textview.Emphasis:
			n.Content = chatReferenceInlines(n.Content, known)
			node = n
		case textview.Strikethrough:
			n.Content = chatReferenceInlines(n.Content, known)
			node = n
		case textview.Underline:
			n.Content = chatReferenceInlines(n.Content, known)
			node = n
		case textview.Mark:
			n.Content = chatReferenceInlines(n.Content, known)
			node = n
		}
		out = append(out, node)
	}
	return out
}

func chatReferenceBlocks(blocks []textview.Block, known map[string]bool) {
	for i, block := range blocks {
		switch n := block.(type) {
		case textview.Paragraph:
			n.Content = chatReferenceInlines(n.Content, known)
			blocks[i] = n
		case textview.Heading:
			n.Content = chatReferenceInlines(n.Content, known)
			blocks[i] = n
		case textview.Blockquote:
			chatReferenceBlocks(n.Children, known)
			blocks[i] = n
		case textview.List:
			for j := range n.Items {
				chatReferenceBlocks(n.Items[j].Children, known)
			}
			blocks[i] = n
		case textview.Table:
			for j := range n.Head {
				n.Head[j].Content = chatReferenceInlines(n.Head[j].Content, known)
			}
			for j := range n.Rows {
				for k := range n.Rows[j] {
					n.Rows[j][k].Content = chatReferenceInlines(n.Rows[j][k].Content, known)
				}
			}
			blocks[i] = n
		case textview.Details:
			n.Summary = chatReferenceInlines(n.Summary, known)
			chatReferenceBlocks(n.Children, known)
			blocks[i] = n
		}
	}
}

func chatReferenceDocument(markdown string, files []string) textview.Document {
	known := make(map[string]bool, len(files))
	for _, file := range files {
		known[filepath.ToSlash(file)] = true
	}
	doc := textview.Parse(markdown)
	chatReferenceBlocks(doc.Blocks, known)
	for i := range doc.Footnotes {
		chatReferenceBlocks(doc.Footnotes[i].Children, known)
	}
	return doc
}
