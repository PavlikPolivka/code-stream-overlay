// Rename the tool by changing these values only.
export const PKG_NAME = "stream-overlay";
export const VERSION = "0.1.0";
export const DEFAULT_PORT = 4747;
export const PORT_ATTEMPTS = 20;
/** Directory inside the real git dir holding everything the tool writes. */
export const STATE_DIR = PKG_NAME;
export const SHARED_CONFIG_FILE = `${PKG_NAME}.json`;
export const ENV_PREFIX = PKG_NAME.toUpperCase().replace(/-/g, "_");
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const WIDGETS = ["now", "timer", "git", "tests", "goals", "commits", "file", "agent", "custom"] as const;
export type WidgetName = (typeof WIDGETS)[number];
