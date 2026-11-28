package officedoc

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"path"
	"strconv"
	"strings"
)

// Where a workbook keeps its strings and its worksheets.
const (
	sharedStringsPart = "xl/sharedStrings.xml"
	workbookPart      = "xl/workbook.xml"
	workbookRelsPart  = "xl/_rels/workbook.xml.rels"
)

// Sheet is what a spreadsheet's first worksheet holds, as a preview shows it.
type Sheet struct {
	// Rows are the cells by row, a row as long as its last cell.
	Rows [][]string
	// Columns is how many columns the rows use.
	Columns int
	// Limited says the sheet holds more rows or columns than were asked
	// for, so Rows is not all of it.
	Limited bool
}

// XlsxSheet reads the first worksheet of a .xlsx workbook: shared strings
// resolved, booleans as TRUE and FALSE, and numbers and formula results as
// the file stores them, which is a serial number for a date that carries a
// date format. maxRows and maxColumns bound what is read; the sheet says
// when it held more.
func XlsxSheet(data []byte, maxRows, maxColumns int) (Sheet, error) {
	if maxRows < 1 || maxColumns < 1 {
		return Sheet{}, fmt.Errorf("%w: no limits", ErrFormat)
	}
	zr, err := openArchive(data)
	if err != nil {
		return Sheet{}, err
	}
	// A workbook without shared strings is plain: its cells hold their own.
	var shared []string
	if part, err := readPart(zr, sharedStringsPart); err == nil {
		shared = sharedStrings(part)
	} else if !errors.Is(err, ErrFormat) {
		return Sheet{}, err
	}
	part, err := firstSheetPart(zr)
	if err != nil {
		return Sheet{}, err
	}
	return sheetRows(part, shared, maxRows, maxColumns)
}

// firstSheetPart follows workbook order; worksheet file names need not match it.
func firstSheetPart(zr *zip.Reader) ([]byte, error) {
	part, err := readPart(zr, workbookPart)
	if err != nil {
		return nil, err
	}
	var workbook struct {
		Sheets []struct {
			ID string `xml:"id,attr"`
		} `xml:"sheets>sheet"`
	}
	if err := xml.Unmarshal(part, &workbook); err != nil {
		return nil, fmt.Errorf("%w: workbook: %v", ErrFormat, err)
	}
	if len(workbook.Sheets) == 0 || workbook.Sheets[0].ID == "" {
		return nil, fmt.Errorf("%w: no first worksheet", ErrFormat)
	}
	part, err = readPart(zr, workbookRelsPart)
	if err != nil {
		return nil, err
	}
	var relationships struct {
		Items []struct {
			ID         string `xml:"Id,attr"`
			Type       string `xml:"Type,attr"`
			Target     string `xml:"Target,attr"`
			TargetMode string `xml:"TargetMode,attr"`
		} `xml:"Relationship"`
	}
	if err := xml.Unmarshal(part, &relationships); err != nil {
		return nil, fmt.Errorf("%w: workbook relationships: %v", ErrFormat, err)
	}
	for _, rel := range relationships.Items {
		if rel.ID != workbook.Sheets[0].ID {
			continue
		}
		if rel.Target == "" || !strings.HasSuffix(rel.Type, "/worksheet") || (rel.TargetMode != "" && rel.TargetMode != "Internal") {
			return nil, fmt.Errorf("%w: first sheet is not an internal worksheet", ErrFormat)
		}
		name := path.Clean(strings.TrimPrefix(rel.Target, "/"))
		if !strings.HasPrefix(rel.Target, "/") {
			name = path.Join(path.Dir(workbookPart), rel.Target)
		}
		if name == ".." || strings.HasPrefix(name, "../") {
			return nil, fmt.Errorf("%w: worksheet target outside archive", ErrFormat)
		}
		return readPart(zr, name)
	}
	return nil, fmt.Errorf("%w: first worksheet relationship missing", ErrFormat)
}

