/*
 * Aus Textstücken wieder eine Seite machen.
 *
 * ── Das Problem, gegen das dieser Code geschrieben ist ──
 *
 * Ein PDF speichert keine Zeilen, sondern Zeichnungsbefehle. Die Reihenfolge
 * darin ist die, in der der Erzeuger gezeichnet hat — nicht die, in der ein
 * Mensch liest. Bei einspaltigem Fließtext ist das dasselbe. Bei einer Tabelle
 * nicht: Manche Systeme zeichnen erst die ganze Mengenspalte und danach die
 * ganze Artikelspalte.
 *
 * Wer diesen Text so weitergibt, übergibt eine Liste von Mengen ohne Artikel
 * und eine Liste von Artikeln ohne Mengen. Ein Modell ordnet sie danach
 * zusammen — falsch, und niemand sieht es dem Ergebnis an.
 *
 * ── Die Antwort ──
 *
 * Jedes Stück weiß, wo es steht. Also: nach y in Zeilen gruppieren, innerhalb
 * der Zeile nach x sortieren, Lücken als Leerraum erhalten. Deterministisch,
 * ohne Modell, ohne Kosten.
 *
 * ── Warum Leerzeichen und kein Trennzeichen ──
 *
 * Eine Spalte, die durch Leerraum ausgerichtet bleibt, ist als Tabelle
 * erkennbar. Ein erfundenes „|" wäre von einem echten Zeichen im Beleg nicht zu
 * unterscheiden — und würde dort stehen, wo im Original nichts steht.
 */

/** Ein Textstück mit seinem Platz auf der Seite; Ursprung unten links. */
export interface TextPiece {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Ab wie vielen geschätzten Zeichenbreiten eine Lücke sichtbar bleibt. */
const GAP_MIN_CHARS = 2
/** Mehr Leerzeichen als das sagen nichts mehr und blähen nur den Text. */
const GAP_MAX_CHARS = 12

/**
 * Setzt eine Seite aus ihren Stücken zusammen.
 *
 * Die Zeilentoleranz ist die halbe mittlere Stückhöhe: Hoch- und
 * Tiefgestelltes und leicht versetzte Tabellenzellen gehören noch zur Zeile,
 * die nächste Textzeile nicht mehr. Ein fester Wert in Punkten würde bei
 * kleiner Schrift Zeilen verschmelzen und bei großer zerreißen.
 */
export function reflow(pieces: readonly TextPiece[]): string {
  const visible = pieces.filter((piece) => piece.text.trim().length > 0)
  if (visible.length === 0) return ''

  const heightOf = (piece: TextPiece) => piece.height || 10
  const lineHeight = median(visible.map(heightOf))
  const sameLine = Math.max(1, lineHeight * 0.5)

  const lines: TextPiece[][] = []
  for (const piece of [...visible].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const current = lines[lines.length - 1]
    const reference = current?.[0]
    if (reference && Math.abs(reference.y - piece.y) <= sameLine) current!.push(piece)
    else lines.push([piece])
  }

  const out: string[] = []
  let previousY: number | null = null
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x)
    // Ein deutlich größerer Zeilenabstand ist ein Absatz. Das erhält die
    // Gliederung eines Belegs: Anschrift, Betreff, Tabelle, Fußtext.
    if (previousY !== null && previousY - line[0]!.y > lineHeight * 1.8) out.push('')
    previousY = line[0]!.y
    out.push(joinLine(line, lineHeight))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Eine Zeile aus ihren Stücken, mit erhaltenen Abständen. */
function joinLine(line: readonly TextPiece[], lineHeight: number): string {
  let text = ''
  let previousEnd: number | null = null
  for (const piece of line) {
    const part = piece.text.replace(/\s+/g, ' ')
    if (previousEnd !== null) {
      const gap = piece.x - previousEnd
      /*
       * Die Zeichenbreite wird am Stück selbst gemessen und nur ersatzweise
       * geschätzt. Ohne dieses Maß wäre die Lücke eine Länge in Punkten, und
       * dieselbe Tabelle käme in 8 pt und in 12 pt verschieden heraus.
       */
      const charWidth = piece.text.length > 0 && piece.width > 0
        ? piece.width / piece.text.length
        : Math.max(lineHeight * 0.5, 1)
      const spaces = Math.round(gap / Math.max(charWidth, 0.5))
      if (spaces >= GAP_MIN_CHARS) text += ' '.repeat(Math.min(spaces, GAP_MAX_CHARS))
      else if (spaces >= 1 || !/\s$/.test(text)) text += ' '
    }
    text += part
    previousEnd = piece.x + piece.width
  }
  return text.trimEnd()
}

/** Alles außer Leerraum — das Maß, in dem zwei Lesarten gleich sein müssen. */
export function density(text: string): number {
  return text.replace(/\s+/g, '').length
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 10
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
