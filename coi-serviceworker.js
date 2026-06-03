/*! coi-serviceworker v0.1.7 | MIT License | https://github.com/gzguidoti/coi-serviceworker */
if (typeof window === 'undefined') {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener("fetch", (event) => {
        if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") {
            return;
        }
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response.status === 0) {
                        return response;
                    }
                    const newHeaders = new Headers(response.headers);
                    newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
                    newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
                    return new Response(response.body, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: newHeaders,
                    });
                })
                .catch((e) => {
                    console.error(e);
                })
        );
    });
} else {
    (() => {
        if ("serviceWorker" in navigator) {
            navigator.serviceWorker.register(window.document.currentScript.src)
                .then((registration) => {
                    console.log("COI Service Worker registered with scope: ", registration.scope);
                    registration.addEventListener("updatefound", () => {
                        console.log("COI Service Worker update found, reloading...");
                        window.location.reload();
                    });
                    if (navigator.serviceWorker.controller && !window.crossOriginIsolated) {
                        console.log("COI Service Worker active but headers missing. Reloading...");
                        window.location.reload();
                    }
                })
                .catch((err) => {
                    console.error("COI Service Worker registration failed: ", err);
                });
        }
    })();
}
