export type WorkbenchTheme = "light" | "dark" | "system";

export const theme_storage_key = "gachasimulate.workbench-theme";

const dark_scheme = "(prefers-color-scheme: dark)";

function apply_theme(theme: WorkbenchTheme) {
  document.body.dataset.workbenchTheme =
    theme === "system"
      ? window.matchMedia(dark_scheme).matches
        ? "dark"
        : "light"
      : theme;
}

export function watch_theme(theme: WorkbenchTheme) {
  const apply = () => apply_theme(theme);
  apply();
  if (theme === "system") {
    const system_dark = window.matchMedia(dark_scheme);
    system_dark.addEventListener("change", apply);
    return () => system_dark.removeEventListener("change", apply);
  }
}

export function restore_theme(): WorkbenchTheme {
  let theme: WorkbenchTheme = "light";
  try {
    const stored = localStorage.getItem(theme_storage_key);
    if (stored === "dark" || stored === "system") theme = stored;
  } catch {
    // Storage may be unavailable; the default theme remains usable.
  }
  apply_theme(theme);
  return theme;
}

export function save_theme(theme: WorkbenchTheme): boolean {
  try {
    localStorage.setItem(theme_storage_key, theme);
    return true;
  } catch {
    return false;
  }
}
