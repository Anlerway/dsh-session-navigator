Versionshinweise: V1.2.0-Alpha-V1

Wichtigste Änderungen

Dies ist eine Vorschauversion. Danke an alle, die das Plugin installieren und benutzen, und danke für die Geduld bei jedem Zwischenstand; Fehlerberichte und Vorschläge sind willkommen.

- Zehn Sprachen in der Oberfläche, acht davon neu
- Das Plugin wurde umgebaut, der Kaltstart ist deutlich schneller
- Wurde die Liste nach dem Löschen einer Sitzung nicht aktualisiert, ist das behoben
- Fehlt eine Laufzeit, wird der Download jetzt direkt angeboten
- Das Datenverzeichnis lässt sich auf den Standard zurücksetzen
- Alle Dialoge laufen über die Dialoge von DSH

Alle Änderungen im Einzelnen

Neu

- Acht neue Sprachen, insgesamt zehn (Japanisch, Koreanisch, Deutsch, Französisch, Spanisch, Russisch, Portugiesisch, traditionelles Chinesisch)
- Fortschrittsbalken für die KI-Zusammenfassung
- Fehlt die Electron-Komponente, wird der Download direkt angeboten
- Einstellungen › Datenverzeichnis: Speicherort ändern, auf den Standard zurücksetzen
- Versionshinweise gibt es ebenfalls in allen Sprachen

Verbessert

- Kaltstart 3,1 s → 0,12 s (zweitausend Sitzungen); der Neustart liest aus dem Sitzungsmanifest
- Aktualisieren liest nur geänderte Dateien; eine Antwort löst keinen vollständigen Durchlauf mehr aus
- Lange Listen erzeugen nur sichtbare Zeilen; der erste Bildschirm spart über fünfzigtausend Elemente
- Sitzungskopf und Statistik werden je Dateiversion zwischengespeichert
- Die Indizierung gibt alle 150 ms den Hauptthread frei und begrenzt den Text einer Sitzung
- Hover-Hervorhebung reagiert sofort
- Cache leeren umfasst zwei weitere Punkte: Sitzungsmanifest und Inhaltsindex
- Dialoge nutzen die nativen Dialoge von DSH
- Einige Formulierungen überarbeitet

Behoben

- Sitzungen löschen: auch geöffnete landen im Papierkorb, rutschen nicht mehr nach „Nicht gruppiert“ und hinterlassen keine leeren Ordner
- Das Panel blieb gelegentlich leer
- Gelöschte Sitzungen blieben im Arbeitsbereich sichtbar
- Das Fenster des Dateimanagers hielt den DSH-Prozess fest
- Abstände im Zeilenmenü wichen vom Menü des Hosts ab
- Die Laufzeit hieß im Text Electron
- Der Download-Fortschritt der Komponente beginnt jetzt beim Klick statt nach der Antwort
