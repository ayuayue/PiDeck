package officedoc

import (
	"archive/zip"
	"bytes"
	"errors"
	"strings"
	"testing"
)

// archive builds the bytes of a zipped document holding parts.
func archive(t *testing.T, parts map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range parts {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestDocxText(t *testing.T) {
	body := `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>
<w:p><w:r><w:t>Second</w:t><w:tab/><w:t>column</w:t></w:r></w:p>
<w:tbl><w:tr>
<w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p><w:p><w:r><w:t>B1 again</w:t></w:r></w:p></w:tc>
</w:tr></w:tbl>
<w:p><w:r><w:delText>deleted</w:delText><w:t>Kept</w:t></w:r></w:p>
</w:body></w:document>`
	got, err := DocxText(archive(t, map[string]string{"word/document.xml": body}))
	if err != nil {
		t.Fatal(err)
	}
	want := "Hello world\nSecond\tcolumn\nA1 | B1 B1 again\nKept"
	if got != want {
		t.Errorf("DocxText = %q, want %q", got, want)
	}
}

func TestDocxTextRefusesNonDocuments(t *testing.T) {
	if _, err := DocxText([]byte("this is not a zip")); !errors.Is(err, ErrFormat) {
		t.Errorf("error = %v, want ErrFormat", err)
	}
	empty := archive(t, map[string]string{"word/styles.xml": "<styles/>"})
	if _, err := DocxText(empty); !errors.Is(err, ErrFormat) {
		t.Errorf("missing body error = %v, want ErrFormat", err)
	}
}

func TestXlsxSheet(t *testing.T) {
	shared := `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>Name</t></si>
<si><r><t>Bo</t></r><r><t>b</t></r></si>
<si><t>名前</t><rPh sb="0" eb="2"><t>なまえ</t></rPh></si>
</sst>`
	sheet := `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c><c r="B2"><v>42</v></c></row>
<row r="3"><c r="B3" t="b"><v>1</v></c></row>
</sheetData></worksheet>`
	data := archive(t, map[string]string{
		"xl/workbook.xml":            testXLSXWorkbook,
		"xl/_rels/workbook.xml.rels": testXLSXRelationships,
		"xl/sharedStrings.xml":       shared,
		"xl/worksheets/sheet1.xml":   sheet,
	})
	got, err := XlsxSheet(data, 100, 48)
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{
		{"Name", "Bob", "名前"},
		{"Ada", "42"},
		{"", "TRUE"},
	}
	if len(got.Rows) != len(want) {
		t.Fatalf("rows = %q, want %q", got.Rows, want)
	}
	for i := range want {
		if strings.Join(got.Rows[i], "\x00") != strings.Join(want[i], "\x00") {
			t.Errorf("row %d = %q, want %q", i, got.Rows[i], want[i])
		}
	}
	if got.Columns != 3 {
		t.Errorf("columns = %d, want 3", got.Columns)
	}
	if got.Limited {
		t.Error("limited = true, want false")
	}
}

func TestXlsxSheetLimits(t *testing.T) {
	sheet := `<worksheet><sheetData>
<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>
<row r="2"><c r="A2"><v>3</v></c></row>
</sheetData></worksheet>`
	data := archive(t, map[string]string{
		"xl/workbook.xml":            testXLSXWorkbook,
		"xl/_rels/workbook.xml.rels": testXLSXRelationships,
		"xl/worksheets/sheet1.xml":   sheet,
	})

	rows, err := XlsxSheet(data, 1, 48)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows.Rows) != 1 || !rows.Limited {
		t.Errorf("row limit: %d rows, limited %v", len(rows.Rows), rows.Limited)
	}

	columns, err := XlsxSheet(data, 10, 1)
	if err != nil {
		t.Fatal(err)
	}
	if columns.Columns != 1 || !columns.Limited {
		t.Errorf("column limit: %d columns, limited %v", columns.Columns, columns.Limited)
	}
}

func TestXlsxSheetRefusesNonWorkbooks(t *testing.T) {
	if _, err := XlsxSheet([]byte("nope"), 10, 10); !errors.Is(err, ErrFormat) {
		t.Errorf("error = %v, want ErrFormat", err)
	}
	doc := archive(t, map[string]string{"word/document.xml": "<w:document/>"})
	if _, err := XlsxSheet(doc, 10, 10); !errors.Is(err, ErrFormat) {
		t.Errorf("missing sheet error = %v, want ErrFormat", err)
	}
}

func TestCellColumn(t *testing.T) {
	cases := []struct {
		ref   string
		index int
		ok    bool
	}{
		{"A1", 0, true},
		{"B12", 1, true},
		{"Z9", 25, true},
		{"AA1", 26, true},
		{"ab3", 27, true},
		{"", -1, false},
		{"1", -1, false},
	}
	for _, c := range cases {
		index, ok := cellColumn(c.ref)
		if index != c.index || ok != c.ok {
			t.Errorf("cellColumn(%q) = %d, %v, want %d, %v", c.ref, index, ok, c.index, c.ok)
		}
	}
}
