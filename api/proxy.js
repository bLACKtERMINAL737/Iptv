export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');

  if (!target) {
    return new Response('Missing ?url= parameter', { status: 400 });
  }

  // Safety: only allow http/https streams
  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) {
      return new Response('Invalid protocol', { status: 400 });
    }
  } catch {
    return new Response('Invalid URL', { status: 400 });
  }

  // If it's an .m3u8 playlist, we need to rewrite segment URLs too
  const isPlaylist = target.includes('.m3u8') || target.includes('playlist');
  const isSegment  = target.includes('.ts') || target.includes('.aac') || target.includes('.mp4');

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Referer':    targetUrl.origin + '/',
        'Origin':     targetUrl.origin,
      },
      redirect: 'follow',
    });

    if (!upstream.ok) {
      return new Response(`Upstream error: ${upstream.status}`, { status: upstream.status });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': isSegment ? 'public, max-age=10' : 'no-cache',
    };

    // For .m3u8 playlists: rewrite all URLs so segments also go through proxy
    if (isPlaylist) {
      const text    = await upstream.text();
      const baseUrl = targetUrl.origin + targetUrl.pathname.replace(/\/[^/]*$/, '/');

      const rewritten = text
        .split('\n')
        .map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;

          // Build absolute URL for the segment
          let absUrl;
          if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            absUrl = trimmed;
          } else if (trimmed.startsWith('/')) {
            absUrl = targetUrl.origin + trimmed;
          } else {
            absUrl = baseUrl + trimmed;
          }

          // Rewrite through our proxy
          return `/api/proxy?url=${encodeURIComponent(absUrl)}`;
        })
        .join('\n');

      return new Response(rewritten, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/vnd.apple.mpegurl',
        },
      });
    }

    // For segments / direct streams: pipe through as-is
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        'Content-Type': contentType,
      },
    });

  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }
}
