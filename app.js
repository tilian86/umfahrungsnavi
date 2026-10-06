/* Umfahrungsnavi.
 *
 * Auto-Navi für eine Person. Anders als die grossen Navis darf es
 * kompromisslos durch Wohngebiete führen.
 *
 * Dienste:
 *   CARTO       Kartenbilder, hell und dunkel          — frei
 *   BRouter     Routing, Sperrzonen, Abbiegehinweise   — frei
 *   Nominatim   Adresssuche                            — frei
 *   Autobahn    amtliche Staumeldungen (INRIX)         — frei, ohne Schlüssel
 *   TomTom      Verkehrsfluss abseits der Autobahn     — Schlüssel nötig
 *   Overpass    feste Blitzer, Strassenkennungen       — frei
 *
 * Der Kern steckt in `sperren`: BRouter kennt `nogos`, mit dem sich Bereiche
 * verteuern lassen. Das Gewicht wird aus dem gemeldeten Zeitverlust gerechnet
 * (siehe `gewichtAus`), damit ein dicker Stau die Route stärker verbiegt als
 * ein kleiner. Die Routing-Maschine muss dadurch nie etwas von Verkehr wissen.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ Grundwerte */
  var BROUTER = 'https://brouter.de/brouter';
  var PROFIL_DATEI = 'profil/umfahrung.brf';
  var ERSATZPROFIL = 'car-fast';        // falls der Upload scheitert

  // Umrechnung Zeitverlust -> Sperrgewicht. Das Gewicht einer BRouter-Sperre
  // sind Kosten JE METER im Kreis. Eine Minute Fahrt kostet im Mittel rund
  // 1.960 Kosteneinheiten (gemessen Tuebingen -> Filderstadt: 44.149 fuer
  // 22,5 min, die Umfahrung 17.760 mehr fuer 10,9 min mehr).
  //   Gewicht = Stauminuten x 1.960 / (2 x Radius x ANRECHNUNG)
  // ANRECHNUNG: BRouter rechnet nicht die ganze Strecke im Kreis an, sondern
  // je Wegstueck zwischen zwei Kreuzungen nur den letzten Abschnitt im Kreis
  // (Quelltext OsmPath/RoutingContext, nachgemessen 24.09.2026: B27 17-44 %,
  // A8 63-72 %). Mit vollen 2 x Radius blieb ein 17-Minuten-Stau ungemieden,
  // obwohl die Umfahrung nur 10,9 min mehr kostet. Gerechnet wird deshalb mit
  // einem Viertel - lieber schlaegt BRouter eine Umfahrung zu viel vor: ob sie
  // genommen wird, entscheidet danach der Zeitvergleich mit dem Weg durch den
  // Stau (siehe route()).
  // Frueher: 800 je Minute ohne Vergleich - jeder kleine Stau wurde umfahren,
  // auch mit 20 Minuten Umweg.
  var MINUTE_KOSTEN = 1960;
  var ANRECHNUNG = 0.25;
  // Von Hand gesetzte Sperren ("Stau hier", "Weiche aus"): da will der Fahrer
  // nicht durch. Sie wiegen deshalb wie ein 30-Minuten-Stau.
  var HAND_MINUTEN = 30;

  // Eingebauter TomTom-Schluessel als Voreinstellung. Bewusste Entscheidung:
  // Gratis-Schluessel ohne hinterlegte Zahlungsdaten - schlimmstenfalls
  // verbraucht ein Fremder das Freikontingent, mehr kann nicht passieren.
  // Dafuer funktioniert der Stadtverkehr auf jedem Geraet sofort, auch nach
  // dem Neuanlegen der Homescreen-Kachel (iOS gibt der App dann einen
  // frischen, leeren Speicher - daran gingen die Schluessel bisher verloren).
  // Im TomTom-Portal sollte der Schluessel auf tilian86.github.io
  // eingeschraenkt werden, dann ist auch das Kontingent geschuetzt.
  // Ein selbst eingetragener Schluessel (Mehr -> TomTom) geht immer vor.
  var TOMTOM_STANDARD = 'XRnLd3ee3n7JpJG3ZzcDKTWLUybljt3A';

  // Stadtmodus. `vmax` deckelt die Rechengeschwindigkeit auf allen Strassen.
  // Bei 130 ist die Bundesstrasse dem 30er-Wohngebiet dreifach ueberlegen -
  // dann flieht die Route bei Stau lieber 4 km ueber die B27, statt 500 m
  // durch Nebenstrassen zu schleichen. Bei 50 schrumpft der Vorsprung auf das
  // Anderthalbfache, und der Schleichweg gewinnt.
  //
  // Gemessen quer durch Tuebingen mit Stau auf der Hauptachse:
  //   vmax 130 -> 7,96 km, 23 % kleine Strassen, 1,5 km auf der B27
  //   vmax  50 -> 6,91 km, 61 % kleine Strassen,   0 m auf der B27
  // Ohne Stau aendert vmax so gut wie nichts (3,77 gegen 3,85 km).
  //
  // Auf Langstrecke waere das fatal (Stuttgart-Karlsruhe: 138 statt 65 min),
  // deshalb nur bei kurzen Fahrten - da ist ein Hochgeschwindigkeitsumweg
  // ohnehin selten die Antwort.
  var STADT_VMAX = 50;
  var STADT_BIS_KM = 15;

  // Die drei Radvorschlaege. Alle drei sind Standardprofile auf brouter.de,
  // es muss nichts hochgeladen werden. Reihenfolge egal - sortiert wird
  // spaeter nach Fahrzeit.
  var RAD_PROFILE = [
    { profil: 'trekking', marke: 'Standard' },                // asphaltnah, gemuetlich
    { profil: 'gravel', marke: 'Feldweg' },                   // befestigte Wirtschaftswege
    { profil: 'fastbike-lowtraffic', marke: 'ruhig' }         // Asphalt, wenig Verkehr
  ];

  // Vektorkarten statt Rasterbilder: MapLibre rendert selbst. Dadurch bleiben
  // Strassennamen auch bei gedrehter Karte aufrecht, die Fahransicht bekommt
  // echte Perspektive, und der Nachtstil ist ein richtiger Stil statt eines
  // CSS-Filters. Beide Quellen sind offen und ohne Schluessel.
  var STILE = {
    tag:   { url: 'https://tiles.openfreemap.org/styles/liberty', hg: '#eae6e0' },
    nacht: { url: 'https://tiles.versatiles.org/assets/styles/eclipse/style.json', hg: '#101418' }
  };
  var QUELLE = '© OpenStreetMap · OpenFreeMap · VersaTiles · BRouter · Autobahn GmbH';

  /* ------------------------------------------------------------------ Zustand */
  var karte;
  var ichMarke, ichKreis, zielMarke = null, stoppMarken = [], blitzMarken = [];
  var standort = null, kurs = null, ziel = null, zielName = '';
  var stopps = [];                       // [{ort:[lat,lon], name:''}]
  var varianten = [], variante = 0;
  // Was der Fahrer zuletzt SELBST gewaehlt hat. Ohne das springt jede
  // Neuberechnung zurueck auf Vorschlag 1 - die Wahl wirkte "verselbstaendigt".
  var variantenWunsch = null;
  var hinweise = [], gesagt = {}, letzterText = '';
  var routePunkte = [], routeRefs = [], blitzer = [];
  var sperren = [];                      // {ort,radius,gewicht,hart,text,quelle,kreis}
  var folgen = true, sprache = false, nacht = false;
  var musikWeiter = true;                // Ansage ueber die Musik, siehe tonSitzung()
  var blitzWarnen = true, verkehrAn = true, stoppmodus = false, staumodus = false;
  var schwelle = 5;                      // Minuten Zeitverlust
  var stadtmodus = 'auto';               // 'auto' | 'an' | 'aus'
  var tomtomKey = '';
  var profilId = null;
  var profilNeuVersucht = false;
  var brouterGrund = '';
  // Wenn BRouter drosselt, hilft weiteres Anklopfen nicht - es verlaengert
  // die Sperre eher. Deshalb Pause einlegen und solange den Ersatzdienst
  // nehmen. Nach Ablauf wird beim naechsten Routing wieder BRouter versucht.
  var brouterPauseBis = 0;
  var BROUTER_PAUSE = 10 * 60 * 1000;
  var abseitsZaehler = 0, letzteNeu = 0, laeuft = 0;
  var vorschlagTimer = null, letzteSuche = 0;
  var verkehrTimer = null, letzterVerkehr = 0, verkehrLaeuft = false;
  var schleichErzwingen = false;
  var alternativenGewuenscht = false;
  var letzteVerkehrsRoute = 0, bremsTimer = null, verkehrsAnlass = false;
  var gerechneteNogos = null;            // Sperren, mit denen die Route gerechnet ist
  var verkehrLuecke = '';                // Quellen, die zuletzt nichts geliefert haben
  var fahrmodus = false, drehung = 0, zoomStufe = 0, tempoKmh = 0;
  var kumWeg = [], limitAktuell = null, limitGesagt = null, limitGesagtUm = 0;
  var abschnitte = null;                 // strassenArten() der gewaehlten Route
  // Strassennamen kommen von OSRM (BRouter kennt keine), siehe strassenLaufBauen()
  var strassenLauf = null;
  // Standort-Wachhund: iOS laesst watchPosition nach App-Wechsel (Spotify)
  // oder Bildschirmsperre manchmal still einschlafen - dann kommt keine
  // Position mehr und die Karte "haengt", obwohl man faehrt. Nach GPS_STILL
  // ohne Meldung wird das angezeigt und die Abfrage neu gestartet.
  var GPS_STILL = 10000;
  var gpsId = null, letzteMeldung = 0, gpsNeustart = 0, genauigkeit = 0;
  // Beim Fahren rastet Folgen von selbst wieder ein, wenn die Karte so lange
  // nicht beruehrt wurde. Vorher blieb es nach jedem Verschieben, nach
  // "Übersicht" oder der Stoerfahne fuer immer aus.
  var WIEDER_FOLGEN = 20000;
  var kartenBeruehrt = 0, fingerAufKarte = false;
  // Nach einer Berechnung mit mehreren Vorschlaegen bleiben die so lange
  // stehen; danach raeumt die Fahrt sie weg (alternativenRaeumen)
  var auswahlBis = 0;
  var verkehrKarteAn = true;
  var modus = 'auto';                    // 'auto' | 'rad'
  var feldwegeFrei = false, schotterOk = false;

  // fetch mit Zeitlimit. Ohne das bleibt eine Anfrage bei stehender
  // Mobilverbindung fuer immer offen, die Promise-Kette settled nie und die
  // Statuszeile klebt auf "Berechne Route ...".
  function hol(url, ms, opt) {
    if (!window.AbortController) return fetch(url, opt);
    var ab = new AbortController();
    var uhr = setTimeout(function () { ab.abort(); }, ms || 15000);
    var o = {};
    for (var k in (opt || {})) o[k] = opt[k];
    o.signal = ab.signal;
    return fetch(url, o)
      .then(function (r) { clearTimeout(uhr); return r; },
            function (e) { clearTimeout(uhr); throw e; });
  }

  function $(id) { return document.getElementById(id); }
  var infoStand = 0;
  function info(t) { $('status').textContent = t; infoStand = Date.now(); }
  function merken(k, v) { try { localStorage.setItem('un-' + k, v); } catch (e) {} }
  function geholt(k, ers) {
    try { var v = localStorage.getItem('un-' + k); return v === null ? ers : v; }
    catch (e) { return ers; }
  }

  /* --------------------------------------------------------------- Geometrie */
  var abstand = window.Verkehr.abstand;
  // Intern rechnet alles in [lat, lon]; MapLibre will [lon, lat].
  function m(p) { return [p[1], p[0]]; }
  function kreisPolygon(ort, radius) {
    var ecken = [], t = Math.PI / 180;
    for (var i = 0; i <= 40; i++) {
      var w = i / 40 * 2 * Math.PI;
      ecken.push([ort[1] + radius * Math.sin(w) / (111320 * Math.cos(ort[0] * t)),
                  ort[0] + radius * Math.cos(w) / 110540]);
    }
    return ecken;
  }
  // Lot von p auf die Strecke a-b: Abstand in Metern und Anteil t (0 = a,
  // 1 = b). Grob gerechnet; für "bin ich noch auf der Route" genau genug.
  function lot(p, a, b) {
    var kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
    var px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
    var bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
    var l2 = bx * bx + by * by;
    var t = l2 ? Math.max(0, Math.min(1, (px * bx + py * by) / l2)) : 0;
    var dx = px - t * bx, dy = py - t * by;
    return { d: Math.sqrt(dx * dx + dy * dy), t: t };
  }
  function punktZuStrecke(p, a, b) { return lot(p, a, b).d; }

  // Wie viele Meter eines Linienzugs im Kreis um c liegen. (BRouter selbst
  // rechnet davon nur einen Teil an, siehe MINUTE_KOSTEN.)
  function streckeImKreis(koord, c, r) {
    var kx = 111320 * Math.cos(c[0] * Math.PI / 180), ky = 110540, summe = 0;
    for (var i = 1; i < koord.length; i++) {
      var ax = (koord[i - 1][1] - c[1]) * kx, ay = (koord[i - 1][0] - c[0]) * ky;
      var dx = (koord[i][1] - c[1]) * kx - ax, dy = (koord[i][0] - c[0]) * ky - ay;
      var aa = dx * dx + dy * dy;
      if (!aa) continue;
      var bb = 2 * (ax * dx + ay * dy), cc = ax * ax + ay * ay - r * r;
      var disk = bb * bb - 4 * aa * cc;
      if (disk <= 0) continue;
      var w = Math.sqrt(disk);
      var t1 = Math.max(0, (-bb - w) / (2 * aa)), t2 = Math.min(1, (-bb + w) / (2 * aa));
      if (t2 > t1) summe += (t2 - t1) * Math.sqrt(aa);
    }
    return summe;
  }
  function abstandZurRoute(ll) {
    if (!routePunkte.length) return 0;
    var min = Infinity;
    for (var i = 1; i < routePunkte.length; i++) {
      var d = punktZuStrecke(ll, routePunkte[i - 1], routePunkte[i]);
      if (d < min) min = d;
    }
    return min;
  }
  // Index des nächstgelegenen Routenpunkts - damit lässt sich unterscheiden,
  // was noch vor einem liegt und was schon hinter einem.
  function routenIndex(ll) {
    var best = Infinity, k = 0;
    for (var i = 0; i < routePunkte.length; i++) {
      var d = abstand(ll, routePunkte[i]);
      if (d < best) { best = d; k = i; }
    }
    return k;
  }

  // Wie weit bin ich auf der Route schon gekommen (Meter ab Routenanfang)?
  // Lot auf den naechsten Abschnitt - gesucht zuerst rund um die letzte
  // Position. Sonst springt die Zuordnung dort, wo die Route dicht an sich
  // selbst vorbeifuehrt (Serpentinen, Rampen, Hin- und Rueckweg), und die
  // Abbiegehinweise kaemen in falscher Reihenfolge.
  // Dazu kostet jeder Meter Sprung entlang der Strecke 0,1 m Abstand: mit
  // 15 m GPS-Streuung lag ein spaeterer Abschnitt sonst oft "naeher" - an
  // einer Wende sprang der Fortschritt 400 m vor und der Banner uebersprang
  // zwei Hinweise.
  var lotIdx = -1, lotS = 0, lotMerk = { ll: null, r: null, p: null };
  function lotAufStrecke(ll) {
    var n = routePunkte.length;
    if (n < 2 || kumWeg.length !== n) return null;
    // Banner, Fahrtzeile und Temposchild fragen fuer dieselbe Position
    if (ll === lotMerk.ll && routePunkte === lotMerk.r && lotIdx >= 0) return lotMerk.p;
    function suche(von, bis, stetig) {
      var best = null;
      for (var i = Math.max(1, von); i <= Math.min(n - 1, bis); i++) {
        var l = lot(ll, routePunkte[i - 1], routePunkte[i]);
        var s = kumWeg[i - 1] + l.t * (kumWeg[i] - kumWeg[i - 1]);
        var wert = l.d + (stetig ? Math.abs(s - lotS) * 0.1 : 0);
        if (!best || wert < best.wert) best = { wert: wert, d: l.d, i: i, s: s };
      }
      return best;
    }
    var treffer = null;
    if (lotIdx > 0) {
      var von = lotIdx, bis = lotIdx;
      while (von > 1 && kumWeg[lotIdx] - kumWeg[von - 1] < 300) von--;
      while (bis < n - 1 && kumWeg[bis] - kumWeg[lotIdx] < 3000) bis++;
      treffer = suche(von, bis, true);
      if (treffer && treffer.d > 60) treffer = null;
    }
    if (!treffer) {
      // Neu einrasten (neue Route, lange Luecke): unter den fast gleich
      // nahen Abschnitten der frueheste - nach einer Neuberechnung steht man
      // am Anfang der Strecke, nicht auf ihrem Rueckweg.
      var nah = suche(1, n - 1, false);
      treffer = nah;
      for (var i = 1; i < nah.i; i++) {
        var l = lot(ll, routePunkte[i - 1], routePunkte[i]);
        if (l.d <= nah.d + 20) {
          treffer = { d: l.d, i: i, s: kumWeg[i - 1] + l.t * (kumWeg[i] - kumWeg[i - 1]) };
          break;
        }
      }
    }
    lotIdx = treffer.i;
    lotS = treffer.s;
    lotMerk = { ll: ll, r: routePunkte, p: { s: treffer.s, d: treffer.d, idx: treffer.i } };
    return lotMerk.p;
  }
  function uhrzeit(minutenSpaeter) {
    var d = new Date(Date.now() + minutenSpaeter * 60000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ------------------------------------------------------- Fahransicht */
  // Fahrtrichtung oben, Perspektive, Standort im unteren Drittel, Zoom nach
  // Tempo. MapLibre kann das alles nativ (bearing, pitch, padding) - der
  // fruehere CSS-Rotations-Umbau des Kartenbehaelters ist damit weg.
  // Kamerafahrt - aber nur, wenn die Seite sichtbar ist. Im Hintergrund
  // pausiert der Browser die Animationsschleife, easeTo kaeme nie an und die
  // Kamera bliebe irgendwo haengen. Dann lieber sofort springen.
  function kamera(zielwerte) {
    if (document.hidden) karte.jumpTo(zielwerte);
    else karte.easeTo(zielwerte);
  }

  function fahrmodusAnwenden() {
    fahrmodus = !!(ziel && folgen);
    if (!fahrmodus) kamera({ bearing: 0, pitch: 0, padding: { top: 0 }, duration: 500 });
    naviModusPruefen();
  }

  // Navigationsmodus: Beim Fahren braucht es kein Zielfeld, keine
  // Vorschlagskacheln und keine Stoppliste - die nahmen ein Drittel des
  // Bildschirms. Unten bleiben Ankunftszeile und Knoepfe. Alles kommt wieder
  // mit "Übersicht" (Folgen aus), nach einer Neuberechnung mit Auswahl
  // (auswahlBis) oder mit einem Tipp auf die Ankunftszeile (NAVI_OFFEN lang).
  // Einmal losgefahren bleibt er an, auch an der Ampel.
  var naviModus = false, naviOffenBis = 0, NAVI_OFFEN = 15000;
  function naviModusPruefen() {
    var jetzt = Date.now();
    naviModus = !!(fahrmodus && ziel && routePunkte.length && jetzt >= auswahlBis &&
                   (naviModus || tempoKmh >= 12));
    document.body.classList.toggle('navi', naviModus && jetzt >= naviOffenBis);
  }

  function tempoZoom() {
    if (tempoKmh >= 95) return 15;
    if (tempoKmh >= 55) return 16;
    return 17;
  }

  function folgeAnsicht(ll) {
    // Liegt ein Finger auf der Karte (Zoomen mit zwei Fingern), nicht
    // dagegen anfahren - sonst ruckelt die Geste. Danach geht es weiter.
    if (fingerAufKarte) return;
    if (!fahrmodus || kurs === null) {
      kamera({ center: m(ll), zoom: Math.max(karte.getZoom(), 16), duration: 800 });
      return;
    }
    var z = tempoZoom();
    if (z !== zoomStufe) zoomStufe = z; else z = karte.getZoom();
    kamera({
      center: m(ll), zoom: z, bearing: kurs, pitch: 58,
      // Innenabstand oben schiebt den Fokuspunkt nach unten - das Auto sitzt
      // im unteren Drittel des SICHTBAREN Kartenausschnitts (die Bedienleiste
      // unten verdeckt ~40 %; mehr als 0.12 schoebe den Punkt darunter).
      padding: { top: Math.round(karte.getContainer().clientHeight * 0.12) },
      duration: 950, easing: function (t) { return t; }
    });
  }

  /* ------------------------------------------------------------------- Karte */
  function kartenAufbau() {
    karte = new maplibregl.Map({
      container: 'karte',
      style: STILE[nacht ? 'nacht' : 'tag'].url,
      center: [9.0576, 48.5216], zoom: 13,
      attributionControl: { compact: true, customAttribution: QUELLE },
      pitchWithRotate: false, dragRotate: false,
      // Erst ab 8 Pixeln Bewegung gilt eine Beruehrung als Verschieben (statt
      // 3). Im fahrenden Auto wackelt der Finger beim Antippen - und jedes
      // Verschieben schaltet das Folgen ab.
      clickTolerance: 8
    });
    karte.once('style.load', ebenenAnlegen);

    // Langer Druck setzt das Ziel - auf dem Handy gibt es kein Rechtsklick.
    // iOS/Safari feuert fuer dieselbe Beruehrung BEIDE Ereignisse: touchstart
    // und kurz darauf mousedown. Ohne Sperre liefen dadurch zwei Zeitgeber -
    // einer setzte still ein Ziel, der andere oeffnete das Menue. Genau so
    // ging im Betrieb das eingegebene Ziel verloren.
    var druckTimer = null, druckSperre = 0;
    function druckStart(e) {
      var jetzt = Date.now();
      if (jetzt - druckSperre < 800) return;      // dasselbe Antippen
      druckSperre = jetzt;
      clearTimeout(druckTimer);
      var p = [e.lngLat.lat, e.lngLat.lng];
      var pixel = e.point || { x: karte.getContainer().clientWidth / 2,
                               y: karte.getContainer().clientHeight / 2 };
      druckTimer = setTimeout(function () {
        druckTimer = null;
        // Immer fragen - nie stillschweigend etwas ueberschreiben.
        kartenMenue(p, pixel);
      }, 700);
    }
    function druckEnde() { clearTimeout(druckTimer); druckTimer = null; }
    karte.on('mousedown', druckStart);
    karte.on('touchstart', druckStart);
    ['mouseup', 'touchend', 'mousemove', 'touchmove', 'zoomstart', 'dragstart'].forEach(function (t) {
      karte.on(t, druckEnde);
    });

    karte.on('click', function (e) {
      if (stoppmodus) {
        stoppmodus = false; knopfStand();
        stoppHinzufuegen(e.lngLat.lat, e.lngLat.lng);
      } else if (staumodus) {
        staumodus = false; knopfStand();
        sperreHinzufuegen({
          ort: [e.lngLat.lat, e.lngLat.lng], radius: 220, minuten: 10,
          text: 'Stau von Hand', quelle: 'hand'
        });
        if (ziel) route(); else info('Stauzone gesetzt – jetzt das Ziel eingeben');
      }
    });

    // Klick auf eine Sperrzone loescht sie
    karte.on('click', 'sperr-flaeche', function (e) {
      if (stoppmodus || staumodus) return;
      var i = e.features && e.features[0] && e.features[0].properties.idx;
      if (i != null && sperren[i]) sperreEntfernen(sperren[i]);
    });

    // Folgen aus, wenn man die Karte mit EINEM Finger verschiebt. Zoomen mit
    // zwei Fingern laesst es an - MapLibre meldet dabei ebenfalls dragstart,
    // und genau das schaltete das Folgen bisher still ab.
    karte.on('dragstart', function (e) {
      kartenBeruehrt = Date.now();
      var t = e.originalEvent && e.originalEvent.touches;
      if (t && t.length > 1) return;
      if (folgen) folgenSetzen(false);
    });
    karte.on('zoomstart', function (e) { if (e.originalEvent) kartenBeruehrt = Date.now(); });
    // Mit der Maus (oder langem Ziehen) zaehlt das ENDE der Geste
    karte.on('dragend', function () { kartenBeruehrt = Date.now(); });
    var flaeche = karte.getCanvasContainer();
    flaeche.addEventListener('touchstart', function () {
      fingerAufKarte = true; kartenBeruehrt = Date.now();
    }, { passive: true });
    ['touchend', 'touchcancel'].forEach(function (t) {
      flaeche.addEventListener(t, function (e) {
        if (!e.touches || !e.touches.length) fingerAufKarte = false;
        kartenBeruehrt = Date.now();
      }, { passive: true });
    });
  }

  // Nach jedem Stilwechsel muessen die eigenen Ebenen neu angelegt werden -
  // setStyle wirft alles Fremde weg. Die Marker (DOM-Elemente) ueberleben.
  function ebenenAnlegen() {
    if (karte.getSource('routen')) return;

    // Live-Verkehr (gruen/gelb/rot) direkt auf der Karte - TomTom-Kacheln,
    // eigenes Freikontingent (200.000/Monat), unabhaengig von den Messpunkten
    // fuers Routing. Nur mit Schluessel.
    if (tomtomKey && verkehrKarteAn) {
      karte.addSource('tt-verkehr', {
        type: 'raster', tileSize: 256, minzoom: 8, maxzoom: 16,
        tiles: ['https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=' +
                encodeURIComponent(tomtomKey)],
        attribution: '© TomTom'
      });
      karte.addLayer({ id: 'tt-verkehr', source: 'tt-verkehr', type: 'raster',
                       paint: { 'raster-opacity': 0.8 } });
    }

    radwegeEbenen();

    karte.addSource('routen', { type: 'geojson', data: leer() });
    karte.addSource('sperrzonen', { type: 'geojson', data: leer() });

    karte.addLayer({ id: 'route-neben', source: 'routen', type: 'line',
      filter: ['==', ['get', 'art'], 'neben'],
      paint: { 'line-color': '#8a929c', 'line-width': 4, 'line-opacity': .55, 'line-dasharray': [1.6, 1.8] },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    karte.addLayer({ id: 'route-rand', source: 'routen', type: 'line',
      filter: ['==', ['get', 'art'], 'haupt'],
      paint: { 'line-color': nacht ? '#000' : '#fff', 'line-width': 11, 'line-opacity': .6 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });
    karte.addLayer({ id: 'route-haupt', source: 'routen', type: 'line',
      filter: ['==', ['get', 'art'], 'haupt'],
      paint: { 'line-color': '#1f6feb', 'line-width': 7 },
      layout: { 'line-cap': 'round', 'line-join': 'round' } });

    karte.addLayer({ id: 'sperr-flaeche', source: 'sperrzonen', type: 'fill',
      paint: { 'fill-color': '#c82d2d', 'fill-opacity': .2 } });
    karte.addLayer({ id: 'sperr-rand', source: 'sperrzonen', type: 'line',
      paint: { 'line-color': '#c82d2d', 'line-width': 2, 'line-opacity': .85 } });

    routenZeichnen();
    sperrenZeichnen();
  }
  function leer() { return { type: 'FeatureCollection', features: [] }; }

  /* ------------------------------------------------------------ Radwegenetz
   * Im Radmodus faerbt die Karte ein, was fuer das Rad zaehlt:
   *   gruen  = ausgewiesener Radweg oder Weg mit Radfreigabe
   *   ocker  = befestigter Feld-/Wirtschaftsweg (fahrbar, aber kein Radweg)
   *   rot    = fuer Rad gesperrt (bicycle=no)
   * Das Rot ist der eigentliche Zweck: es beantwortet auf einen Blick die
   * Frage "warum nimmt er den Weg da nicht?" - naemlich weil er nicht darf.
   * Beide Kartenstile liefern die Daten schon mit, es kostet keine Anfrage.
   * Nur die Feldnamen unterscheiden sich (OpenMapTiles vs. Shortbread).
   */
  var RAD_EBENEN = ['rad-feldweg', 'rad-weg', 'rad-gesperrt'];
  var BEFESTIGT = ['paved', 'asphalt', 'concrete', 'compacted',
                   'fine_gravel', 'paving_stones', 'cobblestone', 'sett'];
  var RAD_FREI = ['yes', 'designated', 'permissive', 'official'];

  function radwegeEbenen() {
    if (karte.getLayer('rad-weg')) return;
    var s = radFelder();
    if (!karte.getSource(s.quelle)) return;   // Stil ohne bekannte Strassendaten

    function ebene(id, filter, farbe, breite, strich) {
      var paint = { 'line-color': farbe, 'line-width': breite, 'line-opacity': .85 };
      if (strich) paint['line-dasharray'] = strich;
      karte.addLayer({
        id: id, source: s.quelle, 'source-layer': s.ebene, type: 'line',
        minzoom: 12, filter: filter,
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: paint
      });
    }

    ebene('rad-feldweg', ['all', s.istFeldweg, s.befestigt], '#b8801f', 3, [2.5, 1.5]);
    ebene('rad-weg', s.istRadweg, '#12a150', 3.5, null);
    ebene('rad-gesperrt', ['==', ['get', s.rad], 'no'], '#d63a3a', 3, [1.4, 1.4]);

    radwegeAnzeigen();
  }

  // Feldnamen der beiden Stile. Tag: OpenFreeMap/OpenMapTiles ("transportation",
  // class/subclass). Nacht: VersaTiles/Shortbread ("streets", kind).
  function radFelder() {
    if (nacht) {
      return {
        quelle: 'versatiles-shortbread', ebene: 'streets', rad: 'bicycle',
        istRadweg: ['any',
          ['==', ['get', 'kind'], 'cycleway'],
          ['all', ['match', ['get', 'kind'], ['path', 'footway', 'track'], true, false],
                  ['match', ['get', 'bicycle'], RAD_FREI, true, false]]],
        istFeldweg: ['==', ['get', 'kind'], 'track'],
        befestigt: ['any', ['match', ['get', 'surface'], BEFESTIGT, true, false],
                           ['match', ['get', 'tracktype'], ['grade1', 'grade2'], true, false]]
      };
    }
    return {
      quelle: 'openmaptiles', ebene: 'transportation', rad: 'bicycle',
      istRadweg: ['any',
        ['==', ['get', 'subclass'], 'cycleway'],
        ['all', ['match', ['get', 'class'], ['path', 'track'], true, false],
                ['match', ['get', 'bicycle'], RAD_FREI, true, false]]],
      istFeldweg: ['==', ['get', 'class'], 'track'],
      befestigt: ['match', ['get', 'surface'], BEFESTIGT, true, false]
    };
  }

  function radwegeAnzeigen() {
    var sicht = modus === 'rad' ? 'visible' : 'none';
    RAD_EBENEN.forEach(function (id) {
      if (karte && karte.getLayer(id)) karte.setLayoutProperty(id, 'visibility', sicht);
    });
  }

  // Kleines Menue am Druckpunkt: was soll dieser Ort werden? Ohne das hat
  // ein versehentlicher langer Druck das ganze Ziel ueberschrieben.
  function kartenMenue(ort, pixel) {
    menueSchliessen();
    var m = document.createElement('div');
    m.id = 'kartenmenue';
    var hoehe = 4 * 46 + 8;
    m.style.left = Math.min(Math.max(pixel.x - 80, 8),
                            karte.getContainer().clientWidth - 168) + 'px';
    // Deutlich ueber dem Finger: sonst landet der Klick beim Loslassen auf
    // einem Menuepunkt und loest ihn sofort aus.
    m.style.top = Math.max(pixel.y - hoehe - 40, 8) + 'px';

    // Reihenfolge bewusst: das Harmlose oben, das Ersetzen ganz unten.
    var eintraege = [];
    if (ziel) {
      eintraege.push(['Zwischenziel', function () { stoppHinzufuegen(ort[0], ort[1]); }]);
      eintraege.push(['Stau hier', function () {
        sperreHinzufuegen({ ort: ort, radius: 220, minuten: 10,
                            text: 'Stau von Hand', quelle: 'hand' });
        route();
      }]);
      eintraege.push(['Ziel ersetzen', function () { zielSetzen(ort[0], ort[1], 'Kartenpunkt'); }]);
    } else {
      eintraege.push(['Als Ziel', function () { zielSetzen(ort[0], ort[1], 'Kartenpunkt'); }]);
      eintraege.push(['Zwischenziel', function () { stoppHinzufuegen(ort[0], ort[1]); }]);
      eintraege.push(['Stau hier', function () {
        sperreHinzufuegen({ ort: ort, radius: 220, minuten: 10,
                            text: 'Stau von Hand', quelle: 'hand' });
      }]);
    }
    eintraege.push(['Abbrechen', null]);

    // Erst nach kurzer Schutzzeit bedienbar - der Klick beim Loslassen der
    // langen Beruehrung darf nichts ausloesen.
    var frei = Date.now() + 400;
    eintraege.forEach(function (eintrag) {
      var b = document.createElement('button');
      b.textContent = eintrag[0];
      if (!eintrag[1]) b.className = 'ab';
      if (eintrag[0] === 'Ziel ersetzen') b.className = 'ernst';
      b.onclick = function (e) {
        e.stopPropagation();
        if (Date.now() < frei) return;
        menueSchliessen();
        if (eintrag[1]) eintrag[1]();
      };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    setTimeout(function () {
      document.addEventListener('click', menueSchliessen, { once: true });
    }, 450);
  }

  function menueSchliessen() {
    var offen = $('kartenmenue');
    if (offen) offen.remove();
  }

  function stilSetzen() {
    var st = STILE[nacht ? 'nacht' : 'tag'];
    document.body.style.background = st.hg;
    $('karte').style.background = st.hg;
    karte.setStyle(st.url);
    karte.once('style.load', ebenenAnlegen);
  }

  function routenZeichnen() {
    if (!karte.getSource('routen')) return;
    var fs = [];
    varianten.forEach(function (v, j) {
      fs.push({ type: 'Feature',
        properties: { art: j === variante ? 'haupt' : 'neben' },
        geometry: { type: 'LineString', coordinates: v.koord.map(m) } });
    });
    karte.getSource('routen').setData({ type: 'FeatureCollection', features: fs });
    karte.setPaintProperty('route-rand', 'line-color', nacht ? '#000' : '#fff');
  }

  function sperrenZeichnen() {
    if (!karte.getSource('sperrzonen')) return;
    karte.getSource('sperrzonen').setData({
      type: 'FeatureCollection',
      features: sperren.map(function (sp, i) {
        return { type: 'Feature', properties: { idx: i },
                 geometry: { type: 'Polygon', coordinates: [kreisPolygon(sp.ort, sp.radius)] } };
      })
    });
  }

  /* ---------------------------------------------------------------- Standort */
  // Startet die Positionsabfrage - oder startet sie neu, wenn sie haengt
  // (siehe gpsWache). Die alte wird vorher abgemeldet, sonst kaeme jede
  // Position doppelt.
  function standortStarten() {
    if (!navigator.geolocation) { info('Kein Standort verfügbar'); return; }
    if (gpsId !== null) { try { navigator.geolocation.clearWatch(gpsId); } catch (e) {} }
    gpsNeustart = Date.now();
    gpsId = navigator.geolocation.watchPosition(positionNeu, positionFehler,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  // Ein Fehler in einem Teil (Banner, Blitzer, ...) darf die anderen nicht
  // mitreissen - schon gar nicht das Folgen der Karte.
  function sicher(f, ll) {
    try { f(ll); } catch (e) { if (window.console) console.error(e); }
  }

  // GPS-Filter gegen Spruenge "mitten in die Pampa": iOS schiebt zwischen
  // gute GPS-Positionen immer wieder grobe Schaetzungen aus Funkzellen/WLAN
  // (±100 m bis Kilometer) und liefert nach Tunneln alte, zwischengespeicherte
  // Positionen. Die werden verworfen, solange vor kurzem eine gute kam. Ohne
  // gute Position nimmt die Seite nach GPS_GROB_HALTEN auch grobe - besser
  // als stehenzubleiben.
  var GPS_GROB_HALTEN = 15000;
  var gpsGut = null;                     // zuletzt angenommene: {ll, t, acc, da}
  var gpsSprungZahl = 0, gpsGrobSeit = 0, gpsVerworfenAcc = 0;
  var standortGezeigt = null;            // auf die Route eingerastet

  function positionTaugt(ll, acc, t) {
    var jetzt = Date.now();
    if (jetzt - t > 15000) return false;                     // alt
    if (!gpsGut) return true;
    if (t <= gpsGut.t) return false;                         // doppelt
    if (jetzt - gpsGut.da > GPS_GROB_HALTEN) return true;   // lange nichts Gutes
    if (acc > Math.max(50, 3 * gpsGut.acc)) return false;    // grobe Schaetzung
    // Mehr als 250 km/h (Genauigkeit abgezogen): Sprung. Dreimal hintereinander
    // dasselbe "Springen" ist dagegen echt - dann lag eher die alte falsch.
    var dt = (t - gpsGut.t) / 1000;
    if (abstand(gpsGut.ll, ll) - acc - gpsGut.acc > dt * 70 && gpsSprungZahl < 3) {
      gpsSprungZahl++;
      return false;
    }
    return true;
  }

  // Punkt auf der Route zur Lotposition (fuer die Anzeige)
  function punktAufStrecke(lp) {
    var a = routePunkte[lp.idx - 1], b = routePunkte[lp.idx];
    var seg = kumWeg[lp.idx] - kumWeg[lp.idx - 1];
    var t = seg > 0 ? Math.max(0, Math.min(1, (lp.s - kumWeg[lp.idx - 1]) / seg)) : 0;
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }

  function positionNeu(p) {
    letzteMeldung = Date.now();
    var ll = [p.coords.latitude, p.coords.longitude];
    var acc = p.coords.accuracy || 0;
    var t = p.timestamp || Date.now();
    if (!positionTaugt(ll, acc, t)) { gpsVerworfenAcc = acc; return; }
    gpsSprungZahl = 0;
    gpsVerworfenAcc = 0;
    var vorher = gpsGut;
    gpsGut = { ll: ll, t: t, acc: acc, da: Date.now() };
    gpsGrobSeit = acc > 300 ? (gpsGrobSeit || Date.now()) : 0;
    var erste = !standort;
    standort = ll;
    genauigkeit = acc;
    // Tempo und Richtung: iOS meldet -1 (bei uns null), solange es sie nicht
    // kennt - in der App "Werkstatt" auch mal laenger. Dann aus der Bewegung
    // seit der letzten guten Position.
    var v = p.coords.speed, h = p.coords.heading, eigen = false;
    if (typeof v !== 'number' || isNaN(v) || v < 0) {
      v = null;
      var dt = vorher ? (t - vorher.t) / 1000 : 0;
      if (vorher && dt >= 0.5 && dt <= 10 && acc <= 30 && vorher.acc <= 30) {
        var weg = abstand(vorher.ll, ll);
        v = weg / dt;
        eigen = true;
        if (v > 2.5 && weg > 8) h = window.Verkehr.peilung(vorher.ll, ll);
      }
    }
    // Kurs erst ab 2,5 m/s: beim Rangieren und Rueckwaerts-Ausparken meldet
    // das iPhone die Bewegungsrichtung - rueckwaerts. Die Karte stand dann
    // "falsch herum" und blieb so bis zum Losfahren. Langsam auf der Route
    // gilt deshalb die Richtung der Strecke.
    var lp = (fahrmodus && routePunkte.length > 1) ? lotAufStrecke(ll) : null;
    if (lp && lp.d < 25 && (v || 0) < 4) {
      kurs = window.Verkehr.peilung(routePunkte[lp.idx - 1], routePunkte[lp.idx]);
    } else if (typeof h === 'number' && !isNaN(h) && h >= 0 && (v || 0) > 2.5) {
      kurs = h;
    }
    if (v === null) tempoKmh = 0;
    else if (eigen) tempoKmh = tempoKmh * 0.5 + v * 3.6 * 0.5;   // aus Positionen: glaetten
    else tempoKmh = v * 3.6;
    // Auf der Route rastet der Punkt auf der Linie ein, statt neben ihr zu
    // zittern (gerechnet wird weiter mit der echten Position)
    var zeigen = (lp && lp.d <= Math.max(20, Math.min(acc, 50))) ? punktAufStrecke(lp) : ll;
    standortGezeigt = zeigen;
    gpsAnzeigen(0);
    sicher(function () { ichZeichnen(zeigen, acc); });
    if (folgen) {
      sicher(function () {
        if (erste) karte.jumpTo({ center: m(zeigen), zoom: 16 });
        else folgeAnsicht(zeigen);
      });
    }
    if (erste && ziel) route();
    if (ziel && !gesagt.ziel && Date.now() - fahrtGemerkt > 60000) fahrtMerken();
    if (ziel && routePunkte.length) {
      [bannerAktualisieren, blitzPruefen, abweichungPruefen, fahrdatenZeigen,
       durchfahrenPruefen, alternativenRaeumen].forEach(function (f) { sicher(f, ll); });
      if (blitzBisS && lotS > blitzBisS - 5000) sicher(blitzerNachladen);
      if (naviNeu) { naviNeu = false; letzteNeu = Date.now(); abseitsZaehler = 0; route(); }
      else sicher(naviGesagtMelden);
    }
    sicher(tempoEcke, ll);
  }

  function positionFehler(e) {
    if (e.code === 1) { info('Standort abgelehnt – in den Einstellungen erlauben'); return; }
    info('GPS-Signal fehlt – suche weiter …');
    // Kein Signal oder Zeitueberschreitung: neu anstossen, aber nicht im
    // Sekundentakt
    if (Date.now() - gpsNeustart > 15000) standortStarten();
  }

  // Laeuft alle 2 Sekunden. Erkennt die eingeschlafene Positionsabfrage und
  // laesst Folgen beim Fahren wieder einrasten.
  function gpsWache() {
    var jetzt = Date.now();
    var still = letzteMeldung ? jetzt - letzteMeldung : 0;
    var alt = still > GPS_STILL;
    gpsAnzeigen(alt ? still : 0);
    if (alt && jetzt - gpsNeustart > 15000) standortStarten();
    if (!folgen && standort && !alt && tempoKmh >= 15 &&
        jetzt - kartenBeruehrt > WIEDER_FOLGEN && $('sheet').hidden && !$('kartenmenue')) {
      folgenSetzen(true);
    }
  }

  function gpsAnzeigen(still) {
    var f = $('gpsfahne'), alt = still > 0, jetzt = Date.now();
    // Es kommen Positionen, aber nur verworfene (grob oder Spruenge)
    var gehalten = !alt && gpsGut && gpsVerworfenAcc && jetzt - gpsGut.da > 5000;
    // Dauerhaft grob: meist ist "Genauer Standort" fuer die App aus
    var grob = !alt && gpsGrobSeit && jetzt - gpsGrobSeit > 20000;
    f.hidden = !(alt || gehalten || grob);
    if (alt) f.textContent = '⚠︎ Kein GPS seit ' + Math.round(still / 1000) +
                             ' s – Standort wird neu gesucht';
    else if (gehalten) f.textContent = '⚠︎ GPS ungenau (±' + Math.round(gpsVerworfenAcc) +
                                       ' m) – Position gehalten';
    else if (grob) f.textContent = '⚠︎ GPS sehr ungenau (±' + Math.round(genauigkeit) +
                                   ' m) – iPhone-Einstellungen › Datenschutz › Ortungsdienste › diese App › „Genauer Standort“ an?';
    if (ichMarke) ichMarke.getElement().classList.toggle('alt', alt || gehalten);
    naviModusPruefen();
  }

  var kegelMarke = null;
  function ichZeichnen(ll, genauigkeit) {
    if (!ichMarke) {
      var kegelEl = document.createElement('div');
      kegelEl.className = 'ich-kegel';
      // rotationAlignment 'map': der Kegel zeigt die echte Himmelsrichtung
      // und dreht mit der Karte mit - MapLibre uebernimmt das Rechnen.
      kegelMarke = new maplibregl.Marker({
        element: kegelEl, rotationAlignment: 'map', pitchAlignment: 'map', anchor: 'bottom'
      }).setLngLat(m(ll)).addTo(karte);
      var punktEl = document.createElement('div');
      punktEl.className = 'ich-punkt';
      ichMarke = new maplibregl.Marker({ element: punktEl, rotationAlignment: 'viewport' })
        .setLngLat(m(ll)).addTo(karte);
    } else {
      ichMarke.setLngLat(m(ll));
      kegelMarke.setLngLat(m(ll));
    }
    kegelMarke.getElement().style.display = kurs === null ? 'none' : 'block';
    if (kurs !== null) kegelMarke.setRotation(kurs);
  }

  /* ------------------------------------------------------------ Zwischenziele */  /* ------------------------------------------------------------ Zwischenziele */
  function stoppHinzufuegen(lat, lon, name) {
    stopps.push({ ort: [lat, lon], name: name || ('Stopp ' + (stopps.length + 1)) });
    fahrtMerken();
    stoppMarkenZeichnen();
    stoppListeZeichnen();
    if (ziel) route(); else info('Zwischenziel gesetzt – jetzt noch das Ziel eingeben');
  }
  function stoppEntfernen(i) {
    stopps.splice(i, 1);
    fahrtMerken();
    stoppMarkenZeichnen(); stoppListeZeichnen();
    if (ziel) route();
  }
  function stoppMarkenZeichnen() {
    stoppMarken.forEach(function (mk) { mk.remove(); });
    stoppMarken = stopps.map(function (sp, i) {
      var el = document.createElement('div');
      el.className = 'stopp-punkt';
      el.textContent = i + 1;
      el.onclick = function (e) { e.stopPropagation(); stoppEntfernen(i); };
      return new maplibregl.Marker({ element: el, rotationAlignment: 'viewport' })
        .setLngLat(m(sp.ort)).addTo(karte);
    });
  }

  function stoppListeZeichnen() {
    var l = $('stoppliste');
    // Auch leeren, nicht nur verstecken - sonst bleiben tote Knoepfe im
    // Dokument stehen und lassen sich weiter antippen.
    if (!stopps.length) { l.hidden = true; l.innerHTML = ''; return; }
    l.hidden = false;
    l.innerHTML = '';
    stopps.forEach(function (s, i) {
      var b = document.createElement('button');
      b.innerHTML = '<b>' + (i + 1) + '</b> ' + s.name + ' <span>✕</span>';
      b.onclick = function () { stoppEntfernen(i); };
      l.appendChild(b);
    });
  }

  /* ---------------------------------------------------------------- Sperrzonen */
  // Zeitverlust der Stoerungen, durch die die gewaehlte Route trotz allem
  // hindurchfuehrt (weil es nichts Besseres gibt oder die Schwelle nicht
  // erreicht ist). Der Betrag wird auf die Ankunftszeit aufgeschlagen -
  // BRouter selbst rechnet immer mit freier Fahrt.
  // `ab`: erst ab diesem Routenpunkt zaehlen (was hinter einem liegt, ist
  // schon durchfahren).
  function stauAufRoute(ab) {
    if (!routePunkte.length) return 0;
    return Math.round(stauAuf(ab ? routePunkte.slice(ab) : routePunkte));
  }

  // Minuten Stau auf einer Strecke: je Sperre anteilig nach den Metern, die
  // die Strecke durch ihren Kreis faehrt - wer ihn ganz quert, bekommt die
  // vollen Minuten. BRouter rechnet das Gewicht anders an (siehe
  // MINUTE_KOSTEN) - die Wahl zwischen den Vorschlaegen trifft deshalb diese
  // Rechnung, nicht BRouters Kosten. `fuerWahl`: Hand- und Vollsperren
  // zaehlen dann so schwer, wie sie beim Routing wiegen (Vergleich der
  // Vorschlaege), sonst wie gemeldet (Anzeige der Ankunftszeit).
  function stauAuf(koord, fuerWahl) {
    var summe = 0;
    if (!koord || koord.length < 2) return 0;
    sperren.forEach(function (sp) {
      var min = fuerWahl ? wahlMinuten(sp) : sp.minuten;
      if (!min) return;
      var drin = streckeImKreis(koord, sp.ort, sp.radius);
      if (drin > 0) summe += min * Math.min(1, drin / (2 * sp.radius));
    });
    return summe;
  }
  function wahlMinuten(sp) {
    if (sp.hart) return Math.max(sp.minuten || 0, 60);
    if (sp.quelle === 'hand') return Math.max(sp.minuten || 0, HAND_MINUTEN);
    return sp.minuten || 0;
  }
  // Fahrzeit einer Variante MIT dem Stau, durch den sie fuehrt. BRouters
  // eigene Zeit (`min`) rechnet immer mit freier Fahrt - nach ihr sortiert,
  // saehe die Route mitten durch den Stau immer am schnellsten aus.
  function zeit(v) {
    if (v.malus == null) v.malus = stauAuf(v.koord, true);
    return v.min + v.malus;
  }

  // Aus dem gemeldeten Zeitverlust wird das Sperrgewicht (Kosten je Meter im
  // Kreis, siehe MINUTE_KOSTEN). Ein 20-Minuten-Stau verbiegt die Route
  // deutlich staerker als ein 6-Minuten-Stau. Bei einer TomTom-Kette traegt
  // jeder Kreis den GANZEN Stau: liegen mehrere Kreise auf einem Wegstueck
  // ohne Kreuzung, rechnet BRouter davon nur einen an.
  function gewichtAus(sp) {
    if (sp.hart) return 0;                          // 0 = harte Sperre
    var min = Math.max(wahlMinuten(sp), sp.gesamt || 0, 1);
    // Nie 0 - ohne Gewicht wuerde BRouter die Zone hart sperren
    return Math.max(1, Math.round(min * MINUTE_KOSTEN / (2 * sp.radius * ANRECHNUNG)));
  }

  function sperreHinzufuegen(s) {
    var sp = {
      ort: s.ort,
      radius: s.radius || 220,
      hart: !!s.hart,
      minuten: s.minuten || 0,
      gesamt: s.gesamtMinuten || s.minuten || 0,   // ganzer Stau (TomTom-Kette)
      text: s.text || 'Stau',
      quelle: s.quelle || 'hand',
      ref: s.ref || null,                 // Autobahn, fuers Nachmessen
      bestaetigt: Date.now()              // zuletzt als Stau gemessen
    };
    sp.gewicht = gewichtAus(sp);
    sperren.push(sp);
    sperrenZeichnen();
    stoerfahne();
    return sp;
  }

  function sperreEntfernen(s) {
    var i = sperren.indexOf(s);
    if (i < 0) return;
    sperren.splice(i, 1);
    sperrenZeichnen();
    stoerfahne();
    if (ziel) route();
  }

  function sperrenLeeren(nurQuelle) {
    sperren = sperren.filter(function (sp) { return nurQuelle && sp.quelle !== nurQuelle; });
    sperrenZeichnen();
    stoerfahne();
  }

  // Sichtbar machen, wenn nur der Ersatzdienst laeuft - sonst wundert man
  // sich, warum die drei Vorschlaege fehlen und keine Umfahrung greift.
  function ersatzfahne(an, grund) {
    var f = $('ersatzfahne');
    f.hidden = !an;
    if (an) f.textContent = '⚠︎ Ersatzdienst' + (grund ? ' · ' + grund : '') +
                            ' · Umfahrung eingeschränkt';
  }

  function stoerfahne() {
    var f = $('stoerfahne');
    if (!sperren.length) { f.hidden = true; return; }
    var min = sperren.reduce(function (a, s) { return a + (s.minuten || 0); }, 0);
    f.hidden = false;
    f.textContent = 'Umfahrung aktiv · ' + sperren.length +
                    (sperren.length === 1 ? ' Störung' : ' Störungen') +
                    (min ? ' · ' + Math.round(min) + ' min gespart' : '') + ' ›';
  }

  // Fahne antippen: zur Stoerung springen und sie benennen. Bei mehreren
  // reihum durchgehen, damit man jede einzeln ansehen kann.
  var stoerZeiger = 0;
  function stoerungZeigen() {
    if (!sperren.length) return;
    stoerZeiger = stoerZeiger % sperren.length;
    var sp = sperren[stoerZeiger];
    stoerZeiger++;
    folgenSetzen(false);
    karte.easeTo({ center: [sp.ort[1], sp.ort[0]], zoom: 15, bearing: 0, pitch: 0, duration: 700 });
    info(sp.text + (sperren.length > 1
      ? ' · ' + stoerZeiger + '/' + sperren.length + ' – nochmal tippen für die nächste'
      : ' · tippe den roten Kreis an, um sie zu löschen'));
  }

  // BRouter erwartet lon,lat,radius[,gewicht], mehrere durch | getrennt.
  // Ohne Gewicht ist die Zone hart gesperrt, mit Gewicht nur teuer.
  // `ohneStau`: nur Hand- und Vollsperren - fuer den Vergleichsweg, der
  // einfach durch den Stau faehrt.
  function nogoParameter(ohneStau) {
    var liste = ohneStau
      ? sperren.filter(function (s) { return s.quelle === 'hand' || s.hart; })
      : sperren;
    if (!liste.length) return '';
    return '&nogos=' + liste.map(function (s) {
      return s.ort[1].toFixed(6) + ',' + s.ort[0].toFixed(6) + ',' + s.radius +
             (s.gewicht ? ',' + s.gewicht : '');
    }).join('|');
  }

  /* ------------------------------------------------------- Sofort ausweichen */
  // Fuer den Moment, in dem man IM Stau steht, den keine Quelle meldet:
  // legt zwei enge Sperren auf die eigene Route direkt voraus und rechnet
  // neu - diesmal mit erzwungenem Schleichweg-Vorschlag, egal wie lang die
  // Fahrt ist. Kein Warten auf TomTom oder Meldungen.
  function ausweichen() {
    if (!ziel || !routePunkte.length || !standort) { info('Erst ein Ziel setzen'); return; }
    // Nochmal gedrueckt = neue Lage: alte Vor-mir-Sperren ersetzen, nicht stapeln
    sperren = sperren.filter(function (sp) { return sp.text !== 'Stau vor mir'; });
    sperrenZeichnen();
    var idx = routenIndex(standort);
    var abHier = kumWeg[idx];
    [300, 900].forEach(function (voraus) {
      for (var i = idx; i < routePunkte.length; i++) {
        if (kumWeg[i] - abHier >= voraus) {
          sperreHinzufuegen({ ort: routePunkte[i], radius: 200, minuten: 10,
                              text: 'Stau vor mir', quelle: 'hand' });
          return;
        }
      }
    });
    schleichErzwingen = true;
    if (sprache) { letzterText = ''; sagen('Weiche aus'); }
    info('Weiche aus – suche Nebenstraßen …');
    route();
  }

  /* ------------------------------------------------------------------ Verkehr */
  // Eine automatische Sperre haelt, solange ihr Stau bestaetigt wird. Faellt
  // sie aus der Meldung, wird ihre EIGENE Stelle nachgemessen: erst wenn es
  // dort wieder frei ist UND sie seit HALTEN nicht mehr bestaetigt wurde,
  // faellt sie. Antwortet kein Dienst, haelt sie HALTEN_OHNE_DATEN.
  // Frueher fiel sie, sobald die Umfahrung selbst frei gemessen war - also
  // anderthalb Sekunden nach dem Umleiten -, und die Route kehrte mitten in
  // den Stau zurueck.
  var HALTEN = 10 * 60 * 1000;
  var HALTEN_OHNE_DATEN = 30 * 60 * 1000;
  // Mindestabstand verkehrsbedingter Neuberechnungen, in beide Richtungen
  var BREMSE = 120000;

  function istAuto(sp) { return sp.quelle !== 'hand'; }

  // Sperre still streichen, weil sie hinter uns liegt - ohne Neuberechnung,
  // fuer den Weg vor uns aendert sich nichts.
  function sperreStreichen(sp) {
    var i = sperren.indexOf(sp);
    if (i < 0) return;
    var aktuell = gerechneteNogos === nogoParameter();
    sperren.splice(i, 1);
    if (aktuell) gerechneteNogos = nogoParameter();
    sperrenZeichnen();
    stoerfahne();
  }

  // Durchfahrene Stoerungen fallen weg: war man einmal im Kreis, ist wieder
  // draussen und fuehrt der Weg voraus nicht mehr hinein, liegt der Stau
  // hinter einem. Die letzte Bedingung zaehlt bei den grossen Autobahn-
  // Kreisen (900 m): eine Umfahrung streift sie oft nur am Rand.
  function durchfahrenPruefen(ll) {
    sperren.slice().forEach(function (sp) {
      if (!istAuto(sp)) return;
      var d = abstand(ll, sp.ort);
      if (d < sp.radius) sp.drin = true;
      else if (sp.drin && d > sp.radius + 150 &&
               !streckeImKreis(routePunkte.slice(Math.max(0, lotIdx - 1)), sp.ort, sp.radius)) {
        sperreStreichen(sp);
      }
    });
  }

  function verkehrPruefen(stillschweigend) {
    if (modus === 'rad') return;         // Stau interessiert das Rad nicht
    if (!verkehrAn || !routePunkte.length || verkehrLaeuft) return;
    verkehrLaeuft = true;
    letzterVerkehr = Date.now();
    $('k-verkehr').classList.add('an');
    if (!stillschweigend) info('Prüfe Verkehrslage auf den nächsten Kilometern …');
    function fertig() {
      verkehrLaeuft = false;
      $('k-verkehr').classList.remove('an');
    }

    // Nur den Teil vor uns betrachten - hinter uns liegende Staus sind egal.
    var vorne = routePunkte.slice(standort ? routenIndex(standort) : 0);
    if (vorne.length < 2) { fertig(); return; }

    // Vorausschau: bei langen Fahrten reichen 15 km (weiter vorn aendert sich
    // die Lage bis zum Eintreffen ohnehin). Bei kurzen Fahrten muss aber die
    // GANZE Reststrecke geprueft werden - sonst faellt ausgerechnet der
    // zaehe Zielbereich durchs Raster, wie bei Tuebingen -> Reutlingen (15,9 km).
    var restKm = 0;
    for (var i = 1; i < vorne.length; i++) restKm += abstand(vorne[i - 1], vorne[i]);
    restKm /= 1000;
    var sichtKm = restKm <= 25 ? restKm + 1 : 15;

    var neu = [];
    window.Verkehr.alleStoerungen(vorne, routeRefs, tomtomKey, schwelle, sichtKm)
      .then(function (stoerungen) {
        var jetzt = Date.now();
        verkehrLuecke = (stoerungen.ausfall || []).join(', ');

        // 1. Gemeldetes mit den Sperren abgleichen: derselbe Stau bestaetigt
        //    seine Sperre, ein neuer bekommt eine. 500 m Spielraum, weil die
        //    TomTom-Messpunkte mit jeder Pruefung ein Stueck weiterwandern.
        stoerungen.forEach(function (st) {
          var alt = null;
          sperren.forEach(function (sp) {
            if (!alt && istAuto(sp) &&
                abstand(sp.ort, st.ort) < Math.max(Math.max(sp.radius, st.radius || 0) * 1.2, 500)) alt = sp;
          });
          if (!alt) { neu.push(st); return; }
          alt.bestaetigt = jetzt;
          // Nur deutliche Aenderungen uebernehmen. Jede Messung schwankt ein
          // wenig - wuerde jede das Gewicht verschieben, rechnete die Route
          // alle drei Minuten neu und sagte jedes Mal wieder an.
          var gesamt = st.gesamtMinuten || st.minuten;
          if (!!st.hart !== alt.hart ||
              Math.abs(st.minuten - alt.minuten) >= Math.max(2, alt.minuten * 0.25) ||
              Math.abs(gesamt - alt.gesamt) >= Math.max(2, alt.gesamt * 0.25)) {
            alt.minuten = st.minuten;
            alt.gesamt = gesamt;
            alt.hart = !!st.hart;
            alt.text = st.text || alt.text;
            alt.gewicht = gewichtAus(alt);
          }
        });

        // 2. Nicht gemeldete Sperren an ihrer eigenen Stelle nachmessen. Die
        //    Pruefung lief nur entlang der Route - und die fuehrt bei einer
        //    Umfahrung gerade NICHT durch den Stau. Weit hinter uns: weg.
        var offen = [];
        sperren.slice().forEach(function (sp) {
          if (!istAuto(sp) || sp.bestaetigt === jetzt) return;
          if (standort && abstand(standort, sp.ort) > 25000) sperreStreichen(sp);
          else offen.push(sp);
        });
        return window.Verkehr.nachmessen(offen, tomtomKey).then(function (befunde) {
          offen.forEach(function (sp, k) {
            if (befunde[k] === 'stau') { sp.bestaetigt = jetzt; return; }
            var frist = befunde[k] === 'frei' ? HALTEN : HALTEN_OHNE_DATEN;
            if (jetzt - sp.bestaetigt < frist) return;       // haelt noch
            var j = sperren.indexOf(sp);
            if (j >= 0) sperren.splice(j, 1);
          });
          neu.forEach(sperreHinzufuegen);
          sperrenZeichnen();
          stoerfahne();
          return stoerungen;
        });
      })
      .then(function (stoerungen) {
        fertig();
        var autos = sperren.filter(istAuto).length;
        if (!stillschweigend && !neu.length) {
          if (!stoerungen.length && verkehrLuecke) {
            info('Verkehrsdaten gerade nicht verfügbar (' + verkehrLuecke + ')');
          } else if (autos) {
            info('Verkehrslage unverändert – Umfahrung bleibt');
          } else {
            info(tomtomKey ? 'Freie Fahrt – keine Störung ab ' + schwelle + ' min'
                           : 'Keine Autobahn-Störung. Für Staus auf Land- und '
                             + 'Stadtstraßen fehlt der TomTom-Schlüssel.');
          }
        }
        if (neu.length && sprache) {
          var min = Math.round(neu.reduce(function (a, s) { return a + s.minuten; }, 0));
          letzterText = '';
          sagen(neu.length === 1
            ? 'Stau voraus, ' + min + ' Minuten. Ich suche eine Umfahrung.'
            : neu.length + ' Störungen voraus, zusammen ' + min +
              ' Minuten. Ich suche eine Umfahrung.');
        }
        // Neu, geaendert, aufgeloest - oder eine frueher gebremste Rechnung,
        // die noch aussteht: das erledigt die gebremste Neuberechnung.
        verkehrsNeuberechnung();
      })
      .catch(function () {
        fertig();
        info('Verkehrsdienst antwortet nicht');
      });
  }

  // Verkehrsbedingt neu rechnen - hoechstens alle zwei Minuten, und zwar in
  // BEIDE Richtungen (Stau kommt, Stau geht). Was in die Sperrfrist faellt,
  // wird nachgeholt statt verworfen: frueher blieb es einfach liegen, dann
  // standen die Sperren in der Liste, die Route fuehrte aber weiter mitten
  // durch den Stau.
  function verkehrsNeuberechnung() {
    clearTimeout(bremsTimer);
    bremsTimer = null;
    if (!ziel || !standort || nogoParameter() === gerechneteNogos) return;
    var warten = letzteVerkehrsRoute + BREMSE - Date.now();
    if (warten > 0) { bremsTimer = setTimeout(verkehrsNeuberechnung, warten); return; }
    letzteVerkehrsRoute = Date.now();
    verkehrsAnlass = true;
    route();
  }

  // Feste Blitzer fuer die naechsten 25 km ab dem Standort. Naehert man sich
  // dem Ende des geladenen Stuecks, kommt das naechste dazu - vorher gab es
  // nach km 25 keine Warnung mehr.
  var blitzBisS = 0;
  function blitzerNachladen(melden) {
    if (modus !== 'auto' || !routePunkte.length) return;
    var pos = standort ? lotAufStrecke(standort) : null;
    if (pos && pos.d > 150) pos = null;
    var fuer = routePunkte;
    blitzBisS = (pos ? pos.s : 0) + 25000;   // sofort: bei Fehlern keine Anfrage-Flut
    window.Verkehr.blitzerLaden(routePunkte.slice(pos ? pos.idx - 1 : 0), 25).then(function (b) {
      if (routePunkte !== fuer) return;      // inzwischen andere Route
      blitzer = b;
      blitzerZeichnen();
      naviMelden();
      if (melden && b.length) info($('status').textContent + ' · ' + b.length + ' Blitzer');
    });
  }

  function verkehrTaktStarten() {
    clearInterval(verkehrTimer);
    // Alle drei Minuten. Häufiger lohnt nicht - Staumeldungen ändern sich
    // nicht schneller, und das TomTom-Freikontingent ist begrenzt.
    verkehrTimer = setInterval(function () {
      if (!ziel || !routePunkte.length || !standort) return;
      var v = varianten[variante];
      if (!routeRefs.length && v && v.messages) {
        // Kennungen nachholen, falls die Auskunft beim ersten Mal klemmte
        window.Verkehr.refsErmitteln(v.messages || null, routePunkte).then(function (refs) {
          routeRefs = refs;
          verkehrPruefen(true);
        });
      } else verkehrPruefen(true);
    }, 180000);
  }

  /* ------------------------------------------------------------------ Blitzer */
  function blitzerZeichnen() {
    blitzMarken.forEach(function (mk) { mk.remove(); });
    blitzMarken = [];
    if (!blitzWarnen || modus === 'rad') return;
    blitzer.forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'blitz-punkt' + (b.mobil ? ' mobil' : '');
      el.textContent = b.tempo || '!';
      blitzMarken.push(new maplibregl.Marker({ element: el, rotationAlignment: 'viewport' })
        .setLngLat(m(b.ort)).addTo(karte));
    });
  }

  // Warnt nur vor Blitzern  // Warnt nur vor Blitzern, auf die man wirklich zufährt. OSM hält bei vielen
  // Standorten die Messrichtung fest; wo sie fehlt, wird über den Kurs
  // entschieden, um Gegenrichtungs-Fehlalarme zu vermeiden.
  function blitzPruefen(ll) {
    if (!blitzWarnen || modus === 'rad' || !blitzer.length) { $('blitzfahne').hidden = true; return; }
    var naechster = null, nd = Infinity;
    blitzer.forEach(function (b) {
      var d = abstand(ll, b.ort);
      if (d > 500 || d >= nd) return;
      if (kurs !== null) {
        // Liegt der Blitzer ungefähr voraus?
        if (window.Verkehr.winkelDiff(window.Verkehr.peilung(ll, b.ort), kurs) > 65) return;
        if (b.richtung.length &&
            !b.richtung.some(function (r) { return window.Verkehr.winkelDiff(r, kurs) < 60; })) return;
      }
      naechster = b; nd = d;
    });
    var f = $('blitzfahne');
    if (!naechster) { f.hidden = true; return; }
    f.hidden = false;
    f.textContent = '📷 ' + (naechster.mobil ? 'Mobiler Blitzer' : 'Blitzer') +
                    ' in ' + Math.round(nd / 10) * 10 + ' m' +
                    (naechster.tempo ? ' · Tempo ' + naechster.tempo : '');
    var schluessel = 'blitz' + naechster.ort[0].toFixed(5);
    if (nd < 350 && !gesagt[schluessel]) {
      gesagt[schluessel] = true;
      sagen('Achtung, ' + (naechster.mobil ? 'mobiler Blitzer' : 'Blitzer') +
            (naechster.tempo ? '. Tempo ' + naechster.tempo : ' voraus'));
    }
  }

  /* ------------------------------------------------------------------ Profil */
  // Das eigene Profil wird beim ersten Start zu BRouter hochgeladen und die
  // Kennung gemerkt. BRouter räumt hochgeladene Profile irgendwann weg -
  // deshalb bei einem Fehlschlag einmal neu hochladen.
  var PROFIL_VERSION = '3';   // bei jeder Aenderung an umfahrung.brf hochzaehlen
  function profilBesorgen(erzwingen) {
    var gemerkt = geholt('profilid', '');
    if (geholt('profilv', '') !== PROFIL_VERSION) { gemerkt = ''; merken('profilv', PROFIL_VERSION); }
    if (gemerkt && !erzwingen) { profilId = gemerkt; return Promise.resolve(profilId); }
    return hol(PROFIL_DATEI, 15000)
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        return hol(BROUTER + '/profile', 20000, { method: 'POST', body: txt });
      })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.profileid) throw new Error('kein Profil');
        profilId = d.profileid;
        merken('profilid', profilId);
        return profilId;
      })
      .catch(function () {
        // Auch die gemerkte Kennung wegwerfen - sonst liefert der naechste
        // Aufruf wieder die alte, tote Kennung und es entsteht eine Schleife
        // aus Fehlversuch und Neuversuch.
        merken('profilid', '');
        profilId = ERSATZPROFIL;
        return profilId;
      });
  }

  /* ----------------------------------------------------------------- Routing */
  function zielSetzen(lat, lon, name) {
    ziel = [lat, lon];
    zielName = name || '';
    if (zielMarke) zielMarke.remove();
    var zEl = document.createElement('div');
    zEl.className = 'ziel-punkt';
    zEl.textContent = '🏁';
    zielMarke = new maplibregl.Marker({ element: zEl, rotationAlignment: 'viewport', anchor: 'bottom' })
      .setLngLat(m(ziel)).addTo(karte);
    $('suche').value = (name || '').split(',')[0];
    $('suche-loeschen').hidden = false;
    if (name && name !== 'Kartenpunkt') zielMerken(name.split(',')[0], lat, lon);
    fahrtMerken();
    // Neues Ziel, neue Lage: Staus der alten Strecke nicht mitschleppen
    sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic');
    fahrmodusAnwenden();
    route();
  }

  // Die Fahrt ueberlebt ein Neuladen der Seite (in der App "Werkstatt"
  // beendet iOS sie bei gesperrtem Bildschirm manchmal): Ziel und
  // Zwischenziele liegen im Speicher und kommen beim Start zurueck - solange
  // die Fahrt keine FAHRT_HALTEN ruht und das Ziel nicht erreicht ist.
  var FAHRT_HALTEN = 30 * 60 * 1000, fahrtGemerkt = 0;
  function fahrtMerken() {
    fahrtGemerkt = Date.now();
    merken('fahrt', ziel ? JSON.stringify({ ziel: ziel, name: zielName, stopps: stopps, t: fahrtGemerkt }) : '');
  }
  function fahrtHolen() {
    var f = null;
    try { f = JSON.parse(geholt('fahrt', '') || 'null'); } catch (e) {}
    if (!f || !f.ziel || f.ziel.length !== 2 || Date.now() - (f.t || 0) > FAHRT_HALTEN) {
      merken('fahrt', '');
      // Lief in der App noch die Hintergrund-Navi weiter (Seite war weg), hier endet sie
      if (naviNativ) window.funkNativ.navi.ende().catch(function () {});
      return;
    }
    stopps = (f.stopps || []).filter(function (sp) { return sp && sp.ort && sp.ort.length === 2; });
    stoppMarkenZeichnen(); stoppListeZeichnen();
    zielSetzen(f.ziel[0], f.ziel[1], f.name);
  }

  function zielMerken(n, lat, lon) {
    var liste = [];
    try { liste = JSON.parse(geholt('ziele', '[]')); } catch (e) {}
    liste = [{ n: n, lat: lat, lon: lon }].concat(
      liste.filter(function (z) { return z.n !== n; })).slice(0, 6);
    merken('ziele', JSON.stringify(liste));
  }

  function zielLoeschen() {
    ziel = null; zielName = ''; varianten = []; hinweise = [];
    routePunkte = []; routeRefs = []; blitzer = []; blitzBisS = 0;
    fahrtMerken();
    naviMelden();
    if (zielMarke) { zielMarke.remove(); zielMarke = null; }
    routenZeichnen();
    blitzerZeichnen();
    sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic');
    clearTimeout(bremsTimer); bremsTimer = null;
    gerechneteNogos = null; verkehrLuecke = '';
    $('varianten').hidden = true;
    $('banner').hidden = true;
    $('blitzfahne').hidden = true;
    $('suche').value = '';
    $('suche-loeschen').hidden = true;
    ersatzfahne(false);
    fahrmodusAnwenden();
    info('Ziel gelöscht');
  }

  function route() {
    if (!ziel) return;
    if (!standort) { info('Warte auf Standort …'); return; }
    var lauf = ++laeuft;
    info('Berechne Route …');

    var punkte = [standort].concat(stopps.map(function (s) { return s.ort; }), [ziel]);
    var ll = punkte.map(function (p) { return p[1] + ',' + p[0]; }).join('|');
    var nogos = nogoParameter();

    var radfahrt = modus === 'rad';
    var ohneStau = radfahrt ? nogos : nogoParameter(true);
    var ausVerkehr = verkehrsAnlass;       // wegen Stau neu gerechnet?
    verkehrsAnlass = false;

    // Waehrend der Fahrt (Abweichung, Stauwechsel) braucht es KEINE
    // Auswahl - nur den besten Weg. Das spart drei Viertel der Anfragen und
    // war der eigentliche Grund fuer die Drosselung: sechs Anfragen bei
    // jeder Neuberechnung summieren sich auf einer Fahrt schnell zu Hunderten.
    // Waehrend der Fahrt reicht der beste Weg - die Auswahl holt man sich
    // bewusst ueber "Übersicht". Das spart drei Viertel der Anfragen.
    var nurHaupt = !!(fahrmodus && varianten.length && !schleichErzwingen && !alternativenGewuenscht);
    alternativenGewuenscht = false;

    if (Date.now() < brouterPauseBis) return osrmRoute(punkte, lauf);

    var kette = (radfahrt ? Promise.resolve('trekking') : profilBesorgen(false)).then(function (prof) {
      // Mehrere Kandidaten, damit am Ende wirklich drei *verschiedene* übrig
      // bleiben. BRouters Alternativen ähneln sich oft; die Anfrage ohne
      // Autobahn bringt fast immer eine echte Alternative.
      var kandidaten = [
        { zusatz: '&alternativeidx=0', marke: '' },
        { zusatz: '&alternativeidx=1', marke: '' },
        { zusatz: '&alternativeidx=2', marke: '' },
        { zusatz: '&alternativeidx=0&profile:avoid_motorways=1', marke: '' }
      ];
      // Beim Rad bringen BRouters Alternativen kaum Unterschied - sie rechnen
      // ja mit demselben Profil und weichen nur ein paar Strassen aus. Der
      // echte Unterschied steckt im Profil selbst: trekking bleibt auf
      // Asphalt, gravel nimmt befestigte Feldwege (oft deutlich direkter),
      // fastbike-lowtraffic meidet Verkehr. Drei Profile statt drei
      // Alternativen - gleiche Zahl Anfragen, drei wirklich andere Wege.
      if (radfahrt) {
        kandidaten = RAD_PROFILE.map(function (p) {
          return { zusatz: '&alternativeidx=0', marke: p.marke, profil: p.profil };
        });
        // Waehrend der Fahrt nur nachrechnen, was gerade gefahren wird -
        // sonst springt die Fuehrung bei jeder Neuberechnung aufs Standard-
        // profil zurueck und der eben gewaehlte Feldweg ist wieder weg.
        if (nurHaupt) {
          var wunsch = (variantenWunsch && variantenWunsch.marke) || '';
          var treffer = kandidaten.filter(function (k) { return k.marke === wunsch; });
          kandidaten = treffer.length ? treffer : kandidaten.slice(0, 1);
        }
      } else if (nurHaupt) kandidaten = kandidaten.slice(0, 1);
      if (!nurHaupt && !radfahrt && (stadtmodusGilt(punkte) || schleichErzwingen)) {
        kandidaten.push({
          zusatz: '&alternativeidx=0&profile:vmax=' + STADT_VMAX, marke: 'Schleichweg'
        });
        kandidaten.push({
          zusatz: '&alternativeidx=1&profile:vmax=' + STADT_VMAX, marke: 'Schleichweg'
        });
      }
      // Vergleichsweg: einfach durch den Stau. Ein Umweg wird nur genommen,
      // wenn er schneller ist als dieser Weg SAMT Stauminuten. BRouters
      // Kosten sind keine Minuten - darauf allein ist kein Verlass.
      if (ohneStau !== nogos) {
        kandidaten.push({ zusatz: '&alternativeidx=0', marke: '', nogos: ohneStau });
      }
      // Wege-Schalter nur im Auto-Modus - das trekking-Profil kennt die
      // Parameter nicht und BRouter bricht bei unbekannten Namen ab
      var wege = radfahrt ? '' :
        (feldwegeFrei ? '&profile:feldwege_frei=1' : '') +
        (schotterOk ? '&profile:schotter_ok=1' : '');
      // Unterwegs die Fahrtrichtung mitgeben: sonst beginnt die Route nach
      // einer Abweichung gern hinter dem Auto ("hinten herum"), ohne Ansage
      // zum Wenden - und nach 40 s heisst es wieder "neu berechnet".
      var richtung = (fahrmodus && kurs !== null && tempoKmh > 10) ? '&heading=' + Math.round(kurs) : '';
      function hole(k) {
        return hol(BROUTER + '?lonlats=' + ll + '&profile=' + (k.profil || prof) +
                   '&format=geojson&timode=2' + richtung + k.zusatz + wege +
                   (k.nogos != null ? k.nogos : nogos), 20000)
          .then(function (r) {
            if (!r.ok) {
              // 403 ist BRouters eigene Drosselung ("Please, retry later!").
              // Sie haengt an der IP und loest sich von selbst wieder.
              if (r.status === 403) {
                brouterGrund = 'BRouter drosselt gerade';
                brouterPauseBis = Date.now() + BROUTER_PAUSE;
              } else brouterGrund = 'BRouter antwortet nicht';
              return null;
            }
            return r.json();
          })
          .then(function (g) { return g ? { geo: g, marke: k.marke } : null; })
          .catch(function () { return null; });
      }

      // Erst NUR den Hauptweg holen. Antwortet BRouter nicht, sind wir nach
      // einer Anfrage draussen statt nach sechs - genau die sechs Fehlschlaege
      // bei jeder Berechnung haben die Drosselung am Leben gehalten.
      // Die Alternativen kommen erst nach, wenn der Hauptweg da ist.
      var anfragen = hole(kandidaten[0]).then(function (haupt) {
        if (!haupt) return [null];
        if (kandidaten.length === 1) return [haupt];
        return Promise.all(kandidaten.slice(1).map(hole))
          .then(function (rest) { return [haupt].concat(rest); });
      });

      // Zurueckgeben, nicht nur anstossen: sonst ist die aeussere Kette schon
      // fertig, bevor hier ueberhaupt etwas passiert - und der .catch unten
      // haengt an einer Kette, in der der eigentliche Teil gar nicht liegt.
      return anfragen.then(function (ergebnisse) {
        if (lauf !== laeuft) return;               // eine neuere Anfrage läuft
        if (!ergebnisse.some(Boolean)) {
          // Profil bei BRouter weggeraeumt? Einmal neu hochladen, dann nochmal.
          // Nur einmal - wenn BRouter selbst nicht antwortet (Wartung,
          // Drosselung), wuerde das sonst endlos kreisen.
          if (!radfahrt && prof !== ERSATZPROFIL && !profilNeuVersucht) {
            profilNeuVersucht = true;
            merken('profilid', '');
            return profilBesorgen(true).then(function () { route(); });
          }
          // Notlauf: der offene OSRM-Dienst der FOSSGIS rechnet die Route.
          // Keine Sperrzonen, kein Schleichweg - aber Karte, Fuehrung und
          // Ansagen bleiben am Leben, statt dass gar nichts mehr geht.
          return osrmRoute(punkte, lauf);
        }
        profilNeuVersucht = false;

        var roh = [];
        ergebnisse.forEach(function (e) {
          var f = e && e.geo && e.geo.features && e.geo.features[0];
          if (!f || !f.geometry || !f.geometry.coordinates) return;
          var pr = f.properties || {};
          roh.push({
            marke: e.marke,
            koord: f.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }),
            hinweise: pr.voicehints || [],
            km: parseInt(pr['track-length'] || 0, 10) / 1000,
            min: Math.round(parseInt(pr['total-time'] || 0, 10) / 60),
            auf: parseInt(pr['filtered ascend'] || 0, 10),
            messages: pr.messages || null,
            art: streckenArt(pr.messages)
          });
        });
        if (!roh.length) {
          info(sperren.length ? 'Keine Route – Sperrzone zu gross?' : 'Keine Route gefunden');
          return;
        }

        ersatzfahne(false);
        var luft = abstand(punkte[0], punkte[punkte.length - 1]) / 1000;
        varianten = auswaehlen(verschiedene(roh), luft);
        // Waehrend der Fahrt nur der beste Weg - der Vergleichsweg durch den
        // Stau war nur zum Abwaegen da.
        if (nurHaupt) varianten = varianten.slice(0, 1);
        if (varianten.length > 1) auswahlBis = Date.now() + 25000;
        gerechneteNogos = nogos;

        // Zur zuletzt selbst gewaehlten Art zurueckfinden: erst gleiche Marke
        // (Schleichweg bleibt Schleichweg), sonst aehnliche Laenge.
        variante = 0;
        if (variantenWunsch && varianten.length > 1) {
          var treffer = -1;
          varianten.forEach(function (v, i) {
            if (treffer < 0 && (v.marke || '') === variantenWunsch.marke) treffer = i;
          });
          if (treffer < 0) {
            var beste = Infinity;
            varianten.forEach(function (v, i) {
              var d = Math.abs(v.km - variantenWunsch.km);
              if (d < beste) { beste = d; treffer = i; }
            });
          }
          if (treffer >= 0) variante = treffer;
        }
        variantenWaehlen(variante);
        // Fuehrt der gewaehlte Weg trotz Stau weiter hindurch, weil jeder
        // Umweg laenger dauert, das auch sagen - sonst wartet man nach
        // "Ich suche eine Umfahrung" vergeblich auf eine.
        if (ausVerkehr && stauAufRoute() >= schwelle) {
          letzterText = '';
          sagen('Umfahrung lohnt sich nicht, ich bleibe auf der Strecke.');
        }
        // Kennungen und Blitzer fuer den Weg, der wirklich gefahren wird
        umgebungNachladen(varianten[variante]);
      });
    });
    // Ohne diesen Fang klebt die Statuszeile bei einem Fehler irgendwo in der
    // Kette fuer immer auf "Berechne Route ...".
    if (kette && kette.catch) kette.catch(function () {
      if (lauf !== laeuft) return;
      info('Route konnte nicht berechnet werden – nochmal versuchen');
    });
  }

  // Drei Vorschläge auswählen. Nach Fahrzeit sortiert, aber der Schleichweg
  // wird nicht verdrängt: er ist auf dem Papier immer langsamer (er meidet ja
  // die schnellen Strassen) und wäre sonst nie dabei - obwohl er im Stau
  // genau der Vorschlag ist, um den es geht.
  // Unsinnige Vorschlaege aussortieren. Ein Umweg, der dreimal so lange
  // dauert, ist kein Vorschlag - er ist ein Rechenfehler. Und eine Route, die
  // ein Vielfaches der Luftlinie faehrt, hat meist eine Schleife drin.
  function plausibel(liste, luftlinieKm) {
    if (!liste.length) return liste;
    var beste = liste[0];
    liste.forEach(function (v) { if (zeit(v) < zeit(beste)) beste = v; });
    // Die schnellste Route bleibt immer drin, auch wenn sie selbst eine
    // Schleife enthaelt - ohne Route waere die App unbrauchbar.
    var raus = liste.filter(function (v) {
      if (v === beste) return true;
      if (hatSchleife(v.koord)) return false;                 // dreht eine Runde
      // Der Schleichweg darf laenger dauern - er wird ja gerade gewaehlt,
      // WEIL die schnelle Strecke steht. Sein eigener Deckel steckt in
      // auswaehlen(). Unsinnig weit darf er trotzdem nicht sein.
      if (v.marke !== 'Schleichweg' && zeit(v) > zeit(beste) * 1.8) return false;
      if (v.km > beste.km * 2.2) return false;                // absurd weit
      if (luftlinieKm > 0.5 && v.km > luftlinieKm * 4) return false;
      return true;
    });
    return raus.length ? raus : [beste];
  }

  // Schleifenerkennung: kommt die Route auf ein Feld zurueck, das sie viel
  // frueher schon befahren hat, dreht sie eine Runde.
  function hatSchleife(koord) {
    if (koord.length < 40) return false;
    var gesehen = {}, abstandNoetig = Math.floor(koord.length * 0.25);
    for (var i = 0; i < koord.length; i++) {
      var k = Math.round(koord[i][0] * 2200) + '/' + Math.round(koord[i][1] * 3300);
      if (gesehen[k] !== undefined && i - gesehen[k] > abstandNoetig) return true;
      if (gesehen[k] === undefined) gesehen[k] = i;
    }
    return false;
  }

  function auswaehlen(liste, luftlinieKm) {
    liste = plausibel(liste, luftlinieKm);
    var schnellste = liste[0] ? zeit(liste[0]) : 0;
    var grenze = schleichErzwingen ? 2.5 : 1.6;
    schleichErzwingen = false;
    // Einen Schleichweg, der fast doppelt so lange dauert, will niemand -
    // das passiert auf Strecken mit viel Schnellstrasse, wo das gedeckelte
    // Rechentempo die ganze Route ausbremst statt nur den Stau zu umgehen.
    liste = liste.filter(function (v) {
      return v.marke !== 'Schleichweg' || !schnellste || zeit(v) <= schnellste * grenze;
    });
    var raus = liste.slice(0, 3);
    if (raus.some(function (v) { return v.marke; })) return raus;
    var schleich = liste.find(function (v) { return v.marke; });
    if (schleich) raus[Math.min(2, raus.length)] = schleich;
    return raus.filter(Boolean);
  }

  // Stadtmodus lohnt nur auf kurzen Strecken. Massstab ist die Luftlinie
  // ueber alle Punkte - die steht schon vor der ersten Anfrage fest.
  function stadtmodusGilt(punkte) {
    if (stadtmodus === 'aus') return false;
    if (stadtmodus === 'an') return true;
    var weit = 0;
    for (var i = 1; i < punkte.length; i++) weit += abstand(punkte[i - 1], punkte[i]);
    return weit < STADT_BIS_KM * 1000;
  }

  /* ------------------------------------------------------- Notlauf: OSRM */
  var OSRM = 'https://routing.openstreetmap.de/routed-car/route/v1/driving/';
  var OSRM_RAD = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';
  var OSRM_WINKEL = { 'uturn': 180, 'sharp right': 135, 'right': 90, 'slight right': 45,
                      'straight': 0, 'slight left': -45, 'left': -90, 'sharp left': -135 };

  // OSRM kennt keine Sperrzonen. Umfahren geht trotzdem: einen Zwischenpunkt
  // seitlich neben den Stau setzen, dann MUSS die Route dort vorbei. Die
  // Seite wird danach geprueft - fuehrt der Weg immer noch mitten durch die
  // Sperre, wird die andere Seite versucht.
  function umweggPunkt(sperre, seite) {
    var idx = 0, best = Infinity;
    for (var i = 0; i < routePunkte.length; i++) {
      var d = abstand(sperre.ort, routePunkte[i]);
      if (d < best) { best = d; idx = i; }
    }
    var a = routePunkte[Math.max(0, idx - 3)];
    var b = routePunkte[Math.min(routePunkte.length - 1, idx + 3)];
    var kurs = window.Verkehr.peilung(a, b);
    var quer = (kurs + seite * 90) * Math.PI / 180;
    var weit = sperre.radius * 3.5;
    var t = Math.PI / 180;
    return [sperre.ort[0] + weit * Math.cos(quer) / 110540,
            sperre.ort[1] + weit * Math.sin(quer) / (111320 * Math.cos(sperre.ort[0] * t))];
  }

  function trifftSperre(koord) {
    return sperren.some(function (sp) {
      return koord.some(function (p) { return abstand(p, sp.ort) < sp.radius * 0.8; });
    });
  }

  // Seitlich versetzter Punkt neben einem Ort auf der Route - Grundlage
  // sowohl fuer Stau-Umfahrung als auch fuer echte Alternativvorschlaege.
  function seitwaerts(ort, seite, weit) {
    var idx = 0, best = Infinity;
    for (var i = 0; i < routePunkte.length; i++) {
      var d = abstand(ort, routePunkte[i]);
      if (d < best) { best = d; idx = i; }
    }
    var a = routePunkte[Math.max(0, idx - 3)];
    var b = routePunkte[Math.min(routePunkte.length - 1, idx + 3)];
    var quer = (window.Verkehr.peilung(a, b) + seite * 90) * Math.PI / 180;
    var t = Math.PI / 180;
    return [ort[0] + weit * Math.cos(quer) / 110540,
            ort[1] + weit * Math.sin(quer) / (111320 * Math.cos(ort[0] * t))];
  }

  function osrmEinzel(punkte) {
    var koords = punkte.map(function (p) { return p[1] + ',' + p[0]; }).join(';');
    return hol((modus === 'rad' ? OSRM_RAD : OSRM) + koords +
               '?overview=full&geometries=geojson&steps=true', 20000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return (d && d.routes && d.routes[0]) || null; })
      .catch(function () { return null; });
  }

  function osrmRoute(punkte, lauf) {
    // OSRM kennt keine Sperrzonen und liefert praktisch nie Alternativen.
    // Beides laesst sich mit Zwischenpunkten nachbauen: ein Punkt seitlich
    // neben dem Stau erzwingt die Umfahrung, Punkte seitlich der Streckenmitte
    // erzeugen echte Alternativvorschlaege.
    var anfragen = [{ punkte: punkte, marke: '' }];

    var dickste = null;
    if (routePunkte.length) {
      sperren.forEach(function (sp) { if (!dickste || sp.minuten > dickste.minuten) dickste = sp; });
    }
    if (dickste) {
      anfragen = [1, -1].map(function (seite) {
        return { punkte: [punkte[0], seitwaerts(dickste.ort, seite, dickste.radius * 3.5)]
                            .concat(punkte.slice(1)), marke: '' };
      });
    }
    // KEINE kuenstlichen Alternativen mehr ueber seitliche Punkte: OSRM haengt
    // so einen Punkt an die naechstgelegene Strasse - oft ein Feldweg oder die
    // falsche Flussseite. Das ergab Schleifen und Vorschlaege mit 108 statt
    // 11 Minuten. Lieber ein ehrlicher Vorschlag als drei unsinnige.

    return Promise.all(anfragen.map(function (a) { return osrmEinzel(a.punkte); }))
      .then(function (rohe) {
        if (lauf !== laeuft) return;
        var gut = rohe.filter(Boolean);
        if (!gut.length) { info('Routendienst nicht erreichbar – später nochmal'); return; }

        var roh = gut.map(function (rt) {
          return {
            koord: rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }),
            hinweise: [],
            osrmSteps: rt.legs.reduce(function (a, l) { return a.concat(l.steps || []); }, []),
            km: rt.distance / 1000,
            min: Math.round(rt.duration / 60),
            messages: null,
            art: { wohn: 0, anlieger: 0, gesamt: 0 },
            marke: ''
          };
        });
        // Bei Stau: die Variante bevorzugen, die wirklich aussen herum geht
        if (dickste) {
          roh = roh.filter(function (v) {
            return !v.koord.some(function (p) { return abstand(p, dickste.ort) < dickste.radius * 0.8; });
          }).concat(roh).slice(0, 3);
        }
        var luft = abstand(punkte[0], punkte[punkte.length - 1]) / 1000;
        varianten = plausibel(verschiedene(roh), luft).slice(0, 3);
        if (!varianten.length) varianten = roh.slice(0, 1);
        if (varianten.length > 1) auswahlBis = Date.now() + 25000;
        variante = 0;
        gerechneteNogos = nogoParameter();
        variantenWaehlen(0);
        ersatzfahne(true, brouterGrund);
        umgebungNachladen(varianten[variante]);
      })
      .catch(function () { info('Routendienst nicht erreichbar'); });
  }

  function osrmHinweise(v) {
    var ab = 0;
    return v.osrmSteps.map(function (st) {
      var man = st.maneuver || {};
      if (man.type === 'depart' || man.type === 'arrive') return null;
      var ort = [man.location[1], man.location[0]];
      // Platz auf der Strecke - die Schritte kommen der Reihe nach, also
      // nur vorwaerts suchen (sonst landet ein Hinweis bei einer Schleife
      // auf dem falschen Durchgang)
      var idx = punktAb(v.koord, ort, ab); ab = idx;
      if (man.type === 'roundabout' || man.type === 'rotary') {
        return { ort: ort, idx: idx, winkel: 0, kreis: true,
                 text: 'im Kreisverkehr die ' + (ZAHLWORT[man.exit] || (man.exit || 1) + '.') + ' Ausfahrt' };
      }
      var w = OSRM_WINKEL[man.modifier];
      var seite = /left/.test(man.modifier || '') ? 'links' : /right/.test(man.modifier || '') ? 'rechts' : '';
      // Ausfahrten und Gabelungen sind flach - "leicht rechts" oder gar
      // nichts waere dort falsch. Wie bei BRouter: "rechts halten – Ausfahrt".
      if ((man.type === 'off ramp' || man.type === 'fork') && seite && Math.abs(w || 0) <= 45) {
        return { ort: ort, idx: idx, kreis: false,
                 winkel: (seite === 'links' ? -1 : 1) * Math.max(Math.abs(w || 0), 20),
                 text: seite + ' halten' + (man.type === 'off ramp' ? ' – Ausfahrt' : '') };
      }
      if (w === undefined || w === 0) return null;
      return { ort: ort, idx: idx, winkel: w, kreis: false, text: winkelText(w) };
    }).filter(Boolean);
  }
  // Index des Routenpunkts zu einem Ort, gesucht ab einem Startindex
  function punktAb(koord, ort, ab) {
    var best = ab, bd = Infinity;
    for (var i = ab; i < koord.length; i++) {
      var d = abstand(ort, koord[i]);
      if (d < bd) { bd = d; best = i; }
      if (d < 3) break;                   // genau getroffen
    }
    return best;
  }

  /* Aussortieren, was praktisch dieselbe Strecke ist. Ein Vergleich über
   * km und Minuten reicht dafür nicht - zwei Wege können gleich lang sein und
   * trotzdem völlig anders verlaufen. Deshalb über die tatsächliche
   * Überdeckung: wer sich zu über 90 % mit einer schon vorhandenen Variante
   * deckt, fliegt raus.
   *
   * 90 und nicht 80: gemessen an Tübingen -> Reutlingen liegen BRouters
   * Alternativen bei 83 %, 82 % und 99 % Überdeckung. Nur die 99er ist
   * wirklich dieselbe Strecke - bei 80 % wären auch die beiden echten
   * Alternativen verschwunden, und es blieb nur ein Vorschlag übrig. */
  function verschiedene(liste) {
    // Nach Fahrzeit samt Stau - siehe zeit()
    liste.sort(function (a, b) { return zeit(a) - zeit(b); });
    var raus = [];
    liste.forEach(function (v) {
      v.raster = rasterMenge(v.koord);
      var doppelt = raus.some(function (r) { return ueberdeckung(v.raster, r.raster) > 0.9; });
      if (!doppelt) raus.push(v);
    });
    return raus;
  }
  // Route auf ein grobes Gitter (~150 m) abbilden - macht den Vergleich
  // unempfindlich gegen kleine Abweichungen der Stützpunkte.
  function rasterMenge(koord) {
    var m = {};
    koord.forEach(function (p) {
      m[Math.round(p[0] * 740) + '/' + Math.round(p[1] * 1100)] = true;
    });
    return m;
  }
  function ueberdeckung(a, b) {
    var ka = Object.keys(a), treffer = 0;
    ka.forEach(function (k) { if (b[k]) treffer++; });
    return treffer / Math.max(ka.length, 1);
  }

  /* Wertet BRouters `messages` aus: dort steht je Abschnitt Länge und die
   * OSM-Merkmale. Daraus der Wohnstrassen- und Anlieger-Anteil - die Angaben,
   * ohne die man eine aggressive Umfahrung nicht beurteilen kann. */
  function streckenArt(messages) {
    var art = { wohn: 0, anlieger: 0, gesamt: 0, tempo: 0 };
    if (!messages || messages.length < 2) return art;
    var kopf = messages[0];
    var iD = kopf.indexOf('Distance'), iT = kopf.indexOf('WayTags');
    if (iD < 0 || iT < 0) return art;
    for (var i = 1; i < messages.length; i++) {
      var d = parseInt(messages[i][iD], 10) || 0;
      art.gesamt += d;
      var tags = {};
      String(messages[i][iT] || '').split(' ').forEach(function (p) {
        var j = p.indexOf('=');
        if (j > 0) tags[p.slice(0, j)] = p.slice(j + 1);
      });
      var hw = tags.highway || '';
      if (hw === 'residential' || hw === 'living_street' ||
          hw === 'service' || hw === 'unclassified') art.wohn += d;
      if (tags.access === 'destination' || tags.motor_vehicle === 'destination' ||
          tags.motorcar === 'destination' || tags.vehicle === 'destination') art.anlieger += d;
    }
    return art;
  }

  function variantenZeigen() {
    var leiste = $('varianten');
    if (varianten.length < 2) { leiste.hidden = true; leiste.innerHTML = ''; return; }
    leiste.hidden = false;
    leiste.innerHTML = '';
    var schnellste = varianten.reduce(function (a, c) { return zeit(c) < zeit(a) ? c : a; });
    var kuerzeste = varianten.reduce(function (a, c) { return c.km < a.km ? c : a; });
    varianten.forEach(function (v, i) {
      var b = document.createElement('button');
      var etikett = v.marke ? v.marke
                  : (v === schnellste ? 'schnell' : (v === kuerzeste ? 'kurz' : 'Alternative'));
      // Immer eine Zusatzzeile - sonst sind die Kacheln verschieden hoch und
      // die dritte wirkt unfertig
      var zusatz = modus === 'rad'
        ? '<br><span class="klein">' + (v.auf || 0) + ' m ↑</span>'
        : '<br><span class="klein">' + (v.art.wohn / 1000).toFixed(1) + ' km klein</span>';
      // Fahrzeit samt Stau auf diesem Weg - sonst wirkt der Weg mitten durch
      // den Stau auf der Kachel schneller als die Umfahrung
      var dauer = Math.round(v.min + stauAuf(v.koord));
      b.innerHTML = (etikett ? '<b>' + etikett + '</b><br>' : '') +
                    dauer + ' min<br>' + uhrzeit(dauer) + '<br>' +
                    v.km.toFixed(1) + ' km' + zusatz;
      if (i === variante) b.className = 'gewaehlt';
      b.onclick = function () {
        variantenWunsch = { marke: v.marke || '', km: v.km };
        // Gewaehlt ist gewaehlt: beim Fahren verschwinden die anderen bald
        auswahlBis = Date.now() + 8000;
        variantenWaehlen(i);
        // Andere Strecke, andere Autobahnen: Kennungen neu ermitteln, sonst
        // kaemen die Staumeldungen weiter von der alten Strecke
        umgebungNachladen(v);
      };
      leiste.appendChild(b);
    });
  }

  // Sobald die Fahrt mit dem gewaehlten Weg laeuft, verschwinden die anderen
  // Vorschlaege (Linien und Kacheln) - vorher blieben alle drei bis zum Ziel
  // stehen. Nach einer Neuberechnung mit Auswahl (Stau!, Übersicht) duerfen
  // sie fuer auswahlBis wieder erscheinen. In der Übersicht (Folgen aus)
  // bleibt alles stehen, dort wird ja gerade verglichen.
  function alternativenRaeumen() {
    if (varianten.length < 2 || !fahrmodus || tempoKmh < 12 || Date.now() < auswahlBis) return;
    varianten = [varianten[variante]];
    variante = 0;
    routenZeichnen();
    variantenZeigen();
  }

  function variantenWaehlen(i) {
    variante = i;
    var v = varianten[i];
    if (!v) return;

    routenZeichnen();

    routePunkte = v.koord;
    kumWeg = [0];
    for (var ki = 1; ki < v.koord.length; ki++) {
      kumWeg.push(kumWeg[ki - 1] + abstand(v.koord[ki - 1], v.koord[ki]));
    }
    abschnitte = strassenArten(v);
    strassenLauf = null;                  // Namen kommen mit spurenAnheften
    limitAktuell = null; limitGesagt = null;
    abseitsZaehler = 0;
    lotIdx = -1;                          // neue Strecke, Fortschritt neu suchen
    // Schon Angesagtes nicht wiederholen: die neuen Hinweise erben die
    // "gesagt"-Marken der alten, wenn sie am selben Ort liegen. Ohne das
    // wiederholt jede Neuberechnung die gerade laufende Ansage ("in 20 Metern
    // links abbiegen"), weil die Marken sonst komplett geleert werden.
    var alteHinweise = hinweise, altesGesagt = gesagt;
    gesagt = {};
    // Blitzer haengen am Ort, nicht an der Route: schon gewarnt bleibt gewarnt
    Object.keys(altesGesagt).forEach(function (k) { if (k.indexOf('blitz') === 0) gesagt[k] = true; });
    hinweise = hinweiseBauen(v);
    // Wo auf der Strecke liegt jeder Hinweis (Meter ab Start)? Daran misst
    // der Banner den Weg bis zur Abbiegung - nicht an der Luftlinie.
    hinweise.forEach(function (h) {
      h.s = h.idx != null ? kumWeg[Math.min(h.idx, kumWeg.length - 1)] : null;
    });
    hinweise.forEach(function (h, i) {
      for (var j = 0; j < alteHinweise.length; j++) {
        if (abstand(h.ort, alteHinweise[j].ort) < 30) {
          ['ton', 'jetzt', 'weg'].forEach(function (art) {
            if (altesGesagt[art + j]) gesagt[art + i] = true;
          });
          break;
        }
      }
    });
    if (modus === 'auto') spurenAnheften([standort || v.koord[0]].concat(stopps.map(function (sp) { return sp.ort; }), [ziel || v.koord[v.koord.length - 1]]));

    variantenZeigen();
    var zusatz = '';
    if (v.art.wohn > 400) zusatz += ' · ' + (v.art.wohn / 1000).toFixed(1) + ' km kleine Straßen';
    if (v.art.anlieger > 100) zusatz += ' · ' + (v.art.anlieger / 1000).toFixed(1) + ' km Anlieger';
    var stau = stauAufRoute();
    info('→ ' + (zielName || 'Ziel').split(',')[0] + ' · an ' + uhrzeit(v.min + stau) +
         ' · ' + (v.min + stau) + ' min' + (stau ? ' (+' + stau + ' Stau)' : '') +
         ' · ' + v.km.toFixed(1) + ' km' + zusatz);
    if (standort) bannerAktualisieren(standort);
    naviMelden();
  }

  // Nach einer neuen Route die Umgebung nachladen: feste Blitzer im Korridor
  // und die Kennungen befahrener Autobahnen. Beide Quellen merken sich ihr
  // Ergebnis und schweigen, wenn dieselbe Strecke nochmal berechnet wird -
  // sonst wuerde jede Neuberechnung waehrend der Fahrt neue Abfragen ausloesen
  // und Overpass sperrt einen aus.
  function umgebungNachladen(v) {
    if (!v) return;                       // Filter hat alles verworfen
    if (modus === 'auto') blitzerNachladen(true);
    // Kurz warten: direkt davor lief die Adresssuche ueber denselben Dienst,
    // und Nominatim drosselt bei zwei Anfragen in derselben Sekunde.
    // Die Kennungen gehoeren zur gewaehlten Strecke. Ist inzwischen eine
    // andere gewaehlt (Kachel, Neuberechnung), gilt diese Antwort nicht mehr.
    setTimeout(function () {
      if (routePunkte !== v.koord) return;
      window.Verkehr.refsErmitteln(v.messages || null, routePunkte).then(function (refs) {
        if (routePunkte !== v.koord) return;
        routeRefs = refs;
        if (verkehrAn) verkehrPruefen(true);
      });
    }, 1500);
  }

  /* ------------------------------------------------------- Fahrtdaten live */
  // Waehrend der Fahrt zaehlen Restzeit und Ankunft runter. Die Statuszeile
  // wird nur ueberschrieben, wenn dort seit ein paar Sekunden nichts Neues
  // steht - Meldungen wie "Stau voraus" sollen erst gelesen werden koennen.
  function fahrdatenZeigen(ll) {
    if (!kumWeg.length || Date.now() - infoStand < 5000) return;
    var pos = lotAufStrecke(ll);
    if (!pos) return;
    var gesamt = kumWeg[kumWeg.length - 1];
    var rest = gesamt - pos.s;
    var v = varianten[variante];
    if (!v || rest < 30) return;
    var restMin = v.min * rest / Math.max(gesamt, 1);
    // Nur der Stau, der noch vor einem liegt - durchfahrener kostet nichts mehr
    var stau = stauAufRoute(Math.max(0, pos.idx - 1));
    $('status').textContent = '→ ' + (zielName || 'Ziel').split(',')[0] +
      ' · an ' + uhrzeit(restMin + stau) + ' · ' + Math.round(restMin + stau) + ' min' +
      (stau ? ' (+' + stau + ' Stau)' : '') + ' · ' + (rest / 1000).toFixed(1) + ' km' +
      // Ohne Verkehrsdaten ist "kein Stau" keine Aussage - dazusagen
      (verkehrLuecke ? ' · ⚠ Verkehrsdaten fehlen' : '');
  }

  /* ---------------------------------------------------- Tempolimit-Schild */
  // Das Limit je Abschnitt steckt schon in BRouters Antwort (maxspeed in
  // `messages`, siehe strassenArten). Zugeordnet wird ueber den Fortschritt
  // auf der Strecke: jede messages-Zeile beschreibt das Stueck BIS zu ihrem
  // Punkt. Frueher galt der naechstgelegene Zeilenpunkt - das ist das ENDE
  // des vorigen Stuecks, und am Anfang einer 30er-Zone stand noch die 50.
  // Beim Ersatzdienst (OSRM) gibt es keine messages: dann kein Schild.
  function limitAus(tags) {
    // Gegen die Zeichenrichtung des Wegs gilt maxspeed:backward
    var richtung = tags.reversedirection === 'yes' ? tags['maxspeed:backward'] : tags['maxspeed:forward'];
    var w = richtung || tags.maxspeed || '';
    // Nur echte Zahlen. none/signals/urban/rural/unknown (BRouter-Platzhalter)
    // sind kein Wert fuers Schild - lieber keins als ein geratenes.
    if (!/^\d{1,3}$/.test(w)) return null;
    var z = parseInt(w, 10);
    return z >= 5 && z <= 130 ? z : null;
  }

  function limitHier(ll) {
    if (!abschnitte) return null;
    var pos = lotAufStrecke(ll);
    if (!pos || pos.d > 40) return null;   // abseits: unbekannt
    for (var r = 0; r < abschnitte.length; r++) {
      if (abschnitte[r].idx >= pos.idx) return abschnitte[r].limit;
    }
    return null;
  }

  function tempoEcke(ll) {
    var ecke = $('tempoecke');
    if (!routePunkte.length || !ziel) { ecke.hidden = true; return; }
    ecke.hidden = false;
    var jetzt = $('tempojetzt');
    jetzt.textContent = tempoKmh > 2 ? Math.round(tempoKmh) : '–';

    limitAktuell = modus === 'rad' ? null : limitHier(ll);
    var schild = $('temposchild');
    schild.hidden = !limitAktuell;
    // Ab 5 drueber wird die eigene Tempozahl rot - dezent, ohne Blinken
    jetzt.classList.toggle('drueber', !!limitAktuell && tempoKmh > limitAktuell + 5);
    if (!limitAktuell) { limitGesagt = null; return; }
    schild.textContent = limitAktuell;
    // Ab 8 drueber einmal ansagen; erneut erst, wenn man zwischendurch
    // wieder im Limit war (sonst plappert es an der Schwelle)
    if (tempoKmh > limitAktuell + 8) {
      // Wechselt das Limit gleich wieder (30-40-30), nicht jedes Mal
      if (limitGesagt !== limitAktuell && Date.now() - limitGesagtUm > 30000) {
        limitGesagt = limitAktuell; limitGesagtUm = Date.now();
        sagen('Tempolimit ' + limitAktuell);
      }
    } else if (tempoKmh <= limitAktuell) limitGesagt = null;
  }

  /* ------------------------------------------- Spurfuehrung und Strassennamen */
  // BRouter kennt weder Spuren noch Strassennamen, der offene OSRM-Dienst
  // schon: je Schritt Name, Nummer (ref), Wegweiser-Ziele und je Kreuzung die
  // Spurpfeile. Eine Anfrage je Route; geheftet wird ueber den Ort an unsere
  // Abbiegehinweise. OSRM rechnet aber seinen EIGENEN Weg - deshalb wird
  // jeder Schritt geprueft, ob er wirklich dort weiterfaehrt, wo wir fahren.
  var SPURPFEIL = { 'uturn': '⤸', 'sharp left': '↙', 'left': '←', 'slight left': '↖',
                    'straight': '↑', 'none': '↑',
                    'slight right': '↗', 'right': '→', 'sharp right': '↘',
                    'merge to left': '↰', 'merge to right': '↱' };
  var spurSpeicher = { kennung: null, orte: [] };

  // OSRM-Wegweiser: "B 28, B 28, , : Hechingen, Herrenberg, Reutlingen"
  // -> "Hechingen, Herrenberg" (Orte nach dem Doppelpunkt, hoechstens zwei)
  function zieleText(d) {
    if (!d) return '';
    var teile = String(d).split(':'), liste = [];
    teile[teile.length - 1].split(',').forEach(function (o) {
      o = o.trim();
      if (o && liste.indexOf(o) < 0) liste.push(o);
    });
    return liste.slice(0, 2).join(', ');
  }

  // Stuetzpunkte fuer OSRM. Ohne sie rechnet OSRM seinen eigenen Weg, und
  // wo der von unserem abweicht, fehlen Strassennamen und Spuren (gemessen
  // Rottenburg: die letzten drei Abbiegungen ohne Namen). Mit Punkten entlang
  // UNSERER Route (waypoints: nur Durchfahrt, keine Zwischenziele) faehrt
  // OSRM denselben Weg. Die Punkte liegen mitten auf Abschnitten ab 40 m:
  // auf Knoten (Kreuzungen) rasteten sie auf die Querstrasse ein und OSRM
  // drehte Schleifen (gemessen: 7,9 statt 5,3 km). Die Richtung (bearings)
  // haelt sie auf der richtigen Fahrbahn. Je ein Punkt kurz nach jeder
  // Abbiegung legt sie fest, dazwischen hoechstens alle FUELL Meter einer.
  function stuetzpunkte(punkte) {
    var n = routePunkte.length;
    if (n < 2 || kumWeg.length !== n) return null;
    var gesamt = kumWeg[n - 1], fuell = Math.max(800, gesamt / 70);
    var pflicht = {};
    hinweise.forEach(function (h) {
      if (h.s == null || h.idx == null) return;
      for (var i = Math.max(1, h.idx); i < n && kumWeg[i - 1] <= h.s + 400; i++) {
        if (kumWeg[i] - kumWeg[i - 1] >= 40) { pflicht[i] = true; return; }
      }
    });
    // Zwischenziele bleiben echte Wegpunkte (dort darf OSRM wenden)
    var halte = [], ab = 0;
    stopps.forEach(function (sp) {
      var best = -1, bd = Infinity;
      for (var i = ab; i < n; i++) {
        var d = abstand(routePunkte[i], sp.ort);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0 && bd < 300) { halte.push({ s: kumWeg[best], ort: sp.ort }); ab = best; }
    });
    var liste = [{ ort: punkte[0], halt: true }], letzte = 0, hi = 0;
    for (var i = 1; i < n; i++) {
      var len = kumWeg[i] - kumWeg[i - 1], mitte = kumWeg[i - 1] + len / 2;
      while (hi < halte.length && halte[hi].s <= mitte) {
        liste.push({ ort: halte[hi].ort, halt: true }); letzte = halte[hi].s; hi++;
      }
      if (len < 40 || mitte < 60 || mitte > gesamt - 60) continue;
      if (!pflicht[i] && mitte - letzte < fuell) continue;
      var a = routePunkte[i - 1], b = routePunkte[i];
      liste.push({ ort: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
                   kurs: Math.round(window.Verkehr.peilung(a, b)) });
      letzte = mitte;
    }
    for (; hi < halte.length; hi++) liste.push({ ort: halte[hi].ort, halt: true });
    liste.push({ ort: punkte[punkte.length - 1], halt: true });
    if (liste.length - halte.length <= 2) return null;    // nichts zu stuetzen
    var wege = [];
    liste.forEach(function (p, i) { if (p.halt) wege.push(i); });
    return OSRM + liste.map(function (p) { return p.ort[1].toFixed(6) + ',' + p.ort[0].toFixed(6); }).join(';') +
      '?steps=true&overview=false&geometries=geojson&continue_straight=true' +
      '&waypoints=' + wege.join(';') +
      '&bearings=' + liste.map(function (p) { return p.halt ? '' : p.kurs + ',40'; }).join(';') +
      '&radiuses=' + liste.map(function (p) { return p.halt ? 'unlimited' : '40'; }).join(';');
  }

  function osrmHolen(url) {
    return hol(url, 20000)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.code === 'Ok' && d.routes && d.routes[0] ? d : null; })
      .catch(function () { return null; });
  }

  function spurenErmitteln(punkte) {
    var gestuetzt = stuetzpunkte(punkte);
    var kennung = punkte.map(function (p) { return p[0].toFixed(4) + p[1].toFixed(4); }).join('|') +
                  '#' + (gestuetzt ? routePunkte.length + ':' + Math.round(kumWeg[kumWeg.length - 1]) : '');
    if (spurSpeicher.kennung === kennung) return Promise.resolve(spurSpeicher.orte);
    var koords = punkte.map(function (p) { return p[1] + ',' + p[0]; }).join(';');
    var schlicht = OSRM + koords + '?steps=true&overview=false&geometries=geojson';
    // Klappt es mit Stuetzpunkten nicht (Punkt neben jeder Strasse), wie frueher
    return (gestuetzt ? osrmHolen(gestuetzt) : Promise.resolve(null))
      .then(function (d) { return d || osrmHolen(schlicht); })
      .then(function (d) {
        var orte = [];
        if (d && d.routes && d.routes[0]) {
          d.routes[0].legs.forEach(function (leg) {
            (leg.steps || []).forEach(function (st) {
              if (!st.maneuver || st.maneuver.type === 'arrive') return;
              var kreuzung = (st.intersections || [])[0];
              orte.push({
                ort: [st.maneuver.location[1], st.maneuver.location[0]],
                name: st.name || '',
                ref: String(st.ref || '').split(';')[0].trim(),
                ziele: zieleText(st.destinations),
                ausfahrt: st.exits ? String(st.exits).split(';')[0].trim() : '',
                geo: ((st.geometry && st.geometry.coordinates) || []).map(function (c) { return [c[1], c[0]]; }),
                spuren: kreuzung && kreuzung.lanes ? kreuzung.lanes.map(function (l) {
                  return {
                    zeichen: (l.indications || []).map(function (i) {
                      return SPURPFEIL[i] || '↑';
                    }).join(''),
                    an: !!l.valid
                  };
                }) : null
              });
            });
          });
        }
        // Nur Brauchbares merken - ein Fehlschlag soll beim naechsten Mal
        // neu versucht werden
        if (orte.length) spurSpeicher = { kennung: kennung, orte: orte };
        return orte;
      })
      .catch(function () { return []; });
  }

  // Kurzname einer Strasse: Nummer vor Name ("B 27" statt "Stuttgarter Str.")
  function strassenName(st) { return st ? (st.ref || st.name || '') : ''; }

  // Punkt `meter` weit entlang eines Linienzugs
  function punktEntlang(geo, meter) {
    for (var i = 1; i < geo.length; i++) {
      var d = abstand(geo[i - 1], geo[i]);
      if (d >= meter) {
        var t = meter / Math.max(d, 0.01);
        return [geo[i - 1][0] + t * (geo[i][0] - geo[i - 1][0]),
                geo[i - 1][1] + t * (geo[i][1] - geo[i - 1][1])];
      }
      meter -= d;
    }
    return geo[geo.length - 1];
  }

  // Faehrt der OSRM-Schritt hinter dem Abbiegepunkt dort weiter, wo unsere
  // Route weiterfaehrt? Geprueft 60 m hinter dem Manoever.
  function schrittPasst(st, h) {
    if (!st.geo || st.geo.length < 2 || h.idx == null || h.s == null) return false;
    var p = punktEntlang(st.geo, 60);
    for (var i = Math.max(1, h.idx); i < routePunkte.length && kumWeg[i - 1] <= h.s + 250; i++) {
      if (punktZuStrecke(p, routePunkte[i - 1], routePunkte[i]) < 12) return true;
    }
    return false;
  }

  // Wo auf der eigenen Route welche Strasse gilt: die Route wird alle 40 m
  // abgetastet, und nur wo ein OSRM-Abschnitt hoechstens 20 m daneben liegt,
  // bekommt die Stelle dessen Namen. Wo die Wege auseinandergehen, bleibt
  // die Strasse unbekannt - lieber nichts als etwas Falsches.
  // Ergebnis: Laeufe [{von, bis, name}] in Metern ab Routenanfang.
  var TAKT = 40;
  function strassenLaufBauen(orte) {
    var n = routePunkte.length;
    if (n < 2 || kumWeg.length !== n || !orte.length) return null;
    var stuecke = [];
    orte.forEach(function (st, k) {
      for (var i = 1; i < st.geo.length; i++) stuecke.push({ a: st.geo[i - 1], b: st.geo[i], k: k });
    });
    if (!stuecke.length) return null;
    var zeiger = 0;
    // Erst vorwaerts in der Naehe suchen (beide Wege laufen in derselben
    // Richtung); nur wenn dort nichts liegt und `weit`, bis zum Ende - so
    // findet die Zuordnung auch nach einem Stueck Abweichung wieder zurueck.
    function naechster(p, weit) {
      function suche(bis) {
        var best = -1, bd = 20;
        for (var i = zeiger; i < bis; i++) {
          var d = punktZuStrecke(p, stuecke[i].a, stuecke[i].b);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      }
      var b = suche(Math.min(stuecke.length, zeiger + 150));
      if (b < 0 && weit) b = suche(stuecke.length);
      if (b < 0) return -1;
      zeiger = b;
      return stuecke[b].k;
    }
    var proben = [], j = 1, gesamt = kumWeg[n - 1];
    for (var s = 0, z = 0; s <= gesamt; s += TAKT, z++) {
      while (j < n - 1 && kumWeg[j] < s) j++;
      var t = Math.max(0, Math.min(1, (s - kumWeg[j - 1]) / Math.max(1, kumWeg[j] - kumWeg[j - 1])));
      var a = routePunkte[j - 1], b = routePunkte[j];
      proben.push(naechster([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], z % 10 === 0));
    }
    // Einzelne Aussetzer an Kreuzungen ueberbruecken
    for (var i = 1; i < proben.length - 1; i++) {
      if (proben[i] < 0 && proben[i - 1] >= 0 && proben[i + 1] >= 0 &&
          strassenName(orte[proben[i - 1]]) === strassenName(orte[proben[i + 1]])) proben[i] = proben[i - 1];
    }
    var laeufe = [];
    proben.forEach(function (k, z) {
      var name = k < 0 ? null : strassenName(orte[k]);
      var letzter = laeufe[laeufe.length - 1];
      if (letzter && letzter.name === name) { letzter.bis = z * TAKT + TAKT / 2; return; }
      laeufe.push({ von: Math.max(0, z * TAKT - TAKT / 2), bis: z * TAKT + TAKT / 2, name: name });
    });
    return { koord: routePunkte, laeufe: laeufe };
  }

  // Strasse an der Stelle s der Route: { name, rest } oder null
  function strasseBei(s) {
    if (!strassenLauf || strassenLauf.koord !== routePunkte) return null;
    var l = strassenLauf.laeufe;
    for (var i = 0; i < l.length; i++) {
      if (l[i].von <= s && s < l[i].bis) return l[i].name ? { name: l[i].name, rest: l[i].bis - s } : null;
    }
    return null;
  }

  function spurenAnheften(punkte) {
    var fuer = routePunkte;
    spurenErmitteln(punkte).then(function (orte) {
      if (routePunkte !== fuer || !orte.length) return;   // inzwischen andere Route
      strassenLauf = strassenLaufBauen(orte);
      hinweise.forEach(function (h) {
        var best = null, bd = Infinity;
        orte.forEach(function (o) {
          var d = abstand(h.ort, o.ort);
          if (d < 40 && d < bd) { bd = d; best = o; }
        });
        // Biegt OSRM an derselben Kreuzung anders ab, gehoeren Spuren und
        // Name zu SEINEM Weg - dann lieber keine
        if (best && !schrittPasst(best, h)) best = null;
        if (best) {
          h.strasse = { name: best.name, ref: best.ref, ziele: best.ziele, ausfahrt: best.ausfahrt };
        } else if (h.s != null) {
          var nach = strasseBei(h.s + 60);
          h.strasse = nach ? { name: nach.name, ref: '', ziele: '', ausfahrt: '' } : null;
        }
        if (best && best.spuren) {
          h.spuren = best.spuren;
          // "rechts einordnen" in die Ansage, wenn die gueltigen Spuren
          // eindeutig auf einer Seite liegen und es was zum Einordnen gibt
          var n = best.spuren.length;
          if (n >= 3) {
            var gueltig = [];
            best.spuren.forEach(function (sp, i) { if (sp.an) gueltig.push(i); });
            if (gueltig.length && gueltig.length < n) {
              if (gueltig[0] >= n - gueltig.length) h.einordnen = 'rechts einordnen';
              else if (gueltig[gueltig.length - 1] < gueltig.length) h.einordnen = 'links einordnen';
            }
          }
        }
      });
      if (standort) sicher(bannerAktualisieren, standort);
      naviMelden();
    });
  }

  /* --------------------------------------------------------------- Abbiegen */
  // Über den Winkel statt über BRouters Befehlsnummern, wo es geht: die
  // Nummern sind nirgends verbindlich dokumentiert, der Winkel ist eindeutig
  // (negativ = links, positiv = rechts). Nur beim Kreisverkehr hilft die
  // Nummer weiter, weil dort die Ausfahrt mitgeliefert wird.
  var KREISVERKEHR = { 13: 'rechts', 14: 'links' };
  var ZAHLWORT = ['', 'erste', 'zweite', 'dritte', 'vierte', 'fünfte', 'sechste'];

  function winkelText(w) {
    var a = Math.abs(w), seite = w < 0 ? 'links' : 'rechts';
    if (a < 25)  return 'geradeaus';
    if (a < 60)  return 'leicht ' + seite;
    if (a < 120) return seite + ' abbiegen';
    return 'scharf ' + seite;
  }

  // Welche Seite ein BRouter-Befehl meint. Gebraucht, wo der Winkel zu flach
  // ist, um die Richtung zu tragen: Ausfahrten und Gabelungen liegen oft
  // unter 25 Grad (gemessen: B27-Ausfahrt mit 12 Grad).
  var SEITE = { 2: 'links', 3: 'links', 4: 'links', 8: 'links', 17: 'links',
                5: 'rechts', 6: 'rechts', 7: 'rechts', 9: 'rechts', 18: 'rechts' };

  // Strassenart je Abschnitt aus BRouters messages: jede Zeile beschreibt
  // das Stueck BIS zu ihrem Punkt. Die Punkte stehen dort als Ganzzahl mit
  // sechs Nachkommastellen - genau wie in der Geometrie, also exakt
  // vergleichbar. Ergebnis: [{ idx: Endpunkt, hw: highway-Wert }] in
  // Fahrtrichtung.
  function strassenArten(v) {
    if (v.abschnitte !== undefined) return v.abschnitte;
    v.abschnitte = null;
    var m = v.messages;
    if (!m || m.length < 2) return null;
    var kopf = m[0];
    var iLon = kopf.indexOf('Longitude'), iLat = kopf.indexOf('Latitude');
    var iT = kopf.indexOf('WayTags');
    if (iLon < 0 || iLat < 0 || iT < 0) return null;
    var raus = [], j = 0, n = v.koord.length;
    for (var r = 1; r < m.length; r++) {
      var lon = parseInt(m[r][iLon], 10), lat = parseInt(m[r][iLat], 10);
      var k = j;
      while (k < n && (Math.round(v.koord[k][1] * 1e6) !== lon ||
                       Math.round(v.koord[k][0] * 1e6) !== lat)) k++;
      if (k >= n) continue;               // nicht gefunden - Zeile auslassen
      var tags = tagsAus(m[r][iT]);
      raus.push({ idx: k, hw: tags.highway || '', limit: limitAus(tags) });
      j = k + 1;
    }
    v.abschnitte = raus.length ? raus : null;
    return v.abschnitte;
  }
  // "highway=primary maxspeed=50" -> { highway: 'primary', maxspeed: '50' }
  function tagsAus(text) {
    var tags = {};
    String(text || '').split(' ').forEach(function (p) {
      var j = p.indexOf('=');
      if (j > 0) tags[p.slice(0, j)] = p.slice(j + 1);
    });
    return tags;
  }
  // Strassenart des Abschnitts, der am Routenpunkt `bis` endet
  function wegBis(arten, bis) {
    for (var r = 0; r < arten.length; r++) if (arten[r].idx >= bis) return arten[r].hw;
    return '';
  }
  // Ausfahrt = von Autobahn oder Kraftfahrstrasse auf eine Rampe (*_link)
  function istAusfahrt(arten, k) {
    return !!arten && /^(motorway|trunk)$/.test(wegBis(arten, k)) &&
           /_link$/.test(wegBis(arten, k + 1));
  }

  function hinweiseBauen(v) {
    if (v.osrmSteps) {
      var l = osrmHinweise(v);
      l.forEach(function (h, i) {
        var n = l[i + 1];
        if (n && abstand(h.ort, n.ort) < 180) h.danach = n.text;
      });
      return l;
    }
    var arten = strassenArten(v);
    var liste = v.hinweise.map(function (h) {
      var k = Math.min(h[0], v.koord.length - 1);
      var befehl = h[1], w = h[4] || 0;
      // Befehl 1 heisst "weiterfahren". "In 400 Metern geradeaus" hilft
      // niemandem und verdeckt den naechsten echten Hinweis.
      if (befehl === 1) return null;
      var kreis = KREISVERKEHR[befehl];
      if (kreis) {
        var kt = h[2] ? 'im Kreisverkehr die ' + (ZAHLWORT[h[2]] || h[2] + '.') + ' Ausfahrt'
                      : winkelText(w);
        return kt === 'geradeaus' ? null : { ort: v.koord[k], idx: k, winkel: 0, text: kt, kreis: true };
      }
      var seite = SEITE[befehl] || (w < 0 ? 'links' : 'rechts');
      var text = winkelText(w);
      if ((befehl === 17 || befehl === 18 || istAusfahrt(arten, k)) && Math.abs(w) < 60) {
        // Frueher fiel die Ausfahrt unter 25 Grad als "geradeaus" weg - und
        // der Banner zeigte bis dahin die Abbiegung danach
        text = seite + ' halten – Ausfahrt';
      } else if (text === 'geradeaus') {
        // Flache Gabelung: BRouter kennt die Seite, der Winkel ist zu klein
        // fuer "leicht rechts". Ohne Seite bleibt es still.
        if (!SEITE[befehl]) return null;
        text = seite + ' halten';
      }
      // Pfeil fuer "halten" leicht schraeg, damit er nicht wie geradeaus aussieht
      if (/halten/.test(text)) w = (seite === 'links' ? -1 : 1) * Math.max(Math.abs(w), 20);
      return { ort: v.koord[k], idx: k, winkel: w, text: text, kreis: false };
    }).filter(Boolean);

    // Zwei Abbiegungen dicht hintereinander zusammenfassen - im Auto braucht
    // man beide auf einmal, sonst kommt die zweite zu spät.
    liste.forEach(function (h, i) {
      var n = liste[i + 1];
      if (n && abstand(h.ort, n.ort) < 180) h.danach = n.text;
    });
    return liste;
  }

  // "4,2 km" / "650 m" - beim Naeherkommen in immer feineren Schritten
  function wegText(m) {
    if (m < 300) return Math.round(m / 10) * 10 + ' m';
    if (m < 975) return Math.round(m / 50) * 50 + ' m';
    return (m / 1000).toFixed(m < 9950 ? 1 : 0).replace('.', ',') + ' km';
  }
  function sprechWeg(m) {
    if (m < 300) return Math.round(m / 10) * 10 + ' Metern';
    if (m < 975) return Math.round(m / 50) * 50 + ' Metern';
    return (m / 1000).toFixed(1).replace('.', ',') + ' Kilometern';
  }

  // Strassenname zum Vorlesen: "Stuttgarter Str." -> "die Stuttgarter
  // Straße", "B 27" -> "die B 27". Wo der Artikel nicht sicher ist, kommt
  // null - dann sagt die Ansage den Namen lieber gar nicht.
  function mitArtikel(n) {
    if (!n) return null;
    if (/^[A-Z]{1,2} ?\d/.test(n)) return 'die ' + n;
    if (/^(Am|An|Auf|Im|In|Zum|Zur|Unter|Hinter|Vor|Beim?|Über)\s/.test(n)) return null;
    n = n.replace(/([Ss])tr\.(?=\s|$)/g, '$1traße');
    if (/(straße|allee|gasse|steige|staffel|brücke|chaussee|promenade|halde)$/i.test(n)) return 'die ' + n;
    if (/(weg|platz|ring|damm|steg|pfad|graben|markt|wall)$/i.test(n)) return 'den ' + n;
    return null;
  }

  function bannerAktualisieren(ll) {
    var banner = $('banner');
    if (!ziel || !routePunkte.length) { banner.hidden = true; return; }

    // Entfernung zum naechsten Hinweis ENTLANG der Strecke. Die Luftlinie
    // taeuscht in Kurven, Rampen und Schleifen: dort war ein spaeterer
    // Hinweis schon "nah", der Banner zeigte das Falsche und "Jetzt rechts
    // abbiegen" kam bei Tempo 160 ueber 500 m zu frueh.
    var beste = null, besteD = Infinity;
    var pos = lotAufStrecke(ll), aufStrecke = !!pos && pos.d < 150;
    if (aufStrecke) {
      for (var i = 0; i < hinweise.length; i++) {
        if (gesagt['weg' + i] || hinweise[i].s == null) continue;
        var rest = hinweise[i].s - pos.s;
        if (rest < -10) continue;         // schon vorbei
        if (rest < besteD) { besteD = rest; beste = i; }
      }
      if (beste !== null) besteD = Math.max(0, besteD);
    } else {
      // Abseits der Strecke: Luftlinie, bis die Neuberechnung da ist
      for (var j = 0; j < hinweise.length; j++) {
        if (gesagt['weg' + j]) continue;
        var d = abstand(ll, hinweise[j].ort);
        if (d < besteD) { besteD = d; beste = j; }
      }
    }

    var zumZiel = abstand(ll, ziel);
    banner.hidden = false;
    if (zumZiel < 60) {
      banner.classList.add('gleich');
      $('banner-pfeil').textContent = '🏁';
      $('banner-pfeil').style.transform = 'none';
      $('banner-entfernung').textContent = 'Ziel';
      $('banner-anweisung').textContent = zielName.split(',')[0] || 'erreicht';
      ['banner-strasse', 'banner-danach', 'banner-spuren', 'banner-aktuell'].forEach(function (id) { $(id).hidden = true; });
      if (!gesagt.ziel) { gesagt.ziel = true; sagen('Ziel erreicht'); merken('fahrt', ''); }
      return;
    }

    // "noch 3,1 km auf B 27" - aus dem Strassenverlauf (OSRM-Namen auf
    // unserer Route); unbekannt -> Zeile weg
    var hier = aufStrecke && pos.d < 40 ? strasseBei(pos.s) : null;
    $('banner-aktuell').hidden = !(hier && hier.rest >= 200);
    if (hier) $('banner-aktuell').textContent = 'noch ' + wegText(hier.rest) + ' auf ' + hier.name;

    // Keine Abbiegung mehr bis zum Ziel: der Banner bleibt trotzdem stehen
    // und zaehlt zum Ziel herunter
    if (beste === null) {
      var bisZiel = aufStrecke ? Math.max(0, kumWeg[kumWeg.length - 1] - pos.s) : zumZiel;
      banner.classList.remove('gleich');
      $('banner-pfeil').textContent = '🏁';
      $('banner-pfeil').style.transform = 'none';
      $('banner-entfernung').textContent = 'in ' + wegText(bisZiel);
      $('banner-anweisung').textContent = 'Ziel · ' + (zielName.split(',')[0] || 'erreicht');
      ['banner-strasse', 'banner-danach', 'banner-spuren'].forEach(function (id) { $(id).hidden = true; });
      return;
    }

    var h = hinweise[beste];
    if (besteD < 18) gesagt['weg' + beste] = true;

    // Unter 300 m (bei Tempo mehr) gross und orange
    banner.classList.toggle('gleich', besteD < Math.max(modus === 'rad' ? 120 : 300, tempoKmh * 3));
    $('banner-pfeil').textContent = h.kreis ? '↻' : '↑';
    $('banner-pfeil').style.transform =
      h.kreis ? 'none' : 'rotate(' + Math.max(-135, Math.min(135, h.winkel)) + 'deg)';
    $('banner-entfernung').textContent = besteD < 30 ? 'jetzt' : 'in ' + wegText(besteD);
    $('banner-anweisung').textContent = h.text;

    // Wohin es geht: "auf B 27 Richtung Stuttgart", "Ausfahrt 12 · Richtung
    // Herrenberg". Bleibt man auf derselben Strasse, faellt "auf ..." weg.
    // Verglichen wird mit der Strasse kurz VOR dem Manoever - nicht mit der
    // unter dem Auto, die wechselt im letzten Moment schon zur neuen.
    var st = h.strasse, neuName = neuerName(h, hier);
    var zeile = [];
    if (st && st.ausfahrt) zeile.push('Ausfahrt ' + st.ausfahrt);
    if (neuName) zeile.push('auf ' + neuName);
    if (st && st.ziele) zeile.push('Richtung ' + st.ziele);
    $('banner-strasse').hidden = !zeile.length;
    $('banner-strasse').textContent = zeile.join(' · ').replace(' · Richtung', ' Richtung');

    $('banner-danach').hidden = !h.danach;
    if (h.danach) $('banner-danach').textContent = 'dann ' + h.danach;

    // Spurleiste: welche Spuren zum Manoever fuehren
    var leiste = $('banner-spuren');
    if (h.spuren && besteD < 900) {
      leiste.hidden = false;
      leiste.innerHTML = '';
      h.spuren.forEach(function (sp) {
        var k = document.createElement('span');
        k.textContent = sp.zeichen || '↑';
        k.className = sp.an ? 'an' : '';
        leiste.appendChild(k);
      });
    } else leiste.hidden = true;

    // Zweimal ansagen: mit Vorlauf zum Einordnen, und kurz davor.
    // Bei "halten" steckt die Seite schon in der Ansage. Der Strassenname
    // kommt nur in die erste Ansage - "Jetzt" bleibt kurz.
    if (besteD < Math.max(modus === 'rad' ? 110 : 250, tempoKmh * 4.5) && !gesagt['ton' + beste]) {
      gesagt['ton' + beste] = true;
      sagen('In ' + sprechWeg(besteD) + ' ' + ansageTexte(h, neuName).ton);
    } else if (besteD < Math.max(60, tempoKmh * 1.2) && !gesagt['jetzt' + beste]) {
      gesagt['jetzt' + beste] = true;
      sagen(ansageTexte(h, neuName).jetzt);
    }
  }

  // Wohin es geht - verglichen mit der Strasse kurz VOR dem Manoever, nicht
  // mit der unter dem Auto (die wechselt im letzten Moment schon zur neuen).
  // Bleibt man auf derselben Strasse: ''.
  function neuerName(h, hier) {
    var st = h.strasse, neuName = st ? strassenName(st) : '';
    var davor = h.s != null ? strasseBei(Math.max(0, h.s - 60)) : hier;
    if (davor && neuName === davor.name) neuName = '';
    return neuName;
  }

  // Die beiden Ansagen zu einem Hinweis: ton mit Vorlauf (ohne "In 300
  // Metern"), jetzt kurz davor. Der Strassenname kommt nur in die erste.
  // Bei "halten" steckt die Seite schon in der Ansage.
  function ansageTexte(h, neuName) {
    var st = h.strasse;
    var anhang = (h.einordnen && !/halten/.test(h.text) ? ', ' + h.einordnen : '') +
                 (h.danach ? ', dann ' + h.danach : '');
    var wohin = neuName ? mitArtikel(neuName) : null;
    var text = h.text.replace(' – ', ', ');
    if (wohin) text = text.replace(/ abbiegen$/, '') + ' auf ' + wohin;
    else if (st && st.ziele) text += ' Richtung ' + st.ziele.split(',')[0];
    return { ton: text + anhang, jetzt: 'Jetzt ' + h.text.replace(' – ', ', ') + anhang };
  }

  /* ------------------------------------- Hintergrund-Navi (App „Werkstatt“) */
  // In der iPhone-App „Werkstatt“ schlaeft auch diese Seite bei gesperrtem
  // Bildschirm ein. Dann spricht die App selbst weiter - mit denselben Texten
  // und Schwellen (NaviKern.swift). Dafuer bekommt sie die fertige Route samt
  // Ansagetexten. Im Browser und als Home-Symbol fehlt funkNativ.navi: dort
  // aendert sich nichts.
  var naviNativ = !!(window.funkNativ && window.funkNativ.navi);
  var naviTimer = null, naviGesagtZahl = -1, naviNeu = false;
  function naviMelden() {
    if (!naviNativ) return;
    clearTimeout(naviTimer);
    naviTimer = setTimeout(function () {
      naviTimer = null;
      var n = window.funkNativ.navi;
      if (!ziel || !routePunkte.length || !sprache) { n.ende().catch(function () {}); return; }
      naviGesagtZahl = Object.keys(gesagt).length;
      n.route({
        punkte: routePunkte,
        hinweise: hinweise.map(function (h) {
          var t = ansageTexte(h, neuerName(h, null));
          return { s: h.s, ort: h.ort, ton: t.ton, jetzt: t.jetzt };
        }),
        blitzer: blitzer.map(function (b) {
          return { ort: b.ort, mobil: !!b.mobil, tempo: b.tempo || null, richtung: b.richtung || [] };
        }),
        limits: (abschnitte || []).map(function (a) { return { idx: a.idx, limit: a.limit || null }; }),
        ziel: ziel,
        stopps: stopps.map(function (sp) { return sp.ort; }),
        rad: modus === 'rad',
        blitzWarnen: blitzWarnen,
        gesagt: Object.keys(gesagt)
      }).catch(function () {});
    }, 800);
  }
  // Was die Seite schon gesagt hat, soll die App nicht wiederholen
  function naviGesagtMelden() {
    if (!naviNativ || naviTimer) return;
    var k = Object.keys(gesagt);
    if (k.length === naviGesagtZahl) return;
    naviGesagtZahl = k.length;
    window.funkNativ.navi.gesagt(k).catch(function () {});
  }
  // Zurueck auf der Seite: uebernehmen, was die App inzwischen gesagt hat.
  // Hat sie selbst neu berechnet, rechnet die Seite mit der naechsten
  // (frischen) Position auch neu.
  function naviStand(m) {
    if (m.umgeleitet) { naviNeu = true; return; }
    (m.gesagt || []).forEach(function (k) { gesagt[k] = true; });
    naviGesagtZahl = Object.keys(gesagt).length;
  }

  // Banner-Hoehe als CSS-Variable: die Fahnen darunter rutschen genau so
  // weit, wie der Banner gerade hoch ist (mit Strasse, Spuren, "dann ...")
  function bannerHoeheMelden() {
    var b = $('banner');
    function melden() {
      document.documentElement.style.setProperty('--banner-h', (b.hidden ? 0 : b.offsetHeight) + 'px');
    }
    if (window.ResizeObserver) new ResizeObserver(melden).observe(b);
    melden();
  }

  // Neuberechnung wie bei den grossen Navis - aber erst nach drei Messungen
  // abseits, damit ein GPS-Ausreisser nicht gleich eine neue Route auslöst.
  function abweichungPruefen(ll) {
    if (!routePunkte.length) return;
    // Bei grob ungenauem Standort (Tunnel, Haeuserschlucht) nicht als
    // "abseits" zaehlen - sonst springt die Route bei jedem Ausreisser
    if (genauigkeit > 80) return;
    // 50 m sind auf Landstrassen und bei ungenauem GPS schnell erreicht;
    // zusammen mit 12 s Pause fuehrte das zu staendigem Neuberechnen, das sich
    // wie "hin und her schalten" anfuehlt. 70 m und 40 s Ruhe sind stabil,
    // ohne eine echte Abfahrt zu verschlafen.
    if (abstandZurRoute(ll) > 70) {
      abseitsZaehler++;
      if (abseitsZaehler >= 4 && Date.now() - letzteNeu > 40000) {
        letzteNeu = Date.now(); abseitsZaehler = 0;
        info('Abseits der Route – berechne neu …');
        if (sprache) { letzterText = ''; sagen('Route wird neu berechnet'); }
        route();
      }
    } else abseitsZaehler = 0;
  }

  // Ton ueber der Musik. Ohne Angabe nimmt iOS fuer die Ansage eine
  // Wiedergabe-Sitzung, die andere Apps UNTERBRICHT: Spotify pausiert und
  // kommt danach nicht von selbst wieder. 'ambient' (Audio Session API,
  // Safari ab 16.4) mischt stattdessen - die Musik laeuft weiter, die Stimme
  // liegt darueber. Preis: der Stumm-Schalter am iPhone schaltet dann auch
  // die Ansagen stumm. 'auto' ist das alte Verhalten (Schalter unter Mehr).
  // Gesetzt beim Start, beim Umschalten und vor JEDER Ausgabe - iOS soll die
  // Sitzung nie mit einer anderen Art anlegen.
  function tonSitzung() {
    try {
      if (navigator.audioSession) navigator.audioSession.type = musikWeiter ? 'ambient' : 'auto';
    } catch (e) {}
  }

  function sagen(t) {
    if (!sprache || !('speechSynthesis' in window) || t === letzterText) return;
    if (naviNativ && document.hidden) return;   // hinten spricht die App (NaviKern)
    letzterText = t;
    tonSitzung();
    var u = new SpeechSynthesisUtterance(t);
    u.lang = 'de-DE'; u.rate = 1.05;
    window.speechSynthesis.speak(u);
  }

  /* ------------------------------------------------------------ Adresssuche */
  function sucheAktivieren() {
    var feld = $('suche'), liste = $('vorschlaege');

    feld.addEventListener('input', function () {
      clearTimeout(vorschlagTimer);
      $('suche-loeschen').hidden = !feld.value;
      var text = feld.value.trim();
      if (text.length < 3) { liste.hidden = true; return; }
      // Nominatim erlaubt höchstens eine Anfrage pro Sekunde - deshalb
      // Verzögerung und zusätzliche Mindestpause.
      vorschlagTimer = setTimeout(function () {
        var jetzt = Date.now();
        if (jetzt - letzteSuche < 350) return;
        letzteSuche = jetzt;
        var nah = standort ? '&lat=' + standort[0].toFixed(3) + '&lon=' + standort[1].toFixed(3) : '';

        // Photon (Komoot) statt Nominatim: versteht Tippfehler und ist fuer
        // Vervollstaendigung gebaut. Nominatim bleibt Rueckfall.
        // Kurzes Zeitlimit: haengt Photon, soll der Rueckfall auf Nominatim
        // anspringen statt dass die Trefferliste stumm leer bleibt.
        hol('https://photon.komoot.io/api/?q=' + encodeURIComponent(text) +
            '&limit=6&lang=de' + nah, 8000)
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(function (d) {
            var treffer = (d.features || []).map(function (f) {
              var pr = f.properties || {};
              var teile = [pr.name || pr.street || ''];
              if (pr.street && pr.name && pr.street !== pr.name) teile.push(pr.street);
              if (pr.housenumber) teile[teile.length - 1] += ' ' + pr.housenumber;
              if (pr.city || pr.town || pr.village) teile.push(pr.city || pr.town || pr.village);
              return { name: teile.filter(Boolean).join(', '),
                       lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
            }).filter(function (t) { return t.name; });
            if (!treffer.length) throw new Error('leer');
            zeigen(treffer);
          })
          .catch(function () {
            hol('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=de,at,ch&q=' +
                encodeURIComponent(text), 8000)
              .then(function (r) { return r.json(); })
              .then(function (t) {
                zeigen(t.map(function (o) {
                  return { name: o.display_name.split(',').slice(0, 3).join(','),
                           lat: parseFloat(o.lat), lon: parseFloat(o.lon) };
                }));
              })
              .catch(function () { liste.hidden = true; });
          });

        function zeigen(treffer) {
          liste.innerHTML = '';
          if (!treffer.length) { liste.hidden = true; return; }
          treffer.forEach(function (o) {
            var z = document.createElement('div');
            z.textContent = o.name;
            z.onclick = function () {
              liste.hidden = true; feld.blur();
              if (stoppmodus) {
                stoppmodus = false; knopfStand();
                stoppHinzufuegen(o.lat, o.lon, o.name.split(',')[0]);
                feld.value = zielName.split(',')[0];
              } else {
                zielSetzen(o.lat, o.lon, o.name);
              }
            };
            liste.appendChild(z);
          });
          liste.hidden = false;
        }
      }, 600);
    });

    // Leeres Feld antippen zeigt die letzten Ziele - die meisten Fahrten
    // gehen immer wieder an dieselben Orte.
    feld.addEventListener('focus', function () {
      if (feld.value.trim()) return;
      var alte = [];
      try { alte = JSON.parse(geholt('ziele', '[]')); } catch (e) {}
      if (!alte.length) return;
      liste.innerHTML = '';
      alte.forEach(function (z) {
        var d = document.createElement('div');
        d.textContent = '↺ ' + z.n;
        d.onclick = function () {
          liste.hidden = true; feld.blur();
          zielSetzen(z.lat, z.lon, z.n);
        };
        liste.appendChild(d);
      });
      liste.hidden = false;
    });

    feld.addEventListener('blur', function () {
      setTimeout(function () { liste.hidden = true; }, 250);
    });
    $('suche-loeschen').onclick = zielLoeschen;
  }

  /* ----------------------------------------------------------------- Knöpfe */
  function schalter(id, an) { $(id).classList.toggle('an', !!an); }
  function knopfStand() {
    $('k-stopp').classList.toggle('warn', stoppmodus);
    $('s-stau').classList.toggle('warn', staumodus);
  }
  function folgenSetzen(an) {
    folgen = an;
    folgenKnopf();
    // Jedes Abschalten zaehlt als Beruehrung - die Wache wartet dann erst
    // WIEDER_FOLGEN ab, bevor sie von selbst einrastet
    if (!an) kartenBeruehrt = Date.now();
    fahrmodusAnwenden();
    if (an && standort) {
      zoomStufe = 0;                      // Tempozoom wieder anwenden
      var hier = standortGezeigt || standort;
      if (fahrmodus && kurs !== null) folgeAnsicht(hier);
      else karte.easeTo({ center: m(hier), zoom: Math.max(karte.getZoom(), 16) });
    }
  }
  // Der Knopf zeigt den Zustand mit Wort UND Farbe: blau "Folgt ✓" oder
  // orange "Folgen ◎" - bisher war nur das Blau weg, das sah man im Auto nicht.
  function folgenKnopf() {
    var k = $('k-folgen');
    k.classList.toggle('an', folgen);
    k.classList.toggle('los', !folgen);
    k.textContent = folgen ? 'Folgt ✓' : 'Folgen ◎';
  }
  function sheetZeigen(an) {
    $('sheet').hidden = !an;
    $('blende').hidden = !an;
  }

  function knoepfeAktivieren() {
    // Tippen rastet IMMER ein, schaltet nie ab (abschalten tut das
    // Verschieben der Karte). Als Umschalter schaltete das zweite Tippen
    // ("folgt der nicht?") das Folgen gerade aus. Haengt das GPS, wird die
    // Abfrage gleich mit neu gestartet.
    $('k-folgen').onclick = function () {
      folgenSetzen(true);
      if (Date.now() - letzteMeldung > 5000 && Date.now() - gpsNeustart > 3000) standortStarten();
    };

    $('k-sprache').onclick = function () {
      sprache = !sprache;
      schalter('k-sprache', sprache);
      merken('sprache', sprache ? '1' : '0');
      if (sprache) {
        // Die erste Ausgabe muss aus einer Nutzergeste kommen, sonst blockt iOS.
        letzterText = ''; sagen('Ansage an');
      } else window.speechSynthesis.cancel();
      naviMelden();
    };

    $('k-stopp').onclick = function () {
      sheetZeigen(false);
      stoppmodus = !stoppmodus; staumodus = false; knopfStand();
      info(stoppmodus ? 'Zwischenziel: auf die Karte tippen oder oben eintippen' : 'Abgebrochen');
      if (stoppmodus) $('suche').value = '';
    };

    $('stoerfahne').onclick = stoerungZeigen;
    $('k-stau').onclick = ausweichen;

    // Hintergrund-Protokoll der App "Werkstatt" (NaviProtokoll.swift):
    // zeigen und gleich kopieren, damit man es weitergeben kann
    $('s-protokoll-teil').hidden = !(naviNativ && window.funkNativ.navi.protokoll);
    $('s-protokoll').onclick = function () {
      var knopf = this, pre = $('s-protokoll-text');
      window.funkNativ.navi.protokoll().then(function (t) {
        pre.hidden = false;
        pre.textContent = t || '(noch leer – die App schreibt hinein, sobald eine Fahrt läuft)';
        pre.scrollTop = pre.scrollHeight;
        if (t && navigator.clipboard) navigator.clipboard.writeText(t).then(function () {
          knopf.textContent = '📋 kopiert – z. B. in WhatsApp an Claude einfügen';
        }, function () {});
      }, function () { pre.hidden = false; pre.textContent = 'Protokoll nicht lesbar'; });
    };

    // Navigationsmodus: ein Tipp auf die Ankunftszeile holt Zielfeld und
    // Vorschlaege kurz zurueck (noch ein Tipp blendet sie wieder aus);
    // waehrend man tippt, bleiben sie da.
    $('status').onclick = function () {
      if (!naviModus) return;
      naviOffenBis = document.body.classList.contains('navi') ? Date.now() + NAVI_OFFEN : 0;
      naviModusPruefen();
    };
    $('suche').addEventListener('focus', function () { if (naviModus) { naviOffenBis = Infinity; naviModusPruefen(); } });
    $('suche').addEventListener('blur', function () { if (naviOffenBis === Infinity) naviOffenBis = Date.now() + NAVI_OFFEN; });

    $('k-uebersicht').onclick = function () {
      if (routePunkte.length) {
        folgenSetzen(false);
        // In der Übersicht will man vergleichen und waehlen. Liegt nur noch
        // ein Weg vor (waehrend der Fahrt wird gespart), die Alternativen
        // vom aktuellen Standort aus nachholen.
        if (varianten.length < 2 && ziel) {
          alternativenGewuenscht = true;
          info('Hole Alternativen …');
          route();
        }
        var b = new maplibregl.LngLatBounds();
        routePunkte.forEach(function (p) { b.extend(m(p)); });
        sperren.forEach(function (sp) { b.extend(m(sp.ort)); });
        karte.fitBounds(b, { padding: 60, bearing: 0, pitch: 0, duration: 700 });
      } else if (standort) {
        karte.easeTo({ center: m(standort), zoom: 15 });
      }
    };

    $('k-mehr').onclick = function () { sheetZeigen(true); };
    $('s-zu').onclick = function () { sheetZeigen(false); };
    $('blende').onclick = function () { sheetZeigen(false); };

    $('s-nacht').onclick = function () {
      nacht = !nacht;
      $('s-nacht').textContent = nacht ? 'an' : 'aus';
      schalter('s-nacht', nacht);
      merken('nacht', nacht ? '1' : '0');
      stilSetzen();
    };

    $('s-blitzer').onclick = function () {
      blitzWarnen = !blitzWarnen;
      $('s-blitzer').textContent = blitzWarnen ? 'an' : 'aus';
      schalter('s-blitzer', blitzWarnen);
      merken('blitzer', blitzWarnen ? '1' : '0');
      blitzerZeichnen();
      if (!blitzWarnen) $('blitzfahne').hidden = true;
      naviMelden();
    };

    $('s-musik').onclick = function () {
      musikWeiter = !musikWeiter;
      $('s-musik').textContent = musikWeiter ? 'an' : 'aus';
      schalter('s-musik', musikWeiter);
      merken('musik', musikWeiter ? '1' : '0');
      tonSitzung();
    };

    $('s-modus').onclick = function () {
      modus = modus === 'auto' ? 'rad' : 'auto';
      $('s-modus').textContent = modus === 'auto' ? '🚗 Auto' : '🚲 Rad';
    schalter('s-feldwege', feldwegeFrei); $('s-feldwege').textContent = feldwegeFrei ? 'an' : 'aus';
    schalter('s-schotter', schotterOk);   $('s-schotter').textContent = schotterOk ? 'an' : 'aus';
      merken('modus', modus);
      if (modus === 'rad') { sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic'); }
      blitzerZeichnen();
      radwegeAnzeigen();
      variantenWunsch = null;      // Marken heissen im Auto- und Radmodus anders
      if (ziel) route();
      info(modus === 'rad' ? 'Fahrradmodus – grün Radweg, ocker Feldweg, rot fürs Rad gesperrt'
                           : 'Automodus');
    };

    $('s-feldwege').onclick = function () {
      feldwegeFrei = !feldwegeFrei;
      $('s-feldwege').textContent = feldwegeFrei ? 'an' : 'aus';
      schalter('s-feldwege', feldwegeFrei);
      merken('feldwege', feldwegeFrei ? '1' : '0');
      if (ziel) route();
    };
    $('s-schotter').onclick = function () {
      schotterOk = !schotterOk;
      $('s-schotter').textContent = schotterOk ? 'an' : 'aus';
      schalter('s-schotter', schotterOk);
      merken('schotter', schotterOk ? '1' : '0');
      if (ziel) route();
    };

    $('s-verkehrkarte').onclick = function () {
      verkehrKarteAn = !verkehrKarteAn;
      $('s-verkehrkarte').textContent = verkehrKarteAn ? 'an' : 'aus';
      schalter('s-verkehrkarte', verkehrKarteAn);
      merken('verkehrkarte', verkehrKarteAn ? '1' : '0');
      // Ebenen einmal neu aufbauen
      if (karte.getLayer('tt-verkehr')) { karte.removeLayer('tt-verkehr'); karte.removeSource('tt-verkehr'); }
      if (verkehrKarteAn && tomtomKey) {
        var q = karte.getSource('routen');
        if (q) { karte.removeLayer('sperr-rand'); karte.removeLayer('sperr-flaeche');
                 karte.removeLayer('route-haupt'); karte.removeLayer('route-rand');
                 karte.removeLayer('route-neben');
                 karte.removeSource('routen'); karte.removeSource('sperrzonen'); }
        ebenenAnlegen();
      }
    };

    $('s-verkehr').onclick = function () {
      verkehrAn = !verkehrAn;
      $('s-verkehr').textContent = verkehrAn ? 'an' : 'aus';
      schalter('s-verkehr', verkehrAn);
      merken('verkehr', verkehrAn ? '1' : '0');
      if (verkehrAn) verkehrPruefen(false);
      else { sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic'); if (ziel) route(); }
    };

    $('s-stadt').onchange = function () {
      stadtmodus = this.value;
      merken('stadt', stadtmodus);
      if (ziel) route();
    };

    $('s-schwelle').onchange = function () {
      schwelle = parseInt(this.value, 10) || 5;
      merken('schwelle', schwelle);
      // Gewichte der laufenden Sperren bleiben, aber neu geprüft wird sofort.
      if (verkehrAn) verkehrPruefen(false);
    };

    $('s-tomtom').onchange = function () {
      var eigener = this.value.trim();
      merken('tomtom', eigener);
      tomtomKey = eigener || TOMTOM_STANDARD;
      $('s-tomtom-hinweis').textContent = eigener
        ? 'Eigener Schlüssel hinterlegt.'
        : 'Eingebauter Schlüssel aktiv.';
      if (verkehrAn) verkehrPruefen(false);
    };

    $('k-verkehr').onclick = function () {
      sheetZeigen(false);
      if (!ziel) { info('Erst ein Ziel setzen'); return; }
      verkehrPruefen(false);
    };

    $('s-stau').onclick = function () {
      staumodus = !staumodus; stoppmodus = false; knopfStand();
      sheetZeigen(false);
      info(staumodus ? 'Auf den Stau tippen – die Route weicht dann aus' : 'Abgebrochen');
    };

    $('s-leeren').onclick = function () {
      stopps = []; stoppMarkenZeichnen(); stoppListeZeichnen();
      fahrtMerken();
      sperrenLeeren();
      sheetZeigen(false);
      info('Zwischenziele und Sperren gelöscht');
      if (ziel) route();
    };
  }

  /* ------------------------------------------------------------ Wach halten */
  function wachHalten() {
    var sperre = null;
    function holen() {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then(function (l) {
        sperre = l;
        l.addEventListener('release', function () { sperre = null; });
      }).catch(function () {});
    }
    holen();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !sperre) holen();
    });
    // iOS gibt die Sprachausgabe erst frei, wenn ein speak() direkt aus
    // einer Beruehrung kommt (touchend zaehlt, pointerdown nicht). Sonst
    // bleibt das Navi nach dem Start stumm - die erste Ansage kommt ja aus
    // dem GPS, nicht aus einem Tippen. Also beim ersten Tippen einmal leer
    // sprechen.
    var stimmeFrei = false;
    ['pointerdown', 'touchend'].forEach(function (t) {
      document.addEventListener(t, function () {
        if (!sperre) holen();
        if (t === 'touchend' && !stimmeFrei && 'speechSynthesis' in window) {
          stimmeFrei = true;
          tonSitzung();     // auch die Freigabe darf Spotify nicht anhalten
          try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch (e) {}
        }
      }, { passive: true });
    });
  }

  /* ------------------------------------------------------------------ Start */
  function start() {
    if (naviNativ && window.__funk) window.__funk.an('navi.stand', naviStand);
    nacht       = geholt('nacht', '0') === '1';
    blitzWarnen = geholt('blitzer', '1') === '1';
    verkehrAn   = geholt('verkehr', '1') === '1';
    verkehrKarteAn = geholt('verkehrkarte', '1') === '1';
    modus = geholt('modus', 'auto');
    feldwegeFrei = geholt('feldwege', '0') === '1';
    schotterOk   = geholt('schotter', '0') === '1';
    sprache     = geholt('sprache', '0') === '1';
    musikWeiter = geholt('musik', '1') === '1';
    // Vor jeder moeglichen Ausgabe - die erste Ansage darf Spotify schon
    // nicht anhalten
    tonSitzung();
    schwelle    = parseInt(geholt('schwelle', '5'), 10) || 5;
    stadtmodus  = geholt('stadt', 'auto');
    tomtomKey   = geholt('tomtom', '');

    // Schluessel-Uebergabe per Adresse (?key=...) geht vor dem gespeicherten;
    // fehlt beides, greift der eingebaute Standard. Die Adresszeile wird nur
    // im Browser aufgeraeumt - die Homescreen-App behaelt ihre Start-URL
    // (dort sieht sie niemand, und sie ueberlebt jeden Speicherverlust).
    var km = location.search.match(/[?&]key=([A-Za-z0-9_-]{16,})/);
    if (km) {
      tomtomKey = km[1];
      merken('tomtom', tomtomKey);
      var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      if (!standalone) try { history.replaceState(null, '', location.pathname); } catch (e) {}
    }
    if (!tomtomKey) tomtomKey = TOMTOM_STANDARD;

    // iOS darf die Daten nicht nach 7 Tagen Safari-Inaktivitaet wegwerfen
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

    kartenAufbau();
    folgenKnopf();
    bannerHoeheMelden();
    schalter('k-sprache', sprache);
    schalter('s-nacht', nacht);   $('s-nacht').textContent   = nacht ? 'an' : 'aus';
    schalter('s-blitzer', blitzWarnen); $('s-blitzer').textContent = blitzWarnen ? 'an' : 'aus';
    schalter('s-musik', musikWeiter);   $('s-musik').textContent = musikWeiter ? 'an' : 'aus';
    // Aeltere iPhones (vor iOS 16.4) kennen die Audio Session API nicht -
    // dort wirkt der Schalter nicht, und das soll man auch sehen
    if (!navigator.audioSession) $('s-musik-hinweis').textContent =
      'Dieses Gerät unterstützt das nicht (erst ab iOS 16.4) – der Schalter wirkt hier nicht.';
    schalter('s-verkehr', verkehrAn);  $('s-verkehr').textContent = verkehrAn ? 'an' : 'aus';
    schalter('s-verkehrkarte', verkehrKarteAn); $('s-verkehrkarte').textContent = verkehrKarteAn ? 'an' : 'aus';
    $('s-modus').textContent = modus === 'auto' ? '🚗 Auto' : '🚲 Rad';
    schalter('s-feldwege', feldwegeFrei); $('s-feldwege').textContent = feldwegeFrei ? 'an' : 'aus';
    schalter('s-schotter', schotterOk);   $('s-schotter').textContent = schotterOk ? 'an' : 'aus';
    $('s-schwelle').value = String(schwelle);
    $('s-stadt').value = stadtmodus;
    $('s-tomtom').value = geholt('tomtom', '');
    if (tomtomKey) $('s-tomtom-hinweis').textContent = geholt('tomtom', '')
      ? 'Eigener Schlüssel hinterlegt – Staus werden auch in der Stadt erkannt.'
      : 'Eingebauter Schlüssel aktiv – Stadtverkehr funktioniert ohne Zutun. '
        + 'Ein eigener Schlüssel hier drin geht vor.';

    sucheAktivieren();
    knoepfeAktivieren();
    fahrtHolen();
    standortStarten();
    setInterval(gpsWache, 2000);
    // Zurueck in der App (nach Spotify, Bildschirmsperre): kam seit ein paar
    // Sekunden nichts mehr, die Positionsabfrage gleich neu starten, statt
    // auf die Wache zu warten
    function zurueck() {
      if (document.visibilityState === 'visible' && letzteMeldung &&
          Date.now() - letzteMeldung > 3000) standortStarten();
    }
    document.addEventListener('visibilitychange', zurueck);
    window.addEventListener('pageshow', zurueck);
    wachHalten();
    profilBesorgen(false);
    verkehrTaktStarten();
    info('Ziel eingeben oder lange auf die Karte drücken');

    // Griff nach innen für den Prüfstand (pruefung.html). Ein Navi lässt sich
    // am Schreibtisch sonst nicht testen, weil ohne Bewegung nichts passiert.
    window._navi = {
      karte: function () { return karte; },
      route: function () { return routePunkte; },
      hinweise: function () { return hinweise; },
      standort: function () { return standort; },
      sperren: function () { return sperren; },
      blitzer: function () { return blitzer; },
      refs: function () { return routeRefs; },
      varianten: function () { return varianten; },
      verkehrPruefen: verkehrPruefen,
      zielSetzen: zielSetzen,
      stauSetzen: function (lat, lon) {
        sperreHinzufuegen({ ort: [lat, lon], radius: 220, minuten: 10,
                            text: 'Stau von Hand', quelle: 'hand' });
        if (ziel) route();
      },
      zustand: function () { return { fahrmodus: fahrmodus, folgen: folgen,
        zielDa: !!ziel, kurs: kurs, tempo: Math.round(tempoKmh),
        varianten: varianten.length, limit: limitAktuell,
        gpsStill: letzteMeldung ? Date.now() - letzteMeldung : null,
        strassenLauf: strassenLauf ? strassenLauf.laeufe.length : 0 }; },
      profil: function () { return profilId; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
