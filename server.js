const express = require('express');
const https = require('https');
const zlib = require('zlib');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Parse headers from full header block or individual values
function parseHeadersFromEnv(input) {
  if (!input) return {};
  
  const headers = {};
  const lines = input.split('\n');
  
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();
      if (key && value && !key.startsWith('http') && key !== 'host' && key !== 'content-length') {
        headers[key] = value;
      }
    }
  }
  
  return headers;
}

// Configuration
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkoutUrl: "https://www.showroomprive.com/checkout/cart",
  cartReservationMinutes: 15,
  checkIntervalMs: 60 * 1000,
  // Showroomprivé auth headers (parsed from env or set individually)
  customHeaders: parseHeadersFromEnv(process.env.SRP_HEADERS),
  token: process.env.SRP_TOKEN || "",
  clientNum: process.env.SRP_CLIENT_NUM || "",
  crm: process.env.SRP_CRM || ""
};

// Store monitored products
const monitoredProducts = new Map();

// Product history (persists across monitoring sessions)
const productHistory = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// Add product to history
function addToHistory(productId, productInfo, sizeMapping) {
  productHistory.set(productId, {
    productId,
    title: productInfo.title || `Produit ${productId}`,
    label: productInfo.label,
    sizeMapping,
    addedAt: new Date().toISOString(),
    lastMonitored: new Date().toISOString()
  });
}

// ============== SHOWROOMPRIVE API FUNCTIONS ==============

function getDefaultHeaders() {
  // Build headers from config
  const headers = {
    'deviceversion': '5',
    'X-SRP-enable-hpsegment': 'true',
    'country': '64',
    'User-Agent': 'Showroom/25121601 CFNetwork/3860.300.31 Darwin/25.2.0',
    'bundle_identifier': 'com.showroomprive.showroompriveiphone',
    'region': '10',
    'appversion': '14.50',
    'mecapromo': 'true',
    'ab_list': '{"ab_product":"B","ab_home_ordo_predictive":"A","ab_enable_plp":false}',
    'osnumber': 'iPhone',
    'deviceid': '2',
    'Connection': 'keep-alive',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'ab_home': 'B',
    'darkmode': 'dark',
    'osversion': 'ios',
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'langue': '0',
    'ab_test_flagship': '{"mobile-hp-sale-picto":true,"mobile-classic-all-products":true,"mobile-hp-univers-bar-v4":true,"mobile-tlp-segment":"segment_d","mobile-plp-segment":"segment_b","mobile-homepage-cards-2024":true}'
  };
  
  // Add auth headers
  if (CONFIG.token) {
    headers['token'] = CONFIG.token;
  }
  if (CONFIG.clientNum) {
    headers['client_num'] = CONFIG.clientNum;
  }
  if (CONFIG.crm) {
    headers['crm'] = CONFIG.crm;
  }
  
  // Override with custom headers from env
  Object.assign(headers, CONFIG.customHeaders);
  
  return headers;
}

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const headers = getDefaultHeaders();
    const postData = body ? JSON.stringify(body) : null;

    if (postData) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const options = {
      hostname: 'mtandao.showroomprive.com',
      port: 443,
      path: path,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        
        // Decompress if needed
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            buffer = zlib.gunzipSync(buffer);
          } catch (e) { /* ignore */ }
        } else if (encoding === 'br') {
          try {
            buffer = zlib.brotliDecompressSync(buffer);
          } catch (e) { /* ignore */ }
        } else if (encoding === 'deflate') {
          try {
            buffer = zlib.inflateSync(buffer);
          } catch (e) { /* ignore */ }
        }
        
        const data = buffer.toString('utf8');
        
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Unauthorized (${res.statusCode}) - Token expired or invalid`));
          return;
        }
        
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
          return;
        }
        
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message} - Raw: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Parse Showroomprivé product URL
function parseProductUrl(url) {
  // Format: https://www.showroomprive.com/link/product/38450594
  const match = url.match(/\/product\/(\d+)/);
  if (match) {
    return match[1];
  }
  return null;
}

// Get product stock/sizes
async function getProductStock(productId) {
  const path = `/market.svc/quantity/${productId}?productid=${productId}`;
  const response = await makeRequest('GET', path);
  
  if (response.status?.code !== 1) {
    throw new Error(response.status?.message || 'Failed to get stock');
  }
  
  // Response format:
  // {"data":{"label":"...","offers":[{"available":3,"label":"L","offerId":"5014052","price":89.90,"productSku":"38450594"}]}}
  return response.data;
}

// Add to cart
async function addToCart(productId, sizeId) {
  const path = '/cart.svc/cart';
  const body = {
    add_cart_origin: 1,
    updates: [{
      prod_id: productId.toString(),
      quantity: 1,
      sized_id: sizeId.toString()
    }]
  };
  
  const response = await makeRequest('POST', path, body);
  
  if (response.status?.code === 1) {
    return {
      success: true,
      update: response.data?.updates?.[0]
    };
  }
  
  return { success: false, message: response.status?.message };
}

// ============== DISCORD NOTIFICATIONS ==============

function sendDiscordWebhook(payload) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.discordWebhook) {
      console.log('Discord webhook not configured');
      return resolve(false);
    }
    
    const webhookUrl = new URL(CONFIG.discordWebhook);
    const payloadStr = JSON.stringify(payload);

    const options = {
      hostname: webhookUrl.hostname,
      port: 443,
      path: webhookUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 204 || res.statusCode === 200) {
        resolve(true);
      } else {
        reject(new Error(`Discord error: ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });
}

