// Canonical Worker runtime utilities:
// - UTC date keys (YYYY-MM-DD)
// - Bounded streaming HTTP response reading (cancels reader safely, checks content-length & abort signal)
// - Cloudflare Edge Cache (caches.default) helpers with safe waitUntil fallback

export function utcToday(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcDaysAgo(days, now = Date.now()) {
  return new Date(now - days * 86400000).toISOString().slice(0, 10);
}

export async function readBoundedBytes(response, maxBytes, {
  signal,
  failedError = "request_failed",
  tooLargeError = "response_too_large",
  attachStatus = false,
} = {}) {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    const err = new Error(failedError);
    if (attachStatus) err.status = response.status;
    throw err;
  }
  if (Number(response.headers?.get("content-length")) > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error(tooLargeError);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(tooLargeError);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedText(response, maxBytes, options = {}) {
  return new TextDecoder().decode(await readBoundedBytes(response, maxBytes, options));
}

export function edgeCache() {
  return typeof caches !== "undefined" ? caches.default : null;
}

export async function edgeCacheMatch(key) {
  const cache = edgeCache();
  return cache ? cache.match(key) : null;
}

export function edgeCacheJsonResponse(value, ttlSeconds) {
  return Response.json(value, {
    headers: { "Cache-Control": `public, max-age=${Math.max(1, Math.floor(ttlSeconds))}` },
  });
}

export async function edgeCachePut(key, response) {
  const cache = edgeCache();
  if (!cache) return;
  await cache.put(key, response);
}

export function scheduleEdgeCachePut(c, key, response) {
  const cache = edgeCache();
  if (!cache) return;
  let task;
  try {
    task = Promise.resolve(cache.put(key, response)).catch(() => {});
  } catch {
    return;
  }
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    return task;
  }
}
