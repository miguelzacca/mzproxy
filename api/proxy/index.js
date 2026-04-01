import https from 'https';
import http from 'http';

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default function handler(req, res) {
  const setCors = (proxyHeaders = {}) => {
    // 1. Refletir a origem exata (essencial para Credentials) ou usar '*' para requisições simples
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    
    // 2. Liberar todos os métodos HTTP padrão e estendidos
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
    
    // 3. Aceitar qualquer Header customizado que o frontend decida mandar
    const reqHeaders = req.headers['access-control-request-headers'];
    if (reqHeaders) {
      res.setHeader('Access-Control-Allow-Headers', reqHeaders);
    } else {
      res.setHeader('Access-Control-Allow-Headers', '*');
    }
    
    // 4. Liberar fluxo de credenciais (cookies/autenticação) APENAS se a Origem não for wildcard
    // Browser proíbe 'Access-Control-Allow-Credentials: true' combinado com 'Access-Control-Allow-Origin: *'
    if (origin !== '*') {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    
    // 5. Expor todos os headers devolvidos pelo alvo para o JS cliente poder ler (Axios/Fetch)
    if (proxyHeaders && typeof proxyHeaders === 'object' && Object.keys(proxyHeaders).length > 0) {
      const exposeHeaders = Object.keys(proxyHeaders).filter(h => !h.toLowerCase().startsWith('access-control-'));
      if (exposeHeaders.length > 0) {
        res.setHeader('Access-Control-Expose-Headers', exposeHeaders.join(', '));
      } else {
        res.setHeader('Access-Control-Expose-Headers', '*');
      }
    } else {
      res.setHeader('Access-Control-Expose-Headers', '*');
    }
  };

  if (req.method === 'OPTIONS') {
    setCors();
    return res.status(200).end();
  }

  // Reconstrução Impecável: o Vercel joga a "sua URL" em req.query.url, e todas as suas querystrings
  // originais (ex: ?q=miguel) ele separa no próprio req.query (como { q: 'miguel', sourceid: 'chrome' }).
  let targetUrlStr = req.headers['x-target-url'];
  
  if (!targetUrlStr && req.query?.url) {
    targetUrlStr = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    const params = [];
    for (const key in req.query) {
      if (key !== 'url') {
        const val = req.query[key];
        if (Array.isArray(val)) {
          val.forEach(v => params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
        } else {
          params.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
        }
      }
    }
    if (params.length > 0) {
      // Se a URL do host original magicamente já tiver um '?', adicionamos um '&', senão '?'. 
      const separator = targetUrlStr.includes('?') ? '&' : '?';
      targetUrlStr += separator + params.join('&');
    }
  }

  // 🔥 CRÍTICO: Alguns roteadores e browsers acham que "https://" no meio de uma URL na verdade é uma pasta dupla "//"
  // e simplificam para "https:/", quebrando qualquer comunicação (Google joga pra tela de /sorry). Isso normaliza as barras.
  if (targetUrlStr) {
    targetUrlStr = targetUrlStr.replace(/^(https?):\/+([^/])/, '$1://$2');
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
  // 🛡️ Limpeza agressiva: o Vercel e outros CDNs enfiam dezenas de headers como "x-vercel-id"
  // que gritam "sOU UM SCRIPT HOSPEDADO" pro Google. Precisamos vaporizar TODOS ELES.
  Object.keys(options.headers).forEach(key => {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('x-') || lowerKey.startsWith('forwarded') || lowerKey.startsWith('via')) {
      delete options.headers[key];
    }
  });
  
  delete options.headers.host;
  delete options.headers.connection;
  // 🎭 Spoofing Absoluto - Camuflagem pra parecer um Humano e não um bot de Data Center ou Fetch JS
  options.headers.host = targetUrl.host;
  
  // WAFs (como o Google) banem requisições GET padrão que contém Origin (sinal clássico de bot fetch()/CORS)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    options.headers.origin = targetUrl.origin;
  } else {
    delete options.headers.origin;
  }
  options.headers.referer = targetUrl.origin + '/';
  
  // Apaga os rastros biológicos explícitos de Fetch API pra forçar a imagem de Navigation Document
  delete options.headers['sec-fetch-dest'];
  delete options.headers['sec-fetch-mode'];
  delete options.headers['sec-fetch-site'];
  delete options.headers['sec-fetch-user'];
  
  // Injeta headers perfeitos de navegador de verdade (impossível o Google/Cloudflare diferir de uma pessoa real usando Chrome)
  options.headers['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  options.headers['accept-language'] = options.headers['accept-language'] || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';
  
  // Tranca o User-Agent em cima da sua versão moderna pra garantir navegação lisa
  if (!options.headers['user-agent'] || options.headers['user-agent'].includes('undici') || options.headers['user-agent'].includes('node')) {
    options.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
  }

  const proxyReq = requestModule.request(options, (proxyRes) => {
    setCors(proxyRes.headers);
    
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

      // Reescreve a header de location para redirecionamentos automáticos passarem pelo novo formato de rota do lado do cliente
      if (lowerKey === 'location') {
        const locationUrl = proxyRes.headers[key];
        try {
          if (locationUrl.startsWith('/')) {
            const absoluteLocation = new URL(locationUrl, targetUrl.origin).href;
            res.setHeader('location', `/api/proxy/${encodeURIComponent(absoluteLocation)}`);
          } else {
            res.setHeader('location', `/api/proxy/${encodeURIComponent(locationUrl)}`);
          }
        } catch(e) {
          res.setHeader('location', `/api/proxy/${encodeURIComponent(locationUrl)}`);
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
