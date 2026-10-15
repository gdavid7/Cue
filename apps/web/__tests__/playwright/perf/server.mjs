import { createServer } from "node:net";
import { createEmulator } from "emulate";
import { createQuotaProxy } from "../mail-simulation/quota-proxy.mjs";

// A realistic mailbox for the opt-in performance measurement: a few thousand
// messages across short notes, conversations and newsletter-sized HTML, so the
// list, local database and search are exercised at a believable size.
const port = Number(process.argv[2]);
const email = process.env.PLAYWRIGHT_TEST_EMAIL;
if (!email || !port)
  throw new Error("Perf mailbox requires a port and PLAYWRIGHT_TEST_EMAIL");
const threadCount = Number(process.env.PERF_THREADS ?? 1500);
const latencyMs = Number(process.env.PERF_PROVIDER_LATENCY_MS ?? 120);
const topics = ["invoice", "meeting", "launch", "travel", "hiring", "report"];
const senders = [
  "Avery Stone <avery@example.com>",
  "Blake Rivera <blake@example.org>",
  "Casey Lin <casey@example.net>",
  "Devon Park <devon@example.com>",
  "Emery Shah <emery@example.org>",
  "Finley Ortiz <finley@example.net>",
];
const paragraph =
  "<p>Quarterly numbers, the agenda for next week, and a few links to the documents we discussed. Let me know what you think before Friday.</p>";
const messages = [];
const now = Date.now();
// The newest conversation is read, unstarred and never replied to, so every
// other view (Unread, Starred, Sent) opens on a different first row.
for (let thread = 0; thread < threadCount; thread++) {
  const count = thread % 2 === 1 ? 3 : 1;
  const topic = topics[thread % topics.length];
  const sender = senders[thread % senders.length];
  for (let message = 0; message < count; message++) {
    const fromUser = count > 1 && message === 1;
    const marker = `Perf body ${thread} message ${message}`;
    const labels = ["INBOX"];
    if (thread % 3 === 1) labels.push("UNREAD");
    if (thread % 20 === 5) labels.push("STARRED");
    if (fromUser) labels.push("SENT");
    messages.push({
      id: `perf_${thread}_${message}`,
      thread_id: `perf_thread_${thread}`,
      user_email: email,
      from: fromUser ? email : sender,
      to: fromUser ? sender : email,
      subject: `${message ? "Re: " : ""}Perf ${topic} ${String(thread).padStart(4, "0")}`,
      body_text: `${marker}. ${topic} update.`,
      body_html: `<div><p>${marker}</p><p>${topic} update.</p>${paragraph.repeat(thread % 10 === 1 ? 400 : 6)}</div>`,
      label_ids: labels,
      internal_date: String(
        now - thread * 20 * 60_000 - (count - message) * 60_000,
      ),
    });
  }
}
const allocator = createServer();
await new Promise((resolve) => allocator.listen(0, "127.0.0.1", resolve));
const upstreamPort = allocator.address().port;
await new Promise((resolve) => allocator.close(resolve));
const emulator = await createEmulator({
  service: "google",
  port: upstreamPort,
  baseUrl: `http://127.0.0.1:${port}`,
  seed: {
    google: {
      users: [{ email, name: "Perf User" }],
      oauth_clients: [
        {
          client_id: "client_id",
          client_secret: "client_secret",
          redirect_uris: [
            new URL(
              "/api/auth/callback/google",
              process.env.NEXT_PUBLIC_BASE_URL,
            ).href,
          ],
        },
      ],
      messages,
    },
  },
});
const proxy = await createQuotaProxy({
  upstream: `http://127.0.0.1:${upstreamPort}`,
  port,
  options: {
    latencyMs,
    userUnits: 10_000_000,
    projectUnits: 10_000_000,
    concurrency: 100,
    bytesPerSecond: 20_000_000,
  },
});
console.log(
  `Perf mailbox ready at ${proxy.url}; ${messages.length} messages in ${threadCount} threads`,
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();
    for (const close of [() => proxy.close(), () => emulator.close()]) {
      try {
        await close();
      } catch (error) {
        console.error("Perf mailbox shutdown failed", error);
      }
    }
    process.exit(0);
  });
