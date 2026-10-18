import englishLocale from "zod/v4/locales/en.js";

// Stands in for zod's `locales` namespace (see `turbopack.resolveAlias` in
// next.config.ts) so the bundle carries only English. zod configures English
// errors from its own `locales/en.js` import, not from this namespace.
export const en = englishLocale;
