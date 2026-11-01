// Thin client for the gateway API (S35). Same-origin only. The CSRF token comes from the sign-in or /api/me answer and is kept in memory,
// never in storage. Every call returns {ok, status, data}; a 401 "no_session" sends the user back to the sign-in screen.

export function createApi(opts = {}) {
  const fetchFn = opts.fetch || ((...a) => fetch(...a));
  let csrf = "";
  const api = {
    setCsrf(t) {
      csrf = t || "";
    },
    async call(path, body, o) {
      let res;
      try {
        res = await fetchFn(path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body || {}), credentials: "same-origin" });
      } catch {
        return { ok: false, status: 0, data: { message: "Cannot reach the server." } };
      }
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (res.status === 401 && data.error === "no_session" && opts.onUnauthorized && !(o && o.quiet)) opts.onUnauthorized();
      return { ok: res.ok, status: res.status, data };
    },
    async get(path, o) {
      let res;
      try {
        res = await fetchFn(path, { credentials: "same-origin" });
      } catch {
        return { ok: false, status: 0, data: { message: "Cannot reach the server." } };
      }
      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (res.status === 401 && data.error === "no_session" && opts.onUnauthorized && !(o && o.quiet)) opts.onUnauthorized();
      return { ok: res.ok, status: res.status, data };
    },
    async state() {
      try {
        const res = await fetchFn("/api/state", { credentials: "same-origin" });
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    },
    /** Follows a thread's run over SSE with fetch, so the Last-Event-ID header can be set. Calls onEvent({id, type, data}). Resolves when the stream ends. */
    async stream(bot, thread, o) {
      const headers = {};
      if (o.last) headers["last-event-id"] = String(o.last);
      let res;
      try {
        res = await fetchFn(`/api/chat/stream?bot=${encodeURIComponent(bot)}&thread=${encodeURIComponent(thread)}`, { headers, credentials: "same-origin", signal: o.signal });
      } catch {
        return { ok: false };
      }
      if (!res.ok || !res.body) return { ok: false };
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        let r;
        try {
          r = await reader.read();
        } catch {
          return { ok: false };
        }
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (\d+)/m.exec(block);
          const type = /^event: (\w+)/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (type && data) {
            try {
              o.onEvent({ id: id ? Number(id[1]) : 0, type: type[1], data: JSON.parse(data[1]) });
            } catch {
              /* a damaged event is skipped */
            }
          }
        }
      }
      return { ok: true };
    },
  };
  return api;
}
