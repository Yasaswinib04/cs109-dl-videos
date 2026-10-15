import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx, readHtmlTable, looksLikeHtml, decodeEntities, colToIndex } from '../src/workbook.js';

/* A minimal zip writer, so the xlsx tests exercise the real byte layout
 * rather than a mock. `deflate` picks the compressed path. */
async function zip(files, deflate = false) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    let body = raw, method = 0;
    if (deflate) {
      const s = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      body = new Uint8Array(await new Response(s).arrayBuffer());
      method = 8;
    }
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    chunks.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }

  const cdBytes = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdBytes, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out.buffer;
}

const sheet = body => `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`;

test('reads a shared-string xlsx, stored and deflated alike', async () => {
  const files = {
    'xl/sharedStrings.xml': '<sst><si><t>Date</t></si><si><t>Narration</t></si></sst>',
    'xl/worksheets/sheet1.xml': sheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2"><v>45748</v></c><c r="B2" t="inlineStr"><is><t>UPI/Swiggy</t></is></c></row>'),
  };
  for (const deflate of [false, true]) {
    const rows = await readXlsx(await zip(files, deflate));
    assert.deepEqual(rows[0], ['Date', 'Narration']);
    assert.deepEqual(rows[1], [45748, 'UPI/Swiggy']);
  }
});

test('a gap in row numbers is preserved, so a header keeps its distance', async () => {
  const rows = await readXlsx(await zip({
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="str"><v>top</v></c></row>' +
                                      '<row r="4"><c r="A4" t="str"><v>data</v></c></row>'),
  }));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], ['top']);
  assert.deepEqual(rows[3], ['data']);
});

test('a skipped column leaves a blank, not a shifted row', async () => {
  const rows = await readXlsx(await zip({
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="str"><v>a</v></c><c r="C1" t="str"><v>c</v></c></row>'),
  }));
  assert.deepEqual(rows[0], ['a', '', 'c']);
});

test('the workbook names which sheet is first, not the filename', async () => {
  const rows = await readXlsx(await zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Txns" sheetId="2" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Target="worksheets/sheet4.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="str"><v>wrong</v></c></row>'),
    'xl/worksheets/sheet4.xml': sheet('<row r="1"><c r="A1" t="str"><v>right</v></c></row>'),
  }));
  assert.deepEqual(rows[0], ['right']);
});

test('a run-split shared string is joined back together', async () => {
  const rows = await readXlsx(await zip({
    'xl/sharedStrings.xml': '<sst><si><r><t>UPI/</t></r><r><t>Zepto</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
  }));
  assert.deepEqual(rows[0], ['UPI/Zepto']);
});

test('an HTML table named .xls is recognised and read', () => {
  const html = `<html><body><table><tr><td>Date</td><td>Amount</td></tr>
    <tr><td>01/04/2026</td><td>1,299.00</td></tr></table></body></html>`;
  assert.ok(looksLikeHtml(html));
  assert.deepEqual(readHtmlTable(html), [['Date', 'Amount'], ['01/04/2026', '1,299.00']]);
});

test('the data table wins over the layout table wrapping it', () => {
  const html = `<table><tr><td>logo</td></tr></table>
    <table><tr><th>Date</th><th>Narration</th></tr><tr><td>01/04</td><td>UPI/Blinkit</td></tr></table>`;
  assert.deepEqual(readHtmlTable(html), [['Date', 'Narration'], ['01/04', 'UPI/Blinkit']]);
});

test('entities and markup inside a cell are resolved, not carried through', () => {
  const html = '<table><tr><td>A&amp;B<br>Ltd</td><td>&#8377;50</td></tr></table>';
  assert.deepEqual(readHtmlTable(html), [['A&B Ltd', '₹50']]);
});

test('a plain CSV is not mistaken for HTML', () => {
  assert.equal(looksLikeHtml('Date,Narration,Amount\n01/04/2026,UPI/Swiggy,389'), false);
});

test('column letters map to indices past Z', () => {
  assert.equal(colToIndex('A'), 0);
  assert.equal(colToIndex('Z'), 25);
  assert.equal(colToIndex('AA'), 26);
  assert.equal(colToIndex('BC'), 54);
});

test('decodeEntities leaves an unknown entity alone rather than eating it', () => {
  assert.equal(decodeEntities('a &frobnicate; b &amp; c'), 'a &frobnicate; b & c');
});
