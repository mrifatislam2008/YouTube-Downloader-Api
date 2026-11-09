const SITE = "https://www.snapyt.app/";
const AJAX_URL = new URL("wp-admin/admin-ajax.php", SITE).toString();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  "Referer": SITE,
  "User-Agent": UA
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function send(res, status, data) {
  return res
    .status(status)
    .setHeader("Access-Control-Allow-Origin", "*")
    .setHeader("Cache-Control", "no-store")
    .json(data);
}

function validateVideoUrl(value) {
  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function validatePreviewUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (url.hostname === "snapyt.app" ||
       url.hostname.endsWith(".snapyt.app"))
    );
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000)
  });
}

async function getNonce() {
  const body = new URLSearchParams({
    action: "vd_fresh_nonce"
  });

  const res = await fetchWithTimeout(AJAX_URL, {
    method: "POST",
    headers: HEADERS,
    body
  });

  if (!res.ok) {
    throw new Error("Nonce request failed: " + res.status);
  }

  const data = await res.json();

  if (!data.success || !data.data?.nonce) {
    throw new Error("Could not get nonce");
  }

  return data.data.nonce;
}

async function submitVideo(videoUrl, nonce) {
  const body = new URLSearchParams({
    action: "process_video_url",
    video_url: videoUrl,
    security: nonce
  });

  const res = await fetchWithTimeout(AJAX_URL, {
    method: "POST",
    headers: HEADERS,
    body
  });

  if (!res.ok) {
    throw new Error("Video submission failed: " + res.status);
  }

  const data = await res.json();

  if (!data.success || !data.data?.redirect) {
    throw new Error(
      "Submit failed: " + JSON.stringify(data)
    );
  }

  return data.data.redirect;
}

async function getPreviewHtml(previewUrl) {
  if (!validatePreviewUrl(previewUrl)) {
    throw new Error("Invalid preview URL");
  }

  let currentUrl = previewUrl;

  for (let i = 0; i <= 3; i++) {
    const res = await fetchWithTimeout(currentUrl, {
      method: "GET",
      headers: {
        "User-Agent": UA,
        "Referer": SITE
      },
      redirect: "manual"
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");

      if (!location || i === 3) {
        throw new Error("Too many preview redirects");
      }

      currentUrl = new URL(location, currentUrl).toString();

      if (!validatePreviewUrl(currentUrl)) {
        throw new Error("External preview redirect blocked");
      }

      continue;
    }

    if (!res.ok) {
      throw new Error("Preview fetch failed: " + res.status);
    }

    return await res.text();
  }

  throw new Error("Preview request failed");
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(
    "\\b" + escaped + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  );

  const match = regex.exec(tag);

  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function decodeEntities(value) {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
    (match, entity) => {
      const key = entity.toLowerCase();

      if (key === "amp") return "&";
      if (key === "quot") return '"';
      if (key === "apos") return "'";
      if (key === "lt") return "<";
      if (key === "gt") return ">";

      if (key.startsWith("#x")) {
        return String.fromCodePoint(parseInt(key.slice(2), 16));
      }

      if (key.startsWith("#")) {
        return String.fromCodePoint(parseInt(key.slice(1), 10));
      }

      return match;
    }
  );
}

function parseFormats(html) {
  const formats = [];
  const seen = new Set();

  const regex = /<option\b[^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const tag = match[0];

    const value = getAttribute(tag, "value");

    if (!value || !/^\d+$/.test(value)) {
      continue;
    }

    const fmt = Number.parseInt(value, 10);

    if (seen.has(fmt)) {
      continue;
    }

    seen.add(fmt);

    const label = getAttribute(tag, "data-label");
    const size = getAttribute(tag, "data-size");
    const kind = getAttribute(tag, "data-kind");
    const force = getAttribute(tag, "data-force");

    formats.push({
      fmt,
      label: label
        ? decodeEntities(label).trim()
        : "Format " + value,

      size: size ? decodeEntities(size) : "",

      kind: kind
        ? decodeEntities(kind)
        : "video+audio",

      download: force
        ? decodeEntities(force)
        : null
    });
  }

  return formats;
}

export default async function handler(req, res) {

  // CORS preflight
  if (req.method === "OPTIONS") {
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    return res.status(204).end();
  }

  // Only GET allowed
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");

    return send(res, 405, {
      success: false,
      error: "Method Not Allowed"
    });
  }

  const videoUrl = req.query.url;

  if (
    typeof videoUrl !== "string" ||
    videoUrl.length > 2048 ||
    !validateVideoUrl(videoUrl)
  ) {
    return send(res, 400, {
      success: false,
      error: "A valid video URL is required"
    });
  }

  try {
    // Step 1: Get nonce
    const nonce = await getNonce();

    // Step 2: Submit video URL
    const previewUrl = await submitVideo(videoUrl, nonce);

    // Step 3: Fetch preview HTML
    const html = await getPreviewHtml(previewUrl);

    // Step 4: Extract formats
    const formats = parseFormats(html);

    if (formats.length === 0) {
      return send(res, 502, {
        success: false,
        error: "No downloadable formats found"
      });
    }

    // Step 5: JSON response
    return send(res, 200, {
      success: true,
      formats
    });

  } catch (error) {
    console.error("SnapYT API Error:", error);

    return send(res, 500, {
      success: false,
      error: error.name === "TimeoutError"
        ? "Upstream request timed out"
        : error.message || "Internal server error"
    });
  }
}
