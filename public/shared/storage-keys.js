// Single Source of Truth for browser localStorage and sessionStorage keys.
// Note: public/shared/navboot.js runs synchronously before ES modules load;
// test-core/architecture.test.js verifies navboot.js stays in sync with these exact keys.

export const LOCAL_KEYS = {
  lang: "pendulum_lang",
  pfBase: "pf_base",
  pfHide: "pf_hide",
  macroLastVisit: "macro_last_visit",
};

export const SESSION_KEYS = {
  ownerSlug: "owner_slug",
  pfUser: "pf_user",
  fbCap: "fb_cap",
  gaiCap: "gai_cap",
  gaiOpen: "gai_open",
  gaiChatPrefix: "gai_chat:",
  boardCachePrefix: "board_cache_",
  pfCachePrefix: "pf_cache_",
};

export const boardCacheKey = (slug) => SESSION_KEYS.boardCachePrefix + slug;
export const pfCacheKey = (user, base) => `${SESSION_KEYS.pfCachePrefix}${user}_${base}`;
export const gaiChatKey = (path) => SESSION_KEYS.gaiChatPrefix + path;
