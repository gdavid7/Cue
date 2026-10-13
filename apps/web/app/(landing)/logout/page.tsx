"use client";

import { useEffect } from "react";
import { logOut } from "@/utils/user";
import { Loading } from "@/components/Loading";
import { SignInLayout } from "@/components/layouts/SignInLayout";

export default function LogoutPage() {
  useEffect(() => {
    logOut("/login");
  }, []);

  return (
    <SignInLayout>
      <Loading />
    </SignInLayout>
  );
}
