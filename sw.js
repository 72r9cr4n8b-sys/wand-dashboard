/* Zuhause – Service Worker nur für Erinnerungen (Mitteilungen).
   Er speichert bewusst nichts zwischen, damit neue Versionen des Dashboards sofort ankommen. */
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function(e){
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Zuhause', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icons/icon-192.png',
    data: { url: d.url || './' }
  }));
});

// Antippen öffnet das Dashboard im passenden Bereich
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  var view = url.split('#')[1] || '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    for (var i = 0; i < list.length; i++){
      if ('focus' in list[i]){
        list[i].postMessage({ go: view });
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
