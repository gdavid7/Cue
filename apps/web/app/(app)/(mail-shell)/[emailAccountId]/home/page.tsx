import { HomeDashboard } from "@/app/(app)/[emailAccountId]/home/HomeDashboard";

export default function HomePage() {
  return (
    // The mail frame's SidebarInset is already the page's <main>.
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <HomeDashboard />
    </div>
  );
}
