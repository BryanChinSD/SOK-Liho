// Registers the image-caching service worker (runs once on import)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('✅ Image SW registered, scope:', reg.scope))
        .catch(err => console.warn('⚠️ Image SW registration failed:', err.message));
} else {
    console.warn('⚠️ ServiceWorker unsupported — images use HTTP cache only');
}

// Purge locally stored image bytes (call when menu/images change)
export function clearLocalImageCache() {
    navigator.serviceWorker?.controller?.postMessage('CLEAR_IMAGE_CACHE');
    console.log('🗑️ Local image cache purge requested');
}