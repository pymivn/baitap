import http.server
import socketserver

PORT = 8000

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(("127.0.0.1", PORT), MyHTTPRequestHandler) as httpd:
    print(f"Serving HTTP on port {PORT} (http://127.0.0.1:{PORT}) with COOP/COEP headers enabled...")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
