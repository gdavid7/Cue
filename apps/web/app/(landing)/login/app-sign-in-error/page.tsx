import type { Metadata } from "next";
import Link from "next/link";
import { SignInLayout } from "@/components/layouts/SignInLayout";
import { ErrorPage } from "@/components/ErrorPage";
import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/utils/branding";

export const metadata: Metadata = {
  title: "App sign-in didn't finish",
};

export default function AppSignInErrorPage() {
  return (
    <SignInLayout>
      <ErrorPage
        title="App sign-in didn't finish"
        description={`Return to the app and start sign-in again. If you're using ${BRAND_NAME} Desktop and this keeps happening, install the latest version.`}
        button={
          <Button asChild>
            <Link href="/desktop">Get the latest desktop app</Link>
          </Button>
        }
      />
    </SignInLayout>
  );
}
