export const maxDuration = 300;

// Vercel keeps a queue consumer private only while vercel.json declares its
// trigger. The "resend-inbox-health" trigger is off, so a consumer here would
// accept forged messages from anyone. Restore the trigger and consumer together.
export function POST() {
  return new Response(null, { status: 404 });
}
