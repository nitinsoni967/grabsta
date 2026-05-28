
const fetch = require("node-fetch");

// Extract shortcode from various Instagram URL formats
function extractShortcode(url) {
  const patterns = [
    /instagram\.com\/p\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reel\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reels\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/tv\/([A-Za-z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Parse media nodes from Instagram's embedded JSON
function parseMediaFromJson(jsonData) {
  try {
    const items = [];
    const root =
      jsonData?.items?.[0] ||
      jsonData?.graphql?.shortcode_media ||
      jsonData?.data?.shortcode_media ||
      jsonData?.item;

    if (!root) return null;

    const caption =
      root?.caption?.text ||
      root?.edge_media_to_caption?.edges?.[0]?.node?.text ||
      "";

    const username =
      root?.user?.username ||
      root?.owner?.username ||
      root?.owner?.username ||
      "unknown";

    // Carousel / sidecar
    const sidecar =
      root?.carousel_media ||
      root?.edge_sidecar_to_children?.edges;

    if (sidecar && sidecar.length > 0) {
      for (const edge of sidecar) {
        const node = edge?.node || edge;
        if (node?.video_versions || node?.is_video || node?.__typename === "GraphVideo") {
          const videos = node.video_versions || [];
          items.push({
            type: "video",
            url: videos[0]?.url || node?.video_url,
            thumbnail: node?.image_versions2?.candidates?.[0]?.url || node?.display_url,
          });
        } else {
          const candidates = node?.image_versions2?.candidates || [];
          items.push({
            type: "image",
            url: candidates[0]?.url || node?.display_url,
            thumbnail: candidates[0]?.url || node?.display_url,
          });
        }
      }
      return { type: "carousel", items, caption, username };
    }

    // Single video / reel
    if (root?.video_versions || root?.is_video || root?.__typename === "GraphVideo") {
      const videos = root.video_versions || [];
      return {
        type: "video",
        items: [
          {
            type: "video",
            url: videos[0]?.url || root?.video_url,
            thumbnail:
              root?.image_versions2?.candidates?.[0]?.url ||
              root?.display_url ||
              root?.thumbnail_src,
          },
        ],
        caption,
        username,
      };
    }

    // Single image
    const candidates = root?.image_versions2?.candidates || [];
    return {
      type: "image",
      items: [
        {
          type: "image",
          url: candidates[0]?.url || root?.display_url,
          thumbnail: candidates[0]?.url || root?.display_url,
        },
      ],
      caption,
      username,
    };
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "URL is required" });

  const shortcode = extractShortcode(url);
  if (!shortcode) return res.status(400).json({ error: "Invalid Instagram URL. Supported: /p/, /reel/, /reels/, /tv/" });

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://www.instagram.com/",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
  };

  // Try oEmbed first (public, no auth needed, returns basic info)
  try {
    const oembedUrl = `https://www.instagram.com/oembed/?url=${encodeURIComponent(url)}&format=json`;
    const oembedRes = await fetch(oembedUrl, { headers, timeout: 8000 });
    if (oembedRes.ok) {
      const oembedData = await oembedRes.json();
      // oEmbed only gives thumbnail + title, not direct media URLs
      // Use it as a fallback for caption/username
      const authorName = oembedData.author_name || "unknown";
      const title = oembedData.title || "";
      const thumbUrl = oembedData.thumbnail_url || null;

      // Try the /api/v1 endpoint next for full media data
    }
  } catch (_) {}

  // Try the Instagram web API embed endpoint
  const endpoints = [
    `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
    `https://www.instagram.com/graphql/query/?query_hash=2b0673e0dc4580674a88d426fe00ea90&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`,
    `https://www.instagram.com/api/v1/media/${shortcode}/info/`,
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers, timeout: 10000 });
      if (!response.ok) continue;
      const text = await response.text();

      let jsonData;
      try { jsonData = JSON.parse(text); } catch (_) { continue; }

      const parsed = parseMediaFromJson(jsonData);
      if (parsed && parsed.items.length > 0 && parsed.items[0].url) {
        return res.status(200).json({ success: true, data: parsed });
      }
    } catch (_) {
      continue;
    }
  }

  // Fallback: scrape the HTML page and look for embedded JSON
  try {
    const pageUrl = `https://www.instagram.com/p/${shortcode}/`;
    const pageRes = await fetch(pageUrl, { headers, timeout: 12000 });
    if (pageRes.ok) {
      const html = await pageRes.text();

      // Look for JSON in script tags
      const jsonPatterns = [
        /window\.__additionalDataLoaded\('[^']*',(\{.+?\})\);/s,
        /<script type="application\/json" data-content-type="media-symbol[^>]*>(\{.+?\})<\/script>/s,
        /require\(\["JSScheduler","ServerJS","ScheduledApplyEach"\][^;]+;/s,
      ];

      for (const pattern of jsonPatterns) {
        const match = html.match(pattern);
        if (match) {
          try {
            const jsonData = JSON.parse(match[1]);
            const parsed = parseMediaFromJson(jsonData);
            if (parsed && parsed.items.length > 0) {
              return res.status(200).json({ success: true, data: parsed });
            }
          } catch (_) {}
        }
      }

      // Try finding shared_data
      const sharedDataMatch = html.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
      if (sharedDataMatch) {
        try {
          const sharedData = JSON.parse(sharedDataMatch[1]);
          const media =
            sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
          if (media) {
            const parsed = parseMediaFromJson({ graphql: { shortcode_media: media } });
            if (parsed) return res.status(200).json({ success: true, data: parsed });
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  return res.status(422).json({
    error:
      "Could not extract media from this post. Instagram may have restricted access. Make sure the post is public.",
  });
};
