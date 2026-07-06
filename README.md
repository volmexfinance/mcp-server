# Volmex MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the
[Volmex Finance](https://volmex.finance) implied-volatility index datafeed to
MCP-compatible clients (Claude Code, Claude Desktop, etc.).

It wraps the Volmex TradingView-UDF REST API — specifically the `/history` and
`/symbol_info` endpoints — as tools, and registers the Volmex docs and REST API
reference as resources.

## Capabilities

### Tools

| Tool | Endpoint | Description |
| --- | --- | --- |
| `get_history` | `GET /public/history` | Historical OHLCV bars for an index over a time range. |
| `get_symbol_info` | `GET /public/symbol_info` | The list of available index symbols and their metadata. |

`get_history` parameters:

- `symbol` (string, required) — e.g. `BVIV`, `EVIV`, `BVIV7D`, `EVIV90D`
- `resolution` (string, default `D`) — intraday minutes as a number (`1`, `5`, `60`), or `D` / `W`
- `from` (int, required) — start of range, Unix seconds
- `to` (int, required) — end of range, Unix seconds

`get_symbol_info` parameters:

- `group` (string, optional) — symbol group filter passed through to the endpoint

Both tools pivot the UDF column-oriented response (parallel arrays) into an
array of row objects for readability.

### Resources

| Resource | URI | Content |
| --- | --- | --- |
| Volmex documentation | `https://docs.volmex.finance/` | LLM-friendly docs index (`llms.txt`). |
| Volmex REST API reference | `https://rest-v1.volmex.finance/api` | REST API reference page. |

Base API URL: `https://rest-v1.volmex.finance`

## Setup

```bash
npm install
npm run build
```

## Run

```bash
npm start          # runs dist/index.js over stdio
# or during development:
npm run dev        # tsc --watch
```

The server communicates over stdio; it is meant to be launched by an MCP client
rather than run interactively.

## Register with an MCP client

### Claude Code

```bash
claude mcp add volmex -- node /absolute/path/to/mcp-server/dist/index.js
```

### Claude Desktop / generic `mcpServers` config

```json
{
  "mcpServers": {
    "volmex": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

## Example

```
get_symbol_info {}
get_history { "symbol": "BVIV", "resolution": "D", "from": 1704067200, "to": 1704326400 }
```

Common symbols: `BVIV` (Bitcoin 30d IV), `EVIV` (Ethereum 30d IV), `SVIV`
(Solana), `XVIV` (XRP), plus tenor variants (`…1D`, `7D`, `14D`, `60D`, `90D`,
`120D`, `180D`). Call `get_symbol_info` for the authoritative list.
