"""Bridge local MCP stdio servers to the dashboard's MCP_ENDPOINT (Python 3.11+).

Usage: python mcp_pipe.py calculator.py
       python mcp_pipe.py -- node /path/to/server.js
       python mcp_pipe.py                 # reads MCP_CONFIG or mcp_config.json
Each configured stdio server has its own WebSocket. Logs never print the endpoint.
"""

import asyncio
import json
import os
import sys
from urllib.parse import urlsplit

from dotenv import load_dotenv
from websockets.asyncio.client import connect

MAX_BYTES = 256 * 1024


def commands():
    args = sys.argv[1:]
    if args and args[0] == "--" and len(args) > 1:
        return [(args[1:], {})]
    if len(args) == 1:
        return [([sys.executable, args[0]], {})]
    if args:
        raise ValueError("Use a Python script, or -- followed by command and arguments")
    with open(os.environ.get("MCP_CONFIG", "mcp_config.json"), encoding="utf-8") as file:
        config = json.load(file)
    result = []
    for server in config["mcpServers"].values():
        if server.get("disabled"):
            continue
        if server.get("transport", "stdio") != "stdio":
            raise ValueError("This pipe supports stdio servers; use an HTTP-to-stdio adapter for HTTP/SSE")
        command = server.get("command")
        arguments = server.get("args", [])
        environment = server.get("env", {})
        if not isinstance(command, str) or not command or not isinstance(arguments, list) or not all(isinstance(arg, str) for arg in arguments):
            raise ValueError("Invalid MCP command/args")
        if not isinstance(environment, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in environment.items()):
            raise ValueError("Invalid MCP environment")
        result.append(([command, *arguments], environment))
    if not result or len(result) > 16:
        raise ValueError("Configure 1–16 stdio MCP servers")
    return result


async def bridge(endpoint, command, environment):
    async with connect(endpoint, max_size=MAX_BYTES, max_queue=16, open_timeout=15,
                       ping_interval=20, ping_timeout=20, compression=None) as socket:
        process = await asyncio.create_subprocess_exec(
            *command, env={**os.environ, **environment}, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=None, limit=MAX_BYTES)

        async def to_server():
            async for frame in socket:
                if not isinstance(frame, str) or "\n" in frame or "\r" in frame:
                    raise ValueError("Expected one text JSON-RPC object per frame")
                process.stdin.write(frame.encode("utf-8") + b"\n")
                await process.stdin.drain()

        async def to_relay():
            while True:
                line = await process.stdout.readline()
                if not line:
                    return
                if len(line) > MAX_BYTES:
                    raise ValueError("MCP frame too large")
                value = json.loads(line)
                if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
                    raise ValueError("MCP stdout must contain only JSON-RPC")
                await socket.send(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

        tasks = [asyncio.create_task(to_server()), asyncio.create_task(to_relay())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    await process.wait()


async def keep_connected(endpoint, command, environment):
    delay = 1
    while True:
        started = asyncio.get_running_loop().time()
        try:
            await bridge(endpoint, command, environment)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Exception strings may include query credentials. Do not log them.
            print("MCP connection ended. Check server stderr, endpoint and dashboard status.", file=sys.stderr)
        if asyncio.get_running_loop().time() - started > 60:
            delay = 1
        print(f"Reconnecting MCP in {delay}s; pending tool calls are not replayed.", file=sys.stderr)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60)


async def main():
    load_dotenv()
    endpoint = os.environ.get("MCP_ENDPOINT", "")
    url = urlsplit(endpoint)
    if url.scheme not in ("ws", "wss") or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("Set MCP_ENDPOINT to the private WebSocket URL copied from the dashboard")
    await asyncio.gather(*(keep_connected(endpoint, command, environment) for command, environment in commands()))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception:
        print("Cannot start MCP pipe. Check MCP_ENDPOINT, command/config and dependencies.", file=sys.stderr)
        sys.exit(1)
