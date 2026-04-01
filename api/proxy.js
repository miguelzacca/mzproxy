import httpProxy from 'http-proxy';

const proxy = httpProxy.createProxyServer({
  changeOrigin: true, // Muda o header 'Host' da requisição para o alvo, crucial para não ser bloqueado
  ignorePath: true, // Garante que mande exato pra URL de destino sem concatenar "/api/proxy"
  secure: false, // Ignora erros de SSL do alvo (certificados inválidos, etc)
});

// Intercepta a requisição ANTES dela sair para o site de destino
proxy.on('proxyReq', (proxyReq, req, res, options) => {
  // 1. Finge ser um navegador real de usuário comum
  proxyReq.setHeader(
    'User-Agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  // 2. Finge que a chamada partiu de dentro do próprio site deles!
  // Isso burla quase todos os firewalls (WAF) que só liberam Same-Origin
  const targetOrigin = options.target.protocol + '//' + options.target.hostname;
  proxyReq.setHeader('Origin', targetOrigin);
  proxyReq.setHeader('Referer', targetOrigin + '/');

  // 3. Remove cabeçalhos que acusam que é "Cross-Site" ou robô
  proxyReq.removeHeader('Sec-Fetch-Dest');
  proxyReq.removeHeader('Sec-Fetch-Mode');
  proxyReq.removeHeader('Sec-Fetch-Site');
  proxyReq.removeHeader('Sec-Fetch-User');
  
  // 3. Remove cabeçalhos de proxy que revelam de onde veio (ajuda a evitar bloqueios WAF)
  proxyReq.removeHeader('X-Forwarded-For');
  proxyReq.removeHeader('X-Forwarded-Host');
  proxyReq.removeHeader('X-Forwarded-Proto');
  proxyReq.removeHeader('x-vercel-forwarded-for');
  proxyReq.removeHeader('x-vercel-id');
});

// Intercepta a resposta DO SITE ALVO antes de chegar no seu front-end
proxy.on('proxyRes', (proxyRes, req, res) => {
  // Remove bloqueios de framing ou scripts (para não bloquear se você usar iframes ou parsear)
  delete proxyRes.headers['content-security-policy'];
  delete proxyRes.headers['x-frame-options'];
  
  // Limpa CORS estrito imposto pelo site de destino, se houver
  delete proxyRes.headers['access-control-allow-origin'];
  delete proxyRes.headers['access-control-allow-methods'];
  delete proxyRes.headers['access-control-allow-headers'];
  delete proxyRes.headers['access-control-allow-credentials'];

  // Aplica o CORS "Liberado TOTAL" para o front-end
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
  proxyRes.headers['access-control-allow-headers'] = '*';
  proxyRes.headers['access-control-expose-headers'] = '*';
  
  // ---> SOLUÇÃO DO REDIRECIONAMENTO (ERRO 301/302) <---
  // Se o site (ex: google.com) responde um redirecionamento (ex: www.google.com/)
  // O navegador tenta ir direto pra lá e dá erro de CORS. Temos que forçar o redirect no nosso próprio proxy!
  if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
    let location = proxyRes.headers.location;
    
    // Arruma caso seja um redirecionamento relativo (ex: /caminho)
    if (!location.startsWith('http') && req._targetUrl) {
      try {
        location = new URL(location, req._targetUrl).href;
      } catch (e) {}
    }

    // Remonta a URL para passar pelo nosso Proxy de novo
    const host = req.headers.host || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
    
    proxyRes.headers.location = `${protocol}://${host}/api/proxy?url=${encodeURIComponent(location)}`;
  }
  
  // Em alguns casos, pode ser interessante forçar status 200 ou apagar Cookies de terceiros caso haja erro cross-site cookie
  // delete proxyRes.headers['set-cookie'];
});

export const config = {
  api: {
    // Super importante: Desativa o conversor de body da Vercel para 
    // deixar os fluxos passarem puros, perfeito pra envio de POST com imagens, JSON ou FormData.
    bodyParser: false,
    externalResolver: true,
  },
};

export default function handler(req, res) {
  return new Promise((resolve) => {
    // Helpers para injetar o CORS diretamente
    const addCors = () => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', '*');
    };

    // Responde instantaneamente ao "Preflight" do navegador
    if (req.method === 'OPTIONS') {
      addCors();
      res.status(200).end();
      return resolve();
    }

    // Procura o destino
    let targetUrlStr = req.headers['x-target-url'];

    // Para lidar com URLs completas vindo do formato "?url=..."
    if (!targetUrlStr && req.url) {
      const urlQueryIndex = req.url.indexOf('url=');
      if (urlQueryIndex !== -1) {
        targetUrlStr = req.url.substring(urlQueryIndex + 4);
        // Decodifica caso o front faça url.replace ou passe encodado
        if (targetUrlStr.startsWith('http%3A') || targetUrlStr.startsWith('https%3A')) {
          try { targetUrlStr = decodeURIComponent(targetUrlStr); } catch(e) {}
        }
      } else if (req.query?.url) {
        targetUrlStr = req.query.url;
      }
    }

    if (!targetUrlStr) {
      addCors();
      res.status(400).send('Erro: Faltando o parâmetro "url" ou header "x-target-url".');
      return resolve();
    }

    let targetUrl;
    try {
      targetUrl = new URL(targetUrlStr);
    } catch (err) {
      addCors();
      res.status(400).send(`Erro: URL inválida "${targetUrlStr}"`);
      return resolve();
    }

    // Salva na requisição para podermos ler no evento de proxyRes e consertar os redirecionamentos relativos
    req._targetUrl = targetUrl.href;

    // Executa a magia de proxy
    proxy.web(
      req,
      res,
      {
        target: targetUrl.href,
      },
      (err) => {
        console.error('Erro geral no Proxy:', err);
        if (!res.headersSent) {
          addCors();
          res.status(502).send('Error no Proxy (Bad Gateway): Não foi possível buscar o site.');
        }
        resolve();
      }
    );
  });
}
