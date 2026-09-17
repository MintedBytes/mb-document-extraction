/*
 * Vom Inhaltsstrom zu Textstücken mit Platz auf dem Blatt.
 *
 * Ein Inhaltsstrom ist eine Folge von Befehlen in umgekehrter polnischer
 * Notation: erst die Werte, dann der Operator. Für Text sind davon eine
 * Handvoll wichtig — wo die Schreibmarke steht, wie groß geschrieben wird und
 * was geschrieben wird. Alles andere (Linien, Flächen, Bilder) wird gelesen und
 * verworfen, damit die Zustandsstapel stimmen.
 *
 * ── Warum die Breite geschätzt wird ──
 *
 * Genau wäre sie nur mit den Metriken der eingebetteten Schrift — also mit
 * einem Schriftleser, der Glyphtabellen auspackt. Der Wert wird hier für zwei
 * Dinge gebraucht: um zu erkennen, dass zwischen zwei Stücken eine Lücke ist,
 * und um diese Lücke in Zeichen umzurechnen. Für beides genügt eine mittlere
 * Zeichenbreite, und der Fehler wirkt sich auf beide Seiten des Vergleichs
 * gleich aus. Ein Schriftleser für ein paar Prozent genauere Spaltenabstände
 * wäre der teuerste Teil dieses Plugins und der am leichtesten falsche.
 */
import { Lexer, latin1, type PdfValue } from './pdf.ts'
import type { ToUnicode } from './document.ts'
import type { TextPiece } from './layout.ts'

/** Mittlere Zeichenbreite als Anteil der Schriftgröße. */
const AVERAGE_CHAR = 0.5

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}

/** Zeichen aus den Bytes einer Zeichenkette, über die Tabelle der Schrift. */
function decode(bytes: Uint8Array, font: ToUnicode | undefined): string {
  if (!font || font.map.size === 0) {
    // Ohne Tabelle sind die Bytes ihre eigenen Zeichen. Das stimmt für die
    // eingebauten Schriften und für alles, was WinAnsi benutzt — also für den
    // größten Teil dessen, was ein Bürorechner erzeugt.
    return latin1(bytes)
  }
  let out = ''
  const step = font.twoByte ? 2 : 1
  for (let i = 0; i < bytes.length; i += step) {
    const code = step === 2 ? ((bytes[i]! << 8) | (bytes[i + 1] ?? 0)) : bytes[i]!
    out += font.map.get(code) ?? ''
  }
  return out
}

/**
 * Liest einen Inhaltsstrom und gibt zurück, welcher Text wo steht.
 *
 * Die Koordinaten sind die des Blattes (Ursprung unten links, Punkte). Sie
 * werden nicht normiert: Die Weiterverarbeitung vergleicht nur Abstände
 * untereinander, und jede Umrechnung wäre eine Gelegenheit, etwas zu verlieren.
 */
export function extractPieces(content: Uint8Array, fonts: Map<string, ToUnicode>): TextPiece[] {
  const lexer = new Lexer(content, 0)
  const pieces: TextPiece[] = []
  const operands: PdfValue[] = []

  let ctm: Matrix = [...IDENTITY]
  const stack: Matrix[] = []
  let tm: Matrix = [...IDENTITY]
  let tlm: Matrix = [...IDENTITY]
  let fontSize = 10
  let font: ToUnicode | undefined
  let leading = 0
  let charSpace = 0
  let wordSpace = 0
  let horizontal = 1
  let rise = 0

  const numberAt = (index: number): number => {
    const value = operands[operands.length - index]
    return value?.kind === 'number' ? value.value : 0
  }

  const show = (bytes: Uint8Array): void => {
    const text = decode(bytes, font)
    if (text.length === 0) return
    const trm = multiply(multiply([fontSize * horizontal, 0, 0, fontSize, 0, rise], tm), ctm)
    // Die wirksame Größe steckt in der Matrix: Ein Erzeuger darf 1 pt schreiben
    // und die Seite zwölffach skalieren.
    const size = Math.hypot(trm[2], trm[3]) || fontSize
    const width = text.length * AVERAGE_CHAR * size
    if (text.trim().length > 0) {
      pieces.push({ text, x: trm[4], y: trm[5], width, height: size })
    }
    const spaces = text.split(' ').length - 1
    const advance = (text.length * AVERAGE_CHAR * fontSize + charSpace * text.length + wordSpace * spaces) * horizontal
    tm = multiply([1, 0, 0, 1, advance, 0], tm)
  }

  const nextLine = (tx: number, ty: number): void => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm)
    tm = [...tlm]
  }

  for (;;) {
    lexer.skip()
    if (lexer.pos >= content.length) break
    const before = lexer.pos
    const value = lexer.value()
    if (value !== null) {
      operands.push(value)
      if (operands.length > 64) operands.shift()
      continue
    }
    // Kein Objekt an dieser Stelle: also ein Operator.
    lexer.pos = before
    const operator = lexer.keyword()
    switch (operator) {
      case 'q':
        stack.push([...ctm])
        break
      case 'Q':
        ctm = stack.pop() ?? [...IDENTITY]
        break
      case 'cm':
        ctm = multiply(
          [numberAt(6), numberAt(5), numberAt(4), numberAt(3), numberAt(2), numberAt(1)] as Matrix,
          ctm,
        )
        break
      case 'BT':
        tm = [...IDENTITY]
        tlm = [...IDENTITY]
        break
      case 'ET':
        break
      case 'Tf': {
        fontSize = numberAt(1)
        const key = operands[operands.length - 2]
        font = key?.kind === 'name' ? fonts.get(key.value) : undefined
        break
      }
      case 'Td':
        nextLine(numberAt(2), numberAt(1))
        break
      case 'TD':
        leading = -numberAt(1)
        nextLine(numberAt(2), numberAt(1))
        break
      case 'Tm':
        tlm = [numberAt(6), numberAt(5), numberAt(4), numberAt(3), numberAt(2), numberAt(1)] as Matrix
        tm = [...tlm]
        break
      case 'T*':
        nextLine(0, -leading)
        break
      case 'TL':
        leading = numberAt(1)
        break
      case 'Tc':
        charSpace = numberAt(1)
        break
      case 'Tw':
        wordSpace = numberAt(1)
        break
      case 'Tz':
        horizontal = (numberAt(1) || 100) / 100
        break
      case 'Ts':
        rise = numberAt(1)
        break
      case 'Tj':
      case "'":
      case '"': {
        if (operator !== 'Tj') nextLine(0, -leading)
        const last = operands[operands.length - 1]
        if (last?.kind === 'string') show(last.value)
        break
      }
      case 'TJ': {
        const array = operands[operands.length - 1]
        if (array?.kind === 'array') {
          for (const item of array.items) {
            if (item.kind === 'string') show(item.value)
            else if (item.kind === 'number') {
              // Ein Zahlenwert im TJ-Feld verschiebt gegen die Schreibrichtung;
              // so werden Sperrungen und der Abstand zur nächsten Spalte
              // ausgedrückt. Wer ihn übergeht, verliert genau die Lücken, um
              // die es hier geht.
              const shift = (-item.value / 1000) * fontSize * horizontal
              tm = multiply([1, 0, 0, 1, shift, 0], tm)
            }
          }
        }
        break
      }
      default:
        break
    }
    operands.length = 0
  }
  return pieces
}
