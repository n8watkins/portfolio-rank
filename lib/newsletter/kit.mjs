// Kit (kit.com, formerly ConvertKit), which keeps the blog newsletter's list
// and sends it (AUTOMATION.md "Newsletter"). Its V4 API, three calls:
//
//   subscribe       a sign-up: the address is created as an "inactive"
//                   subscriber and added to our double opt-in form, so Kit
//                   sends its own confirm email and only a confirmed
//                   address ever gets a post. Kit handles unsubscribes,
//                   bounces and complaints itself.
//   onlyForm        the sign-up form when the account has exactly one (so
//                   KIT_FORM_ID is needed only once there are several).
//   confirmedCount  how many confirmed (active) subscribers there are.
//   createBroadcast a post's email, scheduled to everyone (send_at a few
//                   minutes ahead; the V4 API has no "send now") or saved as
//                   a draft (send_at null) for the owner to send from Kit.
//
// Only the API key authenticates (header X-Kit-Api-Key); it is a Worker
// secret (KIT_API_KEY) and never in code or logs. KIT_TEST_API points the
// client at a mock in tests. Every call times out after 10 seconds.

export const KIT_API = "https://api.kit.com/v4";
const TIMEOUT_MS = 10_000;

export class KitError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.name = "KitError";
    this.status = status;
  }
}

/**
 * A Kit V4 client, or null without an API key.
 * @param {{ apiKey?: string | null, base?: string | null, fetch?: typeof fetch }} o
 */
export function kitClient({ apiKey, base, fetch: f = globalThis.fetch } = {}) {
  const key = String(apiKey ?? "").trim();
  if (!key) return null;
  const root = String(base || KIT_API).replace(/\/$/, "");

  async function call(method, path, body) {
    const res = await f(`${root}${path}`, {
      method,
      headers: { "X-Kit-Api-Key": key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      // Kit's errors are { errors: [string] }; never echo anything else (no addresses in logs).
      const why = Array.isArray(data?.errors) ? data.errors.map(String).join("; ") : "";
      throw new KitError(`kit ${method} ${path.split("?")[0].replace(/\d+/g, ":id")} ${res.status}${why ? `: ${why}` : ""}`.replace(/[^\s@]+@[^\s@]+/g, "[email]").slice(0, 300), res.status);
    }
    return data;
  }

  return {
    /**
     * Signs an address up through the double opt-in form. Kit sends the
     * confirm email when the address is new to the form; an address already
     * on it (confirmed or not) gets nothing new.
     * @param {string} email @param {{ formId: string | number, referrer?: string | null }} o
     */
    async subscribe(email, { formId, referrer = null }) {
      if (!/^\d+$/.test(String(formId ?? ""))) throw new KitError("kit form id missing", 0);
      await call("POST", "/subscribers", { email_address: email, state: "inactive" });
      await call("POST", `/forms/${formId}/subscribers`, { email_address: email, ...(referrer ? { referrer } : {}) });
      return { ok: true };
    },

    /** The account's one active form's id, or null when it has none or several (then KIT_FORM_ID must say which). */
    async onlyForm() {
      const data = await call("GET", "/forms?status=active&per_page=2");
      const forms = Array.isArray(data?.forms) ? data.forms : [];
      return forms.length === 1 && forms[0]?.id != null ? String(forms[0].id) : null;
    },

    /** Confirmed (active) subscribers. */
    async confirmedCount() {
      const data = await call("GET", "/subscribers?status=active&include_total_count=true&per_page=1");
      const n = Number(data?.pagination?.total_count ?? data?.total_count);
      if (!Number.isFinite(n)) throw new KitError("kit subscriber count missing", 0);
      return n;
    },

    /**
     * A broadcast to every subscriber: scheduled at `sendAt` (ISO) or, with
     * sendAt null, a draft. Returns { id, sendAt }.
     * @param {{ subject: string, content: string, previewText?: string, description?: string, sendAt: string | null, thumbnailUrl?: string | null, thumbnailAlt?: string | null }} b
     */
    async createBroadcast({ subject, content, previewText = "", description = "", sendAt, thumbnailUrl = null, thumbnailAlt = null }) {
      const data = await call("POST", "/broadcasts", {
        subject,
        content,
        preview_text: previewText,
        description,
        public: false,
        send_at: sendAt,
        ...(thumbnailUrl ? { thumbnail_url: thumbnailUrl, thumbnail_alt: thumbnailAlt ?? "" } : {}),
        // No subscriber_filter: Kit sends to every subscriber without one.
      });
      const b = data?.broadcast ?? data;
      if (!b?.id) throw new KitError("kit broadcast id missing", 0);
      return { id: String(b.id), sendAt: b.send_at ?? null };
    },
  };
}
