const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const SLUG_RE = /^[a-z0-9-]{3,32}$/;
export function validateUsername(s) { return typeof s === "string" && USERNAME_RE.test(s); }
export function validateSlug(s) { return typeof s === "string" && SLUG_RE.test(s); }
export function rowToUser(r) {
  return { id: r.id, username: r.username, boardSlug: r.board_slug, boardName: r.board_name, createdAt: r.created_at };
}
