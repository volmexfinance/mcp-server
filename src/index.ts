#!/usr/bin/env node
/**
 * Volmex Finance MCP server.
 *
 * Exposes the Volmex implied-volatility index datafeed over the Model Context Protocol:
 *
 *   Tools
 *     - get_history      -> GET /v2/history      (OHLCV bars for an index)
 *     - get_symbol_info  -> GET /v2/symbol_info   (available index symbols)
 *
 *   Resources
 *     - https://docs.volmex.finance        (documentation index)
 *     - https://rest-v1.volmex.finance/api (REST API reference)
 *
 * Configuration
 *     - VOLMEX_API_KEY (optional) — sent as the `apikey` query parameter on API
 *       requests. Without it the v2 endpoints operate on the free plan, which
 *       rejects historical ranges (HTTP 400); a key unlocks fuller access.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_BASE = 'https://rest-v1.volmex.finance';
// Trailing slash matches the URL-normalized form used for resource lookup.
const DOCS_URL = 'https://docs.volmex.finance/';
const DOCS_INDEX_URL = 'https://docs.volmex.finance/llms.txt';
const API_DOCS_URL = 'https://rest-v1.volmex.finance/api';

const USER_AGENT = 'volmex-mcp-server/0.1.0';

// Optional API key, supplied by the user via the VOLMEX_API_KEY environment
// variable (set in the MCP client's server config). Sent as an `apikey` query
// parameter on each request. Without it the v2 endpoints run on the free plan,
// which limits the accessible date range.
const API_KEY = process.env.VOLMEX_API_KEY;

/** Fetch JSON from the Volmex API, throwing a readable error on failure. */
async function apiGet(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (API_KEY) {
    url.searchParams.set('apikey', API_KEY);
  }

  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });

  const text = await res.text();
  if (!res.ok) {
    // v2 error bodies look like { statusCode, message }, where message may be a
    // string or an array of strings. Surface it cleanly, falling back to raw text.
    let detail = text;
    try {
      const body = JSON.parse(text);
      if (body?.message) {
        detail = Array.isArray(body.message) ? body.message.join('; ') : String(body.message);
      }
    } catch {
      // Non-JSON error body — keep the raw text.
    }
    throw new Error(`Volmex API ${res.status} ${res.statusText} for ${url.pathname}: ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Volmex API returned non-JSON response for ${url.pathname}: ${text.slice(0, 500)}`);
  }
}

/**
 * The UDF /history and /symbol_info responses use column-oriented parallel
 * arrays. Pivot them into an array of row objects, which is far easier for a
 * model (or a human) to read.
 */
function pivotColumns(payload: Record<string, unknown>, keyField: string): Record<string, unknown>[] {
  const keys = Object.keys(payload).filter((k) => Array.isArray(payload[k]));
  const length = Array.isArray(payload[keyField]) ? (payload[keyField] as unknown[]).length : 0;

  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < length; i++) {
    const row: Record<string, unknown> = {};
    for (const k of keys) {
      row[k] = (payload[k] as unknown[])[i];
    }
    rows.push(row);
  }
  return rows;
}

const server = new McpServer({
  name: 'volmex-mcp-server',
  version: '0.1.0',
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  'get_history',
  {
    title: 'Get index history (OHLCV bars)',
    description:
      'Fetch historical OHLCV bars for a Volmex implied-volatility index from the ' +
      'GET /v2/history endpoint. Returns open/high/low/close values per bar ' +
      'over the requested time range. Symbols include BVIV (Bitcoin 30d), EVIV ' +
      '(Ethereum 30d), and tenor variants like BVIV7D, EVIV90D — call get_symbol_info ' +
      'for the full list.',
    inputSchema: {
      symbol: z.string().describe('Index symbol, e.g. BVIV, EVIV, BVIV7D, EVIV90D.'),
      resolution: z
        .string()
        .describe('Bar resolution. One of "1", "5", "15", "30", "60" (intraday minutes) or "D" (daily).')
        .default('D'),
      from: z.number().int().describe('Start of range, Unix timestamp in seconds.'),
      to: z.number().int().describe('End of range, Unix timestamp in seconds.'),
    },
  },
  async ({ symbol, resolution, from, to }) => {
    const data = await apiGet('/v2/history', {
      symbol,
      resolution,
      from: String(from),
      to: String(to),
    });

    // UDF status codes: "ok", "no_data", "error".
    if (data?.s && data.s !== 'ok') {
      const detail =
        data.s === 'no_data'
          ? `No data for ${symbol} at resolution ${resolution} in the requested range.` +
            (data.nextTime ? ` Next available data at Unix time ${data.nextTime}.` : '')
          : `Volmex history error: ${data.errmsg ?? data.s}`;
      return { content: [{ type: 'text', text: detail }] };
    }

    const bars = pivotColumns(data, 't').map((r) => ({
      time: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ symbol, resolution, from, to, count: bars.length, bars }, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  'get_symbol_info',
  {
    title: 'Get symbol info (available indices)',
    description:
      'List the Volmex implied-volatility indices available from the datafeed via the ' +
      'GET /v2/symbol_info endpoint. Returns each symbol with its description, ' +
      'currency, exchange, and precision metadata.',
    inputSchema: {
      group: z.string().optional().describe('Optional symbol group filter passed through to the UDF endpoint.'),
    },
  },
  async ({ group }) => {
    const params: Record<string, string> = {};
    if (group) params.group = group;

    const data = await apiGet('/v2/symbol_info', params);

    if (data?.s && data.s !== 'ok') {
      return {
        content: [{ type: 'text', text: `Volmex symbol_info error: ${data.errmsg ?? data.s}` }],
      };
    }

    const symbols = pivotColumns(data, 'symbol');
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: symbols.length, symbols }, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/** Fetch a documentation URL and return it as resource text. */
async function fetchText(url: string): Promise<{ text: string; mimeType: string }> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'text/plain';
  return { text, mimeType };
}

server.registerResource(
  'volmex-docs',
  DOCS_URL,
  {
    title: 'Volmex Finance documentation',
    description:
      'Volmex Finance product and data documentation (docs.volmex.finance). Served as ' +
      'the LLM-friendly documentation index (llms.txt) listing the available guides and pages.',
    mimeType: 'text/markdown',
  },
  async (uri) => {
    const { text } = await fetchText(DOCS_INDEX_URL);
    return {
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text }],
    };
  },
);

server.registerResource(
  'volmex-rest-api',
  API_DOCS_URL,
  {
    title: 'Volmex REST API reference',
    description:
      'The Volmex REST API reference hosted at rest-v1.volmex.finance/api — base URL and ' +
      'documentation for the datafeed endpoints.',
    mimeType: 'text/html',
  },
  async (uri) => {
    const { text, mimeType } = await fetchText(API_DOCS_URL);
    return {
      contents: [{ uri: uri.href, mimeType, text }],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP transport channel.
  console.error('volmex-mcp-server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting volmex-mcp-server:', err);
  process.exit(1);
});
