import { create } from "zustand";

export interface MentionPickerState {
  /** mention: `@` lists threads; slash: `/` lists line types. */
  readonly kind: "mention" | "slash";
  readonly date: string;
  readonly nodeId: string;
  /** Model offset of the `@` or `/`. */
  readonly start: number;
  readonly query: string;
  readonly left: number;
  readonly top: number;
  readonly highlighted: number;
}

export const useMentionPickerStore = create<{ readonly picker: MentionPickerState | null }>(() => ({
  picker: null,
}));

export function openMentionPicker(next: Omit<MentionPickerState, "highlighted">) {
  const current = useMentionPickerStore.getState().picker;
  const highlighted =
    current && current.nodeId === next.nodeId && current.query === next.query
      ? current.highlighted
      : 0;
  useMentionPickerStore.setState({ picker: { ...next, highlighted } });
}

export function closeMentionPicker() {
  if (useMentionPickerStore.getState().picker !== null) {
    useMentionPickerStore.setState({ picker: null });
  }
}

export function moveMentionHighlight(delta: number, count: number) {
  const picker = useMentionPickerStore.getState().picker;
  if (!picker || count === 0) return;
  useMentionPickerStore.setState({
    picker: { ...picker, highlighted: (picker.highlighted + delta + count) % count },
  });
}
