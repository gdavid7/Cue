import { HomeDashboard } from "@/app/(app)/[emailAccountId]/home/HomeDashboard";
import { MailFrame } from "@/app/(app)/[emailAccountId]/mail/MailFrame";

export default function HomePage() {
  return (
    <MailFrame activeType="today">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <HomeDashboard />
      </main>
    </MailFrame>
  );
}
