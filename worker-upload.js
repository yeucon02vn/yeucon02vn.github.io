// Cloudflare Worker: bridge for uploading files -> GitHub Releases,
// plus entry-password check.
// Deploy: Cloudflare Dashboard > Workers > Create > paste this file > Deploy,
// then Settings > Variables > add 4 Secrets:
//   GH_REPO          = yeucon02vn/yeucon02vn.github.io
//   GH_TOKEN         = token with Contents read+write permission for the repo above
//   UPLOAD_PASSWORD  = self-chosen upload password
//   APP_PASSWORD     = gate password checked when entering the site

function json(o, status, cors) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "x-password, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const isUpload = req.method === "POST" && url.pathname === "/upload";
    const isVerify = req.method === "POST" && url.pathname === "/verify";
    if (!isUpload && !isVerify) return json({ error: "not found" }, 404, cors);

    // ---- Gate: check entry password against APP_PASSWORD ----
    if (isVerify) {
      let body = {};
      try { body = await req.json(); } catch (e) {}
      if (!env.APP_PASSWORD || body.password !== env.APP_PASSWORD)
        return json({ ok: false }, 200, cors);
      return json({ ok: true }, 200, cors);
    }

    if (req.headers.get("x-password") !== env.UPLOAD_PASSWORD)
      return json({ error: "Sai mật khẩu upload" }, 401, cors);

    const parts = String(env.GH_REPO || "").split("/");
    if (parts.length !== 2 || !env.GH_TOKEN)
      return json({ error: "Worker chưa cấu hình GH_REPO/GH_TOKEN" }, 500, cors);
    const [owner, repo] = parts;

    const gh = (path, opts = {}) =>
      fetch("https://api.github.com" + path, {
        ...opts,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + env.GH_TOKEN,
          "User-Agent": "autotool-uploader",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(opts.headers || {}),
        },
      });

    // ---- Upload: tu tao 1 Release theo ten file ----
    const name = (url.searchParams.get("name") || "file.bin").slice(0, 200);
    const tag =
      "file-" +
        (name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "file");

    let rel;
    const got = await gh(`/repos/${owner}/${repo}/releases/tags/${tag}`);
    if (got.ok) {
      rel = await got.json();
    } else {
      const cr = await gh(`/repos/${owner}/${repo}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag_name: tag, name }),
      });
      if (!cr.ok) {
        const detail = await cr.text();
        return json({ error: "Cannot create release (" + cr.status + "): " + detail.slice(0, 200) }, 502, cors);
      }
      rel = await cr.json();
    }

    // Xoa ban trung ten truoc (neu co) de chi can upload 1 lan duy nhat,
    // roi stream file thang sang GitHub (khong doc het vao RAM).
    const lr = await gh(`/repos/${owner}/${repo}/releases/${rel.id}/assets?per_page=100`);
    const assets = lr.ok ? await lr.json() : [];
    const same = assets.find((a) => a.name === name);
    if (same) await gh(`/repos/${owner}/${repo}/releases/assets/${same.id}`, { method: "DELETE" });

    const contentLength = req.headers.get("content-length");
    const up = await fetch(rel.upload_url.split("{")[0] + "?name=" + encodeURIComponent(name), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.GH_TOKEN,
        "Content-Type": "application/octet-stream",
        ...(contentLength ? { "Content-Length": contentLength } : {}),
      },
      body: req.body,
    });
    if (!up.ok) return json({ error: "Upload thất bại (" + up.status + ")" }, 502, cors);
    const asset = await up.json();
    return json({ ok: true, url: asset.browser_download_url, name: asset.name }, 200, cors);
  },
};
