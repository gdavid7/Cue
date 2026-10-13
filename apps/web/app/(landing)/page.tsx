import { redirect } from "next/navigation";
import { auth } from "@/utils/auth";
import { WELCOME_PATH } from "@/utils/config";

// The root is the way into the mail app, not a marketing page.
export default async function RootPage() {
  const session = await auth();
  redirect(session?.user ? WELCOME_PATH : "/login");
}
