import https from 'https';
import http from 'http';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default function handler(req, res) {
  const setCors = () => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
    
    const reqHeaders = req.headers['access-control-request-headers'];
    if (reqHeaders) {
      res.setHeader('Access-Control-Allow-Headers', reqHeaders);
    } else {
      res.setHeader('Access-Control-Allow-Headers', '*');
    }
    
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', '*');
  };

  if (req.method === 'OPTIONS') {
    setCors();
    return res.status(200).end();
  }

  // Extração robusta da URL. Como o Vercel junta os Query Params após um rewrite (ex: /https://site.com?id=5 vira ?url=https://site.com&id=5),
  // buscamos diretamente na req.url original para não perdermos nenhuma parte depois do '&' !
  let targetUrlStr = req.headers['x-target-url'];
  
  if (!targetUrlStr && req.url) {
    const urlMatch = req.url.match(/[?&]url=(.*)/);
    if (urlMatch) {
      targetUrlStr = decodeURIComponent(urlMatch[1]);
    } else {
      targetUrlStr = req.query?.url;
    }
  }

  if (!targetUrlStr) {
    setCors();
    return res.status(400).json({ error: 'URL de destino ausente na query (?url=) ou no header x-target-url' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetUrlStr);
  } catch (err) {
    setCors();
    return res.status(400).json({ error: 'URL inválida', details: err.message });
  }

  const isHttps = targetUrl.protocol === 'https:';
  const requestModule = isHttps ? https : http;

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: { ...req.headers },
    rejectUnauthorized: false, // Ignorar erros de certificado SSL no alvo para evitar quebras
  };

  // 🛡️ Limpeza agressiva de headers originais para burlar WAF, CORS e Cloudflare
  delete options.headers.host;
  delete options.headers['x-target-url'];
  delete options.headers['x-forwarded-for'];
  delete options.headers['x-vercel-forwarded-for'];
  delete options.headers['x-forwarded-proto'];
  delete options.headers['x-forwarded-host'];
  delete options.headers['x-real-ip'];
  delete options.headers['connection'];
  
  // 🎭 Spoofing - fazendo-se passar pela própria origem do alvo
  options.headers.host = targetUrl.host;
  options.headers.origin = targetUrl.origin;
  options.headers.referer = targetUrl.origin + '/';
  
  // Se não existir, configura um User-Agent moderno padrão
  if (!options.headers['user-agent']) {
    options.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  }

  const proxyReq = requestModule.request(options, (proxyRes) => {
    setCors();
    
    // Repassa o código de status
    res.statusCode = proxyRes.statusCode;
    
    // Repassa headers interceptando proteções de segurança
    Object.keys(proxyRes.headers).forEach((key) => {
      const lowerKey = key.toLowerCase();
      
      // Remove bloqueios de iFrame, CSP e HSTS e cors originais
      if (
        lowerKey === 'content-security-policy' ||
        lowerKey === 'content-security-policy-report-only' ||
        lowerKey === 'x-frame-options' ||
        lowerKey === 'strict-transport-security' ||
        lowerKey.startsWith('access-control-') 
      ) {
        return;
      }

      // Reescreve a header de location para redirecionamentos automáticos passarem pelo proxy
      if (lowerKey === 'location') {
        const locationUrl = proxyRes.headers[key];
        try {
          if (locationUrl.startsWith('/')) {
            const absoluteLocation = new URL(locationUrl, targetUrl.origin).href;
            res.setHeader('location', `/api/proxy?url=${encodeURIComponent(absoluteLocation)}`);
          } else {
            res.setHeader('location', `/api/proxy?url=${encodeURIComponent(locationUrl)}`);
          }
        } catch(e) {
          res.setHeader('location', `/api/proxy?url=${encodeURIComponent(locationUrl)}`);
        }
        return;
      }

      // Hack: Força cookies de terceiros cross-domain a funcionarem
      if (lowerKey === 'set-cookie') {
        let cookies = proxyRes.headers[key];
        if (!Array.isArray(cookies)) cookies = [cookies];
        cookies = cookies.map(c => {
          let cookie = c.replace(/SameSite=[a-zA-Z]+/ig, 'SameSite=None');
          if (!cookie.match(/SameSite=None/i)) cookie += '; SameSite=None';
          if (!cookie.match(/Secure/i)) cookie += '; Secure';
          return cookie;
        });
        res.setHeader(key, cookies);
        return;
      }

      res.setHeader(key, proxyRes.headers[key]);
    });

    // Encaminha a resposta do site alvo como stream de volta pro cliente
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Erro no Proxy:', err);
    if (!res.headersSent) {
      setCors();
      res.status(502).json({ error: 'Erro de comunicação com o servidor alvo', details: err.message });
    }
  });

  // Para requisições comuns sem corpo como GET/HEAD apenas finalizamos
  // Para POST/PUT/PATCH, repassamos o stream do corpo completo
  if (req.method === 'GET' || req.method === 'HEAD') {
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}
