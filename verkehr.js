/* Verkehrslage, Blitzer und Straßenkennungen.
 *
 * Reine Datenbeschaffung, keine Oberfläche. Alles, was hier herauskommt,
 * landet in app.js in derselben `sperren`-Liste, die auch der Knopf
 * "Stau hier" füllt.
 *
 * Drei Quellen, bewusst gestaffelt:
 *
 *   1. Autobahn GmbH des Bundes  — kostenlos, ohne Schlüssel, amtlich.
 *      Liefert für jede deutsche Autobahn Staumeldungen samt
 *      Reisezeitverlust in Minuten und Durchschnittsgeschwindigkeit.
 *      Datengrundlage ist INRIX, also dieselbe Liga wie TomTom und HERE.
 *      Das sind genau die "Riesendinger", die im Radio kommen.
 *
 *   2. TomTom Flow Segment Data — braucht einen Schlüssel, deckt dafür
 *      Bundes-, Land- und Stadtstraßen ab. Wichtig: *Flow*, nicht
 *      *Incidents*. Incidents meldet nur, was jemand gemeldet hat; Flow
 *      misst die tatsächliche Geschwindigkeit gegen die freie Strecke und
 *      findet damit auch Staus, die niemand gemeldet hat.
 *
 *   3. OpenStreetMap — feste Blitzer über Overpass, die Kennung befahrener
 *      Autobahnen über Nominatim. Beide Abfragen merken sich ihr Ergebnis;
 *      Overpass sperrt sonst bei zu vielen Anfragen aus (HTTP 429).
 *
 * Google und Waze gehen nicht: Waze hat keine Schnittstelle, und Googles
 * Bedingungen verbieten es ausdrücklich, ihre Verkehrsdaten mit fremdem
 * Routing oder auf fremden Karten zu verwenden.
 */
