"""Local HTTP dev server with COOP/COEP headers and RFC 7233 Range support."""

import http.server
import os
import socketserver
import urllib.parse

from scripts.http_range_core import ByteRange, RangeUnsatisfiable, parse_byte_range

DEFAULT_PORT = 8000
CHUNK_SIZE = 64 * 1024


def get_server_port() -> int:
    """Read port from PORT environment variable, falling back to 8000."""
    raw = os.environ.get("PORT", str(DEFAULT_PORT)).strip()
    return int(raw) if raw.isdigit() else DEFAULT_PORT


class RangeCOIHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler serving static assets with COOP/COEP/CORP and HTTP Range."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "application/javascript",
        ".js": "application/javascript",
        ".wasm": "application/wasm",
        ".erofs": "application/octet-stream",
        ".json": "application/json",
    }

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self) -> None:
        self._handle_request(send_body=True)

    def do_HEAD(self) -> None:
        self._handle_request(send_body=False)

    def _handle_request(self, *, send_body: bool) -> None:
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.isfile(path):
            if send_body:
                super().do_GET()
            else:
                super().do_HEAD()
            return

        file_size = os.path.getsize(path)
        range_header = self.headers.get("Range")
        parsed = parse_byte_range(range_header, file_size)

        if isinstance(parsed, RangeUnsatisfiable):
            self.send_response(416, "Range Not Satisfiable")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", parsed.content_range_header)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        ctype = self.guess_type(path)
        stat_res = os.stat(path)

        if isinstance(parsed, ByteRange):
            self.send_response(206, "Partial Content")
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", parsed.content_range_header)
            self.send_header("Content-Length", str(parsed.length))
            self.send_header("Last-Modified", self.date_time_string(stat_res.st_mtime))
            self.end_headers()
            if send_body:
                self._send_file_slice(path, parsed.start, parsed.length)
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(file_size))
        self.send_header("Last-Modified", self.date_time_string(stat_res.st_mtime))
        self.end_headers()
        if send_body:
            self._send_file_slice(path, 0, file_size)

    def _send_file_slice(self, path: str, start: int, length: int) -> None:
        remaining = length
        with open(path, "rb") as fh:
            fh.seek(start)
            while remaining > 0:
                chunk = fh.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    port = get_server_port()
    with ThreadingTCPServer(("127.0.0.1", port), RangeCOIHTTPRequestHandler) as httpd:
        print(
            f"Serving HTTP on http://127.0.0.1:{port} "
            "(COOP/COEP + HTTP Range enabled)..."
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server.")


if __name__ == "__main__":
    main()