function sendStockNotification(productInfo, offerId, size, quantity, price, productUrl) {
  const embed = {
    title: "🚨 STOCK DISPONIBLE!",
    color: 0x9c27b0, // Showroomprivé purple
    fields: [
      { name: "👕 Produit", value: `**${productInfo.title || 'Produit'}**`, inline: false },
      { name: "📏 Taille", value: `**${size}**`, inline: true },
      { name: "📦 Quantité", value: `${quantity} dispo`, inline: true },
      { name: "💰 Prix", value: `${price}€`, inline: true },
      { name: "🔗 Produit", value: `[Voir le produit](${productUrl})`, inline: true },
      { name: "🛒 Checkout", value: `[Aller au panier](${CONFIG.checkoutUrl})`, inline: true }
    ],
    footer: { text: `Offer ID: ${offerId}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🚨 **STOCK DISPONIBLE - AJOUTE VITE AU PANIER!**",
    embeds: [embed]
  });
}

function sendCartNotification(productInfo, offerId, size, quantity, price, productUrl) {
  const deadline = new Date(Date.now() + CONFIG.cartReservationMinutes * 60 * 1000);
  const deadlineStr = deadline.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const embed = {
    title: "🛒 ARTICLE AJOUTÉ AU PANIER!",
    color: 0x4caf50, // Green
    fields: [
      { name: "👕 Produit", value: `**${productInfo.title || 'Produit'}**`, inline: false },
      { name: "📏 Taille", value: `**${size}**`, inline: true },
      { name: "💰 Prix", value: `${price}€`, inline: true },
      { name: "⏰ CHECKOUT AVANT", value: `**${deadlineStr}**`, inline: false },
      { name: "🔗 Produit", value: `[Voir le produit](${productUrl})`, inline: true },
      { name: "🛒 Checkout", value: `[Aller au panier](${CONFIG.checkoutUrl})`, inline: true }
    ],
    footer: { text: `Offer ID: ${offerId}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🛒 **AJOUTÉ AU PANIER - CHECKOUT MAINTENANT!**",
    embeds: [embed]
  });
}

let tokenExpiredNotificationSent = false;

