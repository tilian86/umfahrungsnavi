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

  // Markiert "Dienst hat nicht geantwortet". Das ist etwas anderes als
  // "keine Stoerung" - ein Ausfall darf nie als freie Fahrt durchgehen.
  var FEHLT = { fehlt: true };

  // fetch mit Zeitlimit, und zwar fuer Kopf UND Inhalt. Ohne das bleibt eine
  // Anfrage bei stehender Mobilverbindung ewig offen: die Verkehrspruefung
  // kommt nie zurueck, und weil sie als "laeuft noch" gilt, wird auch nie
  // wieder geprueft. Liefert den gelesenen Inhalt ('json' oder 'text');
  // eine Fehlantwort wird zum Fehler mit `status`, damit sich 400 (dort gibt
  // es keine Daten) von 429 (Kontingent aus) unterscheiden laesst.
  function abruf(url, ms, art, opt) {
    var ab = window.AbortController ? new AbortController() : null;
    var uhr = ab ? setTimeout(function () { ab.abort(); }, ms) : null;
    var o = {};
    for (var k in (opt || {})) o[k] = opt[k];
    if (ab) o.signal = ab.signal;
    return fetch(url, o).then(function (r) {
      if (!r.ok) { var f = new Error('HTTP ' + r.status); f.status = r.status; throw f; }
      return art === 'text' ? r.text() : r.json();
    }).then(function (d) { clearTimeout(uhr); return d; },
            function (e) { clearTimeout(uhr); throw e; });
  }

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
  // Blitzer des Tages - das kann OpenStreetMap nicht.
  //
  // TYPEN (am 09.10.2026 an ~1200 Punkten quer durch Deutschland gemessen,
  // weil die frueher hier angenommene Tabelle schlicht falsch war):
  //   1, 20-29   von Nutzern gemeldet, also MOBIL. Frisches `create_date`,
  //              `counter` 1-3, `backend` faengt mit 4- oder 0- an, kein
  //              `vmax`. In der Praxis ist fast alles davon Typ 26.
  //   101-119    FESTE Anlagen aus der Redaktion: `info.fixed` ist 1,
  //              `counter` 0, `backend` 1-, dazu `vmax` und ein Beschreibungs-
  //              text ("PoliScan (3R)", "stadtauswaerts"). Beobachtet:
  //              105 Durchfahrt-/Wendeverbot, 107 Starenkasten, 110 Ampel
  //              plus Tempo, 111 reiner Rotlichtblitzer, 114 Tunnel.
  //   Typen 2-6 gibt es nicht - eine Abfrage darauf kommt ueberall leer
  //   zurueck. Die alte Liste fragte nur 1-6 und 20-26 ab und hat damit
  //   KEINEN EINZIGEN festen Blitzer geholt; alles Gefundene war gemeldet
  //   und wurde folgerichtig als "mobil" angesagt (Florians Beobachtung
  //   an der Paul-Horn-Arena). Ob fest oder mobil entscheidet jetzt
  //   `info.fixed` und nicht mehr die Typnummer.
  //
  // WICHTIG: atudo fasst Blitzer zu "cluster"-Eintraegen zusammen, sobald das
  // abgefragte Rechteck gross wird - und ein Cluster verraet die einzelnen
  // Standorte nicht, nur eine Anzahl. Frueher fragte diese Datei EIN Rechteck
  // ueber die ganze Route ab und warf die Cluster weg. Gemessen am 08.10.2026
  // fuer den Grossraum Tuebingen-Stuttgart: eine Box liefert 23 Blitzer
  // einzeln und verdeckt 163 weitere in 26 Clustern; in Kacheln von 0,05 Grad
  // abgefragt kommen 223 heraus. Auf langen Strecken fiel also der Grossteil
  // der Warnungen aus. Der Parameter `zoom` hilft nicht (geprueft).
  // Deshalb: den Routenkorridor in Kacheln zerlegen und die parallel abfragen.
  var ATUDO = 'https://cdn2.atudo.net/api/4.0/pois.php';
  var ATUDO_TYPEN = '1,20,21,22,23,24,25,26,27,28,29,' +
                    '101,102,103,104,105,106,107,108,109,110,' +
                    '111,112,113,114,115,116,117,118,119';
  var KACHEL = 0.05;        // Grad Kantenlaenge; darueber faengt atudo an zu clustern
  var KACHELRAND = 0.006;   // Grad Zugabe (~650 m), damit am Kachelrand nichts fehlt
  var MAX_KACHELN = 14;     // Deckel: eine Fernfahrt soll keine 50 Anfragen stellen
  var MAX_ANFRAGEN = 26;    // auch mit Nachfassen: atudo bremst bei zu vielen aus

  // Den Streckenverlauf in Kacheln von hoechstens KACHEL Grad zerlegen. Das
  // folgt dem Korridor statt dem umschliessenden Rechteck - bei einer
  // L-foermigen Route sind das halb so viele Anfragen.
  function kacheln(route) {
    var liste = [], cur = null;
    route.forEach(function (p) {
      if (!cur) { cur = [p[0], p[1], p[0], p[1]]; return; }
      var a0 = Math.min(cur[0], p[0]), a1 = Math.max(cur[2], p[0]);
      var o0 = Math.min(cur[1], p[1]), o1 = Math.max(cur[3], p[1]);
      if (a1 - a0 > KACHEL || o1 - o0 > KACHEL) {
        liste.push(cur);
        cur = [p[0], p[1], p[0], p[1]];
      } else cur = [a0, o0, a1, o1];
    });
    if (cur) liste.push(cur);
    return liste.slice(0, MAX_KACHELN);
  }

  // Einen Rohdatensatz in einen Blitzer uebersetzen - oder in nichts,
  // wenn er keiner ist.
  function blitzerAus(x) {
    var la = parseFloat(x.lat), lo = parseFloat(x.lng);
    if (isNaN(la) || isNaN(lo)) return null;
    var i = x.info || {};
    var fest = String(i.fixed) === '1';
    // Stillgelegte Kaesten stehen mit "inaktiv" in der Beschreibung. Eine
    // Warnung davor ist ein sicherer Fehlalarm - und einer, der das
    // Vertrauen in alle anderen Warnungen kostet.
    if (fest && /inaktiv/i.test(i.desc || '')) return null;
    return {
      id: x.id || (la.toFixed(5) + ',' + lo.toFixed(5)),
      ort: [la, lo],
      tempo: parseInt(x.vmax, 10) || null,
      richtung: [],
      mobil: !fest
    };
  }

  function entdoppeln(liste) {
    var gesehen = {}, raus = [];
    liste.forEach(function (b) {
      if (gesehen[b.id]) return;
      gesehen[b.id] = true;
      raus.push(b);
    });
    // Nutzer melden feste Kaesten regelmaessig als mobile Blitzer. Dann liegen
    // zwei Eintraege fast am selben Ort, und weil der Ansage-Schluessel die
    // Position auf ~1 m genau nimmt, kaeme die Ansage zweimal ("Blitzer,
    // Tempo 50" und gleich danach "mobiler Blitzer"). Steht ein fester Kasten
    // in 80 m, fliegt die Nutzermeldung raus - der redaktionelle Eintrag ist
    // der verlaesslichere, er bringt Tempo und Beschreibung mit.
    var feste = raus.filter(function (b) { return !b.mobil; });
    if (!feste.length) return raus;
    return raus.filter(function (b) {
      if (!b.mobil) return true;
      return !feste.some(function (f) { return abstand(b.ort, f.ort) < 80; });
    });
  }

  function vierteln(boxen) {
    var raus = [];
    boxen.forEach(function (b) {
      var mLa = (b[0] + b[2]) / 2, mLo = (b[1] + b[3]) / 2;
      raus.push([b[0], b[1], mLa, mLo], [b[0], mLo, mLa, b[3]],
                [mLa, b[1], b[2], mLo], [mLa, mLo, b[2], b[3]]);
    });
    return raus;
  }

  // Rohabfrage mehrerer Boxen, entdoppelt. Wo atudo trotzdem zusammengefasst
  // hat, wird genau diese Box geviertelt und noch einmal gefragt - sonst
  // fehlen ausgerechnet in dichten Innenstaedten die meisten Blitzer.
  // Gedeckelt auf MAX_ANFRAGEN: atudo sperrt bei zu vielen Abrufen fuer
  // einige Minuten aus (beim Vermessen der Typen selbst ausgeloest).
  function atudoBoxen(boxen, budget) {
    if (budget == null) budget = MAX_ANFRAGEN;
    boxen = boxen.slice(0, Math.max(1, budget));
    var fehler = 0;
    return Promise.all(boxen.map(function (b) {
      var box = (b[0] - KACHELRAND).toFixed(4) + ',' + (b[1] - KACHELRAND).toFixed(4) + ',' +
                (b[2] + KACHELRAND).toFixed(4) + ',' + (b[3] + KACHELRAND).toFixed(4);
      return abruf(ATUDO + '?type=' + ATUDO_TYPEN + '&box=' + box, 10000, 'json')
        .then(function (d) { return { box: b, pois: d.pois || [] }; },
              // Eine einzelne Kachel darf fehlen - lieber die anderen melden
              // als gar nichts. Nur wenn ALLE scheitern, geht es zu OSM.
              function () { fehler++; return { box: b, pois: [] }; });
    })).then(function (antworten) {
      if (fehler === boxen.length) throw new Error('atudo aus');
      var liste = [], eng = [];
      antworten.forEach(function (a) {
        var cluster = false;
        a.pois.forEach(function (x) {
          if (x.type === 'cluster') { cluster = true; return; }
          var bl = blitzerAus(x);
          if (bl) liste.push(bl);
        });
        if (cluster) eng.push(a.box);
      });
      // Nur so viele Kacheln nachfassen, wie das Budget GANZ traegt -
      // eine halb abgefragte Runde kostet Abrufe und liefert Luecken.
      var rest = budget - boxen.length;
      var machbar = Math.floor(rest / 4);
      if (!eng.length || machbar < 1) {
        return { liste: entdoppeln(liste), cluster: eng.length };
      }
      return atudoBoxen(vierteln(eng.slice(0, machbar)), rest).then(function (e2) {
        return { liste: entdoppeln(liste.concat(e2.liste)), cluster: e2.cluster };
      }, function () { return { liste: entdoppeln(liste), cluster: eng.length }; });
    });
  }

  function atudoLaden(vorne) {
    return atudoBoxen(kacheln(vorne)).then(function (erg) {
      return erg.liste.filter(function (b) {
        return anDerRoute(b.ort, vorne).abstand < 300;
      });
    });
  }

  // Blitzer rund um den Standort - fuer die Fahrt OHNE Ziel. Ein
  // Blitzerwarner muss immer warnen, nicht nur wenn gerade eine Route
  // laeuft; genau daran lag es, dass er sich "generell" nicht meldete.
  // Eine Box von +-7 km clustert in der Stadt sehr wohl - atudoBoxen
  // viertelt sie dann von selbst nach.
  var umSpeicher = { kennung: null, treffer: [], zeit: 0 };
  function blitzerUmher(ort, km) {
    var r = km || 7;
    var gLa = r / 111, gLo = r / (111 * Math.cos(ort[0] * Math.PI / 180));
    var kennung = ort[0].toFixed(2) + ',' + ort[1].toFixed(2) + '/' + r;
    if (umSpeicher.kennung === kennung &&
        Date.now() - umSpeicher.zeit < BLITZ_HALTBAR) {
      return Promise.resolve(umSpeicher.treffer);
    }
    var ganz = [[ort[0] - gLa, ort[1] - gLo, ort[0] + gLa, ort[1] + gLo]];
    return atudoBoxen(ganz).then(function (erg) {
      return erg.liste;
    }).then(function (liste) {
      var raus = liste.filter(function (b) { return abstand(ort, b.ort) < r * 1000; });
      umSpeicher = { kennung: kennung, treffer: raus, zeit: Date.now() };
      return raus;
    }).catch(function (e) {
      // Nichts bekommen: nur die Treffer DIESER Gegend weiterreichen. Sonst
      // haengen die Blitzer der letzten Stadt an der neuen Position - und
      // eine leere Liste wuerde dem Aufrufer vorgaukeln, hier sei nichts.
      if (umSpeicher.kennung === kennung) return umSpeicher.treffer;
      throw e;
    });
  }

  // Mobile Blitzer ("Blitzer des Tages") kommen und gehen waehrend der Fahrt.
  // Deshalb gilt das Gemerkte nur 10 Minuten, danach wird neu gefragt.
  var BLITZ_HALTBAR = 600000;
  function blitzerLaden(route, maxKm) {
    if (!route || route.length < 2) return Promise.resolve([]);
    var vorne = kuerzen(route, maxKm || 25);
    var kennung = kennungVon(vorne);
    if (blitzSpeicher.kennung === kennung &&
        Date.now() - (blitzSpeicher.zeit || 0) < BLITZ_HALTBAR) {
      return Promise.resolve(blitzSpeicher.treffer);
    }

    return atudoLaden(vorne).then(function (treffer) {
      blitzSpeicher = { kennung: kennung, treffer: treffer, zeit: Date.now() };
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
      blitzSpeicher = { kennung: kennung, treffer: treffer, zeit: Date.now() };
      return treffer;
    }).catch(function () { return blitzSpeicher.treffer; });
  }

  // Overpass-Spiegel der Reihe nach durchprobieren. Der Hauptserver
  // antwortet oft mit 504 oder 429, die Spiegel springen dann ein.
  function versuche(server, q) {
    var i = 0;
    function next() {
      if (i >= server.length) return Promise.reject(new Error('alle Spiegel aus'));
      // 25 s: die Abfrage selbst darf serverseitig bis 30 s rechnen
      return abruf(server[i++], 25000, 'json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
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
    // Alle vier Spalten pruefen: fehlt Latitude, liefe lat=NaN in die
    // Nominatim-Abfragen und die Kennungen blieben still fuer immer leer.
    if (iLon < 0 || iT < 0 || iLat < 0 || iD < 0) return Promise.resolve([]);

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
      return abruf('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=' +
                   p[0].toFixed(5) + '&lon=' + p[1].toFixed(5), 8000, 'json')
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

  // Alle Warnungen einer Autobahn - oder FEHLT, wenn der Dienst schweigt.
  function warnungenHolen(ref) {
    return abruf(AUTOBAHN + encodeURIComponent(ref) + '/services/warning', 10000, 'json')
      .then(function (d) { return (d && d.warning) || []; })
      .catch(function () { return FEHLT; });
  }
  function warnungsOrt(w) {
    var c = w.coordinate;
    var ort = c ? [parseFloat(c.lat), parseFloat(c.long)] : null;
    return ort && !isNaN(ort[0]) && !isNaN(ort[1]) ? ort : null;
  }

  function autobahnStoerungen(refs, route, schwelle) {
    if (!refs || !refs.length) return Promise.resolve([]);
    var gefragt = refs.slice(0, 4);

    return Promise.all(gefragt.map(warnungenHolen)).then(function (listen) {
      var raus = [], fehlt = 0;
      listen.forEach(function (warnungen, k) {
        if (warnungen === FEHLT) { fehlt++; return; }
        warnungen.forEach(function (w) {
          var ort = warnungsOrt(w);
          if (!ort) return;

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
            ref: gefragt[k],              // fuers Nachmessen an Ort und Stelle
            quelle: 'autobahn'
          });
        });
      });
      raus.ausfall = fehlt > 0;
      return raus;
    });
  }

  /* ------------------------------ 2. TomTom Flow: Bundes- und Stadtstrassen */
  // Misst je Stuetzstelle die gefahrene gegen die freie Geschwindigkeit.
  // Zusammenhaengende langsame Stuecke werden zu einer Stoerung gebuendelt,
  // damit nicht jeder Messpunkt eine eigene Sperrzone wird.
  // Eine Messung an einem Punkt: {ort, jetzt, frei, sicher}. null, wenn
  // TomTom dort keine Strasse kennt (HTTP 400) - FEHLT, wenn der Dienst
  // nicht antwortet oder das Kontingent aus ist (403, 429).
  function tomtomPunkt(p, schluessel) {
    return abruf(TOMTOM + '?key=' + encodeURIComponent(schluessel) +
                 '&unit=KMPH&point=' + p[0].toFixed(5) + ',' + p[1].toFixed(5), 8000, 'json')
      .then(function (d) {
        var f = d && d.flowSegmentData;
        if (!f || !f.freeFlowSpeed) return null;
        return { ort: p, jetzt: f.currentSpeed, frei: f.freeFlowSpeed,
                 sicher: f.confidence == null ? 1 : f.confidence };
      })
      .catch(function (e) { return e && e.status === 400 ? null : FEHLT; });
  }
  // Ab wann ein Messpunkt als Stau zaehlt
  function stockt(m) {
    return !!m && m !== FEHLT && m.sicher >= 0.5 && m.jetzt < m.frei * 0.65;
  }

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

    var anfragen = stuetzen.map(function (p) { return tomtomPunkt(p, schluessel); });

    return Promise.all(anfragen).then(function (messungen) {
      var raus = [], lauf = null, fehlt = 0;
      messungen.forEach(function (m, i) {
        if (m === FEHLT) fehlt++;
        if (stockt(m)) {
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
      // Fehlt mehr als die Haelfte der Messungen, ist das keine Lage mehr,
      // sondern eine Luecke (meist Kontingent aus oder kein Netz)
      stoerungen.ausfall = fehlt * 2 > messungen.length;
      return stoerungen;
    }).catch(function () { var leer = []; leer.ausfall = true; return leer; });
  }

  /* --------------------- 1b. Landesmeldestelle BW: Sperrungen & Unfaelle */
  // Amtliche Meldungen des Landes, offen und ohne Schluessel - und anders als
  // die Autobahn-Schnittstelle auch fuer Bundes-, Land- und Stadtstrassen.
  // Aber: dort stehen nur gemeldete Ereignisse (Sperrung, Unfall, Baustelle),
  // keine Rush-Hour-Staus. Die Datei ist 1,3 MB gross, deshalb hoechstens
  // alle zehn Minuten frisch.
  var TIC = 'https://api.mobidata-bw.de/datasets/traffic/incidents-bw/TIC3-Meldungen.xml';
  var ticSpeicher = { stand: 0, meldungen: [], ausfall: false };

  function ticLaden() {
    if (Date.now() - ticSpeicher.stand < 600000) return Promise.resolve(ticSpeicher.meldungen);
    return abruf(TIC, 30000, 'text')
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
            if (!isNaN(la) && !isNaN(lo)) orte.push([la, lo]);
          }
          if (orte.length) raus.push({ text: text, orte: orte });
        }
        ticSpeicher = { stand: Date.now(), meldungen: raus, ausfall: false };
        return raus;
      })
      .catch(function () {
        // Den letzten Stand noch eine halbe Stunde weiterverwenden - danach
        // ist er keine Lage mehr, sondern eine Luecke.
        ticSpeicher.ausfall = Date.now() - ticSpeicher.stand > 1800000;
        return ticSpeicher.meldungen;
      });
  }
  // Steht zu diesem Ort noch eine Meldung in der Liste?
  function ticMeldungBei(meldungen, ort) {
    return meldungen.some(function (m) {
      return m.orte.some(function (o) { return abstand(o, ort) < 300; });
    });
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
      raus.ausfall = ticSpeicher.ausfall;
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
      // Der Mindestabstand richtet sich nach der Sperrgroesse - enge
      // Stadtsperren duerfen dicht in einer Kette liegen.
      var raus = alle.filter(function (s, i) {
        return !alle.some(function (t, j) {
          return j < i && abstand(s.ort, t.ort) < Math.max(s.radius, t.radius) * 1.2;
        });
      });
      // Welche Quelle diesmal nichts geliefert hat. Ohne diese Angabe sieht
      // ein Ausfall genauso aus wie freie Fahrt.
      raus.ausfall = [];
      if (teile[0].ausfall) raus.ausfall.push('Autobahn');
      if (teile[1].ausfall) raus.ausfall.push('TomTom');
      if (teile[2].ausfall) raus.ausfall.push('Landesmeldungen');
      return raus;
    });
  }

  /* ------------------------------------------------- Nachmessen vor Ort */
  // Eine Umfahrung fuehrt am Stau vorbei - die Pruefung entlang der neuen
  // Route sieht ihn also nicht mehr. Das heisst aber nicht, dass er weg ist.
  // Deshalb wird jede Sperre an ihrer EIGENEN Stelle nachgeprueft, bei der
  // Quelle, die sie gemeldet hat. Ergebnis je Sperre: 'stau', 'frei' oder
  // 'unbekannt' (Dienst schweigt - dann entscheidet die Haltezeit in app.js).
  function nachmessen(liste, schluessel) {
    return Promise.all(liste.map(function (sp) {
      if (sp.quelle === 'tomtom') {
        if (!schluessel) return 'unbekannt';
        return tomtomPunkt(sp.ort, schluessel).then(function (m) {
          if (!m || m === FEHLT) return 'unbekannt';
          return stockt(m) ? 'stau' : 'frei';
        });
      }
      if (sp.quelle === 'autobahn') {
        if (!sp.ref) return 'unbekannt';
        return warnungenHolen(sp.ref).then(function (warnungen) {
          if (warnungen === FEHLT) return 'unbekannt';
          var noch = warnungen.some(function (w) {
            var ort = warnungsOrt(w);
            return ort && abstand(ort, sp.ort) < Math.max(sp.radius, 1000);
          });
          return noch ? 'stau' : 'frei';
        });
      }
      if (sp.quelle === 'tic') {
        return ticLaden().then(function (meldungen) {
          if (ticSpeicher.ausfall) return 'unbekannt';
          return ticMeldungBei(meldungen, sp.ort) ? 'stau' : 'frei';
        });
      }
      return 'unbekannt';
    }));
  }

  window.Verkehr = {
    blitzerLaden: blitzerLaden,
    blitzerUmher: blitzerUmher,
    refsErmitteln: refsErmitteln,
    autobahnStoerungen: autobahnStoerungen,
    ticStoerungen: ticStoerungen,
    tomtomFluss: tomtomFluss,
    alleStoerungen: alleStoerungen,
    nachmessen: nachmessen,
    abstand: abstand,
    peilung: peilung,
    winkelDiff: winkelDiff
  };
})();
