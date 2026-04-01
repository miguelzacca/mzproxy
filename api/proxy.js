import https from 'https';
import http from 'http';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function addCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Extrai a URL-alvo bruta a partir de req.url.
 * IMPORTANTE: Aceita URL encodada ou decodada.
 */
function extractTargetUrl(req) {
  if (req.headers['x-target-url']) return req.headers['x-target-url'];

  let target = null;

  // Tentativa 1: Busca a URL via queryString parseada
  if (req.query && req.query.url) {
    target = req.query.url;
    const extraParams = [];
    for (const key in req.query) {
      if (key !== 'url' && key !== '__proxyOrigin') {
        const val = req.query[key] === '' ? '' : '=' + req.query[key];
        extraParams.push(key + val);
      }
    }
    if (extraParams.length > 0) {
      target += (target.includes('?') ? '&' : '?') + extraParams.join('&');
    }
  }

  // Tentativa 2: Fallback puro de Texto da URL (req.url bruto)
  if (!target) {
    const raw = req.url || '';
    const idx = raw.indexOf('url=');
    if (idx !== -1) {
      target = raw.substring(idx + 4);
      if (target.startsWith('http%3A') || target.startsWith('https%3A')) {
        try { target = decodeURIComponent(target); } catch (_) {}
      }
    }
  }

  // Tentativa 3: Se ainda não tiver target, mas for uma rota do proxy sem ?url=
  // Isso acontece em formulários (action="/api/proxy") ou redirects do Google.
  // Usamos o Referer para descobrir de qual site o usuário veio.
  if (!target && req.url.startsWith('/api/proxy')) {
    const referer = req.headers['referer'];
    if (referer && referer.includes('url=')) {
      try {
        const refUrl = new URL(referer);
        const refTarget = refUrl.searchParams.get('url');
        if (refTarget) {
          const originUrl = new URL(refTarget);
          const pathAndQuery = req.url.replace('/api/proxy', '');
          target = originUrl.origin + (pathAndQuery.startsWith('/') ? '' : '/') + pathAndQuery;
        }
      } catch (_) {}
    }
  }

  return target;
}

