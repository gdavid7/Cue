import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Exa's API, in the spirit of the Composio emulator next
 * to it. It answers only what Cue calls: `/contents` for pages an email links
 * to, and `/search` for web searches, both from pages the caller seeds.
 *
 * Fidelity caveat: search is a scripted lookup (the first rule whose pattern
 * matches the query), not ranking, so this catches regressions in Cue's own
 * code, not differences in what the real Exa would return.
 */

const DEFAULT_API_KEY = "emulator-exa-key";

export type ExaEmulatorPage = {
  url: string;
  title: string;
  text: string;
  publishedDate?: string;
};

export interface ExaEmulatorOptions {
  apiKey?: string;
  /** Pages `/contents` can read, by URL. */
  pages?: ExaEmulatorPage[];
  port?: number;
  /** `/search` answers with the results of the first rule matching the query. */
  searches?: { match: RegExp; results: ExaEmulatorPage[] }[];
}

export interface ExaEmulator {
  apiKey: string;
  close(): Promise<void>;
  /** The base URL, for `EXA_API_URL`. */
  url: string;
}

type RequestBody = {
  urls?: string[];
  query?: string;
  numResults?: number;
  startPublishedDate?: string;
  text?: { maxCharacters?: number };
  contents?: { text?: { maxCharacters?: number } };
};

export async function createExaEmulator(
  options: ExaEmulatorOptions = {},
): Promise<ExaEmulator> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const pages = new Map((options.pages ?? []).map((p) => [p.url, p]));
  const searches = options.searches ?? [];

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      respondJson(response, 500, { error: String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? "/", "http://exa.emulator").pathname;
    const raw = await readBody(request);
    const body: RequestBody = raw ? JSON.parse(raw) : {};

    if (path === "/health") return respondJson(response, 200, { ok: true });

    if (request.headers["x-api-key"] !== apiKey) {
      return respondJson(response, 401, { error: "Invalid API key" });
    }

    if (path === "/contents" && request.method === "POST") {
      const urls = body.urls ?? [];
      const max = body.text?.maxCharacters;
      return respondJson(response, 200, {
        requestId: "emulated",
        results: urls
          .map((url) => pages.get(url))
          .filter((page) => page !== undefined)
          .map((page) => withText(page, max)),
        statuses: urls.map((url) =>
          pages.has(url)
            ? { id: url, status: "success", source: "cached" }
            : {
                id: url,
                status: "error",
                error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
              },
        ),
      });
    }

    if (path === "/search" && request.method === "POST") {
      const query = body.query ?? "";
      const since = body.startPublishedDate
        ? Date.parse(body.startPublishedDate)
        : null;
      const results = (searches.find((s) => s.match.test(query))?.results ?? [])
        .filter(
          (page) =>
            since === null ||
            (page.publishedDate && Date.parse(page.publishedDate) >= since),
        )
        .slice(0, body.numResults ?? 10)
        .map((page) => withText(page, body.contents?.text?.maxCharacters));
      return respondJson(response, 200, { requestId: "emulated", results });
    }

    return respondJson(response, 404, {
      error: `The Exa emulator does not implement ${request.method} ${path}`,
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    apiKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${port}`,
  };
}

function withText(page: ExaEmulatorPage, maxCharacters?: number) {
  return { ...page, text: page.text.slice(0, maxCharacters) };
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
