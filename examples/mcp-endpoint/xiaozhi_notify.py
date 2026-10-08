"""Send an inbox message using only the dashboard's MCP_ENDPOINT.

Import notify_send(title, text, idempotency_key), or run this file with CLI flags.
Standard MCP stdio servers use this HTTP helper for agent-initiated messages.
"""

import argparse
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward the bearer credential to another address.


def notify_send(title: str, text: str, idempotency_key: str) -> dict:
    """No automatic retries. Retain the same key AND content if outcome is unknown."""
    endpoint = urlsplit(os.environ.get("MCP_ENDPOINT", ""))
    suffix = "/mcp_endpoint/mcp/"
    endpoint_path = endpoint.path.rstrip("/") + "/"
    tokens = parse_qs(endpoint.query).get("token", [])
    if (endpoint.scheme not in ("ws", "wss") or not endpoint.hostname or endpoint.username or
            endpoint.password or endpoint.fragment or not endpoint_path.endswith(suffix) or
            len(tokens) != 1 or not re.fullmatch(r"[0-9a-f]{64}", tokens[0])):
        raise ValueError("Copy MCP_ENDPOINT from the dashboard before sending notifications")
    if not isinstance(title, str) or not isinstance(text, str) or not text.strip() or not isinstance(idempotency_key, str) or not idempotency_key.strip():
        raise ValueError("title, text and a stable idempotency_key are required")
    target = urlunsplit(("https" if endpoint.scheme == "wss" else "http", endpoint.netloc,
                         endpoint_path[:-len(suffix)] + "/api/notifications", "", ""))
    body = json.dumps({"title": title, "text": text, "idempotency_key": idempotency_key}, ensure_ascii=False).encode("utf-8")
    if len(body) > 16384:
        raise ValueError("Notification too large")
    request = Request(target, data=body, method="POST", headers={
        "Authorization": "Bearer " + tokens[0], "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError("Receipt too large")
        receipt = json.loads(raw)
        if not isinstance(receipt, dict) or receipt.get("stored") is not True:
            raise ValueError("No confirmed stored receipt")
        return receipt
    except HTTPError as error:
        # Do not expose response bodies, headers, credentials or exception URLs.
        raise RuntimeError(f"Notification HTTP {error.code}; check inbox/status before retrying with the same key and content") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise RuntimeError("Notification outcome unknown; check inbox before retrying with the same key and content") from None


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Send to the device paired with MCP_ENDPOINT")
    parser.add_argument("--title", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--idempotency-key", required=True)
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
        load_dotenv()
        print(json.dumps(notify_send(args.title, args.text, args.idempotency_key), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
