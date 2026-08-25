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
| Verkehrsdaten | **TomTom Traffic Incidents API** | 2.500 Abrufe/Monat frei |
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

## 7. Vorgehen in Etappen

**Etappe 1 — Grundgerüst. ✅ fertig, 25.08.2026.**
Karte (Tag/Nacht), Standort mit Richtungskegel, Adresssuche, Ziel per langem
Druck, Routing mit drei Varianten, Abbiegebanner, Sprachansage, Neuberechnung
bei Abweichung, Vollbild-PWA. Dazu bereits die Sperrzonen-Mechanik von Hand
(„Stau hier") — damit ist der Kern des Vorhabens heute schon vorführbar.

**Etappe 2 — Verkehr sichtbar.** TomTom-Konto, Störungen und Stauflächen auf
der Karte einfärben. Noch ohne Einfluss auf die Route.

**Etappe 3 — automatische Umfahrung.** TomTom-Störungen entlang der Route
abfragen und in die vorhandene `sperren`-Liste schreiben. Schwellenwert, ab
wann eine Störung eine Zone wird. Wiederholung während der Fahrt.

**Etappe 4 — Feinschliff.** Tempolimits (stehen bereits in BRouters Antwort),
Spurhinweise, Ansagen verbessern, gefahrene Strecken aufzeichnen.

---

## 8. Offene Entscheidungen

1. **Wie aggressiv?** → jetzt eine Zahl: `SPERRGEWICHT` in `app.js`,
   Voreinstellung 4000 (≈ 4 km Umweg werden in Kauf genommen).
   Zu entscheiden bleibt, ab welcher gemeldeten Verzögerung (5 min? 10 min?)
   eine TomTom-Störung überhaupt zur Sperrzone wird.
2. **„Anlieger frei" respektieren oder ignorieren?** Voreinstellung ist
   ignorieren (so verhält sich `car-fast`). Die App weist den Anteil aus.
   → deine Entscheidung.
3. **Reicht BRouter?** → geprüft: ja. Sperrzonen, Alternativrouten,
   Abbiegehinweise, Profilparameter und sogar eigene Profile laufen über den
   öffentlichen Dienst. Kein eigener Server nötig.
4. **Tempolimits?** → fällt praktisch ab: BRouter liefert `maxspeed` je
   Abschnitt in `messages` mit. Nur die Anzeige fehlt noch.
5. **Aufzeichnung gefahrener Strecken?** → noch offen.

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
