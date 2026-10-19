// Gives every mailbox the Slack, Teams and Telegram links its person already
// connected from another of their mailboxes. Connecting and linking a mailbox
// now share these on their own; this sweeps people who connected before that.
// It only adds rows: nothing is deleted, and a disconnected row is left alone.
// A new link copies only direct-message destinations; team-channel routing
// stays with the mailbox it was chosen for.
//
// Dry run: `pnpm --filter inbox-zero-ai exec tsx scripts/share-messaging-channels.ts`
// Apply:   `pnpm --filter inbox-zero-ai exec tsx scripts/share-messaging-channels.ts --apply`

import "dotenv/config";
import { createScopedLogger } from "@/utils/logger";
import { shareChannelsWithMailbox } from "@/utils/messaging/shared-channels";
import prisma from "@/utils/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const logger = createScopedLogger("share-messaging-channels");

  // Mailboxes of people who have a connected channel on some other mailbox.
  const mailboxes = await prisma.emailAccount.findMany({
    where: {
      user: {
        emailAccounts: {
          some: { messagingChannels: { some: { isConnected: true } } },
        },
      },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  let mailboxesChanged = 0;
  let channels = 0;
  for (const mailbox of mailboxes) {
    const shared = await shareChannelsWithMailbox({
      mailbox: { id: mailbox.id },
      dryRun: !apply,
      logger,
    });
    if (shared > 0) mailboxesChanged++;
    channels += shared;
  }

  console.log(
    JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      mailboxesChecked: mailboxes.length,
      mailboxesChanged,
      channels,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
