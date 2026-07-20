const IMAGE_CACHE = 'sok-images-v1';
const isImg = (u) => u.pathname.toLowerCase().includes('/api/getimageproxy') ||
    /\.(png|jpe?g|webp|gif)$/i.test(u.pathname);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || !isImg(url)) return;
    event.respondWith(
        caches.open(IMAGE_CACHE).then(async (cache) => {
            const hit = await cache.match(event.request);
            if (hit) return hit;
            try {
                const res = await fetch(event.request);
                if (res.ok) cache.put(event.request, res.clone());
                return res;
            } catch {
                return (await cache.match('/img/Logo.png')) || Response.error();
            }
        })
    );
});

self.addEventListener('message', (e) => {
    if (e.data === 'CLEAR_IMAGE_CACHE') caches.delete(IMAGE_CACHE);
});