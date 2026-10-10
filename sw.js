/* Haelt nur das Geruest vor - Kacheln und Routen kommen immer frisch.
 *
 * Die Versionsnummer MUSS bei jeder Aenderung an den Dateien hochgezaehlt
 * werden, sonst mischt GitHub Pages alte und neue Staende. Sie gehoert
 * zusammen mit den ?v=-Marken in index.html angefasst.
 */
var VERSION = 'un-v49';
// Die ?v=-Marke im Geruest MUSS die aus index.html sein - sonst liegt im
// Cache nur eine Fassung unter falschem Namen, und ohne Netz fehlt direkt
// nach einem Update das Skript (weisse Seite). Deshalb aus VERSION abgeleitet.
var V = VERSION.replace('un-v', '');
var GERUEST = [
  './', './index.html', './app.js?v=' + V, './stil.css?v=' + V,
  './verkehr.js?v=' + V, './pruefstand.js?v=' + V, './profil/umfahrung.brf',
  './vendor/maplibre/maplibre-gl.js?v=' + V, './vendor/maplibre/maplibre-gl.css?v=' + V,
  './manifest.json', './icons/Icon-192.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(GERUEST.map(function (u) {
      return c.add(u).catch(function () {});
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (k) {
    return Promise.all(k.filter(function (n) { return n !== VERSION; })
                        .map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

// So lange darf das Netz fuer eine eigene Datei brauchen, dann kommt sie aus
// dem Cache. Ohne Frist hing der Start bei schlechtem Empfang (Funkloch,
// Tiefgarage, ueberlastete Zelle), bis der Abruf aufgab - auf dem iPhone
// bis zu einer Minute weisser Bildschirm.
var FRIST = 3000;

// Eine Seitenadresse mit Anhang (?frisch=v49 nach einem Update, ?key=... im
// Home-Symbol) liegt nach dem Versionswechsel nicht im neuen Cache - ohne
// Netz gab es dann eine Fehlerseite statt der App. Fuer Seitenaufrufe greift
// deshalb das gemerkte Geruest. Skripte bleiben streng bei ihrer ?v=-Fassung.
function ausCache(req) {
  return caches.match(req).then(function (r) {
    if (r || req.mode !== 'navigate') return r;
    return caches.match('./index.html').then(function (i) { return i || caches.match('./'); });
  });
}

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  // Alles Fremde (Kacheln, BRouter, Nominatim) laeuft am Cache vorbei.
  if (u.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  // Netz zuerst, Cache als Rueckfall: so ist ein neuer Stand sofort da,
  // und ohne (oder mit zaehem) Empfang startet die App trotzdem.
  var gemerkt = Promise.resolve();
  var netz = fetch(e.request).then(function (r) {
    // Nur Gutes merken - eine Fehlerseite soll den Stand im Cache nicht
    // ueberschreiben
    if (r.ok) {
      var kopie = r.clone();
      gemerkt = caches.open(VERSION).then(function (c) { return c.put(e.request, kopie); });
    }
    return r;
  });
  // Kommt der Cache zuerst, laeuft der Netzabruf trotzdem zu Ende und
  // frischt den Cache fuer den naechsten Start auf
  e.waitUntil(netz.then(function () { return gemerkt; }).catch(function () {}));
  e.respondWith(new Promise(function (fertig) {
    var erledigt = false;
    function geben(r) { if (!erledigt && r) { erledigt = true; fertig(r); } }
    var uhr = setTimeout(function () { ausCache(e.request).then(geben); }, FRIST);
    netz.then(function (r) { clearTimeout(uhr); geben(r); }, function () {
      clearTimeout(uhr);
      ausCache(e.request).then(function (r) {
        if (r) geben(r);
        else if (!erledigt) { erledigt = true; fertig(Response.error()); }
      });
    });
  }));
});
