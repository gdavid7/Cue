import { NextResponse } from "next/server";
import { env } from "@/env";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { withEmailProvider } from "@/utils/middleware";
import {
  isContactPhotoSweepPaused,
  pauseContactPhotoSweep,
} from "@/utils/redis/contact-photos";

export type ContactPhotosResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailProvider(
  "user/contacts/photos",
  async (request) => {
    if (!env.NEXT_PUBLIC_CONTACTS_ENABLED) {
      return NextResponse.json(
        { error: "Contacts API not enabled" },
        { status: 404 },
      );
    }

    const result = await getData({
      emailAccountId: request.auth.emailAccountId,
      emailProvider: request.emailProvider,
      logger: request.logger,
    });

    return NextResponse.json(result);
  },
);

async function getData({
  emailAccountId,
  emailProvider,
  logger,
}: {
  emailAccountId: string;
  emailProvider: Pick<EmailProvider, "getContactPhotos">;
  logger: Logger;
}) {
  // `swept` tells the browser the photos are complete and worth keeping;
  // the server keeps none of them (RD-3).
  if (await isContactPhotoSweepPaused(emailAccountId, logger))
    return { photos: {} as Record<string, string>, swept: false };

  try {
    const photos = await emailProvider.getContactPhotos();
    return { photos, swept: true };
  } catch (error) {
    // Avatars fall back to initials.
    logger.warn("Failed to load contact photos", { error });
    await pauseContactPhotoSweep(emailAccountId, logger);
    return { photos: {} as Record<string, string>, swept: false };
  }
}
