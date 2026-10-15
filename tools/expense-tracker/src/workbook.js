/**
 * Reading a spreadsheet without depending on the network.
 *
 * This used to load SheetJS from a CDN. That works until it doesn't: a blocked
 * CDN, an offline laptop or a strict content policy and the import silently
 * stops working, which is the one failure mode a tool like this cannot afford -
 * the file is right there and the page claims it cannot read it.
 *
 * So the two formats banks actually hand out are parsed here, natively:
 *
 *   - .xlsx - a zip of XML. Browsers and Node both ship DecompressionStream
 *     now, so inflating it needs no library, only the zip layout.
 *   - .xls that is secretly an HTML table - what ICICI, HDFC and several others
 *     export. It has never been a real Excel file; only the extension says so.
 *
 * A genuine BIFF8 .xls (the old binary format) is NOT handled. It is rare from
 * net banking today, and half-reading one would be worse than saying plainly
 * that it cannot be read.
 */

/* ------------------------------------------------------------------- zip */

const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Entries of a zip, by name. Only the members asked for are inflated. */
export async function unzip(buf) {
  const b = new Uint8Array(buf);
  const v = dv(b);
  // The end-of-central-directory record is last, after a comment of unknown
  // length, so it is found by scanning back for its signature.
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 65557; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip');

  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = v.getUint16(p + 10, true);
    const compressed = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localAt = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));

    // Sizes in the local header can be zero when a data descriptor follows, so
    // the central directory is the authority; only the lengths are read here.
    const lNameLen = v.getUint16(localAt + 26, true);
    const lExtraLen = v.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;

    out.set(name, { method, bytes: b.subarray(start, start + compressed) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(entry) {
  if (!entry) return null;
  if (entry.method === 0) return new TextDecoder().decode(entry.bytes);
  if (entry.method !== 8) throw new Error('unsupported compression');
  const stream = new Blob([entry.bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/* ------------------------------------------------------------------- xml */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of every <t> in a fragment, joined - a string can be split into runs. */
const textOf = xml => [...String(xml).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
  .map(m => decodeEntities(m[1])).join('');

/** "BC" -> 54. Column letters are base-26 with no zero. */
export function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ------------------------------------------------------------------ xlsx */

export async function readXlsx(buf) {
  const zip = await unzip(buf);

  const shared = [];
  const sharedXml = await inflate(zip.get('xl/sharedStrings.xml'));
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  }

  // The first sheet in the workbook's own order, not whatever sorts first by
  // filename: sheet1.xml is not reliably the sheet the bank put the rows in.
  let path = 'xl/worksheets/sheet1.xml';
  const wb = await inflate(zip.get('xl/workbook.xml'));
  const rid = wb && /<sheets>[\s\S]*?<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1];
  if (rid) {
    const rels = await inflate(zip.get('xl/_rels/workbook.xml.rels'));
    const target = rels && new RegExp(`<Relationship[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1];
    if (target) path = target.startsWith('/') ? target.slice(1)
      : target.startsWith('xl/') ? target : `xl/${target}`;
  }
  const sheet = await inflate(zip.get(path)) ?? await inflate(zip.get('xl/worksheets/sheet1.xml'));
  if (!sheet) throw new Error('no worksheet');

  const rows = [];
  for (const rowM of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const declared = /\br="(\d+)"/.exec(rowM[1])?.[1];
    const cells = [];
    for (const cM of rowM[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1], body = cM[2] || '';
      const at = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];

      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'str' || type === 'e') value = decodeEntities(raw ?? '');
      else if (type === 'b') value = raw === '1';
      else if (raw != null && raw !== '') {
        const n = Number(raw);
        value = Number.isFinite(n) ? n : decodeEntities(raw);
      }

      const i = at ? colToIndex(at) : cells.length;
      while (cells.length < i) cells.push('');
      cells[i] = value;
    }
    // Empty rows are omitted from the file entirely; keep the row numbers
    // aligned so a header two rows above its data stays two rows above it.
    const target = declared ? Number(declared) - 1 : rows.length;
    while (rows.length < target) rows.push([]);
    rows[target] = cells;
  }
  return rows;
}

/* ------------------------------------------------- .xls that is really HTML */

const HTML_HEAD = /^\s*(?:﻿)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!doctype html|<html|<table|<meta)/i;

export function looksLikeHtml(text) {
  return HTML_HEAD.test(String(text).slice(0, 2000));
}

/** Rows of the largest <table> in an HTML export. */
export function readHtmlTable(text) {
  const tables = [...String(text).matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(m => m[0]);
  if (!tables.length) return null;

  const parse = table => [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(tr =>
    [...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(td =>
      decodeEntities(td[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()));

  // Statement exports often wrap the real table in a layout table; the one with
  // the most cells is the data.
  const best = tables.map(parse).sort((a, b) =>
    b.reduce((n, r) => n + r.length, 0) - a.reduce((n, r) => n + r.length, 0))[0];
  return best && best.length ? best : null;
}
