import { createFileRoute } from "@tanstack/react-router";

import { DailyNotesPage } from "../components/dailyNotes/DailyNotesPage";

export const Route = createFileRoute("/_chat/notes")({
  component: DailyNotesPage,
});
