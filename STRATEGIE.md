# Umfahrungsnavi — Strategiepapier

Stand 25.08.2026, nach Prüfung gegen die echten Dienste.
Ziel: ein Auto-Navi für Florian allein, das bei Stau kompromisslos umfährt —
auch durch Wohngebiete, was große Navis bewusst nicht tun.

> **Was sich gegenüber der ersten Fassung geändert hat**
> Der als schwierig eingeschätzte Teil (Abschnitt 4) fällt weitgehend weg:
> BRouter kann Sperrzonen von Haus aus, mit einstellbarer Härte. Der
> Zwischenpunkt-Trick wird nicht gebraucht. Außerdem stimmte die Annahme
> nicht, BRouter habe einen Wohnstraßen-Aufschlag — hat es nicht.
> Belege stehen in Abschnitt 9.

---

## 1. Kann man Google Maps oder Waze als Kartenmaterial nehmen?

**Waze: nein.** Waze hat keine öffentliche Schnittstelle für Karten oder
Routing. Es gibt nur einen Deep-Link („öffne Waze mit diesem Ziel"). Man kann
Waze also anspringen, aber nichts davon in eine eigene App einbauen. Fällt aus.

**Google Maps: technisch ja, für dieses Vorhaben aber die falsche Wahl.**

Google verkauft die Bausteine einzeln (Maps JavaScript API für die Karte,
Routes API fürs Routing, Navigation SDK für Abbiegeführung). Zwei Gründe
sprechen dagegen:

*Die Nutzungsbedingungen verbieten genau unseren Fall.* Google-Kartendaten
dürfen nicht zusammen mit einer fremden Routing-Maschine verwendet werden, und
Google-Verkehrsdaten nicht auf einer fremden Karte dargestellt werden. Unser
ganzer Ansatz besteht aber darin, eine **eigene** Routenlogik zu bauen. Mit
Google dürfte man nur Googles Routen anzeigen — und die tun exakt das nicht,
was du willst.

*Die Kosten passen nicht zum Nutzungsmuster.* Routenanfragen kosten pro Aufruf.
Ein Navi, das während der Fahrt minütlich neu rechnet, macht in einer Stunde
schnell 60 Anfragen. Bei einem einzelnen Nutzer bleibt das im Rahmen, aber es
ist ein laufender Kostenposten für etwas, das anderswo kostenlos ist.

**Empfehlung: OpenStreetMap als Datengrundlage, BRouter als Routing-Maschine,
Verkehrsdaten separat zukaufen.**

---

## 2. Warum große Navis nicht durch Wohngebiete führen — und was daraus folgt

Das ist keine technische Grenze, sondern eine bewusste Entscheidung der
großen Anbieter: Wohnstraßen bekommen einen Kostenaufschlag, damit Millionen
Nutzer nicht ganze Viertel fluten.

**BRouter macht das nicht.** Das Profil `car-fast` hat *keinen* Aufschlag auf
Wohnstraßen — der Grundkostenfaktor ist für jeden Straßentyp 0, gerechnet wird
allein über die Fahrzeit. Wohnstraßen werden nur deshalb selten gewählt, weil
das Profil dort mit 30 km/h rechnet statt mit 100 auf der Bundesstraße.

Das ist die eigentlich gute Nachricht: **es muss nichts entschärft werden.**
BRouter ist bereits so aggressiv, wie reine Zeitoptimierung es zulässt. Fehlt
nur die Information, dass die Bundesstraße gerade steht — und genau die
liefert Abschnitt 4.

**„Anlieger frei" wird von `car-fast` bereits ignoriert.** Straßen mit
`access=destination` sind im Profil als befahrbar eingestuft und kosten nichts
extra; das Merkmal landet nur in der Ausgabe (Bit 64 der `classifiermask`).
Die Voreinstellung ist also „durchfahren". Wer es respektieren will, muss das
aktiv einbauen — nicht umgekehrt.

Die App weist den Anlieger-frei-Anteil deshalb offen aus („1,2 km Anlieger"),
damit die Entscheidung pro Route bewusst fällt statt unbemerkt.

---

## 3. Architektur

| Baustein | Empfehlung | Kosten |
|---|---|---|
| Kartenbilder | CARTO Voyager (Tag) / Dark Matter (Nacht) | frei |
| Routing | **BRouter**, öffentlicher Dienst, Profil `car-fast` | frei |
| Sperrzonen | BRouter-Parameter `nogos` | frei |
| Verkehr Autobahn | **Autobahn GmbH des Bundes** (INRIX) | frei, ohne Schlüssel |
| Verkehr sonst | **TomTom Flow Segment Data** | 2.500 Abrufe/Monat frei |
| Adresssuche | Nominatim | frei |

**Warum BRouter und nicht OSRM/GraphHopper:** BRouter läuft als öffentlicher
Dienst, liefert Alternativrouten und Abbiegehinweise, kann Sperrzonen mit
Gewicht — und seine Profile sind bearbeitbare Textdateien, die sich sogar auf
den öffentlichen Server hochladen lassen. Ein eigener Server lohnt erst, wenn
BRouter an Grenzen stößt.

**Zum TomTom-Freikontingent:** 2.500 Abrufe pro **Monat** (nicht pro Tag — das
stand in der ersten Fassung falsch). Bei einer Abfrage alle zwei Minuten sind
das rund 80 Stunden Navigation im Monat. Für eine Person reicht das, aber es
ist kein Puffer für Spielereien: die Abfrage gehört an die Route gekoppelt und
nicht an einen festen Takt. Die Verkehrs-Kacheln zum bloßen *Anzeigen* haben
ein eigenes, viel größeres Kontingent (200.000/Monat).

---

## 4. Die Umfahrung: BRouters `nogos`

BRouter kennt einen URL-Parameter, mit dem sich Bereiche verteuern lassen:

```
&nogos=<lon>,<lat>,<radius>[,<gewicht>]|…
```

Ohne Gewicht ist die Zone **hart gesperrt**. Mit Gewicht ist sie nur **teuer** —
das Gewicht sind Zusatzkosten, grob in Metern Wegstrecke gerechnet. Damit ist
die Frage „ab wann lohnt die Umfahrung?" kein Algorithmus mehr, sondern eine
Zahl.

Gemessen an der Strecke Tübingen → Reutlingen mit einer Sperrzone von 900 m
Radius auf der B28:

| Gewicht | Ergebnis |
|---|---|
| ohne (hart) | 20,0 km / 28,5 min — weicht aus |
| 50 | 15,9 km / 21,1 min — fährt hindurch |
| 500 | 20,0 km / 28,5 min — weicht aus |
| 5000 | 20,0 km / 28,5 min — weicht aus |

Die App arbeitet mit 4000, also etwa „nimm den Umweg, solange er nicht mehr
als 4 km kostet". Der Wert steht als `SPERRGEWICHT` oben in `app.js`.

**Damit muss die Routing-Maschine nie etwas von Verkehr wissen.** Der Ablauf in
Etappe 3 ist nur noch:

1. TomTom nach Störungen im Kartenausschnitt fragen
2. Für jede relevante Störung eine Sperrzone in dieselbe Liste legen, die
   heute der Knopf „Stau hier" füllt
3. Neu routen — der Rest der App bleibt unverändert

Der Zwischenpunkt-Trick aus der ersten Fassung wird nicht gebraucht.

---

## 5. Was aus dem Roller-Navi übernommen wurde

Aus `scooter-utility-backup/offline-navi/karte.js` übernommen und für das Auto
umgebaut: Adresssuche mit Vorschlagsliste, Routenberechnung mit drei Varianten,
Abbiegehinweise aus dem Winkel statt aus BRouters undokumentierten
Befehlsnummern, Neuberechnung bei Abweichung, Abstand-zur-Route-Rechnung,
Sprachansage, Bildschirm-Wachhalten.

Nicht übernommen: die gesamte Flutter-Überlagerung (Höhenregel, Ziehgriff,
Tastaturbehandlung) — die brauchte es nur, weil das Roller-Navi über einer
fremden App lag.

---

## 6. Ein Vorteil, den das Roller-Navi nicht hat

Das Roller-Navi braucht Bluefy, weil nur dieser Browser Bluetooth kann — und
Bluefy kann kein Vollbild.

**Ein Auto-Navi braucht kein Bluetooth.** Es läuft in Safari und lässt sich
über „Zum Home-Bildschirm" als App ablegen. Dann startet es echt im Vollbild,
ohne Adressleiste — genau das, was beim Roller nicht ging.

---

## 7. Stand

**Etappe 1 — Grundgerüst. ✅ 25.08.2026.** Karte Tag/Nacht, Standort mit
Richtungskegel, Adresssuche, Ziel per langem Druck, drei Routenvarianten,
Abbiegebanner, Sprachansage, Neuberechnung, Vollbild-PWA.

**Etappe 2 + 3 — Verkehr und automatische Umfahrung. ✅ 25.08.2026.**
Autobahn-GmbH-Schnittstelle und TomTom Flow, Schwelle einstellbar (Vorgabe
5 Minuten), Sperrgewicht aus dem gemeldeten Zeitverlust, Richtungsfilter,
Prüfung alle drei Minuten während der Fahrt.

**Zusätzlich fertig:** Zwischenziele, Ankunftszeit, Blitzwarner,
Kreisverkehr-Ausfahrten, Verkettung dicht aufeinanderfolgender Abbiegungen.

**Offen:** Tempolimit-Anzeige (die Daten liegen schon in BRouters Antwort),
Spurhinweise, Aufzeichnung gefahrener Strecken.

---

## 8. Entschieden

1. **Wie aggressiv?** Umfahren ab 5 Minuten Zeitverlust; einstellbar von 3 bis
   15. Das Sperrgewicht wächst mit dem gemeldeten Verlust (800 m je Minute),
   damit ein dicker Stau die Route stärker verbiegt als ein kleiner.
2. **„Anlieger frei"** bleibt erlaubt — so verhält sich `car-fast` von Haus
   aus. Die App weist den Anteil je Variante aus.
3. **BRouter reicht.** Sperrzonen, Alternativrouten, Abbiegehinweise,
   Profilparameter und eigene Profile laufen über den öffentlichen Dienst.
4. **Tempolimits** stecken schon in `messages`; nur die Anzeige fehlt.
5. **Aufzeichnung** noch offen.

---

## 9. Prüfprotokoll (25.08.2026)

Alles gegen `https://brouter.de` gemessen, Strecke Tübingen (9.0576, 48.5216)
→ Reutlingen (9.2043, 48.4914).

- `profile=car-fast` liefert 15,9 km / 21 min, mit Abbiegehinweisen bei
  `timode=2`. ✅
- `nogos=…` mit und ohne Gewicht: siehe Tabelle in Abschnitt 4. ✅
- Profilparameter direkt in der URL: `profile:vmax=60` ändert die Fahrzeit von
  1264 s auf 1386 s. Wahrheitswerte brauchen `=1` / `=0`, `=true` bricht ab. ✅
- Eigenes Profil hochladen: `POST https://brouter.de/brouter/profile` mit der
  `.brf`-Datei als Rumpf liefert eine `profileid`, die sich danach wie ein
  eingebautes Profil verwenden lässt. ✅
- `car-fast.brf` gelesen (Kopie in `profil/car-fast-original.brf`):
  Grundkostenfaktor 0, `maxspeed_implicit` für `residential` = 30,
  `access=destination` erlaubt und nur in der `classifiermask` vermerkt. ✅
- `messages` in der GeoJSON-Antwort enthält je Abschnitt Länge und OSM-Merkmale
  (`highway`, `maxspeed`, `access`) — daraus rechnet die App den Wohnstraßen-
  und Anlieger-Anteil. ✅
- TomTom-Freikontingent laut `docs.tomtom.com/pricing`: Traffic Incidents API
  2.500/Monat, Verkehrs-Kacheln 200.000/Monat, ohne Kreditkarte.

---

## 10. Dateien

| Datei | Zweck |
|---|---|
| `index.html` | Vollbild-PWA, wird auf dem Handy abgelegt |
| `app.js` | die ganze Logik, oben die Stellschrauben |
| `stil.css` | Oberfläche fürs Fahren |
| `pruefung.html` | **Prüfstand**: täuscht GPS vor und fährt die Route ab — ohne den geht am Schreibtisch gar nichts |
| `sw.js` | Service Worker; **Versionsnummer bei jeder Änderung hochzählen** |
| `profil/car-fast-original.brf` | BRouters Auto-Profil als Ausgangspunkt für Etappe 4 |

---

## 11. Nachtrag 25.08.2026: wie aggressiv ist es wirklich?

Gemessen an einer Tübinger Innenstadtstrecke (Südstadt → Waldhäuser Ost) mit
gesperrter Hauptachse:

| | Länge | Dauer | kleine Straßen |
|---|---|---|---|
| ohne Stau | 7,58 km | 15 min | 0,82 km (11 %) |
| Hauptachse gesperrt | 6,03 km | 17 min | 2,41 km (**40 %**) |

Er taucht also wirklich ins Wohngebiet ab, sobald die Hauptstraße teuer wird.

Der Versuch, das über ein höher gerechnetes Wohnstraßen-Tempo noch weiter zu
treiben, läuft ins Leere: in deutschen Wohngebieten steht fast überall
`maxspeed=30` in den Kartendaten, und das begrenzt die Rechnung hart. Deshalb
gibt es im eigenen Profil zusätzlich `schleichfaktor` — der hebt das gerechnete
Tempo auf kleinen Straßen an. Voreinstellung 1.0, also legal gerechnet; höhere
Werte machen die Route schleichfreudiger, lohnen sich aber nur, wenn man das
Tempolimit überschreitet.

**Der wirksame Hebel ist nicht die Wohnstraße, sondern der Stau.** Solange
BRouter die verstopfte Bundesstraße mit 100 km/h rechnet, ist der Vergleich
zugunsten der Hauptstraße verzerrt. Genau das korrigiert das aus dem
Zeitverlust gerechnete Sperrgewicht.
