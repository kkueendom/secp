const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distServer = path.join(root, "dist", "server");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const news = fs.readFileSync(path.join(root, "news.json"), "utf8");
const whitelist = fs.readFileSync(path.join(root, "whitelist.json"), "utf8");
const changelog = fs.readFileSync(path.join(root, "changelog.json"), "utf8");
const socialCard = fs.readFileSync(path.join(root, "public", "og.png")).toString("base64");

fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
fs.mkdirSync(distServer, { recursive: true });

const worker = `
const PAGE = ${JSON.stringify(html)};
const NEWS = ${JSON.stringify(news)};
const WHITELIST = ${JSON.stringify(whitelist)};
const CHANGELOG = ${JSON.stringify(changelog)};
const SOCIAL_CARD = ${JSON.stringify(socialCard)};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

function response(body, type, request, status = 200, extra = {}) {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: { "Content-Type": type, "Cache-Control": "public, max-age=300", ...securityHeaders, ...extra }
  });
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method)) {
      return response("Method not allowed", "text/plain; charset=utf-8", request, 405, { "Allow": "GET, HEAD" });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const page = PAGE.replaceAll("__OG_IMAGE__", url.origin + "/og.png");
      return response(page, "text/html; charset=utf-8", request);
    }
    if (url.pathname === "/news.json") return response(NEWS, "application/json; charset=utf-8", request);
    if (url.pathname === "/whitelist.json") return response(WHITELIST, "application/json; charset=utf-8", request);
    if (url.pathname === "/changelog.json") return response(CHANGELOG, "application/json; charset=utf-8", request);
    if (url.pathname === "/og.png") return response(decodeBase64(SOCIAL_CARD), "image/png", request, 200, { "Cache-Control": "public, max-age=86400" });
    return response("Not found", "text/plain; charset=utf-8", request, 404);
  }
};
`;

fs.writeFileSync(path.join(distServer, "index.js"), worker, "utf8");
console.log("Sites build created");
