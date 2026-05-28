
const fetch = require("node-fetch");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: "URL required" });

  // Only allow Instagram CDN domains
  const allowed = [
    "cdninstagram.com",
    "instagram.com",
    "fbcdn.net",
    "scontent",
  ];
  const isAllowed = allowed.some((d) => url.includes(d));
  if (!isAllowed) return res.status(403).json({ error: "Domain not allowed" });

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        Referer: "https://www.instagram.com/",
      },
      timeout: 30000,
    });

    if (!response.ok) throw new Error(`Upstream ${response.status}`);

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const ext = contentType.includes("video") ? ".mp4" : ".jpg";
    const dlFilename = filename || `instagram_media${ext}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${dlFilename}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");

    const buffer = await response.buffer();
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ error: "Failed to proxy media: " + err.message });
  }
};
