/* Haelt nur das Geruest vor - Kacheln und Routen kommen immer frisch.
 *
 * Die Versionsnummer MUSS bei jeder Aenderung an den Dateien hochgezaehlt
 * werden, sonst mischt GitHub Pages alte und neue Staende. Sie gehoert
 * zusammen mit den ?v=-Marken in index.html angefasst.
 */
var VERSION = 'un-v41';
var GERUEST = [
  './', './index.html', './app.js?v=37', './stil.css?v=37',
  './verkehr.js?v=37', './pruefstand.js?v=37', './profil/umfahrung.brf',
  './vendor/maplibre/maplibre-gl.js?v=37', './vendor/maplibre/maplibre-gl.css?v=37',
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
    var uhr = setTimeout(function () { caches.match(e.request).then(geben); }, FRIST);
    netz.then(function (r) { clearTimeout(uhr); geben(r); }, function () {
      clearTimeout(uhr);
      caches.match(e.request).then(function (r) {
        if (r) geben(r);
        else if (!erledigt) { erledigt = true; fertig(Response.error()); }
      });
    });
  }));
});
