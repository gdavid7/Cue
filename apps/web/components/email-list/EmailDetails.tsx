import { PersonCardTrigger } from "@/components/person-card/PersonCard";
import type { ThreadMessage } from "@/components/email-list/types";
import {
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";

export function EmailDetails({ message }: { message: ThreadMessage }) {
  const headers = message.headers;

  const details = [
    { label: "From", value: headers?.from },
    { label: "To", value: headers?.to },
    { label: "Cc", value: headers?.cc },
    { label: "Bcc", value: headers?.bcc },
  ];

  return (
    <div className="mb-4 text-xs leading-relaxed">
      <div className="grid gap-1">
        {details.map(
          ({ label, value }) =>
            value && (
              <div
                key={label}
                className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2"
              >
                <span className="text-muted-foreground">{label}</span>
                <span className="break-words text-foreground">
                  {splitRecipientList(value).map((participant, index) => (
                    <span key={`${index}:${participant}`}>
                      {index > 0 && ", "}
                      <PersonCardTrigger
                        className="inline break-words hover:underline"
                        email={extractEmailAddress(participant)}
                        name={extractNameFromEmail(participant)}
                      >
                        {participant}
                      </PersonCardTrigger>
                    </span>
                  ))}
                </span>
              </div>
            ),
        )}
      </div>
      <div className="mt-1 text-muted-foreground">
        {new Date(headers?.date ?? message.date).toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "short",
        })}
      </div>
    </div>
  );
}
