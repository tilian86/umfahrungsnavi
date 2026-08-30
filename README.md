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
- Abbiegebanner mit Kreisverkehr-Ausfahrten und „dann sofort links"
- Blitzwarner aus OpenStreetMap, richtungsgeprüft
- Automatische Stauumfahrung ab einstellbarem Zeitverlust
- Neuberechnung bei Abweichung, Bildschirm-Wachhalten

## Verkehrsdaten

| Quelle | Deckt ab | Kosten |
|---|---|---|
| **Autobahn GmbH des Bundes** | alle deutschen Autobahnen | frei, ohne Schlüssel |
| **TomTom Flow Segment Data** | Bundes-, Land-, Stadtstraßen | Schlüssel nötig, 2.500/Monat frei |

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
gemeldeten Zeitverlust gerechnet (800 m je Minute), damit ein dicker Stau die
Route stärker verbiegt als ein kleiner.

Die Routing-Maschine muss dadurch nie etwas von Verkehr wissen. Gemessen an
einer Tübinger Innenstadtstrecke mit gesperrter Hauptachse: **6,03 km mit 40 %
kleinen Straßen statt 7,58 km mit 11 %.** Er taucht also wirklich ins
Wohngebiet ab.

`profil/umfahrung.brf` ist BRouters `car-fast` mit drei zusätzlichen
Stellschrauben (`wohntempo`, `nebentempo`, `schleichfaktor`). Die App lädt es
beim ersten Start selbst zu BRouter hoch und merkt sich die Kennung.

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
