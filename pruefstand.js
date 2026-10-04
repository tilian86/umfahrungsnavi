/* Prüfstand: täuscht GPS vor und fährt die berechnete Route ab.
 *
 * Nur aktiv, wenn "?pruefstand" in der Adresse steht - im normalen Betrieb
 * tut die Datei nichts.
 *
 * Ein Navi lässt sich am Schreibtisch sonst nicht prüfen: ohne Bewegung gibt
 * es keine Abbiegehinweise, keine Blitzerwarnung, keine Neuberechnung und
 * keine Ansagen. Muss VOR app.js geladen werden, damit der Ersatz für
 * navigator.geolocation schon steht, wenn die App ihn abruft.
 */
(function () {
  'use strict';
  if (location.search.indexOf('pruefstand') < 0) return;

  var lage = { lat: 48.5216, lon: 9.0576, kurs: 90, tempo: 0 };
  var melder = {}, naechsteId = 1, takt = null, weg = null, index = 0, gpsAus = false;

  // Wie ein echtes GPS: meldet sich auch im Stand etwa jede Sekunde. Mit
  // "GPS aus" verstummt es - so laesst sich der GPS-Waechter der App pruefen.
  navigator.geolocation.watchPosition = function (ok) {
    var id = naechsteId++;
    melder[id] = ok;
    if (!gpsAus) setTimeout(function () { if (melder[id] && !gpsAus) ok(bau()); }, 50);
    return id;
  };
  navigator.geolocation.getCurrentPosition = function (ok) { ok(bau()); };
  navigator.geolocation.clearWatch = function (id) { delete melder[id]; };
  setInterval(function () { if (!takt) melden(); }, 1000);

  function bau() {
    return { coords: {
      latitude: lage.lat, longitude: lage.lon, accuracy: 8,
      heading: lage.kurs, speed: lage.tempo, altitude: null, altitudeAccuracy: null
    }, timestamp: Date.now() };
  }
  function melden() {
    if (gpsAus) return;
    Object.keys(melder).forEach(function (id) { try { melder[id](bau()); } catch (e) {} });
  }
  function melde(t) { var e = document.getElementById('p-lage'); if (e) e.textContent = t; }

  // Von aussen setzbar, damit sich auch Sonderfälle prüfen lassen
  window.pruefSetzen = function (lat, lon, kurs) {
    lage.lat = lat; lage.lon = lon;
    if (kurs != null) { lage.kurs = kurs; lage.tempo = 14; }
    melden();
  };
  window.pruefFahrt = function () { document.getElementById('p-fahrt').click(); };

  function schritt() {
    // Die Route kann sich während der Fahrt ändern (Neuberechnung, Stauzone).
    // Dann auf der neuen Linie beim nächstgelegenen Punkt weiterlaufen.
    var jetzt = window._navi.route();
    if (jetzt !== weg) {
      weg = jetzt;
      var best = Infinity, k = 0;
      for (var i = 0; i < weg.length; i++) {
        var d = Math.abs(weg[i][0] - lage.lat) + Math.abs(weg[i][1] - lage.lon);
        if (d < best) { best = d; k = i; }
      }
      index = k;
    }
    if (!weg || index >= weg.length - 1) {
      clearInterval(takt); takt = null; melde('Ziel erreicht'); return;
    }
    var vorher = weg[index];
    index = Math.min(index + 3, weg.length - 1);
    var p = weg[index];
    lage.lat = p[0]; lage.lon = p[1]; lage.tempo = 14;
    lage.kurs = (Math.atan2(p[1] - vorher[1], p[0] - vorher[0]) * 180 / Math.PI + 360) % 360;
    melden();
    melde('fährt · ' + index + '/' + weg.length);
  }

  // Leiste erst bauen, wenn das Grundgerüst der Seite steht
  document.addEventListener('DOMContentLoaded', function () {
    var leiste = document.createElement('div');
    leiste.id = 'pruef';
    leiste.innerHTML = '<button id="p-fahrt">Fahrt starten</button>' +
                       '<button id="p-halt">Stopp</button>' +
                       '<button id="p-gps">GPS aus</button>' +
                       '<span id="p-lage">steht</span>';
    document.body.appendChild(leiste);
    var stil = document.createElement('style');
    stil.textContent =
      '#pruef{position:absolute;z-index:900;top:0;left:0;right:0;padding:6px 10px;' +
      'display:flex;gap:6px;align-items:center;background:rgba(120,60,160,.95);font-size:12px}' +
      '#pruef button{padding:5px 9px;border-radius:8px;border:0;' +
      'background:rgba(255,255,255,.2);color:#fff;font:inherit}' +
      '#pruef span{opacity:.85;margin-left:auto}' +
      '#banner{top:34px!important}#fahnen{top:42px!important}' +
      '#banner:not([hidden]) ~ #fahnen{top:calc(var(--banner-h,108px) + 42px)!important}';
    document.head.appendChild(stil);

    document.getElementById('p-fahrt').onclick = function () {
      if (takt) return;
      weg = (window._navi && window._navi.route()) || [];
      if (weg.length < 2) { melde('erst ein Ziel setzen'); return; }
      index = 0;
      takt = setInterval(schritt, 600);
    };
    document.getElementById('p-gps').onclick = function () {
      gpsAus = !gpsAus;
      this.textContent = gpsAus ? 'GPS an' : 'GPS aus';
      melde(gpsAus ? 'GPS stumm' : 'GPS da');
    };
    document.getElementById('p-halt').onclick = function () {
      clearInterval(takt); takt = null; lage.tempo = 0; melden(); melde('steht');
    };
  });
})();
