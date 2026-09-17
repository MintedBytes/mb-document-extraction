/*
 * So viel PDF, wie zum Lesen des Textes nötig ist — und keine Zeile mehr.
 *
 * ── Warum hier ein eigener Leser steht ──
 *
 * Ein Plugin läuft abgeschottet: keine Pakete aus dem Netz, kein fremder
 * Prozess, keine Datei auf der Platte. Eine der großen PDF-Bibliotheken kommt
 * hier also nicht herein. Was sie kann, brauchen wir auch nicht: Dieses Modul
 * rendert nichts, druckt nichts und kennt keine Formulare. Es beantwortet eine
 * einzige Frage — welcher Text steht wo auf dem Blatt.
 *
 * ── Was es kann ──
 *
 *   · Objekte und Ströme finden, auch in Objektströmen (PDF 1.5 und neuer)
 *   · FlateDecode über die eingebaute DecompressionStream
 *   · Seitenbaum ab dem Katalog, damit die Seiten in ihrer Reihenfolge stehen
 *   · /ToUnicode je Schrift, damit Teilschriften lesbaren Text ergeben
 *
 * ── Was es nicht kann, ausdrücklich ──
 *
 *   · Verschlüsselte Dateien. Sie werden erkannt und abgelehnt, nicht geraten.
 *   · Andere Filter als Flate (LZW, JBIG2, DCT). Solche Ströme werden
 *     übersprungen; was sie enthalten, ist fast immer ein Bild.
 *   · Seiten ohne Textebene. Ein Scan ist ein Bild — hier steht dann nichts,
 *     und der Aufrufer erfährt genau das, statt eine leere Seite zu bekommen.
 */

/** Ein PDF-Objekt in der Form, in der dieses Modul damit arbeitet. */
export type PdfValue =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: Uint8Array }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ref'; num: number }
  | { kind: 'array'; items: PdfValue[] }
  | { kind: 'dict'; entries: Map<string, PdfValue> }
  | { kind: 'stream'; entries: Map<string, PdfValue>; start: number; end: number }

export class PdfError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const DIGIT = /[0-9]/
const DELIMITER = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)))

function isSpace(byte: number): boolean {
  return byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20
}

function isRegular(byte: number): boolean {
  return !isSpace(byte) && !DELIMITER.has(byte)
}

/** Ein Leser über den Bytes einer Datei oder eines entpackten Stroms. */
export class Lexer {
  constructor(readonly bytes: Uint8Array, public pos = 0) {}

