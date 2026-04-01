import chromium from '@sparticuz/chromium';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createCursor } from 'ghost-cursor';

// Para contornar bugs do bundler da Vercel que deleta plugins dinâmicos
import 'puppeteer-extra-plugin-user-preferences';
import 'puppeteer-extra-plugin-user-data-dir';

// 1. Instanciar o puppeteer-extra conectando ao puppeteer-core compatível com Vercel
const puppeteer = addExtra(puppeteerCore);

// 2. Acoplar o Stealth Plugin para remover rastros óbvios de Selenium/Puppeteer
puppeteer.use(StealthPlugin());

export const config = {
  api: {
    // Vercel Serverless Function limite default. O Puppeteer precisa de mais tempo geramente.
    // Depende do seu plano Vercel (Hobby = max 10s, Pro = max 60s)
    responseLimit: '8mb',
  },
};

export default async function handler(req, res) {
  // CORS universal
  const setCors = () => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
  };

  if (req.method === 'OPTIONS') {
    setCors();
    return res.status(200).end();
  }

  setCors();

  // Limpar e Resgatar a URL (suportando array na url igual na proxy transparente)
  let targetUrlStr = req.headers['x-target-url'] || (Array.isArray(req.query?.url) ? req.query.url[0] : req.query?.url);
  
  if (!targetUrlStr) {
    return res.status(400).json({ error: 'URL alvo ausente (Use ?url=... ou header x-target-url)' });
  }

  // Normalização de barras duplas (caso o framework Vercel remova)
  targetUrlStr = targetUrlStr.replace(/^(https?):\/+([^/])/, '$1://$2');

  try {
    targetUrlStr = new URL(targetUrlStr).href;
  } catch(e) {
    return res.status(400).json({ error: 'URL alvo inválida fornecida' });
  }

  let browser = null;

  try {
    console.log(`[Scraper] Iniciando captura stealth para: ${targetUrlStr}`);

    // Deteccao de ambiente: Vercel Cloud vs Local (Windows Developer)
    const isLocal = !process.env.VERCEL;
    
    // No Windows Local vamos tentar procurar o Google Chrome padrão. Na nuvem pegamos o binário do Sparticuz.
    const executablePath = isLocal 
      ? process.platform === 'win32'
        ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        : process.platform === 'linux' 
          ? '/usr/bin/google-chrome' 
          : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : await chromium.executablePath();

    // 3. Inicializar navegador com os args blindados
    browser = await puppeteer.launch({
      args: isLocal ? [] : chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: executablePath || process.env.CHROME_EXECUTABLE_PATH,
      headless: isLocal ? true : chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // Otimização Extrema de Velocidade: Bloquear imagens, CSS, fontes e mídias
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'imageset'].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // 4. Acoplar o Ghost Cursor para emular movimento humano caso o antibot analise mouse tracking
    const cursor = createCursor(page);

    // Ajustar User-agent se precisar forçar sobre o sparticuz,
    // mas o stealth plugin já embarca bypasses excelentes.
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // 5. Navegar até a URL com timeout curto pra fugir do Hard Kill de 10s da Vercel
    console.log('[Scraper] Acessando URL...');
    let response = null;
    try {
      response = await page.goto(targetUrlStr, { 
        waitUntil: 'networkidle2', 
        timeout: 6500 
      });
    } catch (timeoutErr) {
      console.log('[Scraper] Tempo estourou aguardando networkidle2, processando com o que já foi carregado...');
      // Ignora erro. O navegador fará o scrape do HTML carregado até o limite do tempo.
    }

    // Movimentação humana ultra rápida (paralela) para ativar lazy loads se houver e passar Cloudflare challenge básico
    try {
       await Promise.all([
         cursor.moveTo({ x: 150 + Math.random() * 100, y: 150 + Math.random() * 100 }),
         page.evaluate(() => window.scrollBy(0, 300))
       ]);
    } catch(err) { /* Ignorar timeouts se a page crasher logo depois do reload */ }

    // 6. Obter HTML renderizado e interpretado (SPA bypass)
    let finalHtml = await page.content();
    
    // Você não pode repassar cookies/frames transparentemente com um scraper em HTML cru.
    // Mas resolvemos injetando Content-Type
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    // Repassa o Status code do page original (ex: 404, 403, 200) se existir
    if (response) {
      res.status(response.status()).send(finalHtml);
    } else {
      res.status(200).send(finalHtml);
    }

  } catch (error) {
    console.error(`[Scraper] Falha ao raspar a URL ${targetUrlStr}:`, error);
    
    if (!res.headersSent) {
      res.status(502).json({ 
        error: 'Engine do Scraper abortada falhou', 
        details: error.message 
      });
    }
  } finally {
    if (browser !== null) {
      await browser.close().catch(e => console.error("Erro fechando browser:", e));
    }
  }
}
