export const ICON_NAMES = [
  "activity",
  "arrow-left-right",
  "arrow-right",
  "calendar-clock",
  "calendar-plus",
  "chevron-down",
  "circle-check",
  "circle-plus",
  "circle-user-round",
  "eye",
  "pencil",
  "rotate-ccw",
  "save",
  "trash-2",
  "user-round-check",
  "user-round-plus",
  "users",
  "x",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const ICON_NAME_SET = new Set<string>(ICON_NAMES);

export function isIconName(value: string): value is IconName {
  return ICON_NAME_SET.has(value);
}
