// SemaAfrica file Worker: private uploads and downloads backed by R2.
// Security idea: the Worker never trusts the browser. It forwards the user's Firebase
// login token to Firestore, so Firestore (and your security rules) decide who is who.
const MAX = 25 * 1024 * 1024;
const err = (m, s) => Object.assign(new Error(m), { status: s });
const fsGet = async (env, tok, path) => {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`,
    { headers: tok ? { Authorization: "Bearer " + tok } : {} });
  if (!r.ok) throw err("Not allowed", 403);
  return r.json();
};
const field = (d, k) => d.fields?.[k]?.stringValue || "";
const uidOf = t => {
  const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
  return p.user_id || p.sub;
};

// Does this student own a plan that is active and not expired? (asked with THEIR token, so rules apply)
async function hasActivePlan(env, tok, uid) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`, {
    method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "enrollments" }],
      where: { fieldFilter: { field: { fieldPath: "userId" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 50 } }) });
  if (!r.ok) throw err("Not allowed", 403);
  const now = Date.now();
  return (await r.json()).some(x => {
    const f = x.document && x.document.fields; if (!f) return false;
    const exp = f.expiresAt && f.expiresAt.timestampValue;
    return f.status && f.status.stringValue === "active" && (!exp || Date.parse(exp) > now);
  });
}

async function route(req, env) {
  const tok = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const url = new URL(req.url);

  if (req.method === "PUT" && url.pathname === "/upload") {
    if (!tok) throw err("Log in first", 401);
    const uid = uidOf(tok);
    const me = await fsGet(env, tok, `users/${uid}`);      // fails if the token is fake or expired
    if (field(me, "role") !== "teacher") throw err("Teachers only", 403);
    if (+req.headers.get("Content-Length") > MAX) throw err("File is over 25 MB", 413);
    const name = decodeURIComponent(req.headers.get("X-File-Name") || "file").replace(/[^\w.-]/g, "_").slice(-80);
    const key = `materials/${uid}/${Date.now()}-${name}`;
    await env.BUCKET.put(key, req.body, { httpMetadata: { contentType: req.headers.get("Content-Type") || "application/octet-stream" } });
    return Response.json({ key });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/file/")) {
    if (!tok) throw err("Log in first", 401);
    const uid = uidOf(tok), id = url.pathname.slice(6);
    const doc = await fsGet(env, tok, "materials/" + id);                 // must be readable by this person
    if (field(doc, "teacherId") !== uid) {                                  // not the uploader: only an admin may
      const me = await fsGet(env, tok, `users/${uid}`);
      if (field(me, "role") !== "admin") throw err("Only the teacher who uploaded this file can delete it", 403);
    }
    // Delete the record first (Firestore rules decide), then the stored file
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/materials/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { Authorization: "Bearer " + tok } });
    if (!r.ok) throw err("Not allowed to delete this file", 403);
    const key = field(doc, "fileKey");
    if (key && key.startsWith(`materials/${field(doc, "teacherId")}/`)) await env.BUCKET.delete(key);
    return Response.json({ ok: true });
  }

  if (req.method === "GET" && url.pathname.startsWith("/file/")) {
    const doc = await fsGet(env, tok, "materials/" + url.pathname.slice(6)); // Firestore rules decide who may read (free files need no login)
    // Files shared with "all students" are for people who have a plan (the teacher, admins and free files are exempt)
    const free = doc.fields && doc.fields.free && doc.fields.free.booleanValue === true;
    if (!free && tok && field(doc, "studentId") === "" && field(doc, "teacherId") !== uidOf(tok)) {
      const me = await fsGet(env, tok, `users/${uidOf(tok)}`);
      if (field(me, "role") === "student" && !(await hasActivePlan(env, tok, uidOf(tok)))) throw err("Choose a plan to open this file", 403);
    }
    const key = field(doc, "fileKey");
    if (!key.startsWith(`materials/${field(doc, "teacherId")}/`)) throw err("Not allowed", 403);
    const obj = await env.BUCKET.get(key);
    if (!obj) throw err("File not found", 404);
    return new Response(obj.body, { headers: {
      "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${field(doc, "fileName").replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store" } });
  }
  throw err("Not found", 404);
}

export default {
  async fetch(req, env) {
    const allowed = env.ALLOWED_ORIGINS.split(",").map(s => s.trim());
    const o = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": allowed.includes(o) ? o : allowed[0], Vary: "Origin",
      "Access-Control-Allow-Headers": "Authorization,Content-Type,X-File-Name", "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS" };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    let res;
    try { res = await route(req, env); }
    catch (e) { res = Response.json({ error: e.message }, { status: e.status || 500 }); }
    res = new Response(res.body, res);
    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  }
};
