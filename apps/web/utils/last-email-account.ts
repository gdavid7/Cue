export async function rememberLastEmailAccount(emailAccountId: string) {
  const response = await fetch("/api/user/last-email-account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emailAccountId }),
  });
  if (!response.ok) throw new Error("Could not remember the account");
}
