Versionshinweise: V1.2.0-Alpha-V2

Wichtigste Änderungen

Dies ist eine Vorschauversion. Danke an alle, die das Plugin installieren und benutzen, und danke für die Geduld bei jedem Zwischenstand; Fehlerberichte und Vorschläge sind willkommen.

- Ein Schwebekugel-Einstieg: ziehen, werfen, abprallen lassen; fünf Stile, auswählbar unter Einstellungen › Einstieg-Optionen
- Zehn Sprachen in der Oberfläche, acht davon neu
- Das Plugin wurde umgebaut, der Kaltstart ist deutlich schneller
- Das abgesetzte Fenster folgt dem Theme und arbeitet mit dsh-plugin-wallpaper-engine zusammen
- Wurde die Liste nach dem Löschen einer Sitzung nicht aktualisiert, ist das behoben
- Fehlt eine Laufzeit, wird der Download jetzt direkt angeboten
- Das Datenverzeichnis lässt sich auf den Standard zurücksetzen
- Alle Dialoge laufen über die Dialoge von DSH

Alle Änderungen im Einzelnen

Neu

- Schwebekugel-Einstieg: neben dem Knopf in der Seitenleiste eine ziehbare Kugel, die nach einem Wurf fällt, abprallt und am Boden zur Ruhe kommt; fünf Stile (Standard, DeepSeek, ChatGPT, Claude, Grok) zum Wechseln; auswählbar unter Einstellungen › Einstieg-Optionen
- Acht neue Sprachen, insgesamt zehn (Japanisch, Koreanisch, Deutsch, Französisch, Spanisch, Russisch, Portugiesisch, traditionelles Chinesisch)
- Fortschrittsbalken für die KI-Zusammenfassung
- Fehlt die Electron-Komponente, wird der Download direkt angeboten
- Einstellungen › Datenverzeichnis: Speicherort ändern, auf den Standard zurücksetzen
- Versionshinweise gibt es ebenfalls in allen Sprachen
- „Abgesetztes Fenster“: das Hintergrundbild von dsh-plugin-wallpaper-engine übernehmen oder ein eigenes Bild hochladen; Weichzeichnen, Milchglas, Abdunkeln

Verbessert

- Kaltstart 3,1 s → 0,12 s (zweitausend Sitzungen); der Neustart liest aus dem Sitzungsmanifest
- Aktualisieren liest nur geänderte Dateien; eine Antwort löst keinen vollständigen Durchlauf mehr aus
- Lange Listen erzeugen nur sichtbare Zeilen; der erste Bildschirm spart über fünfzigtausend Elemente
- Sitzungskopf und Statistik werden je Dateiversion zwischengespeichert
- Die Indizierung gibt alle 150 ms den Hauptthread frei und begrenzt den Text einer Sitzung
- Hover-Hervorhebung reagiert sofort
- „Cache leeren“ umfasst jetzt Sitzungsmanifest, Sitzungsinhalte, Chromium-Cache und Index
- Dialoge nutzen die nativen Dialoge von DSH
- Einige Formulierungen überarbeitet
- Die zwölf Gruppen der Einstellungsseite sind nach Zweck geordnet

Behoben

- Sitzungen löschen: auch geöffnete landen im Papierkorb, rutschen nicht mehr nach „Nicht gruppiert“ und hinterlassen keine leeren Ordner
- Das Panel blieb gelegentlich leer
- Gelöschte Sitzungen blieben im Arbeitsbereich sichtbar
- Das Fenster des Dateimanagers hielt den DSH-Prozess fest
- Abstände im Zeilenmenü wichen vom Menü des Hosts ab
- Die Laufzeit hieß im Text Electron
- Der Download-Fortschritt der Komponente beginnt jetzt beim Klick statt nach der Antwort
- Ein Panel mit 100 % verdeckt die Titelleiste nicht mehr
- Die drei Knöpfe oben rechts im abgesetzten Fenster sind größer