  skip(): void {
    for (;;) {
      while (this.pos < this.bytes.length && isSpace(this.bytes[this.pos]!)) this.pos++
      if (this.bytes[this.pos] !== 0x25) return // '%' beginnt einen Kommentar
      while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d) this.pos++
    }
  }

  /** Liest das nächste Objekt. Gibt `null` am Ende oder an einem Schlüsselwort. */
  value(): PdfValue | null {
    this.skip()
    if (this.pos >= this.bytes.length) return null
    const byte = this.bytes[this.pos]!

    if (byte === 0x2f) return { kind: 'name', value: this.name() }
    if (byte === 0x28) return { kind: 'string', value: this.literalString() }
    if (byte === 0x3c) {
      if (this.bytes[this.pos + 1] === 0x3c) return this.dictionary()
      return { kind: 'string', value: this.hexString() }
    }
    if (byte === 0x5b) return this.array()
    if (byte === 0x5d || byte === 0x3e) return null
    if (DIGIT.test(String.fromCharCode(byte)) || byte === 0x2b || byte === 0x2d || byte === 0x2e) return this.numberOrRef()

    const word = this.keyword()
    if (word === 'true') return { kind: 'bool', value: true }
    if (word === 'false') return { kind: 'bool', value: false }
    if (word === 'null') return { kind: 'null' }
    return null
  }

  /** Das nächste Schlüsselwort, etwa `obj`, `stream` oder ein Operator. */
  keyword(): string {
    this.skip()
    const start = this.pos
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) this.pos++
    if (this.pos === start) this.pos++ // Ein Trennzeichen ist selbst ein Zeichen.
    return latin1(this.bytes.subarray(start, this.pos))
  }

  private name(): string {
    this.pos++ // '/'
    const start = this.pos
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) this.pos++
    // `#xx` ist eine Maskierung im Namen; ohne sie hieße `/A#20B` nicht „A B".
    return latin1(this.bytes.subarray(start, this.pos)).replace(/#([0-9a-fA-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
  }

  private numberOrRef(): PdfValue {
    const first = this.number()
    const save = this.pos
    this.skip()
    // `12 0 R` ist ein Verweis; `12 0` sind zwei Zahlen. Nur das dritte Zeichen
    // entscheidet, also wird bis dahin gelesen und sonst zurückgesprungen.
    if (Number.isInteger(first) && first > 0 && this.pos < this.bytes.length && DIGIT.test(String.fromCharCode(this.bytes[this.pos]!))) {
      this.number()
      this.skip()
      if (this.bytes[this.pos] === 0x52) {
        this.pos++
        return { kind: 'ref', num: first }
      }
    }
    this.pos = save
    return { kind: 'number', value: first }
  }

  private number(): number {
    this.skip()
    const start = this.pos
    if (this.bytes[this.pos] === 0x2b || this.bytes[this.pos] === 0x2d) this.pos++
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos]!
      if (DIGIT.test(String.fromCharCode(byte)) || byte === 0x2e) this.pos++
      else break
    }
    const value = Number(latin1(this.bytes.subarray(start, this.pos)))
    return Number.isFinite(value) ? value : 0
  }

  private literalString(): Uint8Array {
    this.pos++ // '('
    const out: number[] = []
    let depth = 1
    while (this.pos < this.bytes.length) {
      const byte = this.bytes[this.pos++]!
      if (byte === 0x5c) {
        const next = this.bytes[this.pos++]!
        const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }
        if (simple[next] !== undefined) out.push(simple[next]!)
        else if (next >= 0x30 && next <= 0x37) {
          let code = next - 0x30
          for (let i = 0; i < 2; i++) {
            const digit = this.bytes[this.pos]!
            if (digit >= 0x30 && digit <= 0x37) {
              code = code * 8 + (digit - 0x30)
              this.pos++
            } else break
          }
          out.push(code & 0xff)
        } else if (next !== 0x0a && next !== 0x0d) out.push(next)
        continue
      }
      if (byte === 0x28) depth++
      if (byte === 0x29) {
        depth--
        if (depth === 0) break
      }
      out.push(byte)
    }
    return new Uint8Array(out)
  }

  private hexString(): Uint8Array {
    this.pos++ // '<'
    const digits: string[] = []
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3e) {
      const char = String.fromCharCode(this.bytes[this.pos++]!)
      if (/[0-9a-fA-F]/.test(char)) digits.push(char)
    }
    this.pos++ // '>'
    if (digits.length % 2) digits.push('0')
    const out = new Uint8Array(digits.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits[i * 2]! + digits[i * 2 + 1]!, 16)
    return out
  }

  private array(): PdfValue {
    this.pos++ // '['
    const items: PdfValue[] = []
    for (;;) {
      this.skip()
      if (this.pos >= this.bytes.length || this.bytes[this.pos] === 0x5d) {
        this.pos++
        break
      }
      const item = this.value()
      if (item === null) break
      items.push(item)
    }
    return { kind: 'array', items }
  }

  private dictionary(): PdfValue {
    this.pos += 2 // '<<'
    const entries = new Map<string, PdfValue>()
    for (;;) {
      this.skip()
      if (this.pos >= this.bytes.length) break
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2
        break
      }
      if (this.bytes[this.pos] !== 0x2f) {
        // Kein Name an einer Stelle, an der ein Schlüssel stehen muss: Der
        // Rest dieses Wörterbuchs ist nicht zu deuten, also hier abbrechen —
        // lieber ein unvollständiger Eintrag als ein erfundener.
        break
      }
      const key = this.name()
      const value = this.value()
      if (value !== null) entries.set(key, value)
    }
    // Folgt `stream`, gehören die Bytes dahinter dazu.
    const save = this.pos
    this.skip()
    if (latin1(this.bytes.subarray(this.pos, this.pos + 6)) === 'stream') {
      this.pos += 6
      if (this.bytes[this.pos] === 0x0d) this.pos++
      if (this.bytes[this.pos] === 0x0a) this.pos++
      return { kind: 'stream', entries, start: this.pos, end: -1 }
    }
    this.pos = save
    return { kind: 'dict', entries }
  }
}

export function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)))
  }
  return out
}

/** Entpackt einen Flate-Strom. Gibt `null` zurück, wenn das nicht gelingt. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  // Zuerst mit zlib-Kopf (so schreibt es der Standard), dann roh: manche
  // Erzeuger lassen den Kopf weg, und ein Fehlschlag hier wäre eine leere Seite.
  for (const format of ['deflate', 'deflate-raw'] as const) {
    try {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format))
      return new Uint8Array(await new Response(stream).arrayBuffer())
    } catch {
      continue
    }
  }
  return null
}
