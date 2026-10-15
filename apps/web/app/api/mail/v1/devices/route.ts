import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MobilePushPlatform,
  MobilePushTokenType,
} from "@/generated/prisma/enums";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";

const APNS_DEVICE_TOKEN = /^[A-Fa-f0-9]{64,200}$/;

const registerDeviceSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(APNS_DEVICE_TOKEN, "Expected a hex APNs device token"),
  appVersion: z.string().trim().min(1).max(64).optional(),
});

const unregisterDeviceSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(APNS_DEVICE_TOKEN, "Expected a hex APNs device token"),
});

export const POST = withAuth("mail/v1/devices/register", async (request) => {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const device = registerDeviceSchema.parse(json.value);

  // Scoped to this user, so a caller who knows another device's token cannot
  // take over its notifications. On Postgres a token owned by someone else
  // makes the upsert change nothing and return null rather than throw.
  let registered: unknown;
  try {
    registered = await prisma.mobilePushToken.upsert({
      where: { token: device.token, userId: request.auth.userId },
      create: {
        token: device.token,
        platform: MobilePushPlatform.IOS,
        tokenType: MobilePushTokenType.APNS,
        appVersion: device.appVersion ?? null,
        userId: request.auth.userId,
      },
      update: {
        platform: MobilePushPlatform.IOS,
        tokenType: MobilePushTokenType.APNS,
        appVersion: device.appVersion ?? null,
        userId: request.auth.userId,
      },
    });
  } catch (error) {
    if (!isDuplicateError(error, "token")) throw error;
    registered = null;
  }

  if (!registered) {
    return NextResponse.json(
      {
        error: "This device is registered to another account",
        isKnownError: true,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
});

export const DELETE = withAuth(
  "mail/v1/devices/unregister",
  async (request) => {
    const json = await readJsonBody(request);
    if (!json.ok) return json.response;
    const { token } = unregisterDeviceSchema.parse(json.value);

    await prisma.mobilePushToken.deleteMany({
      where: {
        token,
        userId: request.auth.userId,
      },
    });

    return NextResponse.json({ ok: true });
  },
);

async function readJsonBody(
  request: Request,
): Promise<
  { ok: true; value: unknown } | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, value: await request.json() };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Invalid JSON", isKnownError: true },
          { status: 400 },
        ),
      };
    }
    throw error;
  }
}
