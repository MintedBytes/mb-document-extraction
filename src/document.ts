/*
 * Die Datei als Sammlung von Objekten, und daraus die Seiten in ihrer
 * Reihenfolge.
 *
 * ── Warum die Objekte gesucht und nicht über die Querverweistabelle gelesen
 * werden ──
 *
 * Weil die Tabelle der Teil ist, der in freier Wildbahn am häufigsten kaputt
 * ist: falsche Offsets nach einer Reparatur, mehrere Aktualisierungen
 * hintereinander, Querverweisströme neben klassischen Tabellen. Ein Leser, der
 * ihr folgt, gibt bei solchen Dateien auf — ein Leser, der die Objekte selbst
 * sucht, liest sie.
 *
 * Bezahlt wird das mit einem Durchlauf über die ganze Datei. Bei einem Beleg
 * von wenigen hundert Kilobyte ist das nichts.
 *
 * ── Die Reihenfolge der Seiten kommt trotzdem aus dem Baum ──
 *
 * Objekte stehen in der Datei in beliebiger Reihenfolge; Seite 7 kann vor
 * Seite 1 liegen. Deshalb wird ab dem Katalog gelaufen. Nur wenn es keinen
 * gibt, bleibt die Reihenfolge der Ströme — mit einem Hinweis, denn dann ist
 * sie geraten.
 */
import { Lexer, PdfError, inflate, latin1, type PdfValue } from './pdf.ts'

export interface PdfPage {
  /** Die entpackten Inhaltsströme dieser Seite, hintereinander. */
  readonly content: Uint8Array
  /** Die Schriften der Seite: Name im Inhaltsstrom auf die Zeichentabelle. */
  readonly fonts: Map<string, ToUnicode>
  /** Drehung in Grad, wie sie im Seitenobjekt steht. */
  readonly rotation: number
}

/** Bytefolgen einer Schrift auf lesbaren Text. Leer: unverändert übernehmen. */
export type ToUnicode = { readonly map: Map<number, string>; readonly twoByte: boolean }

export interface PdfDocument {
  readonly pages: PdfPage[]
  /** Was beim Lesen auffiel und das Ergebnis erklärt. */
  readonly notes: string[]
}

/** Liest die Struktur eines PDFs so weit, dass sein Text zugänglich ist. */
export async function readDocument(bytes: Uint8Array): Promise<PdfDocument> {
  const head = latin1(bytes.subarray(0, 1024))
  if (!head.includes('%PDF-')) {
    throw new PdfError('document.not_a_pdf', 'Die Datei beginnt nicht mit einem PDF-Kopf.')
  }
  const objects = scanObjects(bytes)
  if (hasEncryption(bytes, objects)) {
    throw new PdfError('document.encrypted', 'Das PDF ist verschlüsselt. Ein geschütztes Dokument wird nicht geraten.')
  }
  const notes: string[] = []
  await expandObjectStreams(bytes, objects, notes)

  const pages = await collectPages(bytes, objects, notes)
  return { pages, notes }
}

/** Ein Objekt der Datei: entweder roh in den Bytes oder aus einem Objektstrom. */
type Entry = { value: PdfValue; source: Uint8Array }

type Objects = Map<number, Entry>

/**
 * Sucht `N G obj` in der ganzen Datei.
 *
 * Bei mehreren Fassungen desselben Objekts (eine Datei, die mehrfach
 * fortgeschrieben wurde) gewinnt die SPÄTERE: Sie steht weiter hinten, und
 * genau so liest auch die Querverweistabelle.
 */
function scanObjects(bytes: Uint8Array): Objects {
  const text = latin1(bytes)
  const objects: Objects = new Map()
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const num = Number(match[1])
    const lexer = new Lexer(bytes, match.index + match[0].length)
    const value = lexer.value()
    if (value) objects.set(num, { value, source: bytes })
  }
  return objects
}

function hasEncryption(bytes: Uint8Array, objects: Objects): boolean {
  if (!latin1(bytes.subarray(Math.max(0, bytes.length - 4096))).includes('/Encrypt')) {
    // Der Verweis steht im Nachspann; fehlt er dort, kann eine Zeichenkette
    // irgendwo im Dokument trotzdem „/Encrypt" enthalten. Deshalb nur hier.
    return false
  }
  for (const entry of objects.values()) {
    const dict = dictOf(entry.value)
    if (dict?.has('CF') || dict?.has('Filter') && dict.get('Filter')?.kind === 'name' && name(dict.get('Filter')) === 'Standard') return true
  }
  return true
}

function dictOf(value: PdfValue | undefined): Map<string, PdfValue> | null {
  if (!value) return null
  if (value.kind === 'dict' || value.kind === 'stream') return value.entries
  return null
}

function name(value: PdfValue | undefined): string {
  return value?.kind === 'name' ? value.value : ''
}

function num(value: PdfValue | undefined): number {
  return value?.kind === 'number' ? value.value : 0
}

