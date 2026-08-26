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

  // Umrechnung Zeitverlust -> Sperrgewicht. BRouter rechnet Gewichte grob in
  // Metern Wegstrecke. 800 m je verlorener Minute heisst sinngemäß: "ein
  // Umweg lohnt, solange er kürzer ist als das, was der Stau kostet."
  var METER_JE_MINUTE = 800;

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
  var letzteStoerungsLage = null, letzteVerkehrsRoute = 0;
  var fahrmodus = false, drehung = 0, zoomStufe = 0, tempoKmh = 0;
  var kumWeg = [], limits = [], limitAktuell = null, limitGesagt = null;
  var verkehrKarteAn = true;
  var modus = 'auto';                    // 'auto' | 'rad'
  var feldwegeFrei = false, schotterOk = false;

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
  function punktZuStrecke(p, a, b) {
    // Grob in Metern; für "bin ich noch auf der Route" genau genug.
    var kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 110540;
    var px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
    var bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
    var l2 = bx * bx + by * by;
    var t = l2 ? Math.max(0, Math.min(1, (px * bx + py * by) / l2)) : 0;
    var dx = px - t * bx, dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
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
  }

  function tempoZoom() {
    if (tempoKmh >= 95) return 15;
    if (tempoKmh >= 55) return 16;
    return 17;
  }

  function folgeAnsicht(ll) {
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

  /* ------------------------------------------------------------------- Karte */  /* ------------------------------------------------------------------- Karte */
  function kartenAufbau() {
    karte = new maplibregl.Map({
      container: 'karte',
      style: STILE[nacht ? 'nacht' : 'tag'].url,
      center: [9.0576, 48.5216], zoom: 13,
      attributionControl: { compact: true, customAttribution: QUELLE },
      pitchWithRotate: false, dragRotate: false
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

    karte.on('dragstart', function () { if (folgen) folgenSetzen(false); });
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

  /* ---------------------------------------------------------------- Standort */  /* ---------------------------------------------------------------- Standort */
  function standortStarten() {
    if (!navigator.geolocation) { info('Kein Standort verfügbar'); return; }
    navigator.geolocation.watchPosition(function (p) {
      var ll = [p.coords.latitude, p.coords.longitude];
      var erste = !standort;
      standort = ll;
      if (typeof p.coords.heading === 'number' && !isNaN(p.coords.heading) && p.coords.speed > 1) {
        kurs = p.coords.heading;
      }
      tempoKmh = (p.coords.speed || 0) * 3.6;
      ichZeichnen(ll, p.coords.accuracy);
      if (folgen) {
        if (erste) karte.jumpTo({ center: m(ll), zoom: 16 });
        else folgeAnsicht(ll);
      }
      if (erste && ziel) route();
      if (ziel && routePunkte.length) {
        bannerAktualisieren(ll);
        blitzPruefen(ll);
        abweichungPruefen(ll);
        fahrdatenZeigen(ll);
      }
      tempoEcke(ll);
    }, function (e) {
      info(e.code === 1 ? 'Standort abgelehnt – in den Einstellungen erlauben'
                        : 'Standort nicht verfügbar');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
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
    stoppMarkenZeichnen();
    stoppListeZeichnen();
    if (ziel) route(); else info('Zwischenziel gesetzt – jetzt noch das Ziel eingeben');
  }
  function stoppEntfernen(i) {
    stopps.splice(i, 1);
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
  function stauAufRoute() {
    var min = 0;
    sperren.forEach(function (sp) {
      if (!sp.minuten || !routePunkte.length) return;
      for (var i = 0; i < routePunkte.length; i += 2) {
        if (abstand(sp.ort, routePunkte[i]) < sp.radius + 60) { min += sp.minuten; return; }
      }
    });
    return Math.round(min);
  }

  // Aus dem gemeldeten Zeitverlust wird das Sperrgewicht. So verbiegt ein
  // 20-Minuten-Stau die Route deutlich stärker als ein 6-Minuten-Stau, statt
  // dass beide gleich behandelt werden.
  function gewichtAus(minuten, hart) {
    if (hart) return 0;                            // 0 = harte Sperre
    return Math.round(Math.max(minuten, 1) * METER_JE_MINUTE);
  }

  function sperreHinzufuegen(s) {
    sperren.push({
      ort: s.ort,
      radius: s.radius || 220,
      gewicht: gewichtAus(s.minuten || 0, s.hart),
      hart: !!s.hart,
      minuten: s.minuten || 0,
      text: s.text || 'Stau',
      quelle: s.quelle || 'hand'
    });
    sperrenZeichnen();
    stoerfahne();
    return sperren[sperren.length - 1];
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
  function nogoParameter() {
    if (!sperren.length) return '';
    return '&nogos=' + sperren.map(function (s) {
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
  function verkehrPruefen(stillschweigend) {
    if (modus === 'rad') return;         // Stau interessiert das Rad nicht
    if (!verkehrAn || !routePunkte.length || verkehrLaeuft) return;
    verkehrLaeuft = true;
    letzterVerkehr = Date.now();
    $('k-verkehr').classList.add('an');
    if (!stillschweigend) info('Prüfe Verkehrslage auf den nächsten Kilometern …');

    // Nur den Teil vor uns betrachten - hinter uns liegende Staus sind egal.
    var vorne = routePunkte.slice(standort ? routenIndex(standort) : 0);
    if (vorne.length < 2) { verkehrLaeuft = false; return; }

    // Vorausschau: bei langen Fahrten reichen 15 km (weiter vorn aendert sich
    // die Lage bis zum Eintreffen ohnehin). Bei kurzen Fahrten muss aber die
    // GANZE Reststrecke geprueft werden - sonst faellt ausgerechnet der
    // zaehe Zielbereich durchs Raster, wie bei Tuebingen -> Reutlingen (15,9 km).
    var restKm = 0;
    for (var i = 1; i < vorne.length; i++) restKm += abstand(vorne[i - 1], vorne[i]);
    restKm /= 1000;
    var sichtKm = restKm <= 25 ? restKm + 1 : 15;

    window.Verkehr.alleStoerungen(vorne, routeRefs, tomtomKey, schwelle, sichtKm)
      .then(function (stoerungen) {
        verkehrLaeuft = false;
        $('k-verkehr').classList.remove('an');

        // Rueckkopplung verhindern: dieselbe Stoerungslage wie beim letzten
        // Mal loest weder Ansage noch Neuberechnung aus. Sonst entsteht eine
        // Schleife (route -> pruefen -> dieselben Stoerungen -> route ...),
        // die alle paar Sekunden "2 Stoerungen, ich suche eine Umfahrung"
        // durchsagt - genau so im echten Betrieb passiert.
        var lage = stoerungen.map(function (st) {
          return st.ort[0].toFixed(3) + ',' + st.ort[1].toFixed(3) + '|' + Math.round(st.minuten);
        }).sort().join(';');
        if (lage === letzteStoerungsLage) {
          if (!stillschweigend) info(stoerungen.length
            ? 'Verkehrslage unverändert – Umfahrung bleibt'
            : 'Freie Fahrt – keine Störung ab ' + schwelle + ' min');
          return;
        }
        letzteStoerungsLage = lage;

        var vorher = sperren.filter(function (s) { return s.quelle !== 'hand'; }).length;
        sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic');
        stoerungen.forEach(sperreHinzufuegen);

        if (!stoerungen.length) {
          if (!stillschweigend) {
            info(tomtomKey ? 'Freie Fahrt – keine Störung ab ' + schwelle + ' min'
                           : 'Keine Autobahn-Störung. Für Staus auf Land- und '
                             + 'Stadtstraßen fehlt der TomTom-Schlüssel.');
          }
          if (vorher) route();                    // Stau hat sich aufgelöst
          return;
        }
        var min = Math.round(stoerungen.reduce(function (a, s) { return a + s.minuten; }, 0));
        if (sprache) { letzterText = ''; sagen(
          stoerungen.length === 1
            ? 'Stau voraus, ' + min + ' Minuten. Ich suche eine Umfahrung.'
            : stoerungen.length + ' Störungen voraus, zusammen ' + min +
              ' Minuten. Ich suche eine Umfahrung.'); }
        // Mindestens zwei Minuten zwischen verkehrsbedingten Neuberechnungen -
        // sonst schaukeln sich wechselnde Meldungen zu einem Flackern auf.
        if (Date.now() - letzteVerkehrsRoute < 120000) return;
        letzteVerkehrsRoute = Date.now();
        route();
      })
      .catch(function () {
        verkehrLaeuft = false;
        $('k-verkehr').classList.remove('an');
        info('Verkehrsdienst antwortet nicht');
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
    return fetch(PROFIL_DATEI)
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        return fetch(BROUTER + '/profile', { method: 'POST', body: txt });
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
    fahrmodusAnwenden();
    route();
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
    routePunkte = []; routeRefs = []; blitzer = [];
    if (zielMarke) { zielMarke.remove(); zielMarke = null; }
    routenZeichnen();
    blitzerZeichnen();
    sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic');
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

    // Waehrend der Fahrt (Abweichung, Stauwechsel) braucht es KEINE
    // Auswahl - nur den besten Weg. Das spart drei Viertel der Anfragen und
    // war der eigentliche Grund fuer die Drosselung: sechs Anfragen bei
    // jeder Neuberechnung summieren sich auf einer Fahrt schnell zu Hunderten.
    // Waehrend der Fahrt reicht der beste Weg - die Auswahl holt man sich
    // bewusst ueber "Übersicht". Das spart drei Viertel der Anfragen.
    var nurHaupt = !!(fahrmodus && varianten.length && !schleichErzwingen && !alternativenGewuenscht);
    alternativenGewuenscht = false;

    if (Date.now() < brouterPauseBis) return osrmRoute(punkte, lauf);

    (radfahrt ? Promise.resolve('trekking') : profilBesorgen(false)).then(function (prof) {
      // Mehrere Kandidaten, damit am Ende wirklich drei *verschiedene* übrig
      // bleiben. BRouters Alternativen ähneln sich oft; die Anfrage ohne
      // Autobahn bringt fast immer eine echte Alternative.
      var kandidaten = [
        { zusatz: '&alternativeidx=0', marke: '' },
        { zusatz: '&alternativeidx=1', marke: '' },
        { zusatz: '&alternativeidx=2', marke: '' },
        { zusatz: '&alternativeidx=0&profile:avoid_motorways=1', marke: '' }
      ];
      if (nurHaupt) kandidaten = kandidaten.slice(0, 1);
      else if (radfahrt) kandidaten = kandidaten.slice(0, 3);   // Autobahn-Variante sinnlos
      if (!nurHaupt && !radfahrt && (stadtmodusGilt(punkte) || schleichErzwingen)) {
        kandidaten.push({
          zusatz: '&alternativeidx=0&profile:vmax=' + STADT_VMAX, marke: 'Schleichweg'
        });
        kandidaten.push({
          zusatz: '&alternativeidx=1&profile:vmax=' + STADT_VMAX, marke: 'Schleichweg'
        });
      }
      // Wege-Schalter nur im Auto-Modus - das trekking-Profil kennt die
      // Parameter nicht und BRouter bricht bei unbekannten Namen ab
      var wege = radfahrt ? '' :
        (feldwegeFrei ? '&profile:feldwege_frei=1' : '') +
        (schotterOk ? '&profile:schotter_ok=1' : '');
      function hole(k) {
        return fetch(BROUTER + '?lonlats=' + ll + '&profile=' + prof +
                     '&format=geojson&timode=2' + k.zusatz + wege + nogos)
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

      anfragen.then(function (ergebnisse) {
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
          if (!f) return;
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
        umgebungNachladen(varianten[0]);
      });
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
    liste.forEach(function (v) { if (v.min < beste.min) beste = v; });
    // Die schnellste Route bleibt immer drin, auch wenn sie selbst eine
    // Schleife enthaelt - ohne Route waere die App unbrauchbar.
    var raus = liste.filter(function (v) {
      if (v === beste) return true;
      if (hatSchleife(v.koord)) return false;                 // dreht eine Runde
      // Der Schleichweg darf laenger dauern - er wird ja gerade gewaehlt,
      // WEIL die schnelle Strecke steht. Sein eigener Deckel steckt in
      // auswaehlen(). Unsinnig weit darf er trotzdem nicht sein.
      if (v.marke !== 'Schleichweg' && v.min > beste.min * 1.8) return false;
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
    var schnellste = liste[0] ? liste[0].min : 0;
    var grenze = schleichErzwingen ? 2.5 : 1.6;
    schleichErzwingen = false;
    // Einen Schleichweg, der fast doppelt so lange dauert, will niemand -
    // das passiert auf Strecken mit viel Schnellstrasse, wo das gedeckelte
    // Rechentempo die ganze Route ausbremst statt nur den Stau zu umgehen.
    liste = liste.filter(function (v) {
      return v.marke !== 'Schleichweg' || !schnellste || v.min <= schnellste * grenze;
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
    return fetch((modus === 'rad' ? OSRM_RAD : OSRM) + koords +
                 '?overview=full&geometries=geojson&steps=true')
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
        variante = 0;
        variantenWaehlen(0);
        ersatzfahne(true, brouterGrund);
        umgebungNachladen(varianten[0]);
      })
      .catch(function () { info('Routendienst nicht erreichbar'); });
  }

  function osrmHinweise(v) {
    return v.osrmSteps.map(function (st) {
      var man = st.maneuver || {};
      if (man.type === 'depart' || man.type === 'arrive') return null;
      var ort = [man.location[1], man.location[0]];
      if (man.type === 'roundabout' || man.type === 'rotary') {
        return { ort: ort, winkel: 0, kreis: true,
                 text: 'im Kreisverkehr die ' + (ZAHLWORT[man.exit] || (man.exit || 1) + '.') + ' Ausfahrt' };
      }
      var w = OSRM_WINKEL[man.modifier];
      if (w === undefined || w === 0) return null;
      return { ort: ort, winkel: w, kreis: false, text: winkelText(w) };
    }).filter(Boolean);
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
    liste.sort(function (a, b) { return a.min - b.min; });
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
    var schnellste = varianten.reduce(function (a, c) { return c.min < a.min ? c : a; });
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
      b.innerHTML = (etikett ? '<b>' + etikett + '</b><br>' : '') +
                    v.min + ' min<br>' + uhrzeit(v.min) + '<br>' +
                    v.km.toFixed(1) + ' km' + zusatz;
      if (i === variante) b.className = 'gewaehlt';
      b.onclick = function () {
        variantenWunsch = { marke: v.marke || '', km: v.km };
        variantenWaehlen(i);
      };
      leiste.appendChild(b);
    });
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
    limits = limitsAus(v.messages);
    limitAktuell = null; limitGesagt = null;
    abseitsZaehler = 0;
    // Schon Angesagtes nicht wiederholen: die neuen Hinweise erben die
    // "gesagt"-Marken der alten, wenn sie am selben Ort liegen. Ohne das
    // wiederholt jede Neuberechnung die gerade laufende Ansage ("in 20 Metern
    // links abbiegen"), weil die Marken sonst komplett geleert werden.
    var alteHinweise = hinweise, altesGesagt = gesagt;
    gesagt = {};
    hinweise = hinweiseBauen(v);
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
  }

  // Nach einer neuen Route die Umgebung nachladen: feste Blitzer im Korridor
  // und die Kennungen befahrener Autobahnen. Beide Quellen merken sich ihr
  // Ergebnis und schweigen, wenn dieselbe Strecke nochmal berechnet wird -
  // sonst wuerde jede Neuberechnung waehrend der Fahrt neue Abfragen ausloesen
  // und Overpass sperrt einen aus.
  function umgebungNachladen(v) {
    if (!v) return;                       // Filter hat alles verworfen
    if (modus === 'auto') window.Verkehr.blitzerLaden(routePunkte, 25).then(function (b) {
      blitzer = b;
      blitzerZeichnen();
      if (b.length) info($('status').textContent + ' · ' + b.length + ' Blitzer');
    });
    // Kurz warten: direkt davor lief die Adresssuche ueber denselben Dienst,
    // und Nominatim drosselt bei zwei Anfragen in derselben Sekunde.
    setTimeout(function () {
      window.Verkehr.refsErmitteln(v.messages || null, routePunkte).then(function (refs) {
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
    var idx = routenIndex(ll);
    var rest = kumWeg[kumWeg.length - 1] - kumWeg[idx];
    var v = varianten[variante];
    if (!v || rest < 30) return;
    var restMin = v.min * rest / Math.max(kumWeg[kumWeg.length - 1], 1);
    var stau = stauAufRoute();
    $('status').textContent = '→ ' + (zielName || 'Ziel').split(',')[0] +
      ' · an ' + uhrzeit(restMin + stau) + ' · ' + Math.round(restMin + stau) + ' min' +
      (stau ? ' (+' + stau + ' Stau)' : '') + ' · ' + (rest / 1000).toFixed(1) + ' km';
  }

  /* ---------------------------------------------------- Tempolimit-Schild */
  // Das Limit je Abschnitt steckt schon in BRouters Antwort (maxspeed in
  // `messages`) - es musste nur angezeigt werden. Dazu das eigene Tempo aus
  // dem GPS. Beim Ersatzdienst (OSRM) gibt es keine messages, dann bleibt
  // die Ecke leer.
  function limitsAus(messages) {
    var raus = [];
    if (!messages || messages.length < 2) return raus;
    var kopf = messages[0];
    var iLon = kopf.indexOf('Longitude'), iLat = kopf.indexOf('Latitude');
    var iT = kopf.indexOf('WayTags');
    if (iLon < 0 || iT < 0) return raus;
    for (var i = 1; i < messages.length; i++) {
      var m = /maxspeed=(\d+)/.exec(messages[i][iT] || '');
      raus.push({
        ort: [parseInt(messages[i][iLat], 10) / 1e6, parseInt(messages[i][iLon], 10) / 1e6],
        limit: m ? parseInt(m[1], 10) : null
      });
    }
    return raus;
  }

  function tempoEcke(ll) {
    var ecke = $('tempoecke');
    if (!routePunkte.length || !ziel) { ecke.hidden = true; return; }
    ecke.hidden = false;
    $('tempojetzt').textContent = tempoKmh > 2 ? Math.round(tempoKmh) : '–';

    if (modus === 'rad') { $('temposchild').hidden = true; return; }
    var best = null, bestD = Infinity;
    for (var i = 0; i < limits.length; i++) {
      var d = abstand(ll, limits[i].ort);
      if (d < bestD) { bestD = d; best = limits[i]; }
    }
    if (best && bestD < 400) limitAktuell = best.limit;
    var schild = $('temposchild');
    if (!limitAktuell) { schild.hidden = true; return; }
    schild.hidden = false;
    schild.textContent = limitAktuell;

    var drueber = tempoKmh > limitAktuell + 8;
    schild.classList.toggle('drueber', drueber);
    if (drueber && limitGesagt !== limitAktuell) {
      limitGesagt = limitAktuell;
      sagen('Tempolimit ' + limitAktuell);
    } else if (!drueber) limitGesagt = null;
  }

  /* ------------------------------------------------------- Spurfuehrung */
  // BRouter kennt keine Spuren, der offene OSRM-Dienst schon: je Kreuzung die
  // Spurpfeile samt "gilt fuer dieses Manoever". Eine Anfrage je Route, die
  // Spuren werden ueber den Ort an unsere Abbiegehinweise geheftet.
  var SPURPFEIL = { 'uturn': '⤸', 'sharp left': '↙', 'left': '←', 'slight left': '↖',
                    'straight': '↑', 'none': '↑',
                    'slight right': '↗', 'right': '→', 'sharp right': '↘',
                    'merge to left': '↰', 'merge to right': '↱' };
  var spurSpeicher = { kennung: null, orte: [] };

  function spurenErmitteln(punkte) {
    var kennung = punkte.map(function (p) { return p[0].toFixed(4) + p[1].toFixed(4); }).join('|');
    if (spurSpeicher.kennung === kennung) return Promise.resolve(spurSpeicher.orte);
    var koords = punkte.map(function (p) { return p[1] + ',' + p[0]; }).join(';');
    return fetch(OSRM + koords + '?steps=true&overview=false')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var orte = [];
        if (d && d.routes && d.routes[0]) {
          d.routes[0].legs.forEach(function (leg) {
            (leg.steps || []).forEach(function (st) {
              var kreuzung = (st.intersections || [])[0];
              if (!kreuzung || !kreuzung.lanes || !st.maneuver) return;
              orte.push({
                ort: [st.maneuver.location[1], st.maneuver.location[0]],
                spuren: kreuzung.lanes.map(function (l) {
                  return {
                    zeichen: (l.indications || []).map(function (i) {
                      return SPURPFEIL[i] || '↑';
                    }).join(''),
                    an: !!l.valid
                  };
                })
              });
            });
          });
        }
        spurSpeicher = { kennung: kennung, orte: orte };
        return orte;
      })
      .catch(function () { return []; });
  }

  function spurenAnheften(punkte) {
    spurenErmitteln(punkte).then(function (orte) {
      hinweise.forEach(function (h) {
        var best = null, bd = Infinity;
        orte.forEach(function (o) {
          var d = abstand(h.ort, o.ort);
          if (d < 40 && d < bd) { bd = d; best = o; }
        });
        if (best) {
          h.spuren = best.spuren;
          // "rechts einordnen" in die Ansage, wenn die gueltigen Spuren
          // eindeutig auf einer Seite liegen und es was zum Einordnen gibt
          var n = best.spuren.length;
          if (n >= 3) {
            var gueltig = [];
            best.spuren.forEach(function (sp, i) { if (sp.an) gueltig.push(i); });
            if (gueltig.length && gueltig[0] >= n - gueltig.length) h.einordnen = 'rechts einordnen';
            else if (gueltig.length && gueltig[gueltig.length - 1] < gueltig.length) h.einordnen = 'links einordnen';
          }
        }
      });
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

  function hinweiseBauen(v) {
    if (v.osrmSteps) {
      var l = osrmHinweise(v);
      l.forEach(function (h, i) {
        var n = l[i + 1];
        if (n && abstand(h.ort, n.ort) < 180) h.danach = n.text;
      });
      return l;
    }
    var liste = v.hinweise.map(function (h) {
      var k = Math.min(h[0], v.koord.length - 1);
      var kreis = KREISVERKEHR[h[1]];
      var text = kreis && h[2]
        ? 'im Kreisverkehr die ' + (ZAHLWORT[h[2]] || h[2] + '.') + ' Ausfahrt'
        : winkelText(h[4]);
      return { ort: v.koord[k], winkel: kreis ? 0 : h[4], text: text, kreis: !!kreis };
    }).filter(function (h) {
      // BRouter meldet auch Punkte, an denen man einfach weiterfährt.
      // "In 400 Metern geradeaus" hilft niemandem und verdeckt den nächsten
      // echten Hinweis.
      return h.text !== 'geradeaus';
    });

    // Zwei Abbiegungen dicht hintereinander zusammenfassen - im Auto braucht
    // man beide auf einmal, sonst kommt die zweite zu spät.
    liste.forEach(function (h, i) {
      var n = liste[i + 1];
      if (n && abstand(h.ort, n.ort) < 180) h.danach = n.text;
    });
    return liste;
  }

  function bannerAktualisieren(ll) {
    var banner = $('banner');
    if (!hinweise.length || !ziel) { banner.hidden = true; return; }

    var beste = null, besteD = Infinity;
    for (var i = 0; i < hinweise.length; i++) {
      if (gesagt['weg' + i]) continue;
      var d = abstand(ll, hinweise[i].ort);
      if (d < besteD) { besteD = d; beste = i; }
    }

    var zumZiel = abstand(ll, ziel);
    if (zumZiel < 60) {
      banner.hidden = false;
      banner.classList.add('gleich');
      $('banner-pfeil').style.transform = 'rotate(0deg)';
      $('banner-entfernung').textContent = 'Ziel';
      $('banner-anweisung').textContent = zielName.split(',')[0] || 'erreicht';
      $('banner-danach').hidden = true;
      if (!gesagt.ziel) { gesagt.ziel = true; sagen('Ziel erreicht'); }
      return;
    }

    if (beste === null || besteD > 1500) { banner.hidden = true; return; }
    var h = hinweise[beste];
    if (besteD < 18) gesagt['weg' + beste] = true;

    banner.hidden = false;
    banner.classList.toggle('gleich', besteD < Math.max(120, tempoKmh * 2));
    $('banner-pfeil').textContent = h.kreis ? '↻' : '↑';
    $('banner-pfeil').style.transform =
      h.kreis ? 'none' : 'rotate(' + Math.max(-135, Math.min(135, h.winkel)) + 'deg)';
    $('banner-entfernung').textContent =
      besteD < 30 ? 'jetzt' :
      besteD < 999 ? Math.round(besteD / 10) * 10 + ' m'
                   : (besteD / 1000).toFixed(1) + ' km';
    $('banner-anweisung').textContent = h.text;
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
    var anhang = (h.einordnen ? ', ' + h.einordnen : '') +
                 (h.danach ? ', dann ' + h.danach : '');
    if (besteD < Math.max(modus === 'rad' ? 110 : 250, tempoKmh * 4.5) && !gesagt['ton' + beste]) {
      gesagt['ton' + beste] = true;
      sagen('In ' + Math.round(besteD / 10) * 10 + ' Metern ' + h.text + anhang);
    } else if (besteD < Math.max(60, tempoKmh * 1.2) && !gesagt['jetzt' + beste]) {
      gesagt['jetzt' + beste] = true;
      sagen('Jetzt ' + h.text + anhang);
    }
  }

  // Neuberechnung wie bei den grossen Navis - aber erst nach drei Messungen
  // abseits, damit ein GPS-Ausreisser nicht gleich eine neue Route auslöst.
  function abweichungPruefen(ll) {
    if (!routePunkte.length) return;
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

  function sagen(t) {
    if (!sprache || !('speechSynthesis' in window) || t === letzterText) return;
    letzterText = t;
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
        fetch('https://photon.komoot.io/api/?q=' + encodeURIComponent(text) +
              '&limit=6&lang=de' + nah)
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
            fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=de,at,ch&q=' +
                  encodeURIComponent(text))
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
    schalter('k-folgen', an);
    fahrmodusAnwenden();
    if (an && standort) {
      if (fahrmodus && kurs !== null) folgeAnsicht(standort);
      else karte.easeTo({ center: m(standort), zoom: Math.max(karte.getZoom(), 16) });
    }
  }
  function sheetZeigen(an) {
    $('sheet').hidden = !an;
    $('blende').hidden = !an;
  }

  function knoepfeAktivieren() {
    $('k-folgen').onclick = function () { folgenSetzen(!folgen); };

    $('k-sprache').onclick = function () {
      sprache = !sprache;
      schalter('k-sprache', sprache);
      merken('sprache', sprache ? '1' : '0');
      if (sprache) {
        // Die erste Ausgabe muss aus einer Nutzergeste kommen, sonst blockt iOS.
        letzterText = ''; sagen('Ansage an');
      } else window.speechSynthesis.cancel();
    };

    $('k-stopp').onclick = function () {
      sheetZeigen(false);
      stoppmodus = !stoppmodus; staumodus = false; knopfStand();
      info(stoppmodus ? 'Zwischenziel: auf die Karte tippen oder oben eintippen' : 'Abgebrochen');
      if (stoppmodus) $('suche').value = '';
    };

    $('stoerfahne').onclick = stoerungZeigen;
    $('k-stau').onclick = ausweichen;

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
    };

    $('s-modus').onclick = function () {
      modus = modus === 'auto' ? 'rad' : 'auto';
      $('s-modus').textContent = modus === 'auto' ? '🚗 Auto' : '🚲 Rad';
    schalter('s-feldwege', feldwegeFrei); $('s-feldwege').textContent = feldwegeFrei ? 'an' : 'aus';
    schalter('s-schotter', schotterOk);   $('s-schotter').textContent = schotterOk ? 'an' : 'aus';
      merken('modus', modus);
      if (modus === 'rad') { sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic'); }
      blitzerZeichnen();
      if (ziel) route();
      info(modus === 'rad' ? 'Fahrradmodus – ohne Stau, Blitzer und Tempolimits'
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
    ['pointerdown', 'touchend'].forEach(function (t) {
      document.addEventListener(t, function () { if (!sperre) holen(); }, { passive: true });
    });
  }

  /* ------------------------------------------------------------------ Start */
  function start() {
    nacht       = geholt('nacht', '0') === '1';
    blitzWarnen = geholt('blitzer', '1') === '1';
    verkehrAn   = geholt('verkehr', '1') === '1';
    verkehrKarteAn = geholt('verkehrkarte', '1') === '1';
    modus = geholt('modus', 'auto');
    feldwegeFrei = geholt('feldwege', '0') === '1';
    schotterOk   = geholt('schotter', '0') === '1';
    sprache     = geholt('sprache', '0') === '1';
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
    schalter('k-folgen', true);
    schalter('k-sprache', sprache);
    schalter('s-nacht', nacht);   $('s-nacht').textContent   = nacht ? 'an' : 'aus';
    schalter('s-blitzer', blitzWarnen); $('s-blitzer').textContent = blitzWarnen ? 'an' : 'aus';
    schalter('s-verkehr', verkehrAn);   $('s-verkehr').textContent = verkehrAn ? 'an' : 'aus';
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
    standortStarten();
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
        zielDa: !!ziel, kurs: kurs, tempo: Math.round(tempoKmh) }; },
      profil: function () { return profilId; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
