"""Small stdio MCP example; no notification is sent by starting this server."""

from fastmcp import FastMCP

mcp = FastMCP("Calculator")


@mcp.tool()
def calculator(a: float, b: float, operation: str = "add") -> dict:
    """Calculate two numbers. operation: add, subtract, multiply or divide."""
    if operation == "add":
        result = a + b
    elif operation == "subtract":
        result = a - b
    elif operation == "multiply":
        result = a * b
    elif operation == "divide" and b != 0:
        result = a / b
    else:
        raise ValueError("Choose add, subtract, multiply, or divide with a nonzero divisor")
    return {"result": result}


if __name__ == "__main__":
    mcp.run(transport="stdio")
