package officedoc

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

const testXLSXWorkbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="First" sheetId="1" r:id="rId1"/></sheets></workbook>`
const testXLSXRelationships = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`

func TestXlsxSheetWorkbookOrder(t *testing.T) {
	for _, target := range []string{"worksheets/sheet2.xml", "/xl/worksheets/sheet2.xml", "worksheets/../worksheets/sheet2.xml"} {
		t.Run(target, func(t *testing.T) {
			workbook := `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Second" sheetId="2" r:id="rId2"/><sheet name="First" sheetId="1" r:id="rId1"/></sheets></workbook>`
			relationships := strings.Replace(testXLSXRelationships, "</Relationships>", `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="`+target+`"/></Relationships>`, 1)
			data := archive(t, map[string]string{
				"xl/workbook.xml":            workbook,
				"xl/_rels/workbook.xml.rels": relationships,
				"xl/worksheets/sheet1.xml":   `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c></row></sheetData></worksheet>`,
				"xl/worksheets/sheet2.xml":   `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>B</t></is></c></row></sheetData></worksheet>`,
			})
			got, err := XlsxSheet(data, 10, 10)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got.Rows, [][]string{{"B"}}) {
				t.Errorf("rows = %q, want the first workbook sheet B", got.Rows)
			}
		})
	}
}

func TestXlsxSheetRefusesBrokenRelationships(t *testing.T) {
	for _, tc := range []struct {
		name, workbook, relationships string
	}{
		{"missing workbook", "", testXLSXRelationships},
		{"malformed workbook", "<workbook>", testXLSXRelationships},
		{"empty workbook", "<workbook><sheets/></workbook>", testXLSXRelationships},
		{"missing relationships", testXLSXWorkbook, ""},
		{"malformed relationships", testXLSXWorkbook, "<Relationships>"},
		{"missing sheet relationship", strings.Replace(testXLSXWorkbook, "rId1", "missing", 1), testXLSXRelationships},
		{"missing sheet part", testXLSXWorkbook, strings.Replace(testXLSXRelationships, "sheet1.xml", "missing.xml", 1)},
		{"external sheet", testXLSXWorkbook, strings.Replace(testXLSXRelationships, `Target=`, `TargetMode="External" Target=`, 1)},
		{"wrong relationship type", testXLSXWorkbook, strings.Replace(testXLSXRelationships, "/worksheet", "/styles", 1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parts := map[string]string{"xl/worksheets/sheet1.xml": "<worksheet><sheetData/></worksheet>"}
			if tc.workbook != "" {
				parts["xl/workbook.xml"] = tc.workbook
			}
			if tc.relationships != "" {
				parts["xl/_rels/workbook.xml.rels"] = tc.relationships
			}
			if _, err := XlsxSheet(archive(t, parts), 10, 10); !errors.Is(err, ErrFormat) {
				t.Errorf("error = %v, want ErrFormat without selecting a different sheet", err)
			}
		})
	}
}

func TestXlsxSheetSparseRows(t *testing.T) {
	for _, tc := range []struct {
		name, rows string
		limit      int
		want       [][]string
		limited    bool
	}{
		{"interior gap", `<row r="1"><c r="A1"><v>A</v></c></row><row r="3"><c r="A3"><v>B</v></c></row>`, 5, [][]string{{"A"}, nil, {"B"}}, false},
		{"limit inside gap", `<row r="1"><c r="A1"><v>A</v></c></row><row r="3"><c r="A3"><v>B</v></c></row>`, 2, [][]string{{"A"}, nil}, true},
		{"leading gap", `<row r="3"><c r="A3"><v>A</v></c></row>`, 5, [][]string{nil, nil, {"A"}}, false},
		{"large gap bounded", `<row r="1000000"><c r="A1000000"><v>A</v></c></row>`, 2, [][]string{nil, nil}, true},
		{"omitted row numbers", `<row><c r="A1"><v>A</v></c></row><row><c r="A2"><v>B</v></c></row>`, 5, [][]string{{"A"}, {"B"}}, false},
		{"omitted after gap", `<row r="3"><c r="A3"><v>A</v></c></row><row><c r="A4"><v>B</v></c></row>`, 5, [][]string{nil, nil, {"A"}, {"B"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := archive(t, map[string]string{
				"xl/workbook.xml":            testXLSXWorkbook,
				"xl/_rels/workbook.xml.rels": testXLSXRelationships,
				"xl/worksheets/sheet1.xml":   "<worksheet><sheetData>" + tc.rows + "</sheetData></worksheet>",
			})
			got, err := XlsxSheet(data, tc.limit, 10)
			if err != nil {
				t.Fatal(err)
			}
			columns := 0
			for _, row := range tc.want {
				columns = max(columns, len(row))
			}
			if !reflect.DeepEqual(got.Rows, tc.want) || got.Limited != tc.limited || got.Columns != columns {
				t.Errorf("sheet = %+v, want rows=%q columns=%d limited=%v", got, tc.want, columns, tc.limited)
			}
		})
	}
}

func TestXlsxSheetRefusesInvalidRowNumbers(t *testing.T) {
	for _, rows := range []string{
		`<row r="0"/>`,
		`<row r="-1"/>`,
		`<row r="invalid"/>`,
		`<row r="1"/><row r="1"/>`,
		`<row r="2"/><row r="1"/>`,
	} {
		t.Run(rows, func(t *testing.T) {
			data := archive(t, map[string]string{
				"xl/workbook.xml":            testXLSXWorkbook,
				"xl/_rels/workbook.xml.rels": testXLSXRelationships,
				"xl/worksheets/sheet1.xml":   "<worksheet><sheetData>" + rows + "</sheetData></worksheet>",
			})
			if _, err := XlsxSheet(data, 10, 10); !errors.Is(err, ErrFormat) {
				t.Errorf("error = %v, want ErrFormat", err)
			}
		})
	}
}