// sheetRows reads a worksheet part.
func sheetRows(part []byte, shared []string, maxRows, maxColumns int) (Sheet, error) {
	dec := xml.NewDecoder(bytes.NewReader(part))
	var sheet Sheet
	var row []string
	column := 0
	kind, cell := "", ""
	inCell := false
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return sheet, fmt.Errorf("%w: %v", ErrFormat, err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				at := len(sheet.Rows) + 1
				if raw := attribute(t, "r"); raw != "" {
					at, err = strconv.Atoi(raw)
					if err != nil || at <= len(sheet.Rows) {
						return sheet, fmt.Errorf("%w: invalid row number %q", ErrFormat, raw)
					}
				}
				for len(sheet.Rows) < min(at-1, maxRows) {
					sheet.Rows = append(sheet.Rows, nil)
				}
				if at > maxRows {
					sheet.Limited = true
					return sheet, nil
				}
				row, column = nil, 0
			case "c":
				kind, cell, inCell = attribute(t, "t"), "", true
				if at, ok := cellColumn(attribute(t, "r")); ok {
					column = at
				}
			case "v", "t":
				value, err := elementText(dec, t)
				if err != nil {
					return sheet, err
				}
				if inCell {
					cell += value
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "c":
				if !inCell {
					continue
				}
				inCell = false
				if column < maxColumns {
					row = placeCell(row, column, cellText(kind, cell, shared))
					sheet.Columns = max(sheet.Columns, column+1)
				} else {
					sheet.Limited = true
				}
				column++
			case "row":
				sheet.Rows = append(sheet.Rows, row)
				row = nil
			}
		}
	}
	return sheet, nil
}

// sharedStrings reads a workbook's strings, rich text runs joined.
func sharedStrings(part []byte) []string {
	dec := xml.NewDecoder(bytes.NewReader(part))
	var out []string
	var run strings.Builder
	// inItem says the walk is inside an <si>; phonetic runs (furigana) are
	// not the cell's text and stay out.
	inItem, inPhonetic := false, false
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "si":
				inItem = true
				run.Reset()
			case "rPh":
				inPhonetic = true
			case "t":
				value, err := elementText(dec, t)
				if err == nil && inItem && !inPhonetic {
					run.WriteString(value)
				}
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "si":
				if inItem {
					out = append(out, run.String())
					inItem = false
				}
			case "rPh":
				inPhonetic = false
			}
		}
	}
	return out
}

// cellText is one cell's value as a preview shows it.
func cellText(kind, raw string, shared []string) string {
	switch kind {
	case "s":
		index, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || index < 0 || index >= len(shared) {
			return ""
		}
		return clip(shared[index], maxCellBytes)
	case "b":
		switch strings.TrimSpace(raw) {
		case "1":
			return "TRUE"
		case "0":
			return "FALSE"
		}
		return clip(strings.TrimSpace(raw), maxCellBytes)
	default:
		return clip(strings.TrimSpace(raw), maxCellBytes)
	}
}

// placeCell puts value at column, padding the columns before it.
func placeCell(row []string, column int, value string) []string {
	for len(row) < column {
		row = append(row, "")
	}
	return append(row, value)
}

// cellColumn reads the column a cell reference names ("B12" is 1).
func cellColumn(ref string) (int, bool) {
	column := 0
	for _, r := range ref {
		switch {
		case r >= 'A' && r <= 'Z':
			column = column*26 + int(r-'A') + 1
		case r >= 'a' && r <= 'z':
			column = column*26 + int(r-'a') + 1
		default:
			return column - 1, column > 0
		}
	}
	return column - 1, column > 0
}

// attribute returns the named attribute of an element, "" when it has none.
func attribute(start xml.StartElement, name string) string {
	for _, attr := range start.Attr {
		if attr.Name.Local == name {
			return attr.Value
		}
	}
	return ""
}