function sendTokenExpiredNotification(errorMessage) {
  if (tokenExpiredNotificationSent) {
    return Promise.resolve(false);
  }
  
  tokenExpiredNotificationSent = true;
  
  const embed = {
    title: "⚠️ TOKEN EXPIRÉ",
    color: 0xf44336,
    description: "Le token Showroomprivé a expiré. Le monitoring est en pause.",
    fields: [
      { name: "🔧 Action requise", value: "Mettez à jour les headers via l'interface web", inline: false },
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false }
    ],
    footer: { text: "Showroomprivé Monitor" },
    timestamp: new Date().toISOString()
  };

  console.log('⚠️ Token expired - sending Discord notification');
  
  return sendDiscordWebhook({
    content: "@everyone ⚠️ **TOKEN EXPIRÉ - MISE À JOUR REQUISE!**",
    embeds: [embed]
  });
}

function resetTokenExpiredFlag() {
  tokenExpiredNotificationSent = false;
}

// ============== MONITORING LOGIC ==============

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

async function monitorAllProducts() {
  for (const [key, product] of monitoredProducts) {
    try {
      const stockData = await getProductStock(product.productId);
      
      console.log(`[${getTimestamp()}] Checking product ${product.productId}`);
      
      // Build current stock from offers
      const currentStock = {};
      if (stockData.offers) {
        stockData.offers.forEach(offer => {
          currentStock[offer.offerId] = {
            available: offer.available,
            label: offer.label,
            price: offer.price
          };
        });
      }
      
      for (const [offerId, offerData] of Object.entries(currentStock)) {
        const prevStock = product.previousStock[offerId];
        const wasOutOfStock = !prevStock || prevStock.available === 0;
        const nowInStock = offerData.available > 0;
        const size = offerData.label || '?';
        
        // Check if this size is being watched and stock became available
        if (product.watchedSizes.has(offerId) && wasOutOfStock && nowInStock) {
          if (!product.notified.has(offerId)) {
            console.log(`🚨 NEW STOCK: ${size} (${offerId}) - ${offerData.available} units!`);
            
            // Try to add to cart
            try {
              const cartResult = await addToCart(product.productId, offerId);
              
              if (cartResult.success) {
                product.notified.add(offerId);
                
                console.log(`✅ Added to cart!`);
                
                const productUrl = `https://www.showroomprive.com/link/product/${product.productId}`;
                await sendCartNotification(
                  product.productInfo,
                  offerId,
                  size,
                  offerData.available,
                  offerData.price,
                  productUrl
                );
              } else {
                throw new Error(cartResult.message || 'Add to cart failed');
              }
            } catch (cartError) {
              console.error(`Failed to add to cart: ${cartError.message}`);
              
              // Send stock notification instead
              product.notified.add(offerId);
              const productUrl = `https://www.showroomprive.com/link/product/${product.productId}`;
              await sendStockNotification(
                product.productInfo,
                offerId,
                size,
                offerData.available,
                offerData.price,
                productUrl
              );
            }
          }
        }
        
        // Reset if item goes out of stock
        if (product.notified.has(offerId) && !nowInStock) {
          product.notified.delete(offerId);
        }
      }
      
      // Update previous stock
      product.previousStock = currentStock;
      
      // Update size mapping
      if (stockData.offers) {
        stockData.offers.forEach(offer => {
          product.sizeMapping[offer.offerId] = {
            size: offer.label,
            price: offer.price
          };
        });
      }
      
    } catch (error) {
      console.error(`[${getTimestamp()}] Error monitoring ${key}:`, error.message);
      
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('unauthorized') || 
          errorMsg.includes('401') || 
          errorMsg.includes('403') ||
          errorMsg.includes('token') ||
          errorMsg.includes('auth')) {
        await sendTokenExpiredNotification(error.message);
      }
    }
  }
}

function startMonitoring() {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }
  
  console.log(`[${getTimestamp()}] 🚀 Starting monitoring (interval: ${CONFIG.checkIntervalMs / 1000}s)`);
  monitoringInterval = setInterval(monitorAllProducts, CONFIG.checkIntervalMs);
  
  monitorAllProducts();
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log(`[${getTimestamp()}] ⏹️ Monitoring stopped`);
  }
}

