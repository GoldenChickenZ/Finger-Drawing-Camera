from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; "
        "base-uri 'none'; "
        "object-src 'none'; "
        "form-action 'none'; "
        "frame-ancestors 'none'; "
        "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; "
        "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com; "
        "img-src 'self' data:; "
        "style-src 'self'; "
        "media-src 'self' blob:; "
        "worker-src 'self' blob:"
    ),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


class SecureStaticHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        super().end_headers()


def run():
    port = 5174
    while True:
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), SecureStaticHandler)
            break
        except OSError:
            port += 1

    print(f"http://127.0.0.1:{port}/")
    server.serve_forever()


if __name__ == "__main__":
    run()
