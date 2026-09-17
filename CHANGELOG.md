# Änderungen

## 1.0.1

- Das Feld `documentFile` sagt jetzt, was es erwartet: die Kennung eines
  Anhangs dieses Laufs, nicht seinen Inhalt. Die alte Beschreibung („die Datei
  des Aufrufs") las sich wie eine Aufforderung, die Datei zu übergeben — ein
  Aufruf mit dem Inhalt wurde folgerichtig abgelehnt, und der Fehlertext nannte
  die Ursache nicht.

## 1.0.0

- Erste Fassung: liest den Text eines PDFs in drei Lesarten (`roh`, `layout`,
  `struktur`).
- Eigener PDF-Leser ohne Abhängigkeiten: Objekte und Objektströme, FlateDecode
  über die eingebaute `DecompressionStream`, Seitenbaum ab dem Katalog,
  `/ToUnicode` je Schrift.
- `layout` setzt den Text nach Position zusammen und fällt bei gedrehten Seiten
  oder Textverlust auf `roh` zurück, mit Hinweis.
- Ein Scan ohne Textebene, eine verschlüsselte Datei und etwas, das kein PDF
  ist, werden mit eigenem Code abgelehnt statt geraten.
