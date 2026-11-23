package officedoc

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
)

// documentPart is where a .docx keeps the body's text.
const documentPart = "word/document.xml"

// DocxText returns a .docx document's text: a line per paragraph, a tab or a
// break where the document has one, and a table's cells on one line apart by
// " | ". Deleted revisions, headers, footers, footnotes and comments are
// left out, and formatting is dropped: this is what the words say, not what
// a page looks like.
func DocxText(data []byte) (string, error) {
	zr, err := openArchive(data)
	if err != nil {
		return "", err
	}
	part, err := readPart(zr, documentPart)
	if err != nil {
		return "", err
	}
	return docxText(part)
}

// docxText reads the body of a document part.
func docxText(part []byte) (string, error) {
	dec := xml.NewDecoder(bytes.NewReader(part))
	var out text
	// inCell counts the table cells entered: a paragraph inside one keeps
	// the cell's line rather than starting a new one, and the second
	// paragraph of a cell is a space away from the first.
	inCell := 0
	paragraph := false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("%w: %v", ErrFormat, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "tc":
				out.separate(" | ")
				inCell++
				paragraph = false
			case "p":
				if inCell == 0 {
					out.newline()
					break
				}
				if paragraph {
					out.write(" ")
				}
			case "tr":
				if inCell == 0 {
					out.newline()
				}
			case "t":
				run, err := elementText(dec, t)
				if err != nil {
					return "", err
				}
				out.write(run)
			case "tab":
				out.write("\t")
			case "br", "cr":
				if inCell > 0 {
					out.write(" ")
					continue
				}
				out.write("\n")
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "tc":
				if inCell > 0 {
					inCell--
				}
			case "p":
				paragraph = true
			}
		}
	}
	return out.string(), nil
}

// elementText reads the text of the element dec is inside.
func elementText(dec *xml.Decoder, start xml.StartElement) (string, error) {
	var value string
	if err := dec.DecodeElement(&value, &start); err != nil {
		return "", fmt.Errorf("%w: %v", ErrFormat, err)
	}
	return value, nil
}
