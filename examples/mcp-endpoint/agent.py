"""Two-way example. Replace agent_echo with your real Hermes/agent integration."""

from fastmcp import FastMCP
from xiaozhi_notify import notify_send

mcp = FastMCP("Example agent")


@mcp.tool()
def agent_echo(message: str) -> dict:
    """Return the caller's message. Demonstrates XiaoZhi calling a local agent tool."""
    return {"message": message}


@mcp.tool()
def agent_notify(title: str, text: str, idempotency_key: str) -> dict:
    """Send an inbox message to the paired XiaoZhi device ONLY when requested.

    Reuse the same idempotency_key and content for retries of the same message.
    A stored receipt confirms persistence, not audible playback.
    """
    return notify_send(title, text, idempotency_key)


if __name__ == "__main__":
    mcp.run(transport="stdio")
