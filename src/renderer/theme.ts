export type WorkbenchTheme = "light" | "dark";

export const theme_storage_key = "gachasimulate.workbench-theme";

export function restore_theme(): WorkbenchTheme {
  let theme: WorkbenchTheme = "light";
  try {
    if (localStorage.getItem(theme_storage_key) === "dark") theme = "dark";
  } catch {
    // Storage may be unavailable; the default theme remains usable.
  }
  document.body.dataset.workbenchTheme = theme;
  return theme;
}

export function save_theme(theme: WorkbenchTheme): boolean {
  document.body.dataset.workbenchTheme = theme;
  try {
    localStorage.setItem(theme_storage_key, theme);
    return true;
  } catch {
    return false;
  }
}
