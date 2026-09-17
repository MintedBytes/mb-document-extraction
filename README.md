# Belegtext lesen

Gibt den Text eines PDFs zurück — in der Lesart, die der Aufrufer braucht. Das
Plugin bringt seinen PDF-Leser selbst mit; es ruft kein fremdes System und lädt
nichts nach.

## Die drei Lesarten

| Lesart | Was sie tut | Wofür |
|---|---|---|
| `layout` (Vorgabe) | Setzt den Text nach seiner Position auf dem Blatt zusammen | Belege mit Positionstabellen |
| `roh` | Gibt ihn in der Reihenfolge zurück, in der das PDF ihn zeichnet | Einspaltiger Fließtext, schnellster Weg |
| `struktur` | Lässt das Modell den gelesenen Text in Felder und Positionen zerlegen | Wenn nicht Text, sondern Daten gebraucht werden |

### Warum `layout` die Vorgabe ist

Ein PDF speichert keine Zeilen, sondern Zeichenbefehle. Manche Systeme zeichnen
eine Tabelle spaltenweise: erst alle Mengen, dann alle Artikel. Wer diesen Text
so weitergibt, übergibt Mengen ohne Artikel — und was danach damit arbeitet,
ordnet sie folgerichtig falsch zu. An einem Beleg aus dem Testordner:

```
roh      Artikel Menge Preis 10 4 25 Schraube M8 Mutter M8 Scheibe 8mm 1,20 0,40 0,10
layout   Artikel            Menge           Preis
         Schraube M8            10            1,20
         Mutter M8              4             0,40
         Scheibe 8mm            25            0,10
```

`layout` kann dabei nie schlechter sein als `roh`: Eine gedrehte Seite und ein
Zusammensetzen, bei dem Text verloren ginge, fallen auf `roh` zurück — und
sagen es in `notes`.

## Ausgabe

```ts
{
  mode: "roh" | "layout" | "struktur",
  text: string,        // bei "struktur" das JSON des Modells
  pages: number,
  truncated: boolean,  // der Text war länger als 100.000 Zeichen
  notes: string[],     // gedrehte Seiten, fehlende Teile, Kürzungen
}
```

## Grenzen, ausdrücklich

- **Kein Scan.** Ein PDF ohne Textebene ist ein Bild. Das Plugin lehnt es mit
  `document.no_text_layer` ab, statt eine leere Seite zurückzugeben. Eine
  Texterkennung braucht eine Rasterung und eine Erkennungs-Engine — beides läuft
  nicht in einem abgeschotteten Plugin.
- **Keine verschlüsselten Dateien** (`document.encrypted`). Ein geschütztes
  Dokument wird nicht geraten.
- **Nur Flate-Ströme.** Andere Filter (LZW, JBIG2, DCT) werden übersprungen;
  ihr Inhalt ist fast immer ein Bild.
- **Breiten sind geschätzt.** Ohne die Metriken der eingebetteten Schrift wird
  mit einer mittleren Zeichenbreite gerechnet. Für das Erkennen von Spalten
  reicht das; auf das Zeichen genau ausgerichtete Tabellen sind es nicht.

## Fehlercodes

| Code | Bedeutung |
|---|---|
| `document.not_a_pdf` | Die Datei beginnt nicht mit einem PDF-Kopf. |
| `document.encrypted` | Das PDF ist verschlüsselt. |
| `document.no_pages` | Es wurde keine Seite gefunden. |
| `document.no_text_layer` | Kein Text im Dokument — vermutlich ein Scan. |

## Datenschutz

Der Belegtext verlässt das Plugin nur bei der Lesart `struktur`, und dort nur an
die KI-Anbindung, die für die Umgebung ausgewählt ist. `roh` und `layout`
rechnen ausschließlich im Plugin; sie brauchen keine KI-Anbindung. Der Text wird
dem Modell ausdrücklich als Datum übergeben, nicht als Anweisung.

## In MintedBytes installieren

Als Administrator der Organisation: **Plugins → Aus GitHub**, dann als
Repository `https://github.com/MintedBytes/mb-document-extraction` eintragen.
Ein Repository ist ein Plugin; die `plugin.json` liegt hier im
Wurzelverzeichnis.

## Entwickeln

Voraussetzungen: Go (für `mbplugin` aus dem Backend) und Deno.

```bash
mbplugin check -dir .   # Manifest, Dateien und Typen gegen das SDK
mbplugin test -dir .    # Fälle aus test/cases.json
mbplugin pack -dir . -out mb-document-extraction.mbplugin
```

Die PDFs unter `test/` sind von Hand gebaut und klein genug, um sie zu lesen:
`bestellung.pdf` enthält die spaltenweise gezeichnete Tabelle, an der sich
`layout` und `roh` unterscheiden.

## Eine neue Version veröffentlichen

1. `version` in `plugin.json` erhöhen und `CHANGELOG.md` ergänzen. Eine Version
   bezeichnet genau eine Datei: Wer den Inhalt ändert, erhöht die Version.
2. `mbplugin check` und `mbplugin test` laufen lassen, committen, pushen.
3. In MintedBytes erneut **Aus GitHub** — der Assistent zeigt die Änderungen
   gegenüber der vertrauten Version.
