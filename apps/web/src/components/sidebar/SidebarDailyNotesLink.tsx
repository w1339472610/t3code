import { useLocation, useNavigate } from "@tanstack/react-router";
import { T } from "gt-react";
import { NotebookPenIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useSidebar } from "../ui/sidebar";

/** Opens the daily notes page; sits under the search row at the top of the sidebar. */
export function SidebarDailyNotesLink(props: { readonly shortcutLabel: string | null }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useLocation({ select: (location) => location.pathname === "/notes" });
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "group/notes mt-px flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/70",
        active && "bg-sidebar-row-hover text-sidebar-foreground",
      )}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/notes" });
      }}
    >
      <NotebookPenIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
      <span className="min-w-0 flex-1 truncate">
        <T>Daily notes</T>
      </span>
      {props.shortcutLabel ? (
        <span className="shrink-0 text-xs font-normal text-sidebar-muted-foreground opacity-0 group-hover/notes:opacity-100">
          {props.shortcutLabel}
        </span>
      ) : null}
    </button>
  );
}
