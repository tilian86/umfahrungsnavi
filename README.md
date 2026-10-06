# Staufunk

(Der Ordner heißt noch `umfahrungsnavi` — die Adresse hängt daran.)

Auto- und Rad-Navi für eine Person. Anders als die großen Navis darf es kompromisslos
umfahren — auch durch Wohngebiete.

**Live:** https://tilian86.github.io/umfahrungsnavi/
**Prüfstand:** `?pruefstand` an die Adresse hängen — täuscht GPS vor und fährt
die Route ab. Ohne den lässt sich am Schreibtisch nichts testen.

Auf dem iPhone über Safari → Teilen → „Zum Home-Bildschirm" ablegen. Dann
startet die App echt im Vollbild, ohne Adressleiste.

## Was drin ist

- Karte hell/dunkel, Standort mit Richtungskegel, Folgen-Modus
- Adresssuche mit Vorschlägen, Ziel auch per langem Druck auf die Karte
- Zwischenziele (Knopf „+ Stopp"), Ankunftszeit
- Drei *verschiedene* Routenvorschläge — Dubletten werden über die
  tatsächliche Überdeckung aussortiert, nicht über Länge und Dauer
- Abbiegebanner mit Kreisverkehr- und Autobahn-Ausfahrten und „dann sofort links"
- Blitzwarner aus OpenStreetMap, richtungsgeprüft
- Automatische Stauumfahrung ab einstellbarem Zeitverlust
- Neuberechnung bei Abweichung, Bildschirm-Wachhalten

## Verkehrsdaten

| Quelle | Deckt ab | Kosten |
|---|---|---|
| **Autobahn GmbH des Bundes** | alle deutschen Autobahnen | frei, ohne Schlüssel |
| **TomTom Flow Segment Data** | Bundes-, Land-, Stadtstraßen | Schlüssel nötig, 20.000/Monat frei |

Die Autobahn-Schnittstelle ist amtlich, liefert INRIX-Daten und nennt den
Reisezeitverlust in Minuten — genau die „Riesendinger", die im Radio kommen.
Sie kennt aber nur Autobahnen.

**Für Rush-Hour-Staus in der Stadt braucht es den TomTom-Schlüssel.**
Kostenlos auf developer.tomtom.com, dann in der App unter „Mehr" eintragen.
Wichtig ist dort *Flow*, nicht *Incidents*: Incidents meldet nur, was jemand
gemeldet hat, Flow misst die tatsächliche Geschwindigkeit gegen die freie
Strecke und findet damit auch Staus, die niemand meldet.

Google und Waze gehen nicht: Waze hat keine öffentliche Schnittstelle, und
Googles Bedingungen verbieten es, ihre Verkehrsdaten mit fremdem Routing oder
auf einer fremden Karte zu verwenden.

## Wie die Umfahrung funktioniert

BRouter kennt den Parameter `nogos=lon,lat,radius,gewicht`. Ohne Gewicht ist
eine Zone hart gesperrt, mit Gewicht nur teuer. Das Gewicht wird aus dem
gemeldeten Zeitverlust gerechnet, damit ein dicker Stau die Route stärker
verbiegt als ein kleiner: rund 1.960 BRouter-Kosten je Stauminute, verteilt auf
die Strecke im Kreis (`MINUTE_KOSTEN` in `app.js`). BRouter rechnet davon je
Wegstück nur einen Teil an (nachgemessen 17–72 %), deshalb ist das Gewicht
bewusst eher zu hoch. Ob die vorgeschlagene Umfahrung genommen wird, entscheidet
danach ein Zeitvergleich mit dem Weg durch den Stau (Fahrzeit plus Stauminuten).
Lohnt sie nicht, sagt die App „Umfahrung lohnt sich nicht" und bleibt.

Eine automatische Sperre hält, bis ihre eigene Stelle wieder frei gemessen ist
und seit 10 Minuten keine Meldung sie bestätigt hat (ohne Verkehrsdaten 30
Minuten). Wegen Verkehr wird höchstens alle 2 Minuten neu gerechnet — in beide
Richtungen, damit die Route nicht pendelt.

Die Routing-Maschine muss dadurch nie etwas von Verkehr wissen. Gemessen an
einer Tübinger Innenstadtstrecke mit gesperrter Hauptachse: **6,03 km mit 40 %
kleinen Straßen statt 7,58 km mit 11 %.** Er taucht also wirklich ins
Wohngebiet ab.

`profil/umfahrung.brf` ist BRouters `car-fast` mit drei zusätzlichen
Stellschrauben (`wohntempo`, `nebentempo`, `schleichfaktor`). Die App lädt es
beim ersten Start selbst zu BRouter hoch und merkt sich die Kennung.

## Änderungen

**v34 (06.10.2026)** — Code-Review und Hintergrund-Navi:
- Blitzer kommen jetzt über die ganze Strecke: vorher nur für die ersten 25 km,
  jetzt wird unterwegs nachgeladen.
- Fahrtrichtung beim Rangieren und Rückwärtsfahren: unter 4 m/s auf der Route
  zählt die Richtung der Strecke, nicht der wackelige GPS-Kurs.
- Neuberechnung unterwegs übergibt BRouter die Fahrtrichtung (`heading`), damit
  die neue Route nicht hinter einem beginnt.
- Spurhinweis („links einordnen") nur, wenn wirklich nicht alle Spuren passen.
- „auf die Am Stadtgraben" → „auf Am Stadtgraben" (Straßennamen mit Präposition).
- Blitzer wurden nach einer Neuberechnung doppelt angesagt.
- **Werkstatt-App:** Wer Staufunk als Kachel in der Werkstatt-App nutzt, bekommt
  die Ansagen auch bei gesperrtem Bildschirm. Staufunk schickt der App dafür die
  Route samt Ansagetexten (`funkNativ.navi`), die App fährt mit eigenem GPS mit
  (Code: `zentrale-ios/Zentrale/Web/NaviKern.swift`). Die Schwellen und Texte
  stehen an beiden Stellen: **Ändern in `bannerAktualisieren`, `blitzPruefen`,
  `abweichungPruefen`, `tempoEcke` oder `osrmHinweise` → dort nachziehen.**
  Als Web-App oder im Browser ändert sich nichts.

**v30 (24.09.2026)** — Fehler aus dem Code-Review behoben:
- Umfahrung hält: Sperren fielen nach 1,5 s wieder weg, die Route kehrte
  mitten in den Stau zurück. Jetzt erst, wenn der Stau selbst weg ist.
- Sperrgewicht neu geeicht (war rund 160-mal zu hoch) und Zeitvergleich:
  Umweg nur, wenn er schneller ist als der Weg durch den Stau.
- Autobahn-Ausfahrten und „halten" werden gezeigt und angesagt
  („rechts halten – Ausfahrt").
- iOS: das erste Tippen gibt die Sprachausgabe frei (vorher stumm).
- Abbiegebanner misst den Weg entlang der Strecke statt Luftlinie.
- Fallen Verkehrsdaten aus, steht das da — nicht mehr „Freie Fahrt".
- Zeitlimits für alle Verkehrsabrufe; Service Worker nimmt nach 3 s den Cache.
- Autobahn-Kennungen folgen der angetippten Routen-Kachel.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Vollbild-PWA |
| `app.js` | Oberfläche, Routing, Abbiegeführung |
| `verkehr.js` | Verkehrsdaten, Blitzer, Straßenkennungen |
| `pruefstand.js` | GPS-Attrappe, nur bei `?pruefstand` aktiv |
| `profil/umfahrung.brf` | eigenes BRouter-Auto-Profil |
| `sw.js` | Service Worker — **Version bei jeder Änderung hochzählen** |
| `STRATEGIE.md` | Warum es so gebaut ist, mit Messprotokoll |
