import type { gmail_v1 } from "@googleapis/gmail";
import type { VacationResponderBody } from "@/utils/actions/vacation-responder.validation";
import { withGmailRetry } from "@/utils/gmail/retry";
import { convertEmailHtmlToText } from "@/utils/mail";

export async function getForwardingAddresses(gmail: gmail_v1.Gmail) {
  const res = await withGmailRetry(() =>
    gmail.users.settings.forwardingAddresses.list({
      userId: "me",
    }),
  );
  return res.data.forwardingAddresses || [];
}

export async function getVacationResponder(
  gmail: gmail_v1.Gmail,
): Promise<VacationResponderBody> {
  const res = await withGmailRetry(() =>
    gmail.users.settings.getVacation({ userId: "me" }),
  );
  return vacationResponderFromGmail(res.data);
}

export async function updateVacationResponder(
  gmail: gmail_v1.Gmail,
  body: VacationResponderBody,
) {
  await withGmailRetry(() =>
    gmail.users.settings.updateVacation({
      userId: "me",
      requestBody: vacationResponderToGmail(body),
    }),
  );
}

export function vacationResponderFromGmail(
  settings: gmail_v1.Schema$VacationSettings,
): VacationResponderBody {
  return {
    enabled: settings.enableAutoReply ?? false,
    subject: settings.responseSubject ?? "",
    message:
      settings.responseBodyPlainText ||
      (settings.responseBodyHtml
        ? convertEmailHtmlToText({ htmlText: settings.responseBodyHtml })
        : ""),
    startTime: settings.startTime ? new Date(Number(settings.startTime)) : null,
    endTime: settings.endTime ? new Date(Number(settings.endTime)) : null,
  };
}

export function vacationResponderToGmail(
  body: VacationResponderBody,
): gmail_v1.Schema$VacationSettings {
  return {
    enableAutoReply: body.enabled,
    responseSubject: body.subject,
    responseBodyPlainText: body.message,
    restrictToContacts: false,
    restrictToDomain: false,
    startTime: body.startTime ? String(body.startTime.getTime()) : null,
    endTime: body.endTime ? String(body.endTime.getTime()) : null,
  };
}