/** Folgt Verweisen, bis ein Wert dasteht. */
function resolve(objects: Objects, value: PdfValue | undefined, depth = 0): PdfValue | undefined {
  if (!value || depth > 32) return value
  if (value.kind !== 'ref') return value
  return resolve(objects, objects.get(value.num)?.value, depth + 1)
}

/** Die Bytes eines Stroms, entpackt, oder `null` bei unbekanntem Filter. */
async function streamBytes(objects: Objects, entry: Entry): Promise<Uint8Array | null> {
  const value = entry.value
  if (value.kind !== 'stream') return null
  const length = resolve(objects, value.entries.get('Length'))
  let end = value.start + num(length)
  if (!(num(length) > 0) || end > entry.source.length) {
    // Ohne brauchbare Länge bis `endstream` lesen. Das ist der Fall, für den
    // eine kaputte Länge sonst den ganzen Rest der Datei mitnähme.
    const from = latin1(entry.source.subarray(value.start)).indexOf('endstream')
    if (from < 0) return null
    end = value.start + from
  }
  const raw = entry.source.subarray(value.start, end)

  const filters: string[] = []
  const filter = resolve(objects, value.entries.get('Filter'))
  if (filter?.kind === 'name') filters.push(filter.value)
  if (filter?.kind === 'array') for (const item of filter.items) filters.push(name(resolve(objects, item)))
  if (filters.length === 0) return raw
  if (filters.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl')) {
    const out = await inflate(raw)
    if (!out) return null
    // Vorhersagefilter kommen bei Inhaltsströmen praktisch nicht vor; wo doch,
    // liefert das Entpacken Bytes, die kein Operator sind, und die Seite bleibt
    // leer statt falsch.
    return out
  }
  return null
}

/**
 * Objektströme aufmachen (PDF 1.5). Ohne sie fehlen in neueren Dateien
 * ausgerechnet die Objekte, die der Seitenbaum braucht.
 */
async function expandObjectStreams(bytes: Uint8Array, objects: Objects, notes: string[]): Promise<void> {
  let failed = 0
  for (const entry of [...objects.values()]) {
    if (entry.value.kind !== 'stream' || name(resolve(objects, entry.value.entries.get('Type'))) !== 'ObjStm') continue
    const data = await streamBytes(objects, entry)
    if (!data) {
      failed++
      continue
    }
    const count = num(resolve(objects, entry.value.entries.get('N')))
    const first = num(resolve(objects, entry.value.entries.get('First')))
    const header = new Lexer(data, 0)
    const pairs: Array<[number, number]> = []
    for (let i = 0; i < count; i++) {
      const objectNumber = header.value()
      const offset = header.value()
      if (objectNumber?.kind !== 'number' || offset?.kind !== 'number') break
      pairs.push([objectNumber.value, offset.value])
    }
    for (const [objectNumber, offset] of pairs) {
      // Was roh in der Datei steht, ist die spätere Fassung und bleibt.
      if (objects.has(objectNumber)) continue
      const lexer = new Lexer(data, first + offset)
      const value = lexer.value()
      if (value) objects.set(objectNumber, { value, source: data })
    }
  }
  if (failed > 0) notes.push(`${failed} Objektströme ließen sich nicht entpacken; Teile des Dokuments fehlen dadurch.`)
}

/** Läuft den Seitenbaum ab dem Katalog; ohne Katalog bleiben die Ströme. */
async function collectPages(bytes: Uint8Array, objects: Objects, notes: string[]): Promise<PdfPage[]> {
  const catalog = [...objects.values()].find((entry) => name(resolve(objects, dictOf(entry.value)?.get('Type'))) === 'Catalog')
  const root = catalog ? resolve(objects, dictOf(catalog.value)?.get('Pages')) : undefined

  const leaves: Array<Map<string, PdfValue>> = []
  if (root) walkPages(objects, root, {}, leaves, 0)
  if (leaves.length === 0) {
    notes.push('Das Dokument hat keinen lesbaren Seitenbaum; die Seiten stehen in der Reihenfolge, in der sie in der Datei liegen.')
    return await pagesFromStreams(objects)
  }

  const pages: PdfPage[] = []
  for (const leaf of leaves) {
    pages.push({
      content: await contentOf(objects, leaf),
      fonts: await fontsOf(objects, leaf),
      rotation: ((num(resolve(objects, leaf.get('Rotate'))) % 360) + 360) % 360,
    })
  }
  return pages
}

