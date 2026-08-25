/* Umfahrungsnavi - Etappe 1: Grundgeruest.
 *
 * Auto-Navi fuer eine Person. Anders als die grossen Navis darf es
 * kompromisslos durch Wohngebiete fuehren.
 *
 * Dienste (alle ohne Schluessel, CORS geprueft):
 *   CARTO      Kartenbilder, hell und dunkel
 *   BRouter    Routing (Profil car-fast), Abbiegehinweise, Sperrzonen
 *   Nominatim  Adresssuche
 *
 * Der Kern des Vorhabens steckt in `sperren`: BRouter kennt einen Parameter
 * `nogos`, mit dem sich Bereiche verteuern lassen - hart oder mit Gewicht.
 * Damit muss die Routing-Maschine nichts von Verkehr wissen. In Etappe 1
 * setzt man die Sperren von Hand ("Stau hier"), in Etappe 3 fuellt TomTom
 * dieselbe Liste automatisch. Der Rest der App bleibt dabei unveraendert.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ Einstellungen */
  var BROUTER  = 'https://brouter.de/brouter';
  var PROFIL   = 'car-fast';
  // Sperrgewicht = Zusatzkosten fuers Durchfahren, ungefaehr in Metern
  // Wegstrecke gerechnet. Gemessen an einer Testroute: 50 aendert nichts,
  // ab etwa 500 weicht BRouter aus. 4000 entspricht grob "nimm den Umweg,
  // solange er nicht mehr als ~4 km kostet".
  var SPERRGEWICHT = 4000;
  var SPERRRADIUS  = 400;      // Meter

  // CARTOs Nachtkarte ist von Haus aus so dunkel, dass die Strassen im Auto
  // kaum noch zu erkennen sind. Ein Aufhellungsfilter auf der Kachelebene
  // kostet nichts und macht sie brauchbar.
  var KARTEN = {
    tag:   { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
             hg: '#eae6e0', filter: 'none' },
    nacht: { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
             hg: '#101418', filter: 'brightness(1.9) contrast(.95) saturate(1.2)' }
  };
  var QUELLE = '&copy; OpenStreetMap, &copy; CARTO · Routing: BRouter';

  /* ------------------------------------------------------------------ Zustand */
  var karte, kachelLage, ichMarke, ichKreis;
  var linie = null, nebenlinien = [], zielMarke = null;
  var standort = null, kurs = null, ziel = null, zielName = '';
  var varianten = [], variante = 0;
  var hinweise = [], gesagt = {}, letzterText = '';
  var routePunkte = [];
  var folgen = true, sprache = false, nacht = true, sperrmodus = false;
  var abseitsZaehler = 0, letzteNeu = 0;
  var vorschlagTimer = null, letzteSuche = 0;
  var sperren = [];            // {lat, lon, radius, gewicht, quelle, kreis}
  var laeuft = 0;              // Zaehler, um veraltete Antworten zu verwerfen

  function $(id) { return document.getElementById(id); }
  function info(t) { $('status').textContent = t; }

  /* --------------------------------------------------------------- Geometrie */
  function abstand(a, b) {
    var R = 6371000, t = Math.PI / 180;
    var dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function punktZuStrecke(p, a, b) {
    // Grob in Metern; fuer "bin ich noch auf der Route" genau genug.
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

  /* ------------------------------------------------------------------- Karte */
  function kartenAufbau() {
    karte = L.map('karte', {
      zoomControl: false, attributionControl: true,
      tap: false, doubleClickZoom: false
    }).setView([48.5216, 9.0576], 13);      // Tuebingen, bis der Standort da ist
    kachelSetzen();

    // Langer Druck setzt das Ziel. Auf dem Handy gibt es kein Rechtsklick,
    // und ein kurzer Tipp waere zu leicht aus Versehen ausgeloest.
    var druckTimer = null, druckStart = null;
    karte.on('mousedown touchstart', function (e) {
      var ll = e.latlng;
      druckStart = ll;
      druckTimer = setTimeout(function () {
        druckTimer = null;
        if (!ll) return;
        zielSetzen(ll.lat, ll.lng, 'Kartenpunkt');
      }, 550);
    });
    karte.on('mouseup touchend mousemove touchmove zoomstart', function () {
      if (druckTimer) { clearTimeout(druckTimer); druckTimer = null; }
    });

    // Kurzer Tipp im Sperrmodus setzt eine Stauzone.
    karte.on('click', function (e) {
      if (!sperrmodus) return;
      sperrmodus = false;
      $('k-sperre').classList.remove('warn');
      sperreHinzufuegen(e.latlng.lat, e.latlng.lng, 'hand');
    });

    // Sobald der Nutzer die Karte selbst bewegt, hoert das Folgen auf -
    // sonst zerrt die App bei jedem Blick auf die Umgebung zurueck.
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

  /* --------------------------------------------------------------- Standort */
  function standortStarten() {
    if (!navigator.geolocation) { info('Kein Standort verfügbar'); return; }
    navigator.geolocation.watchPosition(function (p) {
      var ll = [p.coords.latitude, p.coords.longitude];
      var erste = !standort;
      standort = ll;
      kurs = (typeof p.coords.heading === 'number' && !isNaN(p.coords.heading) &&
              p.coords.speed > 1) ? p.coords.heading : kurs;
      ichZeichnen(ll, p.coords.accuracy);
      if (folgen) karte.setView(ll, Math.max(karte.getZoom(), 16), { animate: !erste });
      if (erste) { info('Standort gefunden'); if (ziel) route(); }
      if (ziel && routePunkte.length) { bannerAktualisieren(ll); abweichungPruefen(ll); }
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

  /* --------------------------------------------------------------- Sperrzonen */
  function sperreHinzufuegen(lat, lon, quelle) {
    var s = { lat: lat, lon: lon, radius: SPERRRADIUS, gewicht: SPERRGEWICHT, quelle: quelle };
    s.kreis = L.circle([lat, lon], {
      radius: s.radius, color: '#c82d2d', weight: 2, opacity: .85,
      fillColor: '#c82d2d', fillOpacity: .22
    }).addTo(karte);
    s.kreis.on('click', function (e) {
      L.DomEvent.stop(e);
      sperreEntfernen(s);
    });
    sperren.push(s);
    sperrfahneAktualisieren();
    if (ziel) route(); else info('Stauzone gesetzt – tippe sie an, um sie zu löschen');
  }

  function sperreEntfernen(s) {
    var i = sperren.indexOf(s);
    if (i < 0) return;
    karte.removeLayer(s.kreis);
    sperren.splice(i, 1);
    sperrfahneAktualisieren();
    if (ziel) route();
  }

  function sperrfahneAktualisieren() {
    var f = $('sperrfahne');
    if (!sperren.length) { f.hidden = true; return; }
    f.hidden = false;
    f.textContent = sperren.length === 1
      ? 'Umfahrung aktiv · 1 Stauzone'
      : 'Umfahrung aktiv · ' + sperren.length + ' Stauzonen';
  }

  // BRouter erwartet lon,lat,radius[,gewicht], mehrere durch | getrennt.
  // Ohne Gewicht ist die Zone hart gesperrt, mit Gewicht nur teuer.
  function nogoParameter() {
    if (!sperren.length) return '';
    return '&nogos=' + sperren.map(function (s) {
      return s.lon.toFixed(6) + ',' + s.lat.toFixed(6) + ',' + s.radius +
             (s.gewicht ? ',' + s.gewicht : '');
    }).join('|');
  }

  /* ---------------------------------------------------------------- Routing */
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
    ziel = null; zielName = ''; varianten = []; hinweise = []; routePunkte = [];
    if (zielMarke) { karte.removeLayer(zielMarke); zielMarke = null; }
    if (linie) { karte.removeLayer(linie); linie = null; }
    nebenlinien.forEach(function (l) { karte.removeLayer(l); });
    nebenlinien = [];
    $('varianten').hidden = true;
    $('banner').hidden = true;
    $('suche').value = '';
    $('suche-loeschen').hidden = true;
    info('Ziel gelöscht');
  }

  function route() {
    if (!ziel) return;
    if (!standort) { info('Warte auf Standort …'); return; }
    var lauf = ++laeuft;
    info('Berechne Route …');
    var ll = standort[1] + ',' + standort[0] + '|' + ziel[1] + ',' + ziel[0];
    var nogos = nogoParameter();

    // Drei Varianten parallel. Bei gesetzten Sperren weichen sie oft deutlich
    // voneinander ab - genau dann will man die Wahl haben.
    var anfragen = [0, 1, 2].map(function (idx) {
      return fetch(BROUTER + '?lonlats=' + ll + '&profile=' + PROFIL +
                   '&alternativeidx=' + idx + '&format=geojson&timode=2' + nogos)
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    });

    Promise.all(anfragen).then(function (ergebnisse) {
      if (lauf !== laeuft) return;             // eine neuere Anfrage laeuft schon
      varianten = [];
      ergebnisse.forEach(function (g, idx) {
        var f = g && g.features && g.features[0];
        if (!f) return;
        var pr = f.properties || {};
        varianten.push({
          idx: idx,
          koord: f.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }),
          hinweise: pr.voicehints || [],
          km:  parseInt(pr['track-length'] || 0, 10) / 1000,
          min: Math.round(parseInt(pr['total-time'] || 0, 10) / 60),
          art: streckenArt(pr.messages)
        });
      });
      if (!varianten.length) {
        info(sperren.length ? 'Keine Route – Stauzone zu gross?' : 'Keine Route gefunden');
        return;
      }
      // BRouter gibt manchmal dreimal denselben Weg zurueck
      var gesehen = {};
      varianten = varianten.filter(function (v) {
        var k = v.km.toFixed(2) + '/' + v.min;
        if (gesehen[k]) return false;
        gesehen[k] = true; return true;
      });
      variante = 0;
      variantenWaehlen(0);
    });
  }

  /* Wertet BRouters `messages` aus: dort steht fuer jeden Abschnitt Laenge und
   * die OSM-Merkmale. Damit laesst sich vor der Abfahrt sagen, wie viel der
   * Strecke durch Wohngebiete fuehrt und wie viel durch "Anlieger frei" -
   * die Angaben, ohne die man eine aggressive Umfahrung nicht beurteilen kann. */
  function streckenArt(messages) {
    var art = { wohn: 0, anlieger: 0, tempo30: 0, gesamt: 0 };
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
      if (hw === 'residential' || hw === 'living_street' || hw === 'service') art.wohn += d;
      if (tags.access === 'destination' || tags['motor_vehicle'] === 'destination' ||
          tags.motorcar === 'destination' || tags.vehicle === 'destination') art.anlieger += d;
      var ms = parseInt(tags.maxspeed, 10);
      if (ms && ms <= 30) art.tempo30 += d;
    }
    return art;
  }

  function variantenZeigen() {
    var leiste = $('varianten');
    if (varianten.length < 2) { leiste.hidden = true; return; }
    leiste.hidden = false;
    leiste.innerHTML = '';
    var schnellste = varianten.reduce(function (a, c) { return c.min < a.min ? c : a; });
    varianten.forEach(function (v, i) {
      var b = document.createElement('button');
      var etikett = v === schnellste ? '<b>schnell</b><br>' : '';
      // Anlieger-frei-Anteil offen ausweisen: das ist die Angabe, bei der man
      // selbst entscheiden will, ob man sie in Kauf nimmt.
      var warn = v.art.anlieger > 100
        ? '<br><span class="warn">' + (v.art.anlieger / 1000).toFixed(1) + ' km Anlieger</span>'
        : (v.art.wohn > 300 ? '<br>' + (v.art.wohn / 1000).toFixed(1) + ' km Wohnstr.' : '');
      b.innerHTML = etikett + v.min + ' min<br>' + v.km.toFixed(1) + ' km' + warn;
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
    // Weisser Rand darunter, damit die Route auf hellem wie dunklem Grund traegt
    nebenlinien.push(L.polyline(v.koord, {
      color: nacht ? '#000' : '#fff', weight: 10, opacity: .55, interactive: false
    }).addTo(karte));
    linie = L.polyline(v.koord, { color: '#1f6feb', weight: 6, opacity: .95, interactive: false })
             .addTo(karte);

    routePunkte = v.koord;
    abseitsZaehler = 0;
    gesagt = {};
    // BRouter meldet auch Punkte, an denen man einfach weiterfaehrt (etwa weil
    // die Strasse ihren Namen wechselt). "In 400 Metern geradeaus" hilft
    // niemandem und verdeckt den naechsten echten Hinweis - deshalb raus.
    hinweise = v.hinweise.map(function (h) {
      var k = Math.min(h[0], v.koord.length - 1);
      return { ort: v.koord[k], winkel: h[4], text: winkelText(h[4]) };
    }).filter(function (h) { return h.text !== 'geradeaus'; });

    variantenZeigen();
    var zusatz = '';
    if (v.art.wohn > 300) zusatz += ' · ' + (v.art.wohn / 1000).toFixed(1) + ' km Wohnstraßen';
    if (v.art.anlieger > 100) zusatz += ' · ' + (v.art.anlieger / 1000).toFixed(1) + ' km Anlieger frei';
    info('→ ' + (zielName || 'Ziel').split(',')[0] + ' · ' + v.min + ' min · ' +
         v.km.toFixed(1) + ' km' + zusatz);
    if (standort) bannerAktualisieren(standort);
  }

  /* ------------------------------------------------------------- Abbiegen */
  // Bewusst ueber den Winkel statt ueber BRouters Befehlsnummern: die Nummern
  // sind nirgends verbindlich dokumentiert, der Winkel ist eindeutig
  // (negativ = links, positiv = rechts).
  function winkelText(w) {
    var a = Math.abs(w), seite = w < 0 ? 'links' : 'rechts';
    if (a < 25)  return 'geradeaus';
    if (a < 60)  return 'leicht ' + seite;
    if (a < 120) return seite + ' abbiegen';
    return 'scharf ' + seite;
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
      if (!gesagt.ziel) { gesagt.ziel = true; sagen('Ziel erreicht'); }
      return;
    }

    if (beste === null || besteD > 1500) { banner.hidden = true; return; }
    var h = hinweise[beste];
    if (besteD < 18) gesagt['weg' + beste] = true;      // passiert

    banner.hidden = false;
    banner.classList.toggle('gleich', besteD < 120);
    $('banner-pfeil').style.transform = 'rotate(' + Math.max(-135, Math.min(135, h.winkel)) + 'deg)';
    $('banner-entfernung').textContent =
      besteD < 30 ? 'jetzt' :
      besteD < 999 ? Math.round(besteD / 10) * 10 + ' m'
                   : (besteD / 1000).toFixed(1) + ' km';
    $('banner-anweisung').textContent = h.text;

    // Zweimal ansagen: einmal mit Vorlauf zum Einordnen, einmal kurz davor.
    if (besteD < 250 && !gesagt['ton' + beste]) {
      gesagt['ton' + beste] = true;
      sagen('In ' + Math.round(besteD / 10) * 10 + ' Metern ' + h.text);
    } else if (besteD < 60 && !gesagt['jetzt' + beste]) {
      gesagt['jetzt' + beste] = true;
      sagen('Jetzt ' + h.text);
    }
  }

  // Neuberechnung wie bei den grossen Navis - aber erst nach drei Messungen
  // abseits, damit ein GPS-Ausreisser nicht gleich eine neue Route ausloest.
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
      // Nominatim erlaubt hoechstens eine Anfrage pro Sekunde - deshalb
      // Verzoegerung und zusaetzliche Mindestpause.
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
              z.textContent = o.display_name.split(',').slice(0, 3).join(',');
              z.onclick = function () {
                liste.hidden = true;
                feld.blur();
                zielSetzen(parseFloat(o.lat), parseFloat(o.lon), z.textContent);
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

  /* -------------------------------------------------------------- Knoepfe */
  function schalter(id, an) { $(id).classList.toggle('an', !!an); }

  function folgenSetzen(an) {
    folgen = an;
    schalter('k-folgen', an);
    if (an && standort) karte.setView(standort, Math.max(karte.getZoom(), 16));
  }

  function knoepfeAktivieren() {
    $('k-folgen').onclick = function () { folgenSetzen(!folgen); };

    $('k-sprache').onclick = function () {
      sprache = !sprache;
      schalter('k-sprache', sprache);
      if (sprache) {
        // Die erste Ausgabe muss aus einer Nutzergeste kommen, sonst blockt iOS.
        letzterText = ''; sagen('Ansage an');
      } else window.speechSynthesis.cancel();
    };

    $('k-sperre').onclick = function () {
      if (sperren.length && !sperrmodus) {
        // Zweiter Druck bei bestehenden Zonen raeumt auf - schneller, als
        // waehrend der Fahrt jeden Kreis einzeln anzutippen.
        sperren.slice().forEach(sperreEntfernen);
        info('Stauzonen gelöscht');
        return;
      }
      sperrmodus = !sperrmodus;
      $('k-sperre').classList.toggle('warn', sperrmodus);
      info(sperrmodus ? 'Tippe auf den Stau – die Route weicht dann aus'
                      : 'Abgebrochen');
    };

    $('k-uebersicht').onclick = function () {
      if (linie) {
        folgenSetzen(false);
        karte.fitBounds(linie.getBounds(), { padding: [40, 40] });
      } else if (standort) {
        karte.setView(standort, 15);
      }
    };

    $('k-nacht').onclick = function () {
      nacht = !nacht;
      schalter('k-nacht', nacht);
      kachelSetzen();
      if (varianten.length) variantenWaehlen(variante);   // Randfarbe nachziehen
      try { localStorage.setItem('un-nacht', nacht ? '1' : '0'); } catch (e) {}
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

  /* ---------------------------------------------------------------- Start */
  function start() {
    try { nacht = localStorage.getItem('un-nacht') === '1'; } catch (e) {}
    kartenAufbau();
    schalter('k-nacht', nacht);
    schalter('k-folgen', true);
    sucheAktivieren();
    knoepfeAktivieren();
    standortStarten();
    wachHalten();
    info('Ziel eingeben oder lange auf die Karte drücken');

    // Griff nach innen fuer den Pruefstand (pruefung.html). Ein Navi laesst
    // sich am Schreibtisch sonst nicht testen, weil ohne Bewegung nichts
    // passiert.
    window._navi = {
      karte: function () { return karte; },
      route: function () { return routePunkte; },
      hinweise: function () { return hinweise; },
      standort: function () { return standort; },
      sperren: function () { return sperren; },
      varianten: function () { return varianten; }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else start();
})();