export default function handler(req, res) {
  // ── Preflight ──
  if (req.method === 'OPTIONS') {
    addCors(res);
    res.status(200).end();
    return;
  }

  const targetStr = extractTargetUrl(req);
  if (!targetStr) {
    addCors(res);
    return res.status(400).send('Erro: Passe ?url=<destino> ou header x-target-url.');
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetStr);
  } catch (_) {
    addCors(res);
    return res.status(400).send('Erro: URL inválida.');
  }

  // ── Extrai o path+query da string ORIGINAL sem reparse ──
  // Encontra onde começa o path no targetStr original
  const originPart = targetUrl.protocol + '//' + targetUrl.host;
  const rawPath = targetStr.substring(originPart.length);

  // Log para debug
  console.log('[PROXY] method:', req.method);
  console.log('[PROXY] targetStr:', targetStr.substring(0, 120) + '...');
  console.log('[PROXY] rawPath:', rawPath.substring(0, 120) + '...');

  // ── Headers de segurança e rastreamento a remover ──
  const skipReqHeaders = new Set([
    'host', 'referer', 'origin', 'proxy-connection', 'connection', 
    'x-target-url', 'x-vercel-id', 'x-vercel-proxy-signature', 
    'x-forwarded-for', 'x-real-ip', 'forwarded', 'via',
    'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user'
  ]);
  
  const outHeaders = {};
  for (const key in req.headers) {
    const lowerKey = key.toLowerCase();
    
    // Lista de exceções para headers X- que são VITIAIS para Spotify, Meta e Google
    const isWhiteListedX = 
      lowerKey.includes('spotify') || 
      lowerKey.includes('app-version') || 
      lowerKey.includes('ig-') || 
      lowerKey.includes('fb-') || 
      lowerKey.includes('asbd-id') ||
      lowerKey.includes('goog-') ||
      lowerKey.includes('csrftoken');

    if (lowerKey.startsWith('sec-') || skipReqHeaders.has(lowerKey) || (lowerKey.startsWith('x-') && !isWhiteListedX)) {
        continue;
    }
    outHeaders[key] = req.headers[key];
  }

  outHeaders['host'] = targetUrl.host;
  
  // ── Falsificação de Origem (Inteligente) ──
  let siteOrigin = targetUrl.protocol + '//' + targetUrl.hostname;
  if (req.query && req.query.__proxyOrigin) {
    siteOrigin = req.query.__proxyOrigin;
  } else {
    const refererHeader = req.headers['referer'];
    if (refererHeader && refererHeader.includes('url=')) {
      try {
          const refUrl = new URL(refererHeader).searchParams.get('url');
          if (refUrl) siteOrigin = new URL(refUrl).origin;
      } catch(e) {}
    }
  }
  
  // Forçar Origin e Referer para o domínio principal do site
  if (siteOrigin.includes('instagram.com')) siteOrigin = 'https://www.instagram.com';
  if (siteOrigin.includes('facebook.com')) siteOrigin = 'https://www.facebook.com';
  if (siteOrigin.includes('spotify.com') || siteOrigin.includes('spotify.net')) siteOrigin = 'https://open.spotify.com';
  if (siteOrigin.includes('google.com') || siteOrigin.includes('google.net') || siteOrigin.includes('gstatic.com')) siteOrigin = 'https://www.google.com';

  if (targetUrl.hostname.includes('facebook.com') && !siteOrigin.includes('facebook.com')) {
    siteOrigin = 'https://www.instagram.com';
  }
  if (targetUrl.hostname.includes('spotify') && !siteOrigin.includes('spotify')) {
    siteOrigin = 'https://open.spotify.com';
  }
  if ((targetUrl.hostname.includes('google') || targetUrl.hostname.includes('gstatic')) && !siteOrigin.includes('google')) {
    siteOrigin = 'https://www.google.com';
  }

  outHeaders['origin'] = siteOrigin;
  outHeaders['referer'] = siteOrigin + '/';
  outHeaders['user-agent'] = BROWSER_UA;
  outHeaders['connection'] = 'close';
  outHeaders['accept-language'] = req.headers['accept-language'] || 'en-US,en;q=0.9';

  const acceptHeader = req.headers['accept'] || '';
  if (acceptHeader.includes('text/html') || acceptHeader.includes('text/css')) {
     outHeaders['Accept-Encoding'] = 'identity';
  } else {
     outHeaders['Accept-Encoding'] = req.headers['accept-encoding'] || 'gzip, deflate, br';
  }

  const transport = targetUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    servername: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: rawPath,
    method: req.method,
    headers: outHeaders,
    rejectUnauthorized: false,
    timeout: 30000,
  };

  console.log('[PROXY] sending to:', targetUrl.hostname, 'path:', options.path);

  let isFinished = false;
  const proxyReq = transport.request(options, (proxyRes) => {
    if (isFinished) return;
    console.log('[PROXY] response status:', proxyRes.statusCode, 'from:', targetUrl.hostname);

    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
      let location = proxyRes.headers.location;
      if (!location.startsWith('http')) {
        try { location = new URL(location, targetStr).href; } catch (_) {}
      }
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
      const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');

      addCors(res);
      res.writeHead(proxyRes.statusCode, {
        ...filterResponseHeaders(proxyRes.headers),
        'location': `${proto}://${host}/api/proxy?url=${encodeURIComponent(location)}`,
      });
      proxyRes.pipe(res);
      return;
    }

    const responseHeaders = filterResponseHeaders(proxyRes.headers);
    responseHeaders['access-control-allow-origin'] = '*';

    const contentType = responseHeaders['content-type'] || '';
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');

    if (isHtml || isCss) {
      delete responseHeaders['content-length'];
      delete responseHeaders['content-encoding'];
      res.writeHead(proxyRes.statusCode, responseHeaders);

      let bodyChunks = [];
      proxyRes.on('data', chunk => bodyChunks.push(chunk));
      proxyRes.on('end', () => {
        let bodyStr = Buffer.concat(bodyChunks).toString('utf8');
        if (isHtml) {
          const INJECTED_SCRIPT = `
          <script>
            (function() {
              const __PROXY_URL__ = '/api/proxy?url=';
              const __TARGET_ORIGIN__ = '${targetUrl.origin}';
              const __TARGET_URL__ = '${targetUrl.href}';
              const __HOST_ORIGIN__ = window.location.origin;

              function rewriteUrl(url) {
                if (!url) return url;
                let sUrl = typeof url === 'string' ? url : (url.href || url.toString());
                
                if (sUrl.startsWith('data:') || sUrl.startsWith('blob:') || sUrl.startsWith('javascript:')) return url;
                if (sUrl.includes(__PROXY_URL__)) return url;

                if (sUrl.startsWith(__HOST_ORIGIN__)) {
                  sUrl = __TARGET_ORIGIN__ + sUrl.substring(__HOST_ORIGIN__.length);
                }

                if (sUrl.startsWith('//')) sUrl = '${targetUrl.protocol}' + sUrl;
                if (sUrl.startsWith('/')) sUrl = __TARGET_ORIGIN__ + sUrl;
                if (!sUrl.startsWith('http')) {
                  try { sUrl = new URL(sUrl, __TARGET_URL__).href; } catch(e) { }
                }

                return __PROXY_URL__ + encodeURIComponent(sUrl) + '&__proxyOrigin=' + encodeURIComponent(__TARGET_ORIGIN__);
              }

              // Overrides agressivos
              const originalFetch = window.fetch;
              window.fetch = function(resource, init) {
                if (resource instanceof Request) {
                  const newRequest = new Request(rewriteUrl(resource.url), resource);
                  return originalFetch.call(this, newRequest, init);
                }
                return originalFetch.call(this, rewriteUrl(resource), init);
              };

              const originalOpen = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(method, url, ...args) {
                if (url) url = rewriteUrl(url);
                return originalOpen.call(this, method, url, ...args);
              };

              if (navigator.serviceWorker) {
                const originalRegister = navigator.serviceWorker.register;
                navigator.serviceWorker.register = function(url, options) {
                  return originalRegister.call(this, rewriteUrl(url), options);
                };
              }

              if (navigator.sendBeacon) {
                const originalBeacon = navigator.sendBeacon;
                navigator.sendBeacon = function(url, data) {
                  return originalBeacon.call(this, rewriteUrl(url), data);
                };
              }

              // Interceptação de DOM via Protótipo (Captura TUDO, mesmo Image() e atribuições diretas)
              function hookProperty(Proto, prop) {
                const descriptor = Object.getOwnPropertyDescriptor(Proto.prototype, prop);
                if (!descriptor || !descriptor.set) return;
                Object.defineProperty(Proto.prototype, prop, {
                  set: function(v) {
                    return descriptor.set.call(this, rewriteUrl(v));
                  },
                  get: function() {
                    return descriptor.get.call(this);
                  },
                  configurable: true
                });
              }

              [HTMLImageElement, HTMLScriptElement, HTMLLinkElement, HTMLIFrameElement, HTMLSourceElement, HTMLVideoElement, HTMLAudioElement].forEach(P => hookProperty(P, 'src'));
              [HTMLLinkElement, HTMLAnchorElement].forEach(P => hookProperty(P, 'href'));
              [HTMLFormElement].forEach(P => hookProperty(P, 'action'));

              // Interceptação de History API
              const pushState = history.pushState;
              history.pushState = function(state, title, url) {
                return pushState.call(this, state, title, url ? rewriteUrl(url) : url);
              };
              const replaceState = history.replaceState;
              history.replaceState = function(state, title, url) {
                return replaceState.call(this, state, title, url ? rewriteUrl(url) : url);
              };

              window.addEventListener('click', function(e) {
                  const a = e.target.closest('a');
                  if (a && a.href && !a.href.includes(__PROXY_URL__)) {
                      a.href = rewriteUrl(a.href);
                  }
              }, true);
            })();
          </script>
          `;
          bodyStr = bodyStr.replace('<head>', '<head>' + INJECTED_SCRIPT);
          
          const attrRegex = /(src|href|action)\s*=\s*(['"])(.*?)\2/gi;
          bodyStr = bodyStr.replace(attrRegex, (match, p1, p2, p3) => {
            if (p3.startsWith('data:') || p3.startsWith('javascript:') || p3.startsWith('#')) return match;
            if (p3.includes('/api/proxy?url=')) return match;
            let newUrl = p3;
            if (p3.startsWith('//')) newUrl = targetUrl.protocol + p3;
            else if (p3.startsWith('/')) newUrl = targetUrl.origin + p3;
            else if (!p3.startsWith('http')) {
              try { newUrl = new URL(p3, targetStr).href; } catch(e) { newUrl = targetUrl.origin + '/' + p3; }
            }
            return `${p1}=${p2}/api/proxy?url=${encodeURIComponent(newUrl)}${p2}`;
          });
        } else if (isCss) {
          const cssRegex = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;
          bodyStr = bodyStr.replace(cssRegex, (match, p1, p2) => {
            if (p2.startsWith('data:') || p2.includes('/api/proxy?url=')) return match;
            let newUrl = p2;
            if (p2.startsWith('//')) newUrl = targetUrl.protocol + p2;
            else if (p2.startsWith('/')) newUrl = targetUrl.origin + p2;
            else if (!p2.startsWith('http')) {
              try { newUrl = new URL(p2, targetStr).href; } catch(e) { }
            }
            return `url(${p1}/api/proxy?url=${encodeURIComponent(newUrl)}${p1})`;
          });
        }
        res.end(bodyStr);
      });
      return;
    }

    res.writeHead(proxyRes.statusCode, responseHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (isFinished) return;
    isFinished = true;
    console.error('[PROXY] error:', err.message, err.code || '');
    if (!res.headersSent) {
      addCors(res);
      res.status(502).send(`Bad Gateway: ${err.message} (${err.code || 'unknown'})`);
    }
  });

  proxyReq.on('timeout', () => {
    if (isFinished) return;
    isFinished = true;
    proxyReq.destroy();
    if (!res.headersSent) {
      addCors(res);
      res.status(504).send('Gateway Timeout');
    }
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.on('data', (chunk) => {
      if (!isFinished) proxyReq.write(chunk);
    });
    req.on('end', () => {
      if (!isFinished) proxyReq.end();
    });
  } else {
    proxyReq.end();
  }
}

function filterResponseHeaders(headers) {
  const out = {};
  const skip = new Set([
    'content-security-policy', 'x-frame-options', 'strict-transport-security',
    'access-control-allow-origin', 'access-control-allow-methods',
    'access-control-allow-headers', 'access-control-allow-credentials',
    'transfer-encoding', 'connection', 'keep-alive'
  ]);
  for (const [key, val] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) out[key] = val;
  }
  return out;
}
