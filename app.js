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

  var KARTEN = {
    tag:   { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
             hg: '#eae6e0', filter: 'none' },
    // CARTOs Nachtkarte ist von Haus aus so dunkel, dass die Strassen im Auto
    // kaum zu erkennen sind. Der Aufhellungsfilter kostet nichts.
    nacht: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
             hg: '#101418', filter: 'brightness(1.9) contrast(.95) saturate(1.2)' }
  };
  var QUELLE = '&copy; OpenStreetMap, &copy; CARTO · BRouter · Autobahn GmbH';

  /* ------------------------------------------------------------------ Zustand */
  var karte, kachelLage;
  var ichMarke, ichKreis, zielMarke = null, stoppMarken = [], blitzMarken = [];
  var linie = null, nebenlinien = [];
  var standort = null, kurs = null, ziel = null, zielName = '';
  var stopps = [];                       // [{ort:[lat,lon], name:''}]
  var varianten = [], variante = 0;
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
  var abseitsZaehler = 0, letzteNeu = 0, laeuft = 0;
  var vorschlagTimer = null, letzteSuche = 0;
  var verkehrTimer = null, letzterVerkehr = 0, verkehrLaeuft = false;

  function $(id) { return document.getElementById(id); }
  function info(t) { $('status').textContent = t; }
  function merken(k, v) { try { localStorage.setItem('un-' + k, v); } catch (e) {} }
  function geholt(k, ers) {
    try { var v = localStorage.getItem('un-' + k); return v === null ? ers : v; }
    catch (e) { return ers; }
  }

  /* --------------------------------------------------------------- Geometrie */
  var abstand = window.Verkehr.abstand;
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

  /* ------------------------------------------------------------------- Karte */
  function kartenAufbau() {
    karte = L.map('karte', {
      zoomControl: false, attributionControl: true, tap: false, doubleClickZoom: false
    }).setView([48.5216, 9.0576], 13);
    kachelSetzen();

    // Langer Druck setzt das Ziel. Auf dem Handy gibt es kein Rechtsklick, und
    // ein kurzer Tipp wäre zu leicht aus Versehen ausgelöst.
    var druckTimer = null;
    karte.on('mousedown touchstart', function (e) {
      var ll = e.latlng;
      druckTimer = setTimeout(function () {
        druckTimer = null;
        if (ll) zielSetzen(ll.lat, ll.lng, 'Kartenpunkt');
      }, 550);
    });
    ['mouseup', 'touchend', 'mousemove', 'touchmove', 'zoomstart'].forEach(function (t) {
      karte.on(t, function () { if (druckTimer) { clearTimeout(druckTimer); druckTimer = null; } });
    });

    karte.on('click', function (e) {
      if (stoppmodus) { stoppmodus = false; knopfStand(); stoppHinzufuegen(e.latlng.lat, e.latlng.lng); }
      else if (staumodus) {
        staumodus = false; knopfStand();
        sperreHinzufuegen({
          ort: [e.latlng.lat, e.latlng.lng], radius: 220, minuten: 10,
          text: 'Stau von Hand', quelle: 'hand'
        });
        // Neu rechnen muss hier stehen, nicht in sperreHinzufuegen: die
        // Verkehrspruefung legt mehrere Sperren auf einmal an und rechnet
        // danach ein einziges Mal neu.
        if (ziel) route(); else info('Stauzone gesetzt – jetzt das Ziel eingeben');
      }
    });

    // Sobald der Nutzer die Karte selbst bewegt, hört das Folgen auf.
    karte.on('dragstart', function () { if (folgen) folgenSetzen(false); });
  }

  function kachelSetzen() {
    var k = KARTEN[nacht ? 'nacht' : 'tag'];
    if (kachelLage) karte.removeLayer(kachelLage);
    kachelLage = L.tileLayer(k.url, {
      maxZoom: 20, subdomains: 'abcd', detectRetina: true, attribution: QUELLE
    }).addTo(karte);
    kachelLage.getContainer().style.filter = k.filter;
    document.body.style.background = k.hg;
    $('karte').style.background = k.hg;
  }

  /* ---------------------------------------------------------------- Standort */
  function standortStarten() {
    if (!navigator.geolocation) { info('Kein Standort verfügbar'); return; }
    navigator.geolocation.watchPosition(function (p) {
      var ll = [p.coords.latitude, p.coords.longitude];
      var erste = !standort;
      standort = ll;
      if (typeof p.coords.heading === 'number' && !isNaN(p.coords.heading) && p.coords.speed > 1) {
        kurs = p.coords.heading;
      }
      ichZeichnen(ll, p.coords.accuracy);
      if (folgen) karte.setView(ll, Math.max(karte.getZoom(), 16), { animate: !erste });
      if (erste && ziel) route();
      if (ziel && routePunkte.length) {
        bannerAktualisieren(ll);
        blitzPruefen(ll);
        abweichungPruefen(ll);
      }
    }, function (e) {
      info(e.code === 1 ? 'Standort abgelehnt – in den Einstellungen erlauben'
                        : 'Standort nicht verfügbar');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  function ichZeichnen(ll, genauigkeit) {
    if (!ichMarke) {
      ichMarke = L.marker(ll, {
        icon: L.divIcon({
          className: '', iconSize: [20, 20], iconAnchor: [10, 10],
          html: '<div style="position:relative"><div class="ich-kegel"></div>' +
                '<div class="ich-punkt"></div></div>'
        }),
        interactive: false, keyboard: false, zIndexOffset: 1000
      }).addTo(karte);
      ichKreis = L.circle(ll, {
        radius: genauigkeit || 0, color: '#1f6feb', weight: 1,
        opacity: .35, fillOpacity: .08, interactive: false
      }).addTo(karte);
    } else {
      ichMarke.setLatLng(ll);
      ichKreis.setLatLng(ll).setRadius(genauigkeit || 0);
    }
    var kegel = ichMarke.getElement() && ichMarke.getElement().querySelector('.ich-kegel');
    if (kegel) {
      kegel.style.display = kurs === null ? 'none' : 'block';
      if (kurs !== null) kegel.style.transform = 'rotate(' + kurs + 'deg)';
    }
  }

  /* ------------------------------------------------------------ Zwischenziele */
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
    stoppMarken.forEach(function (m) { karte.removeLayer(m); });
    stoppMarken = stopps.map(function (s, i) {
      return L.marker(s.ort, {
        icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13],
                          html: '<div class="stopp-punkt">' + (i + 1) + '</div>' })
      }).addTo(karte).on('click', function (e) { L.DomEvent.stop(e); stoppEntfernen(i); });
    });
  }
  function stoppListeZeichnen() {
    var l = $('stoppliste');
    if (!stopps.length) { l.hidden = true; return; }
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
  // Aus dem gemeldeten Zeitverlust wird das Sperrgewicht. So verbiegt ein
  // 20-Minuten-Stau die Route deutlich stärker als ein 6-Minuten-Stau, statt
  // dass beide gleich behandelt werden.
  function gewichtAus(minuten, hart) {
    if (hart) return 0;                            // 0 = harte Sperre
    return Math.round(Math.max(minuten, 1) * METER_JE_MINUTE);
  }

  function sperreHinzufuegen(s) {
    var eintrag = {
      ort: s.ort,
      radius: s.radius || 220,
      gewicht: gewichtAus(s.minuten || 0, s.hart),
      hart: !!s.hart,
      minuten: s.minuten || 0,
      text: s.text || 'Stau',
      quelle: s.quelle || 'hand'
    };
    eintrag.kreis = L.circle(s.ort, {
      radius: eintrag.radius, color: '#c82d2d', weight: 2, opacity: .85,
      fillColor: '#c82d2d', fillOpacity: eintrag.hart ? .3 : .18
    }).bindTooltip(eintrag.text).addTo(karte);
    eintrag.kreis.on('click', function (e) { L.DomEvent.stop(e); sperreEntfernen(eintrag); });
    sperren.push(eintrag);
    stoerfahne();
    return eintrag;
  }

  function sperreEntfernen(s) {
    var i = sperren.indexOf(s);
    if (i < 0) return;
    karte.removeLayer(s.kreis);
    sperren.splice(i, 1);
    stoerfahne();
    if (ziel) route();
  }

  function sperrenLeeren(nurQuelle) {
    sperren.slice().forEach(function (s) {
      if (!nurQuelle || s.quelle === nurQuelle) {
        karte.removeLayer(s.kreis);
        sperren.splice(sperren.indexOf(s), 1);
      }
    });
    stoerfahne();
  }

  function stoerfahne() {
    var f = $('stoerfahne');
    if (!sperren.length) { f.hidden = true; return; }
    var min = sperren.reduce(function (a, s) { return a + (s.minuten || 0); }, 0);
    f.hidden = false;
    f.textContent = 'Umfahrung aktiv · ' + sperren.length +
                    (sperren.length === 1 ? ' Störung' : ' Störungen') +
                    (min ? ' · ' + Math.round(min) + ' min gespart' : '');
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

  /* ------------------------------------------------------------------ Verkehr */
  function verkehrPruefen(stillschweigend) {
    if (!verkehrAn || !routePunkte.length || verkehrLaeuft) return;
    verkehrLaeuft = true;
    letzterVerkehr = Date.now();
    $('k-verkehr').classList.add('an');
    if (!stillschweigend) info('Prüfe Verkehrslage auf den nächsten Kilometern …');

    // Nur den Teil vor uns betrachten - hinter uns liegende Staus sind egal.
    var vorne = routePunkte.slice(standort ? routenIndex(standort) : 0);
    if (vorne.length < 2) { verkehrLaeuft = false; return; }

    window.Verkehr.alleStoerungen(vorne, routeRefs, tomtomKey, schwelle)
      .then(function (stoerungen) {
        verkehrLaeuft = false;
        $('k-verkehr').classList.remove('an');
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
        window.Verkehr.refsErmitteln(v.messages, routePunkte).then(function (refs) {
          routeRefs = refs;
          verkehrPruefen(true);
        });
      } else verkehrPruefen(true);
    }, 180000);
  }

  /* ------------------------------------------------------------------ Blitzer */
  function blitzerZeichnen() {
    blitzMarken.forEach(function (m) { karte.removeLayer(m); });
    blitzMarken = [];
    if (!blitzWarnen) return;
    blitzer.forEach(function (b) {
      blitzMarken.push(L.marker(b.ort, {
        icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11],
                          html: '<div class="blitz-punkt' + (b.mobil ? ' mobil' : '') + '">' +
                                (b.tempo || '!') + '</div>' }),
        interactive: false
      }).addTo(karte));
    });
  }

  // Warnt nur vor Blitzern, auf die man wirklich zufährt. OSM hält bei vielen
  // Standorten die Messrichtung fest; wo sie fehlt, wird über den Kurs
  // entschieden, um Gegenrichtungs-Fehlalarme zu vermeiden.
  function blitzPruefen(ll) {
    if (!blitzWarnen || !blitzer.length) { $('blitzfahne').hidden = true; return; }
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
  function profilBesorgen(erzwingen) {
    var gemerkt = geholt('profilid', '');
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
    if (zielMarke) karte.removeLayer(zielMarke);
    zielMarke = L.marker(ziel).addTo(karte);
    $('suche').value = (name || '').split(',')[0];
    $('suche-loeschen').hidden = false;
    route();
  }

  function zielLoeschen() {
    ziel = null; zielName = ''; varianten = []; hinweise = [];
    routePunkte = []; routeRefs = []; blitzer = [];
    if (zielMarke) { karte.removeLayer(zielMarke); zielMarke = null; }
    if (linie) { karte.removeLayer(linie); linie = null; }
    nebenlinien.forEach(function (l) { karte.removeLayer(l); });
    nebenlinien = [];
    blitzerZeichnen();
    sperrenLeeren('autobahn'); sperrenLeeren('tomtom'); sperrenLeeren('tic');
    $('varianten').hidden = true;
    $('banner').hidden = true;
    $('blitzfahne').hidden = true;
    $('suche').value = '';
    $('suche-loeschen').hidden = true;
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

    profilBesorgen(false).then(function (prof) {
      // Mehrere Kandidaten, damit am Ende wirklich drei *verschiedene* übrig
      // bleiben. BRouters Alternativen ähneln sich oft; die Anfrage ohne
      // Autobahn bringt fast immer eine echte Alternative.
      var kandidaten = [
        { zusatz: '&alternativeidx=0', marke: '' },
        { zusatz: '&alternativeidx=1', marke: '' },
        { zusatz: '&alternativeidx=2', marke: '' },
        { zusatz: '&alternativeidx=0&profile:avoid_motorways=1', marke: '' }
      ];
      if (stadtmodusGilt(punkte)) {
        kandidaten.push({
          zusatz: '&alternativeidx=0&profile:vmax=' + STADT_VMAX, marke: 'Schleichweg'
        });
        kandidaten.push({
          zusatz: '&alternativeidx=1&profile:vmax=' + STADT_VMAX, marke: 'Schleichweg'
        });
      }
      var anfragen = kandidaten.map(function (k) {
        return fetch(BROUTER + '?lonlats=' + ll + '&profile=' + prof +
                     '&format=geojson&timode=2' + k.zusatz + nogos)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (g) { return g ? { geo: g, marke: k.marke } : null; })
          .catch(function () { return null; });
      });

      Promise.all(anfragen).then(function (ergebnisse) {
        if (lauf !== laeuft) return;               // eine neuere Anfrage läuft
        if (!ergebnisse.some(Boolean)) {
          // Profil bei BRouter weggeraeumt? Einmal neu hochladen, dann nochmal.
          // Nur einmal - wenn BRouter selbst nicht antwortet (Wartung,
          // Drosselung), wuerde das sonst endlos kreisen.
          if (prof !== ERSATZPROFIL && !profilNeuVersucht) {
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
            messages: pr.messages || null,
            art: streckenArt(pr.messages)
          });
        });
        if (!roh.length) {
          info(sperren.length ? 'Keine Route – Sperrzone zu gross?' : 'Keine Route gefunden');
          return;
        }

        varianten = auswaehlen(verschiedene(roh));
        variante = 0;
        variantenWaehlen(0);
        umgebungNachladen(varianten[0]);
      });
    });
  }

  // Drei Vorschläge auswählen. Nach Fahrzeit sortiert, aber der Schleichweg
  // wird nicht verdrängt: er ist auf dem Papier immer langsamer (er meidet ja
  // die schnellen Strassen) und wäre sonst nie dabei - obwohl er im Stau
  // genau der Vorschlag ist, um den es geht.
  function auswaehlen(liste) {
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
  var OSRM_WINKEL = { 'uturn': 180, 'sharp right': 135, 'right': 90, 'slight right': 45,
                      'straight': 0, 'slight left': -45, 'left': -90, 'sharp left': -135 };

  function osrmRoute(punkte, lauf) {
    var koords = punkte.map(function (p) { return p[1] + ',' + p[0]; }).join(';');
    return fetch(OSRM + koords + '?overview=full&geometries=geojson&steps=true&alternatives=true')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (lauf !== laeuft) return;
        if (!d || !d.routes || !d.routes.length) {
          info('Routendienst nicht erreichbar – später nochmal versuchen');
          return;
        }
        varianten = d.routes.slice(0, 3).map(function (rt) {
          return {
            koord: rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }),
            hinweise: [],
            osrmSteps: rt.legs.reduce(function (a, l) { return a.concat(l.steps || []); }, []),
            km: rt.distance / 1000,
            min: Math.round(rt.duration / 60),
            messages: null,
            art: { wohn: 0, anlieger: 0, gesamt: 0 },
            marke: 'Ersatz'
          };
        });
        variante = 0;
        variantenWaehlen(0);
        info($('status').textContent + ' · Ersatzdienst, Stauumfahrung eingeschränkt');
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
   * Überdeckung: wer sich zu über 80 % mit einer schon vorhandenen Variante
   * deckt, fliegt raus. */
  function verschiedene(liste) {
    liste.sort(function (a, b) { return a.min - b.min; });
    var raus = [];
    liste.forEach(function (v) {
      v.raster = rasterMenge(v.koord);
      var doppelt = raus.some(function (r) { return ueberdeckung(v.raster, r.raster) > 0.8; });
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
    if (varianten.length < 2) { leiste.hidden = true; return; }
    leiste.hidden = false;
    leiste.innerHTML = '';
    var schnellste = varianten.reduce(function (a, c) { return c.min < a.min ? c : a; });
    var kuerzeste = varianten.reduce(function (a, c) { return c.km < a.km ? c : a; });
    varianten.forEach(function (v, i) {
      var b = document.createElement('button');
      var etikett = v.marke ? v.marke
                  : (v === schnellste ? 'schnell' : (v === kuerzeste ? 'kurz' : ''));
      var zusatz = v.art.wohn > 400
        ? '<br><span class="klein">' + (v.art.wohn / 1000).toFixed(1) + ' km klein</span>' : '';
      b.innerHTML = (etikett ? '<b>' + etikett + '</b><br>' : '') +
                    v.min + ' min<br>' + uhrzeit(v.min) + '<br>' +
                    v.km.toFixed(1) + ' km' + zusatz;
      if (i === variante) b.className = 'gewaehlt';
      b.onclick = function () { variantenWaehlen(i); };
      leiste.appendChild(b);
    });
  }

  function variantenWaehlen(i) {
    variante = i;
    var v = varianten[i];
    if (!v) return;

    nebenlinien.forEach(function (l) { karte.removeLayer(l); });
    nebenlinien = [];
    if (linie) { karte.removeLayer(linie); linie = null; }
    varianten.forEach(function (a, j) {
      if (j === i) return;
      nebenlinien.push(L.polyline(a.koord, {
        color: '#8a929c', weight: 4, opacity: .5, dashArray: '6 7', interactive: false
      }).addTo(karte));
    });
    // Rand darunter, damit die Route auf hellem wie dunklem Grund trägt
    nebenlinien.push(L.polyline(v.koord, {
      color: nacht ? '#000' : '#fff', weight: 10, opacity: .55, interactive: false
    }).addTo(karte));
    linie = L.polyline(v.koord, { color: '#1f6feb', weight: 6, opacity: .95, interactive: false })
             .addTo(karte);

    routePunkte = v.koord;
    abseitsZaehler = 0;
    gesagt = {};
    hinweise = hinweiseBauen(v);

    variantenZeigen();
    var zusatz = '';
    if (v.art.wohn > 400) zusatz += ' · ' + (v.art.wohn / 1000).toFixed(1) + ' km kleine Straßen';
    if (v.art.anlieger > 100) zusatz += ' · ' + (v.art.anlieger / 1000).toFixed(1) + ' km Anlieger';
    info('→ ' + (zielName || 'Ziel').split(',')[0] + ' · an ' + uhrzeit(v.min) +
         ' · ' + v.min + ' min · ' + v.km.toFixed(1) + ' km' + zusatz);
    if (standort) bannerAktualisieren(standort);
  }

  // Nach einer neuen Route die Umgebung nachladen: feste Blitzer im Korridor
  // und die Kennungen befahrener Autobahnen. Beide Quellen merken sich ihr
  // Ergebnis und schweigen, wenn dieselbe Strecke nochmal berechnet wird -
  // sonst wuerde jede Neuberechnung waehrend der Fahrt neue Abfragen ausloesen
  // und Overpass sperrt einen aus.
  function umgebungNachladen(v) {
    window.Verkehr.blitzerLaden(routePunkte, 25).then(function (b) {
      blitzer = b;
      blitzerZeichnen();
      if (b.length) info($('status').textContent + ' · ' + b.length + ' Blitzer');
    });
    // Kurz warten: direkt davor lief die Adresssuche ueber denselben Dienst,
    // und Nominatim drosselt bei zwei Anfragen in derselben Sekunde.
    setTimeout(function () {
      window.Verkehr.refsErmitteln(v.messages, routePunkte).then(function (refs) {
        routeRefs = refs;
        if (verkehrAn) verkehrPruefen(true);
      });
    }, 1500);
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
    banner.classList.toggle('gleich', besteD < 120);
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

    // Zweimal ansagen: mit Vorlauf zum Einordnen, und kurz davor.
    var anhang = h.danach ? ', dann ' + h.danach : '';
    if (besteD < 250 && !gesagt['ton' + beste]) {
      gesagt['ton' + beste] = true;
      sagen('In ' + Math.round(besteD / 10) * 10 + ' Metern ' + h.text + anhang);
    } else if (besteD < 60 && !gesagt['jetzt' + beste]) {
      gesagt['jetzt' + beste] = true;
      sagen('Jetzt ' + h.text + anhang);
    }
  }

  // Neuberechnung wie bei den grossen Navis - aber erst nach drei Messungen
  // abseits, damit ein GPS-Ausreisser nicht gleich eine neue Route auslöst.
  function abweichungPruefen(ll) {
    if (!routePunkte.length) return;
    if (abstandZurRoute(ll) > 50) {
      abseitsZaehler++;
      if (abseitsZaehler >= 3 && Date.now() - letzteNeu > 12000) {
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
        if (jetzt - letzteSuche < 1100) return;
        letzteSuche = jetzt;
        var umkreis = '';
        if (standort) {
          var g = 0.4;
          umkreis = '&viewbox=' + (standort[1] - g) + ',' + (standort[0] + g) + ',' +
                                  (standort[1] + g) + ',' + (standort[0] - g);
        }
        fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=de,at,ch&q=' +
              encodeURIComponent(text) + umkreis)
          .then(function (r) { return r.json(); })
          .then(function (t) {
            liste.innerHTML = '';
            if (!t.length) { liste.hidden = true; return; }
            t.forEach(function (o) {
              var z = document.createElement('div');
              var name = o.display_name.split(',').slice(0, 3).join(',');
              z.textContent = name;
              z.onclick = function () {
                liste.hidden = true; feld.blur();
                // Bei gesetztem Ziel wird der Treffer zum Zwischenziel -
                // sonst müsste man das Ziel erst löschen.
                if (stoppmodus) {
                  stoppmodus = false; knopfStand();
                  stoppHinzufuegen(parseFloat(o.lat), parseFloat(o.lon), name.split(',')[0]);
                  feld.value = zielName.split(',')[0];
                } else {
                  zielSetzen(parseFloat(o.lat), parseFloat(o.lon), name);
                }
              };
              liste.appendChild(z);
            });
            liste.hidden = false;
          })
          .catch(function () { liste.hidden = true; });
      }, 600);
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
    if (an && standort) karte.setView(standort, Math.max(karte.getZoom(), 16));
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

    $('k-uebersicht').onclick = function () {
      if (linie) { folgenSetzen(false); karte.fitBounds(linie.getBounds(), { padding: [40, 40] }); }
      else if (standort) karte.setView(standort, 15);
    };

    $('k-mehr').onclick = function () { sheetZeigen(true); };
    $('s-zu').onclick = function () { sheetZeigen(false); };
    $('blende').onclick = function () { sheetZeigen(false); };

    $('s-nacht').onclick = function () {
      nacht = !nacht;
      $('s-nacht').textContent = nacht ? 'an' : 'aus';
      schalter('s-nacht', nacht);
      merken('nacht', nacht ? '1' : '0');
      kachelSetzen();
      if (varianten.length) variantenWaehlen(variante);
    };

    $('s-blitzer').onclick = function () {
      blitzWarnen = !blitzWarnen;
      $('s-blitzer').textContent = blitzWarnen ? 'an' : 'aus';
      schalter('s-blitzer', blitzWarnen);
      merken('blitzer', blitzWarnen ? '1' : '0');
      blitzerZeichnen();
      if (!blitzWarnen) $('blitzfahne').hidden = true;
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
      tomtomKey = this.value.trim();
      merken('tomtom', tomtomKey);
      $('s-tomtom-hinweis').textContent = tomtomKey
        ? 'Schlüssel hinterlegt – Staus werden jetzt auch auf Land- und Stadtstraßen erkannt.'
        : 'Ohne Schlüssel werden nur Autobahn-Staus erkannt.';
      if (tomtomKey && verkehrAn) verkehrPruefen(false);
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
    sprache     = geholt('sprache', '0') === '1';
    schwelle    = parseInt(geholt('schwelle', '5'), 10) || 5;
    stadtmodus  = geholt('stadt', 'auto');
    tomtomKey   = geholt('tomtom', '');

    kartenAufbau();
    schalter('k-folgen', true);
    schalter('k-sprache', sprache);
    schalter('s-nacht', nacht);   $('s-nacht').textContent   = nacht ? 'an' : 'aus';
    schalter('s-blitzer', blitzWarnen); $('s-blitzer').textContent = blitzWarnen ? 'an' : 'aus';
    schalter('s-verkehr', verkehrAn);   $('s-verkehr').textContent = verkehrAn ? 'an' : 'aus';
    $('s-schwelle').value = String(schwelle);
    $('s-stadt').value = stadtmodus;
    $('s-tomtom').value = tomtomKey;
    if (tomtomKey) $('s-tomtom-hinweis').textContent =
      'Schlüssel hinterlegt – Staus werden auch auf Land- und Stadtstraßen erkannt.';

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
      profil: function () { return profilId; }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
