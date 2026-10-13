import type {
  AutomaticRepliesSetting,
  DateTimeTimeZone,
} from "@microsoft/microsoft-graph-types";
import type { VacationResponderBody } from "@/utils/actions/vacation-responder.validation";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { convertEmailHtmlToText } from "@/utils/mail";
import type { OutlookClient } from "@/utils/outlook/client";
import { withMicrosoftGraphRetry } from "@/utils/outlook/retry";
import { escapeHtml } from "@/utils/string";

export async function getAutomaticReplies(
  client: OutlookClient,
  logger: Logger,
): Promise<VacationResponderBody> {
  const setting: AutomaticRepliesSetting = await withMicrosoftGraphRetry(
    () =>
      client
        .getClient()
        .api("/me/mailboxSettings/automaticRepliesSetting")
        .get(),
    logger,
  );
  return vacationResponderFromOutlook(setting);
}

export async function updateAutomaticReplies(
  client: OutlookClient,
  logger: Logger,
  body: VacationResponderBody,
) {
  const automaticRepliesSetting = vacationResponderToOutlook(body);
  await withMicrosoftGraphRetry(
    () =>
      client
        .getClient()
        .api("/me/mailboxSettings")
        .patch({ automaticRepliesSetting }),
    logger,
  );
}

export function vacationResponderFromOutlook(
  setting: AutomaticRepliesSetting,
): VacationResponderBody {
  const scheduled = setting.status === "scheduled";
  return {
    enabled: setting.status === "alwaysEnabled" || scheduled,
    // Outlook automatic replies reuse the original subject.
    subject: "",
    message: setting.internalReplyMessage
      ? convertEmailHtmlToText({ htmlText: setting.internalReplyMessage })
      : "",
    startTime: scheduled
      ? fromGraphDateTime(setting.scheduledStartDateTime)
      : null,
    endTime: scheduled ? fromGraphDateTime(setting.scheduledEndDateTime) : null,
  };
}

export function vacationResponderToOutlook(
  body: VacationResponderBody,
): AutomaticRepliesSetting {
  const message = escapeHtml(body.message).replace(/\r?\n/g, "<br>");
  const replies: AutomaticRepliesSetting = {
    internalReplyMessage: message,
    externalReplyMessage: message,
    externalAudience: "all",
  };
  if (!body.enabled) return { ...replies, status: "disabled" };
  if (!body.startTime && !body.endTime) {
    return { ...replies, status: "alwaysEnabled" };
  }
  if (!body.endTime) {
    throw new SafeError(
      "Outlook needs a last day to schedule automatic replies",
    );
  }
  return {
    ...replies,
    status: "scheduled",
    scheduledStartDateTime: toGraphDateTime(body.startTime ?? new Date()),
    scheduledEndDateTime: toGraphDateTime(body.endTime),
  };
}

function toGraphDateTime(date: Date): DateTimeTimeZone {
  return { dateTime: date.toISOString().replace("Z", ""), timeZone: "UTC" };
}

function fromGraphDateTime(value: DateTimeTimeZone | null | undefined) {
  if (!value?.dateTime) return null;
  // Graph omits the offset; it is only explicit when the zone is UTC.
  const date = new Date(
    value.timeZone === "UTC" ? `${value.dateTime}Z` : value.dateTime,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}