// ============== API ROUTES ==============

app.get('/api/products', (req, res) => {
  const products = [];
  for (const [key, product] of monitoredProducts) {
    products.push({
      key,
      productId: product.productId,
      productInfo: product.productInfo,
      sizeMapping: product.sizeMapping,
      watchedSizes: Array.from(product.watchedSizes),
      currentStock: product.previousStock,
      notified: Array.from(product.notified)
    });
  }
  res.json({ products, isMonitoring: !!monitoringInterval });
});

app.post('/api/products/fetch', async (req, res) => {
  try {
    let { productId, url } = req.body;
    
    if (url) {
      const parsed = parseProductUrl(url);
      if (parsed) {
        productId = parsed;
      } else {
        return res.status(400).json({ error: 'Invalid Showroomprivé URL format' });
      }
    }
    
    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    const stockData = await getProductStock(productId);
    
    const sizes = stockData.offers ? stockData.offers.map(offer => ({
      offerId: offer.offerId,
      size: offer.label,
      stock: offer.available,
      price: offer.price
    })) : [];
    
    res.json({
      productId,
      productInfo: {
        productId,
        title: `Produit ${productId}`,
        label: stockData.label
      },
      sizes,
      sizeUnique: stockData.sizeUnique
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Fetch error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || errorMsg.includes('401') || errorMsg.includes('403')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/products/add', async (req, res) => {
  try {
    let { productId, url, watchedSizes } = req.body;
    
    if (url) {
      const parsed = parseProductUrl(url);
      if (parsed) {
        productId = parsed;
      }
    }
    
    if (!productId || !watchedSizes || !Array.isArray(watchedSizes)) {
      return res.status(400).json({ error: 'Product ID and watchedSizes array are required' });
    }

    const stockData = await getProductStock(productId);
    
    const sizeMapping = {};
    const stockInfo = {};
    
    if (stockData.offers) {
      stockData.offers.forEach(offer => {
        sizeMapping[offer.offerId] = {
          size: offer.label,
          price: offer.price
        };
        stockInfo[offer.offerId] = {
          available: offer.available,
          label: offer.label,
          price: offer.price
        };
      });
    }
    
    // Check if any watched size is already in stock
    const alreadyInStock = [];
    for (const offerId of watchedSizes) {
      const stock = stockInfo[offerId];
      if (stock && stock.available > 0) {
        const size = sizeMapping[offerId]?.size || offerId;
        alreadyInStock.push(size);
        
        // Try to add to cart immediately
        try {
          const cartResult = await addToCart(productId, offerId);
          if (cartResult.success) {
            const productUrl = `https://www.showroomprive.com/link/product/${productId}`;
            await sendCartNotification(
              { title: `Produit ${productId}` },
              offerId,
              size,
              stock.available,
              stock.price,
              productUrl
            );
          }
        } catch (err) {
          console.log(`Could not auto-add ${size} to cart: ${err.message}`);
          // Send stock notification instead
          const productUrl = `https://www.showroomprive.com/link/product/${productId}`;
          await sendStockNotification(
            { title: `Produit ${productId}` },
            offerId,
            size,
            stock.available,
            stock.price,
            productUrl
          );
        }
      }
    }
    
    const productInfo = {
      productId,
      title: `Produit ${productId}`,
      label: stockData.label
    };
    
    monitoredProducts.set(productId, {
      productId,
      productInfo,
      sizeMapping,
      watchedSizes: new Set(watchedSizes),
      previousStock: stockInfo,
      notified: new Set(alreadyInStock.length > 0 ? watchedSizes.filter(id => stockInfo[id]?.available > 0) : [])
    });
    
    // Save to history
    addToHistory(productId, productInfo, sizeMapping);

    startMonitoring();

    res.json({ 
      success: true, 
      message: `Now monitoring product ${productId}`,
      watchedSizes: watchedSizes.map(id => sizeMapping[id]?.size || id),
      alreadyInStock
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Add product error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || errorMsg.includes('401') || errorMsg.includes('403')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:key', (req, res) => {
  const { key } = req.params;
  
  if (monitoredProducts.has(key)) {
    monitoredProducts.delete(key);
    
    if (monitoredProducts.size === 0) {
      stopMonitoring();
    }
    
    res.json({ success: true, message: 'Product removed' });
  } else {
    res.status(404).json({ error: 'Product not found' });
  }
});

app.post('/api/products/:key/reset', (req, res) => {
  const { key } = req.params;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.notified.clear();
  
  res.json({ success: true, message: 'Notifications reset' });
});

// ============== HISTORY API ==============

// Get product history
app.get('/api/history', (req, res) => {
  const history = [];
  for (const [productId, item] of productHistory) {
    history.push({
      productId: item.productId,
      title: item.title,
      label: item.label,
      sizeMapping: item.sizeMapping,
      addedAt: item.addedAt,
      lastMonitored: item.lastMonitored,
      isCurrentlyMonitored: monitoredProducts.has(productId)
    });
  }
  // Sort by lastMonitored (most recent first)
  history.sort((a, b) => new Date(b.lastMonitored) - new Date(a.lastMonitored));
  res.json({ history });
});

// Clear history
app.delete('/api/history', (req, res) => {
  productHistory.clear();
  res.json({ success: true, message: 'History cleared' });
});

// Remove single item from history
app.delete('/api/history/:productId', (req, res) => {
  const { productId } = req.params;
  if (productHistory.has(productId)) {
    productHistory.delete(productId);
    res.json({ success: true, message: 'Item removed from history' });
  } else {
    res.status(404).json({ error: 'Item not found in history' });
  }
});

// Update headers/auth
app.post('/api/config/headers', (req, res) => {
  const { headers, token, clientNum, crm } = req.body;
  
  if (headers) {
    CONFIG.customHeaders = parseHeadersFromEnv(headers);
    console.log(`[${getTimestamp()}] Custom headers updated via API`);
  }
  
  if (token) {
    CONFIG.token = token;
    console.log(`[${getTimestamp()}] Token updated via API`);
  }
  
  if (clientNum) {
    CONFIG.clientNum = clientNum;
    console.log(`[${getTimestamp()}] Client num updated via API`);
  }
  
  if (crm) {
    CONFIG.crm = crm;
    console.log(`[${getTimestamp()}] CRM updated via API`);
  }
  
  resetTokenExpiredFlag();
  res.json({ success: true, message: 'Config updated' });
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  res.json({
    status: 'alive',
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    uptimeSeconds: uptime,
    monitoredProducts: monitoredProducts.size,
    isMonitoring: !!monitoringInterval,
    hasAuth: !!(CONFIG.token || Object.keys(CONFIG.customHeaders).length > 0),
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

// Test endpoints
app.post('/api/test/stock', async (req, res) => {
  try {
    const { productId } = req.body;
    if (!productId) {
      return res.status(400).json({ error: 'productId is required' });
    }
    const data = await getProductStock(productId);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/test/addtocart', async (req, res) => {
  try {
    const { productId, sizeId } = req.body;
    if (!productId || !sizeId) {
      return res.status(400).json({ error: 'productId and sizeId are required' });
    }
    const result = await addToCart(productId, sizeId);
    res.json({ success: result.success, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const serverStartTime = new Date();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛒 Showroomprivé Stock Monitor - Web Interface              ║
║  Server running on port ${String(PORT).padEnd(37)} ║
║  Started at: ${serverStartTime.toISOString().padEnd(48)} ║
║  Health check: /health or /ping                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  
  if (!CONFIG.token && Object.keys(CONFIG.customHeaders).length === 0) {
    console.log('⚠️ No auth configured - set SRP_HEADERS or SRP_TOKEN + SRP_CLIENT_NUM + SRP_CRM');
  }
});
