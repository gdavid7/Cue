import { redirectToEmailAccountPath } from "@/utils/account";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectToEmailAccountPath("/home", await searchParams);
}
