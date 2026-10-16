// Chat searches across accounts hand the model ids for other accounts'
// emails that carry their account, so a later readEmail reads the right
// mailbox and a write tool can tell the email is not in the chat's account.
// The account is still checked against the signed-in user on every use.
const PREFIX = "acct:";

export function toOtherAccountEmailId(emailAccountId: string, id: string) {
  return `${PREFIX}${emailAccountId}:${id}`;
}

export function parseOtherAccountEmailId(value: string) {
  if (!value.startsWith(PREFIX)) return null;
  const rest = value.slice(PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    emailAccountId: rest.slice(0, separator),
    id: rest.slice(separator + 1),
  };
}
