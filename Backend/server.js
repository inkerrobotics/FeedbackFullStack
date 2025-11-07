const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const webhookRoutes = require('./routes/webhook');
const whatsappRoutes = require('./routes/whatsapp');
const feedbackRoutes = require('./routes/feedback');
const { getCorsOrigins, logConfiguration } = require('./utils/urlConfig');

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:', 'ws:', 'wss:'],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      fontSrc: ["'self'", 'data:', 'https:']
    }
  },
  crossOriginEmbedderPolicy: false
}));

// CORS configuration with dynamic origins
const corsOptions = {
  origin: getCorsOrigins(),
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};
app.use(cors(corsOptions));

// Logging middleware
app.use(morgan('combined'));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: require('./package.json').version
  });
});

// CORS Proxy endpoint for WhatsApp flow downloads
app.get('/api/proxy/flow-json', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing url parameter'
      });
    }

    console.log('📥 Proxying flow JSON request:', url);

    // Fetch the JSON from WhatsApp's download URL
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.error('❌ Failed to fetch from download URL:', response.status);
      return res.status(response.status).json({
        success: false,
        error: `Failed to fetch: ${response.statusText}`
      });
    }

    const jsonData = await response.json();
    console.log('✅ Flow JSON fetched successfully via proxy');

    res.json({
      success: true,
      data: jsonData
    });
  } catch (error) {
    console.error('❌ Proxy error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to proxy request'
    });
  }
});

// API routes
app.use('/webhook', webhookRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/feedback', feedbackRoutes);

// Server-Sent Events endpoint for real-time updates
const sseService = require('./services/sseService');
app.get('/api/events', (req, res) => {
  sseService.addClient(res);
});

// Serve static files from public directory (frontend build)
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// API status endpoint
app.get('/api', (req, res) => {
  res.json({
    message: 'WhatsApp Feedback Collection API is running!',
    version: require('./package.json').version,
    endpoints: {
      webhook: '/webhook',
      whatsapp: '/api/whatsapp',
      feedback: '/api/feedback',
      health: '/health',
      events: '/api/events'
    },
    description: 'WhatsApp Business API backend for collecting user feedback through conversation flow'
  });
});

// Serve frontend for all non-API routes (SPA routing)
app.get('*', (req, res) => {
  // Don't serve frontend for API routes
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
    return res.status(404).json({
      error: 'API endpoint not found',
      message: `Route ${req.method} ${req.originalUrl} not found`
    });
  }
  
  // Serve frontend index.html for all other routes
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

const PORT = process.env.PORT || 8080;
// Always bind to 0.0.0.0 in production or when PORT is set by platform (Render, Railway, etc.)
// This allows external connections
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : 'localhost');

app.listen(PORT, HOST, () => {
  console.log(`🚀 WhatsApp Webhook Server running on http://${HOST}:${PORT}`);
  console.log(`📱 Webhook URL: http://${HOST}:${PORT}/webhook`);
  console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Log dynamic URL configuration
  logConfiguration();
  
  console.log('✅ Server is ready to accept requests');
  console.log(`🔌 Binding to: ${HOST}:${PORT} (accessible externally: ${HOST === '0.0.0.0' ? 'YES' : 'NO'})`);
});

module.exports = app;