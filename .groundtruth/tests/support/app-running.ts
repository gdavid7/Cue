// Groundtruth's tests run against an app that is already running; they never start it. This stops the
// run with a clear message when it isn't, instead of every test failing with "connection refused".
// Synced into .groundtruth/tests/support/ by Groundtruth; edits there are overwritten.
import fs from "node:fs";
import path from "node:path";

export default async function appRunning() {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, "app.json"), "utf8"));
  const url = `http://localhost:${app.port}${app.ready}`;
  const answered = await fetch(url).then((r) => r.status < 500, () => false);
  if (!answered) {
    throw new Error(`The app isn't running at ${url}. Start it from .groundtruth/app.yml (build, then start) and run the tests again.`);
  }
}
