from __future__ import annotations

import argparse
import http.server
import pathlib
import socket
import socketserver


def collect_local_ips() -> list[str]:
    candidates = set()
    hostname = socket.gethostname()

    try:
        for item in socket.gethostbyname_ex(hostname)[2]:
            if "." in item and not item.startswith("127."):
                candidates.add(item)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip_address = sock.getsockname()[0]
            if "." in ip_address and not ip_address.startswith("127."):
                candidates.add(ip_address)
    except OSError:
        pass

    return sorted(candidates)


def main() -> None:
    parser = argparse.ArgumentParser(description="段取りノートのローカル確認用サーバー")
    parser.add_argument("--port", type=int, default=4173, help="待ち受けポート番号")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parent
    handler = http.server.SimpleHTTPRequestHandler

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    with ReusableTCPServer(("0.0.0.0", args.port), handler) as httpd:
        print("Serving 段取りノート")
        print(f"Folder: {root}")
        print(f"Local:  http://127.0.0.1:{args.port}")
        for ip_address in collect_local_ips():
            print(f"iPhone: http://{ip_address}:{args.port}")
        print("Stop with Ctrl+C")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
