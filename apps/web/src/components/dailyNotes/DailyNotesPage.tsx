import { SidebarInset } from "~/components/ui/sidebar";
import { DailyNotesView } from "./DailyNotesView";

export function DailyNotesPage() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <DailyNotesView variant="page" />
      </div>
    </SidebarInset>
  );
}