/** Ein Knoten des Seitenbaums; erbbare Einträge reicht der Elternknoten weiter. */
function walkPages(
  objects: Objects,
  node: PdfValue,
  inherited: Record<string, PdfValue>,
  out: Array<Map<string, PdfValue>>,
  depth: number,
): void {
  if (depth > 64 || out.length > 500) return
  const dict = dictOf(node)
  if (!dict) return
  const carry = { ...inherited }
  for (const key of ['Resources', 'MediaBox', 'Rotate']) {
    const value = dict.get(key)
    if (value) carry[key] = value
  }
  const kids = resolve(objects, dict.get('Kids'))
  if (kids?.kind === 'array') {
    for (const kid of kids.items) {
      const child = resolve(objects, kid)
      if (child) walkPages(objects, child, carry, out, depth + 1)
    }
    return
  }
  if (name(resolve(objects, dict.get('Type'))) === 'Page' || dict.has('Contents')) {
    const merged = new Map(dict)
    for (const [key, value] of Object.entries(carry)) if (!merged.has(key)) merged.set(key, value)
    out.push(merged)
  }
}

/** Notnagel ohne Seitenbaum: jeder Strom, der wie ein Inhaltsstrom aussieht. */
async function pagesFromStreams(objects: Objects): Promise<PdfPage[]> {
  const pages: PdfPage[] = []
  for (const entry of objects.values()) {
    if (entry.value.kind !== 'stream') continue
    if (name(resolve(objects, entry.value.entries.get('Type'))) === 'ObjStm') continue
    const data = await streamBytes(objects, entry)
    if (!data) continue
    const text = latin1(data.subarray(0, 4096))
    if (!/\bBT\b/.test(text)) continue
    pages.push({ content: data, fonts: new Map(), rotation: 0 })
  }
  return pages
}

async function contentOf(objects: Objects, page: Map<string, PdfValue>): Promise<Uint8Array> {
  const contents = resolve(objects, page.get('Contents'))
  const refs = contents?.kind === 'array' ? contents.items : contents ? [page.get('Contents')!] : []
  const parts: Uint8Array[] = []
  for (const ref of refs) {
    const target = ref.kind === 'ref' ? objects.get(ref.num) : undefined
    const entry = target ?? (contents?.kind === 'stream' ? { value: contents, source: new Uint8Array() } : undefined)
    if (!entry) continue
    const data = await streamBytes(objects, entry as Entry)
    if (data) {
      parts.push(data)
      parts.push(new Uint8Array([0x0a])) // Zwei Ströme sind zwei Zeilen, nicht ein verschmolzener Operator.
    }
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Die Schriften einer Seite mit ihrer Zeichentabelle, soweit vorhanden. */
async function fontsOf(objects: Objects, page: Map<string, PdfValue>): Promise<Map<string, ToUnicode>> {
  const fonts = new Map<string, ToUnicode>()
  const resources = dictOf(resolve(objects, page.get('Resources')))
  const table = dictOf(resolve(objects, resources?.get('Font')))
  if (!table) return fonts
  for (const [key, value] of table) {
    const font = dictOf(resolve(objects, value))
    if (!font) continue
    const twoByte = name(resolve(objects, font.get('Subtype'))) === 'Type0'
    const unicodeRef = font.get('ToUnicode')
    const entry = unicodeRef?.kind === 'ref' ? objects.get(unicodeRef.num) : undefined
    if (!entry) {
      fonts.set(key, { map: new Map(), twoByte })
      continue
    }
    const data = await streamBytes(objects, entry)
    fonts.set(key, { map: data ? parseToUnicode(latin1(data)) : new Map(), twoByte })
  }
  return fonts
}

/**
 * Liest die Zeichentabelle einer Schrift (`bfchar` und `bfrange`).
 *
 * Ohne sie ergibt eine eingebettete Teilschrift Buchstabensalat: Der Erzeuger
 * darf seine Zeichen frei nummerieren, und viele tun das — der Code für „A" ist
 * dann 3, nicht 65. Die Tabelle ist die einzige Stelle, an der steht, was
 * gemeint war.
 */
export function parseToUnicode(source: string): Map<number, string> {
  const map = new Map<number, string>()
  const hex = (value: string) => parseInt(value, 16)
  const text = (value: string) => {
    let out = ''
    for (let i = 0; i + 3 < value.length + 1; i += 4) {
      const unit = parseInt(value.slice(i, i + 4), 16)
      if (Number.isFinite(unit)) out += String.fromCharCode(unit)
    }
    return out
  }

  for (const block of source.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(hex(pair[1]!), text(pair[2]!))
    }
  }
  for (const block of source.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    // Zwei Formen: Bereich auf einen Startwert, oder Bereich auf eine Liste.
    for (const entry of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
      const from = hex(entry[1]!)
      const to = hex(entry[2]!)
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 65535) continue
      if (entry[4]) {
        const start = entry[4]
        for (let code = from; code <= to; code++) {
          const shifted = (parseInt(start.slice(-4), 16) + (code - from)).toString(16).padStart(4, '0')
          map.set(code, text(start.slice(0, -4) + shifted))
        }
        continue
      }
      const list = [...(entry[5] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)]
      list.forEach((item, index) => map.set(from + index, text(item[1]!)))
    }
  }
  return map
}