(function () {
  'use strict';

  var OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
  ];
  var AUTOBAHN = 'https://verkehr.autobahn.de/o/autobahn/';

  // Sperrradius in der Stadt. Bewusst eng: die Parallelstrasse ist oft nur
  // 80 bis 150 m entfernt und soll frei bleiben. Auf der Autobahn darf die
  // Sperre viel weiter sein - dort gibt es keine Parallelstrasse, und man
  // muss rechtzeitig vorher abfahren.
  var STADT_RADIUS = 200;
  var TOMTOM   = 'https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json';

  /* ------------------------------------------------------------ Geometrie */
  function abstand(a, b) {
    var R = 6371000, t = Math.PI / 180;
    var dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function peilung(a, b) {
    var t = Math.PI / 180;
    var y = Math.sin((b[1] - a[1]) * t) * Math.cos(b[0] * t);
    var x = Math.cos(a[0] * t) * Math.sin(b[0] * t) -
            Math.sin(a[0] * t) * Math.cos(b[0] * t) * Math.cos((b[1] - a[1]) * t);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function winkelDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  // Naechster Routenpunkt zu einem Ort: Abstand und Fahrtrichtung dort
  function anDerRoute(ort, route) {
    var best = Infinity, i, k = 0;
    for (i = 0; i < route.length; i++) {
      var d = abstand(ort, route[i]);
      if (d < best) { best = d; k = i; }
    }
    var j = Math.min(k + 3, route.length - 1);
    return { abstand: best, index: k, kurs: k === j ? null : peilung(route[k], route[j]) };
  }
  // Jeden n-ten Punkt, aber mindestens `meter` auseinander
  function ausduennen(route, meter) {
    var raus = [], letzt = null;
    for (var i = 0; i < route.length; i++) {
      if (!letzt || abstand(letzt, route[i]) >= meter) { raus.push(route[i]); letzt = route[i]; }
    }
    if (raus[raus.length - 1] !== route[route.length - 1]) raus.push(route[route.length - 1]);
    return raus;
  }

  /* ------------------------------------------- 3a. Overpass: feste Blitzer */
  // Overpass ist ein Gemeinschaftsserver und sperrt bei zu vielen Anfragen aus
  // (HTTP 429). Deshalb: nur die naechsten Kilometer abfragen, das Ergebnis
  // merken und bei einer aehnlichen Route nicht erneut fragen.
  var blitzSpeicher = { kennung: null, treffer: [] };

  // Primaer blitzer.de (atudo): kennt neben den festen auch die MOBILEN
  // Blitzer des Tages - das kann OpenStreetMap nicht. Typen 1-6 fest,
  // 20-26 mobil/teilstationaer. Ein Rechteck um die naechsten Kilometer,
  // danach auf den Korridor gefiltert.
  function atudoLaden(vorne) {
    var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    vorne.forEach(function (p) {
      if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLon) minLon = p[1]; if (p[1] > maxLon) maxLon = p[1];
    });
    var box = (minLat - 0.01) + ',' + (minLon - 0.01) + ',' +
              (maxLat + 0.01) + ',' + (maxLon + 0.01);
    return fetch('https://cdn2.atudo.net/api/4.0/pois.php?type=1,2,3,4,5,6,20,21,22,23,24,25,26&box=' + box)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) {
        return (d.pois || []).filter(function (x) { return x.type !== 'cluster'; })
          .map(function (x) {
            var mobil = parseInt(x.type, 10) >= 20;
            return {
              ort: [parseFloat(x.lat), parseFloat(x.lng)],
              tempo: parseInt(x.vmax, 10) || null,
              richtung: [],
              mobil: mobil
            };
          })
          .filter(function (b) {
            if (isNaN(b.ort[0])) return false;
            // nur was am Weg liegt
            var lage = anDerRoute(b.ort, vorne);
            return lage.abstand < 300;
          });
      });
  }

  function blitzerLaden(route, maxKm) {
    if (!route || route.length < 2) return Promise.resolve([]);
    var vorne = kuerzen(route, maxKm || 25);
    var kennung = kennungVon(vorne);
    if (blitzSpeicher.kennung === kennung) return Promise.resolve(blitzSpeicher.treffer);

    return atudoLaden(vorne).then(function (treffer) {
      blitzSpeicher = { kennung: kennung, treffer: treffer };
      return treffer;
    }).catch(function () { return blitzerLadenOSM(vorne, kennung); });
  }

  // Rueckfall auf OpenStreetMap, falls atudo nicht antwortet
  function blitzerLadenOSM(vorne, kennung) {

    var stuetzen = ausduennen(vorne, 900)
      .map(function (p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); }).join(',');
    var q = '[out:json][timeout:30];node["highway"="speed_camera"](around:250,' +
            stuetzen + ');out body;';

    return versuche(OVERPASS, q).then(function (d) {
      var treffer = (d.elements || []).map(function (x) {
        var t = x.tags || {};
        return {
          ort: [x.lat, x.lon],
          tempo: parseInt(t.maxspeed, 10) || null,
          // "direction" ist mal ein Winkel, mal zwei durch ; getrennt
          richtung: (t.direction || '').split(';')
                      .map(function (n) { return parseFloat(n); })
                      .filter(function (n) { return !isNaN(n); })
        };
      }).filter(function (b) { return b.ort[0] != null; });
      blitzSpeicher = { kennung: kennung, treffer: treffer };
      return treffer;
    }).catch(function () { return blitzSpeicher.treffer; });
  }

  // Overpass-Spiegel der Reihe nach durchprobieren. Der Hauptserver
  // antwortet oft mit 504 oder 429, die Spiegel springen dann ein.
  function versuche(server, q) {
    var i = 0;
    function next() {
      if (i >= server.length) return Promise.reject(new Error('alle Spiegel aus'));
      return fetch(server[i++], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }).then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      }).catch(next);
    }
    return next();
  }

  function kuerzen(route, maxKm) {
    var raus = [], weit = 0;
    for (var i = 0; i < route.length; i++) {
      raus.push(route[i]);
      if (i) weit += abstand(route[i - 1], route[i]);
      if (weit > maxKm * 1000) break;
    }
    return raus;
  }
  // Grobe Kennung einer Strecke - aendert sich erst, wenn sie wirklich anders
  // verlaeuft, nicht schon bei jeder Neuberechnung auf demselben Weg.
  function kennungVon(route) {
    var a = route[0], b = route[route.length - 1], m = route[Math.floor(route.length / 2)];
    return [a, m, b].map(function (p) {
      return p[0].toFixed(3) + ',' + p[1].toFixed(3);
    }).join('|') + '/' + route.length;
  }

  /* --------------------------------- 3b. Nominatim: Kennung der Fernstrassen */
  // Frueher lief das ueber Overpass, was den Server bei langen Strecken mit
  // hundert Stuetzstellen ueberfordert hat. BRouter verraet in `messages`
  // ohnehin schon, welche Abschnitte Autobahn sind - fuer die reicht ein
  // Rueckwaerts-Geokodieren an wenigen Punkten, um "A 8" zu erfahren.
  var refSpeicher = { kennung: null, refs: [] };

  function refsErmitteln(messages, route) {
    if (!messages || messages.length < 2) return Promise.resolve([]);
    var kennung = kennungVon(route);
    if (refSpeicher.kennung === kennung) return Promise.resolve(refSpeicher.refs);

    var kopf = messages[0];
    var iLon = kopf.indexOf('Longitude'), iLat = kopf.indexOf('Latitude');
    var iT = kopf.indexOf('WayTags'), iD = kopf.indexOf('Distance');
    if (iLon < 0 || iT < 0) return Promise.resolve([]);

    // Zusammenhaengende Autobahnstuecke sammeln und je Stueck einen Punkt
    // in der Mitte nehmen - drei Abfragen reichen fuer jede Strecke.
    var stuecke = [], lauf = null;
    for (var i = 1; i < messages.length; i++) {
      var r = messages[i];
      var istBab = /highway=motorway(\s|$)/.test(r[iT] || '');
      var ort = [parseInt(r[iLat], 10) / 1e6, parseInt(r[iLon], 10) / 1e6];
      if (istBab) {
        if (!lauf) lauf = { punkte: [], laenge: 0 };
        lauf.punkte.push(ort);
        lauf.laenge += parseInt(r[iD], 10) || 0;
      } else if (lauf) { stuecke.push(lauf); lauf = null; }
    }
    if (lauf) stuecke.push(lauf);

    stuecke = stuecke.filter(function (s) { return s.laenge > 1500; })
                     .sort(function (a, b) { return b.laenge - a.laenge; })
                     .slice(0, 3);
    if (!stuecke.length) { refSpeicher = { kennung: kennung, refs: [] }; return Promise.resolve([]); }

    // Nominatim erlaubt hoechstens eine Anfrage je Sekunde - deshalb
    // nacheinander statt gleichzeitig.
    var refs = {}, i2 = 0, fehler = 0;
    function naechste() {
      if (i2 >= stuecke.length) {
        var liste = Object.keys(refs);
        // Nur merken, wenn die Auskunft auch geklappt hat. Sonst bliebe ein
        // misslungener Versuch fuer die ganze Fahrt haengen - Nominatim
        // drosselt gern mal, wenn kurz zuvor die Adresssuche lief.
        if (liste.length || !fehler) refSpeicher = { kennung: kennung, refs: liste };
        return liste;
      }
      var s = stuecke[i2++];
      var p = s.punkte[Math.floor(s.punkte.length / 2)];
      return fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=' +
                   p[0].toFixed(5) + '&lon=' + p[1].toFixed(5))
        .then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.json();
        })
        .then(function (d) {
          var name = d && (d.name || (d.address || {}).road || '');
          // OSM schreibt "A 8", die Autobahn-Schnittstelle "A8"
          String(name).split(';').forEach(function (n) {
            n = n.trim().replace(/\s+/g, '');
            if (/^A\d+$/.test(n)) refs[n] = true;
          });
        })
        .catch(function () { fehler++; })
        .then(function () {
          return new Promise(function (ok) { setTimeout(ok, 1200); }).then(naechste);
        });
    }
    return Promise.resolve().then(naechste);
  }

  /* ------------------------------------- 1. Autobahn GmbH: die grossen Staus */
  // Ersatzwerte in Minuten, wenn die Meldung keinen Zeitverlust nennt.
  // Grob an dem geeicht, was die Meldungen mit Angabe typischerweise zeigen.
  var ART = {
    QUEUING_TRAFFIC: 'Stau', SLOW_TRAFFIC: 'stockend',
    HEAVY_TRAFFIC: 'dichter Verkehr', UNSPECIFIED_ABNORMAL_TRAFFIC: 'Störung'
  };
  var SCHAETZUNG = {
    QUEUING_TRAFFIC: 10,                  // Stau
    SLOW_TRAFFIC: 5,                      // stockender Verkehr
    HEAVY_TRAFFIC: 3,                     // dichter Verkehr
    UNSPECIFIED_ABNORMAL_TRAFFIC: 3
  };

  function autobahnStoerungen(refs, route, schwelle) {
    if (!refs || !refs.length) return Promise.resolve([]);
    var anfragen = refs.slice(0, 4).map(function (ref) {
      return fetch(AUTOBAHN + encodeURIComponent(ref) + '/services/warning')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return (d && d.warning) || []; })
        .catch(function () { return []; });
    });

    return Promise.all(anfragen).then(function (listen) {
      var raus = [];
      listen.forEach(function (warnungen) {
        warnungen.forEach(function (w) {
          var c = w.coordinate;
          if (!c) return;
          var ort = [parseFloat(c.lat), parseFloat(c.long)];
          if (isNaN(ort[0])) return;

          var lage = anDerRoute(ort, route);
          if (lage.abstand > 2000) return;             // nicht auf unserer Strecke

          // Gegenrichtung aussortieren. Die beiden Fahrbahnen liegen nur
          // wenige Meter auseinander, ueber den Abstand ist das nicht zu
          // trennen - wohl aber ueber die Richtung, in die sich die Meldung
          // erstreckt.
          var geo = w.geometry && w.geometry.coordinates;
          if (geo && geo.length > 1 && lage.kurs !== null) {
            var a = [geo[0][1], geo[0][0]];
            var b = [geo[geo.length - 1][1], geo[geo.length - 1][0]];
            if (abstand(a, b) > 200 && winkelDiff(peilung(a, b), lage.kurs) > 90) return;
          }

          var minuten = parseInt(w.delayTimeValue, 10) || 0;
          var gesperrt = String(w.isBlocked) === 'true';

          // Nicht jede Meldung nennt einen Zeitverlust. Ein gemeldeter Stau
          // ohne Minutenangabe ist trotzdem einer - deshalb aus der Art der
          // Stoerung schaetzen, sonst faellt er durch die Schwelle.
          if (!minuten) minuten = SCHAETZUNG[w.abnormalTrafficType] || 0;
          if (!gesperrt && minuten < schwelle) return;

          raus.push({
            ort: ort,
            index: lage.index,
            minuten: minuten,
            tempo: parseInt(w.averageSpeed, 10) || null,
            hart: gesperrt,
            radius: gesperrt ? 1200 : 900,
            text: (gesperrt ? 'Sperrung' : ART[w.abnormalTrafficType] || 'Stau') + ' ' +
                  (w.title || '').split('|')[0].trim() +
                  (minuten ? ' · ' + minuten + ' min' : ''),
            quelle: 'autobahn'
          });
        });
      });
      return raus;
    });
  }

  /* ------------------------------ 2. TomTom Flow: Bundes- und Stadtstrassen */
  // Misst je Stuetzstelle die gefahrene gegen die freie Geschwindigkeit.
  // Zusammenhaengende langsame Stuecke werden zu einer Stoerung gebuendelt,
  // damit nicht jeder Messpunkt eine eigene Sperrzone wird.
  function tomtomFluss(route, schluessel, schwelle, maxKm) {
    if (!schluessel || !route || route.length < 2) return Promise.resolve([]);

    var abschnitt = route, gefahren = 0;
    if (maxKm) {
      abschnitt = [];
      for (var i = 0; i < route.length; i++) {
        abschnitt.push(route[i]);
        if (i) gefahren += abstand(route[i - 1], route[i]);
        if (gefahren > maxKm * 1000) break;
      }
    }
    var stuetzen = ausduennen(abschnitt, 800);
    if (stuetzen.length > 30) stuetzen = ausduennen(abschnitt, 1500);

    var anfragen = stuetzen.map(function (p) {
      return fetch(TOMTOM + '?key=' + encodeURIComponent(schluessel) +
                   '&unit=KMPH&point=' + p[0].toFixed(5) + ',' + p[1].toFixed(5))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var f = d && d.flowSegmentData;
          if (!f || !f.freeFlowSpeed) return null;
          return { ort: p, jetzt: f.currentSpeed, frei: f.freeFlowSpeed,
                   sicher: f.confidence == null ? 1 : f.confidence };
        })
        .catch(function () { return null; });
    });

    return Promise.all(anfragen).then(function (messungen) {
      var raus = [], lauf = null;
      messungen.forEach(function (m, i) {
        var stockt = m && m.sicher >= 0.5 && m.jetzt < m.frei * 0.65;
        if (stockt) {
          // Zeitverlust auf dem Stueck bis zur naechsten Stuetzstelle
          var strecke = i + 1 < stuetzen.length ? abstand(stuetzen[i], stuetzen[i + 1]) : 800;
          var verlust = strecke / 1000 * (60 / Math.max(m.jetzt, 3) - 60 / m.frei);  // Minuten
          if (!lauf) lauf = { orte: [], minuten: 0, tempo: m.jetzt };
          lauf.orte.push(m.ort);
          lauf.minuten += verlust;
          lauf.tempo = Math.min(lauf.tempo, m.jetzt);
        } else if (lauf) {
          if (lauf.minuten >= schwelle) raus.push(lauf);
          lauf = null;
        }
      });
      if (lauf && lauf.minuten >= schwelle) raus.push(lauf);

      // Wichtig: je Messpunkt eine ENGE Sperre statt einer fetten je Stau.
      // Gemessen quer durch Tuebingen: mit 500 m Radius flieht die Route auf
      // die B27 (7,96 km, 23 % kleine Strassen), mit 200 m nimmt sie die
      // Parallelstrassen (4,99 km, 56 %). Ein fetter Kreis sperrt eben genau
      // die Schleichwege mit, um die es geht.
      var stoerungen = [];
      raus.forEach(function (s) {
        var minutenJeStueck = s.minuten / s.orte.length;
        s.orte.forEach(function (ort) {
          var lage = anDerRoute(ort, route);
          stoerungen.push({
            ort: ort, index: lage.index,
            minuten: Math.round(minutenJeStueck * 10) / 10,
            gesamtMinuten: Math.round(s.minuten),
            tempo: Math.round(s.tempo),
            hart: false, radius: STADT_RADIUS,
            text: 'Stau · ' + Math.round(s.minuten) + ' min · ' + Math.round(s.tempo) + ' km/h',
            quelle: 'tomtom'
          });
        });
      });
      return stoerungen;
    }).catch(function () { return []; });
  }

  /* --------------------- 1b. Landesmeldestelle BW: Sperrungen & Unfaelle */
  // Amtliche Meldungen des Landes, offen und ohne Schluessel - und anders als
  // die Autobahn-Schnittstelle auch fuer Bundes-, Land- und Stadtstrassen.
  // Aber: dort stehen nur gemeldete Ereignisse (Sperrung, Unfall, Baustelle),
  // keine Rush-Hour-Staus. Die Datei ist 1,3 MB gross, deshalb hoechstens
  // alle zehn Minuten frisch.
  var TIC = 'https://api.mobidata-bw.de/datasets/traffic/incidents-bw/TIC3-Meldungen.xml';
  var ticSpeicher = { stand: 0, meldungen: [] };

  function ticLaden() {
    if (Date.now() - ticSpeicher.stand < 600000) return Promise.resolve(ticSpeicher.meldungen);
    return fetch(TIC)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (xml) {
        var dom = new DOMParser().parseFromString(xml, 'text/xml');
        var raus = [];
        var events = dom.getElementsByTagName('TrafficAndTravelEvent');
        for (var i = 0; i < events.length; i++) {
          var e = events[i];
          var textEl = e.getElementsByTagName('Text')[0];
          var text = textEl ? textEl.textContent.replace(/\s+/g, ' ').trim() : '';
          var lats = e.getElementsByTagName('Latitude');
          var lons = e.getElementsByTagName('Longitude');
          var orte = [];
          for (var j = 0; j < Math.min(lats.length, lons.length); j += 4) {
            var la = parseFloat(lats[j].textContent), lo = parseFloat(lons[j].textContent);
            if (!isNaN(la)) orte.push([la, lo]);
          }
          if (orte.length) raus.push({ text: text, orte: orte });
        }
        ticSpeicher = { stand: Date.now(), meldungen: raus };
        return raus;
      })
      .catch(function () { return ticSpeicher.meldungen; });
  }

  function ticStoerungen(route, schwelle) {
    return ticLaden().then(function (meldungen) {
      var raus = [];
      meldungen.forEach(function (m) {
        var beste = null;
        m.orte.forEach(function (o) {
          var lage = anDerRoute(o, route);
          if (lage.abstand < 300 && (!beste || lage.abstand < beste.abstand)) {
            beste = { ort: o, index: lage.index, abstand: lage.abstand };
          }
        });
        if (!beste) return;
        var t = m.text.toLowerCase();
        var hart = t.indexOf('gesperrt') >= 0 || t.indexOf('vollsperrung') >= 0;
        var minuten = hart ? 0 : (t.indexOf('stau') >= 0 ? 10 :
                      t.indexOf('unfall') >= 0 ? 8 :
                      t.indexOf('stockend') >= 0 ? 5 : 0);
        if (!hart && minuten < schwelle) return;
        raus.push({
          ort: beste.ort, index: beste.index,
          minuten: minuten, tempo: null, hart: hart,
          radius: hart ? 300 : STADT_RADIUS,
          text: (hart ? 'Sperrung' : 'Störung') + ' · ' + m.text.slice(0, 60),
          quelle: 'tic'
        });
      });
      return raus;
    });
  }

  /* ------------------------------------------------------------- Buendelung */
  function alleStoerungen(route, refs, schluessel, schwelle, sichtKm) {
    return Promise.all([
      autobahnStoerungen(refs, route, schwelle),
      tomtomFluss(route, schluessel, schwelle, sichtKm || 15),
      ticStoerungen(route, schwelle)
    ]).then(function (teile) {
      var alle = teile[0].concat(teile[1], teile[2]);
      // Doppelte aussortieren: melden Autobahn-API und TomTom denselben Stau,
      // gewinnt die amtliche Meldung, weil sie die Minuten sauberer kennt.
      // Doppelte aussortieren: melden Autobahn-API und TomTom denselben Stau,
      // gewinnt die amtliche Meldung. Der Mindestabstand richtet sich nach der
      // Sperrgroesse - enge Stadtsperren duerfen dicht in einer Kette liegen.
      return alle.filter(function (s, i) {
        return !alle.some(function (t, j) {
          return j < i && abstand(s.ort, t.ort) < Math.max(s.radius, t.radius) * 1.2;
        });
      });
    });
  }

  window.Verkehr = {
    blitzerLaden: blitzerLaden,
    refsErmitteln: refsErmitteln,
    autobahnStoerungen: autobahnStoerungen,
    ticStoerungen: ticStoerungen,
    tomtomFluss: tomtomFluss,
    alleStoerungen: alleStoerungen,
    abstand: abstand,
    peilung: peilung,
    winkelDiff: winkelDiff
  };
})();
