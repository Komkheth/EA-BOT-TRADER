// server.js - Full backend with Scalper and BTC strategies
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');
const winston = require('winston');
const cron = require('node-cron');
const { RateLimiterMemory } = require('rate-limit-flexible');

// Import strategies
const ScalperStrategy = require('./strategies/scalper');
const BTCTrader = require('./strategies/btc_trader');

// ============ LOGGING ============
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// ============ APP SETUP ============
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ============ MIDDLEWARE ============
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimiter = new RateLimiterMemory({ points: 100, duration: 60 });
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch {
    res.status(429).json({ success: false, error: 'Too many requests' });
  }
});

// ============ PYTHON BRIDGE ============
let pythonProcess = null;
let bridgeReady = false;
let pendingRequests = new Map();
let requestId = 0;

function initPythonBridge() {
  return new Promise((resolve, reject) => {
    if (pythonProcess) {
      resolve(true);
      return;
    }

    logger.info('Starting Python MT5 bridge...');
    pythonProcess = spawn(process.env.PYTHON_PATH || 'python3', ['mt5_bridge.py']);
    
    pythonProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      logger.info(`Python: ${chunk.trim()}`);
      
      if (chunk.includes('MT5 initialized') || chunk.includes('Bridge ready')) {
        bridgeReady = true;
        resolve(true);
      }

      try {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('{')) {
            const response = JSON.parse(line);
            if (response.id && pendingRequests.has(response.id)) {
              const { resolve, reject } = pendingRequests.get(response.id);
              pendingRequests.delete(response.id);
              if (response.success === false) {
                reject(new Error(response.error || 'Python bridge error'));
              } else {
                resolve(response);
              }
            }
          }
        }
      } catch (e) {
        // Not JSON, ignore
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      logger.error(`Python Error: ${data}`);
    });

    pythonProcess.on('close', (code) => {
      logger.warn(`Python process exited with code ${code}`);
      bridgeReady = false;
      pythonProcess = null;
    });

    setTimeout(() => {
      if (!bridgeReady) {
        reject(new Error('Python bridge initialization timeout'));
      }
    }, 15000);
  });
}

function callPython(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!pythonProcess || !bridgeReady) {
      reject(new Error('Python bridge not ready'));
      return;
    }

    const id = ++requestId;
    const command = { method, params, id };
    pendingRequests.set(id, { resolve, reject });
    pythonProcess.stdin.write(JSON.stringify(command) + '\n');

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Python bridge timeout'));
      }
    }, 10000);
  });
}

// ============ INITIALIZE STRATEGIES ============
const scalper = new ScalperStrategy(callPython);
const btcTrader = new BTCTrader(callPython);

// ============ WEBSOCKET ============
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);
  
  let marketInterval;
  let scalperInterval;
  
  socket.on('subscribe', async (data) => {
    const { type, symbol } = data;
    
    if (type === 'market') {
      marketInterval = setInterval(async () => {
        try {
          const data = await callPython('get_market_data', { 
            symbol: symbol || 'EURUSD', 
            timeframe: 'M1', 
            bars: 60 
          });
          socket.emit('market_update', data);
        } catch (error) {
          socket.emit('error', { message: error.message });
        }
      }, 3000);
    }
    
    if (type === 'scalper') {
      scalperInterval = setInterval(async () => {
        try {
          const status = await scalper.getStatus();
          socket.emit('scalper_update', status);
        } catch (error) {
          socket.emit('error', { message: error.message });
        }
      }, 5000);
    }
    
    socket.on('disconnect', () => {
      clearInterval(marketInterval);
      clearInterval(scalperInterval);
    });
  });
});

// ============ API ENDPOINTS ============

// Health check
app.get('/api/health', async (req, res) => {
  const scalperStatus = await scalper.getStatus();
  const btcStatus = await btcTrader.getStatus();
  res.json({
    status: 'ok',
    bridge_ready: bridgeReady,
    scalper: scalperStatus,
    btc: btcStatus,
    timestamp: new Date().toISOString()
  });
});

// Account info
app.get('/api/account', async (req, res) => {
  try {
    const result = await callPython('get_account_info');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ SCALPER ENDPOINTS ============
app.get('/api/scalper/status', async (req, res) => {
  try {
    const status = await scalper.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scalper/trade', async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await scalper.executeTrade(symbol || 'EURUSD');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scalper/settings', async (req, res) => {
  try {
    const settings = req.body;
    await scalper.updateSettings(settings);
    const status = await scalper.getStatus();
    res.json({ success: true, settings: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scalper/toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    const result = await scalper.toggle(enabled);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ BTC ENDPOINTS ============
app.get('/api/btc/status', async (req, res) => {
  try {
    const status = await btcTrader.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/btc/trade', async (req, res) => {
  try {
    const { signal } = req.body;
    const result = await btcTrader.executeTrade(signal || 'auto');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/btc/settings', async (req, res) => {
  try {
    const settings = req.body;
    await btcTrader.updateSettings(settings);
    const status = await btcTrader.getStatus();
    res.json({ success: true, settings: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ MARKET DATA ============
app.get('/api/market/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { timeframe = 'M1', bars = 100 } = req.query;
    const result = await callPython('get_market_data', { symbol, timeframe, bars });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ ORDER MANAGEMENT ============
app.post('/api/order', async (req, res) => {
  try {
    const { symbol, type, volume, sl, tp } = req.body;
    const result = await callPython('place_order', { symbol, order_type: type, volume, sl, tp });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/position/:id', async (req, res) => {
  try {
    const positionId = parseInt(req.params.id);
    const result = await callPython('close_position', { position_id: positionId });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ MT5 LOGIN ============
app.post('/api/login', async (req, res) => {
  try {
    const { login, password, server } = req.body;
    const result = await callPython('login', { login, password, server });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CRON JOBS ============
// Scalper runs every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  logger.info('Running Scalper strategy...');
  try {
    const result = await scalper.executeTrade('EURUSD');
    if (result.success) {
      logger.info(`Scalper trade: ${result.direction} ${result.lotSize} lots on ${result.symbol}`);
      io.emit('scalper_trade', result);
    }
  } catch (error) {
    logger.error(`Scalper error: ${error.message}`);
  }
});

// BTC trader runs every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  logger.info('Running BTC strategy...');
  try {
    const result = await btcTrader.executeTrade('auto');
    if (result.success) {
      logger.info(`BTC trade: ${result.direction} ${result.lotSize} lots`);
      io.emit('btc_trade', result);
    }
  } catch (error) {
    logger.error(`BTC error: ${error.message}`);
  }
});

// ============ SERVE DASHBOARD ============
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ============ START SERVER ============
async function startServer() {
  try {
    if (!fs.existsSync('logs')) fs.mkdirSync('logs');

    await initPythonBridge();
    logger.info('✅ Python bridge ready');
    logger.info('📈 Scalper Strategy initialized');
    logger.info('₿ BTC Trader initialized');

    server.listen(PORT, () => {
      logger.info(`🚀 Server running on http://localhost:${PORT}`);
      logger.info(`📊 Dashboard: http://localhost:${PORT}`);
      logger.info(`⚡ Scalper: EURUSD, GBPUSD, USDJPY`);
      logger.info(`₿ BTC: BTCUSD`);
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  logger.info('Shutting down...');
  if (pythonProcess) pythonProcess.kill();
  io.close();
  server.close(() => process.exit(0));
});

startServer();
