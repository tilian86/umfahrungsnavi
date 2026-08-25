/* Haelt nur das Geruest vor - Kacheln und Routen kommen immer frisch.
 *
 * Die Versionsnummer MUSS bei jeder Aenderung an den Dateien hochgezaehlt
 * werden, sonst mischt GitHub Pages alte und neue Staende. Sie gehoert
 * zusammen mit den ?v=-Marken in index.html angefasst.
 */
var VERSION = 'un-v5';
var GERUEST = [
  './', './index.html', './app.js?v=5', './stil.css?v=5',
  './verkehr.js?v=5', './pruefstand.js?v=5', './profil/umfahrung.brf',
  './leaflet/leaflet.js?v=5', './leaflet/leaflet.css?v=5',
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

self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url);
  // Alles Fremde (Kacheln, BRouter, Nominatim) laeuft am Cache vorbei.
  if (u.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  // Netz zuerst, Cache als Rueckfall: so ist ein neuer Stand sofort da,
  // und ohne Empfang startet die App trotzdem.
  e.respondWith(
    fetch(e.request).then(function (r) {
      var kopie = r.clone();
      caches.open(VERSION).then(function (c) { c.put(e.request, kopie); });
      return r;
    }).catch(function () { return caches.match(e.request); })
  );
});
