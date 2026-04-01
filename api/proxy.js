import https from 'https';
import http from 'http';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

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

  // Tentativa 1: Busca a URL via queryString parseada (bom para Vercel)
  // Como o usuário pode ter esquecido de encodar com encodeURIComponent(), o navegador quebra a URL 
  // do Instagram nos "&" como se fossem parametros direcionados pro nosso proxy.
  // Então nós remontamos tudo de volta se acharmos mais parametros!
  if (req.query && req.query.url) {
    let target = req.query.url;
    const extraParams = [];
    for (const key in req.query) {
      if (key !== 'url') {
        // Preserva o valor exatamente como veio
        const val = req.query[key] === '' ? '' : '=' + req.query[key];
        extraParams.push(key + val);
      }
    }
    if (extraParams.length > 0) {
      target += (target.includes('?') ? '&' : '?') + extraParams.join('&');
    }
    return target;
  }

  // Tentativa 2: Fallback puro de Texto da URL (req.url bruto)
  const raw = req.url || '';
  const idx = raw.indexOf('url=');
  if (idx !== -1) {
    let target = raw.substring(idx + 4);
    if (target.startsWith('http%3A') || target.startsWith('https%3A')) {
      try { target = decodeURIComponent(target); } catch (_) {}
    }
    return target;
  }

  return null;
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

  // ── Headers mínimos: SOMENTE o necessário ──
  const skipReqHeaders = new Set(['host', 'referer', 'origin', 'accept-encoding', 'connection', 'x-target-url']);
  const outHeaders = {};
  
  // Preservar todos os headers (inclusive customizados como spotify-app-version), pulando apenas os denunciantes
  for (const key in req.headers) {
    if (!skipReqHeaders.has(key.toLowerCase())) {
        outHeaders[key] = req.headers[key];
    }
  }

  outHeaders['Host'] = targetUrl.host;
  outHeaders['Accept-Encoding'] = 'identity'; // Necessário para não compactar HTML/CSS e podermos manipular

  // Para POST/PUT/PATCH, finge ser do site para o CORS e CSRF do Spotify
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const fakeOrigin = targetUrl.protocol + '//' + targetUrl.hostname;
    outHeaders['Origin'] = fakeOrigin;
    outHeaders['Referer'] = fakeOrigin + '/';
  }

  const transport = targetUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: rawPath,
    method: req.method,
    headers: outHeaders,
    rejectUnauthorized: false,
  };

  console.log('[PROXY] sending to:', targetUrl.hostname, 'path length:', rawPath.length);

  const proxyReq = transport.request(options, (proxyRes) => {
    console.log('[PROXY] response status:', proxyRes.statusCode);

    // ── Segue redirects internamente pelo proxy ──
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
        'access-control-allow-origin': '*',
        'location': `${proto}://${host}/api/proxy?url=${encodeURIComponent(location)}`,
      });
      proxyRes.pipe(res);
      return;
    }

    // ── Resposta normal ──
    const responseHeaders = filterResponseHeaders(proxyRes.headers);
    responseHeaders['access-control-allow-origin'] = '*';
    responseHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD';
    responseHeaders['access-control-allow-headers'] = '*';
    responseHeaders['access-control-expose-headers'] = '*';

    const contentType = responseHeaders['content-type'] || proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');
    const isCss = contentType.includes('text/css');

    if (isHtml || isCss) {
      delete responseHeaders['content-length']; // O tamanho do body vai mudar
      res.writeHead(proxyRes.statusCode, responseHeaders);

      let bodyChunks = [];
      proxyRes.on('data', chunk => bodyChunks.push(chunk));
      proxyRes.on('end', () => {
        let bodyBuffer = Buffer.concat(bodyChunks);
        let bodyStr = bodyBuffer.toString('utf8');

        if (isHtml) {
          // 1. Injetar script para sobrescrever fetch e XHR
          const INJECTED_SCRIPT = `
          <script>
            (function() {
              const __PROXY_URL__ = '/api/proxy?url=';
              const __TARGET_ORIGIN__ = '${targetUrl.origin}';
              const __TARGET_URL__ = '${targetUrl.href}';
              const __HOST_ORIGIN__ = window.location.origin;

              function rewriteUrl(url) {
                if (!url || typeof url !== 'string') return url;
                if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
                if (url.includes('/api/proxy?url=')) return url;
                
                // Se a URL já foi absolultizada com o host local (ex: http://localhost:3000/api/token)
                if (url.startsWith(__HOST_ORIGIN__)) {
                  url = __TARGET_ORIGIN__ + url.substring(__HOST_ORIGIN__.length);
                }

                if (url.startsWith('//')) return __PROXY_URL__ + encodeURIComponent('${targetUrl.protocol}' + url);
                if (url.startsWith('/')) return __PROXY_URL__ + encodeURIComponent(__TARGET_ORIGIN__ + url);
                if (!url.startsWith('http')) {
                  const base = __TARGET_URL__.endsWith('/') ? __TARGET_URL__ : __TARGET_URL__ + '/';
                  try {
                    return __PROXY_URL__ + encodeURIComponent(new URL(url, base).href);
                  } catch(e) { }
                }
                if (url.startsWith('http')) return __PROXY_URL__ + encodeURIComponent(url);
                return url;
              }

              // Intercept Fetch
              const originalFetch = window.fetch;
              window.fetch = async function() {
                let args = Array.prototype.slice.call(arguments);
                let resource = args[0];
                
                // Trata object URL ignorado anteriormente
                if (resource instanceof URL) {
                  resource = resource.toString();
                  args[0] = resource;
                }

                if (typeof resource === 'string') {
                  args[0] = rewriteUrl(resource);
                } else if (resource && resource instanceof Request) {
                  let newUrl = rewriteUrl(resource.url);
                  try {
                    args[0] = new Request(newUrl, resource);
                  } catch (e) {
                    // Fallback to plain URL + config se Request cloning falhar
                    args[0] = newUrl; 
                    args[1] = args[1] || {};
                    args[1].method = resource.method;
                    args[1].headers = resource.headers;
                    args[1].mode = resource.mode;
                    args[1].credentials = resource.credentials;
                  }
                }
                return originalFetch.apply(this, args);
              };

              // Intercept XHR
              const originalOpen = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function() {
                let args = Array.prototype.slice.call(arguments);
                let urlArg = args[1];
                if (urlArg instanceof URL) {
                  urlArg = urlArg.toString();
                  args[1] = urlArg;
                }
                if (typeof urlArg === 'string') {
                  args[1] = rewriteUrl(urlArg);
                }
                return originalOpen.apply(this, args);
              };
            })();
          </script>
          `;

          if (bodyStr.includes('<head>')) {
            bodyStr = bodyStr.replace('<head>', '<head>' + INJECTED_SCRIPT);
          } else {
            bodyStr = INJECTED_SCRIPT + bodyStr;
          }

          // 2. Reescrever atributos estáticos HTML (src, href, action)
          const attrRegex = /(src|href|action)\s*=\s*(['"])(.*?)\2/gi;
          bodyStr = bodyStr.replace(attrRegex, (match, p1, p2, p3) => {
            if (p3.startsWith('data:') || p3.startsWith('javascript:') || p3.startsWith('mailto:') || p3.startsWith('#')) return match;
            if (p3.includes('/api/proxy?url=')) return match;
            
            let newUrl = p3;
            if (p3.startsWith('//')) {
              newUrl = targetUrl.protocol + p3;
            } else if (p3.startsWith('/')) {
              newUrl = targetUrl.origin + p3;
            } else if (!p3.startsWith('http')) {
              try { newUrl = new URL(p3, targetStr).href; } catch(e) { newUrl = targetUrl.origin + '/' + p3; }
            }
            return `${p1}=${p2}/api/proxy?url=${encodeURIComponent(newUrl)}${p2}`;
          });
        } 
        else if (isCss) {
          // 3. Reescrever URLs dentro de arquivos CSS (background-image: url(...))
          const cssRegex = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;
          bodyStr = bodyStr.replace(cssRegex, (match, p1, p2) => {
            if (p2.startsWith('data:') || p2.startsWith('javascript:')) return match;
            if (p2.includes('/api/proxy?url=')) return match;
            
            let newUrl = p2;
            if (p2.startsWith('//')) {
              newUrl = targetUrl.protocol + p2;
            } else if (p2.startsWith('/')) {
              newUrl = targetUrl.origin + p2;
            } else if (!p2.startsWith('http')) {
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
    console.error('[PROXY] error:', err.message);
    if (!res.headersSent) {
      addCors(res);
      res.status(502).send('Bad Gateway: ' + err.message);
    }
  });

  req.pipe(proxyReq);
}

function filterResponseHeaders(headers) {
  const out = {};
  const skip = new Set([
    'content-security-policy', 'x-frame-options', 'strict-transport-security',
    'access-control-allow-origin', 'access-control-allow-methods',
    'access-control-allow-headers', 'access-control-allow-credentials',
  ]);
  for (const [key, val] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) out[key] = val;
  }
  return out;
}
