// The front door of Groundtruth's copy of Cue, on the app's port. It forwards everything to Next.js, except
// the Google emulator's sign-in pages, which it serves from the same origin.
//
// Why: in a production build the login page only follows an external sign-in redirect that's https (real
// Google always is), so it refuses the emulator's http://localhost URL and "Continue with Google" just
// reloads /login. CI's browser tests sidestep the button (auth.setup.ts calls the sign-in API directly);
// Groundtruth's verifier signs in like a person, so the emulator's account chooser has to be same-origin.
// The sign-in API's answer gets its emulator URL made relative, and the chooser's pages are proxied here.
// Server-side calls (token exchange, Gmail, Calendar) still go straight to the emulator.
import http from "node:http";

const EMULATOR_PATHS = ["/o/oauth2/", "/_emulate/"];
const SIGN_IN_PATH = "/api/auth/sign-in/social";

export function startFrontProxy({ port, appPort, googleUrl }) {
  const google = new URL(googleUrl);
  const agent = new http.Agent({ keepAlive: true });
  const server = http.createServer((request, response) => {
    const path = request.url ?? "/";
    const toEmulator = EMULATOR_PATHS.some((prefix) => path.startsWith(prefix));
    const target = toEmulator ? { hostname: google.hostname, port: google.port } : { hostname: "127.0.0.1", port: appPort };
    // Plain text, so the sign-in answer can be rewritten.
    const { "accept-encoding": _acceptEncoding, ...plain } = request.headers;
    const headers = path.startsWith(SIGN_IN_PATH) ? plain : request.headers;
    const upstream = http.request(
      { ...target, method: request.method, path, headers, agent },
      (answer) => {
        if (path.startsWith(SIGN_IN_PATH) && /json/.test(answer.headers["content-type"] ?? "")) {
          return relativiseSignIn(answer, response, google.origin);
        }
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  server.listen(port);
  return server;
}

function relativiseSignIn(answer, response, googleOrigin) {
  const chunks = [];
  answer.on("data", (chunk) => chunks.push(chunk));
  answer.on("end", () => {
    const body = Buffer.from(Buffer.concat(chunks).toString("utf8").replaceAll(`${googleOrigin}/o/oauth2/`, "/o/oauth2/"));
    const { "transfer-encoding": _chunked, "content-encoding": _encoding, ...rest } = answer.headers;
    const headers = { ...rest, "content-length": String(body.length) };
    response.writeHead(answer.statusCode ?? 502, headers);
    response.end(body);
  });
}
