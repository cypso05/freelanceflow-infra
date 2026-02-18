const { app } = require('@azure/functions');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const morgan = require('morgan');

// Import your config and routes
const { logger, errorHandler, getAllowedOrigins, initCosmosDB } = require('./_lib/config');
const formsRouter = require('./routes/forms');
const contractsRouter = require('./routes/contracts');
const invoicesRouter = require('./routes/invoices');
const receiptsRouter = require('./routes/receipts');

// Create Express app
const expressApp = express();

// ===== SIMPLIFIED CORS CONFIGURATION =====
// This avoids the 'vary' error by using a simpler approach
const allowedOrigins = getAllowedOrigins();
expressApp.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    // Check if origin is allowed
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    } else {
      // In development, log but don't block
      if (process.env.NODE_ENV !== 'production') {
        console.warn(`CORS: Blocked request from origin: ${origin}`);
        return callback(null, true); // Allow in development
      }
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

// Middleware
expressApp.use(bodyParser.json({ limit: '50mb' }));
expressApp.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
expressApp.use(morgan('combined'));
expressApp.use(logger);

// Health check endpoint
expressApp.get('/api/health', async (req, res) => {
  try {
    await initCosmosDB();
    res.status(200).json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'Degraded',
      database: 'disconnected',
      error: error.message
    });
  }
});

// API routes
expressApp.use('/api/forms', formsRouter);
expressApp.use('/api/contracts', contractsRouter);
expressApp.use('/api/invoices', invoicesRouter);
expressApp.use('/api/receipts', receiptsRouter);

// 404 handler
expressApp.use('/api/*', (req, res) => {
  res.status(404).json({ 
    error: 'API endpoint not found',
    path: req.originalUrl
  });
});

// Error handler
expressApp.use(errorHandler);

// ===== AZURE FUNCTIONS v4 REGISTRATION =====
app.http('api', {
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    authLevel: 'anonymous',
    route: '{*path}',
    handler: async (request, context) => {
        context.log(`Processing ${request.method} request to ${request.url}`);

        // Create a minimal Express-compatible request
        const expressReq = {
            method: request.method,
            url: request.url,
            path: request.url.split('?')[0],
            headers: request.headers,
            query: request.query,
            params: request.params,
            body: request.body,
            get: (name) => request.headers[name.toLowerCase()],
            header: (name) => request.headers[name.toLowerCase()],
            originalUrl: request.url,
            baseUrl: '',
            route: {},
            // Add required methods for Express middlewares
            socket: { remoteAddress: '127.0.0.1' },
            connection: { remoteAddress: '127.0.0.1' },
            on: () => {},
            once: () => {},
            emit: () => {}
        };

        // Add ip address if available
        if (request.headers['x-forwarded-for']) {
            expressReq.ip = request.headers['x-forwarded-for'];
        } else {
            expressReq.ip = '127.0.0.1';
        }

        // Capture the response
        let responseData = null;
        let responseStatus = 200;
        let responseHeaders = {};

        // Create a comprehensive response handler
        const expressRes = {
            // Status methods
            status: (code) => {
                responseStatus = code;
                return expressRes;
            },
            
            // Response methods
            send: (body) => {
                responseData = body;
                return expressRes;
            },
            json: (body) => {
                responseData = body;
                responseHeaders['content-type'] = 'application/json';
                return expressRes;
            },
            sendStatus: (code) => {
                responseStatus = code;
                responseData = '';
                return expressRes;
            },
            
            // Header methods
            setHeader: (name, value) => {
                responseHeaders[name.toLowerCase()] = value;
                return expressRes;
            },
            set: (name, value) => {
                responseHeaders[name.toLowerCase()] = value;
                return expressRes;
            },
            getHeader: (name) => {
                return responseHeaders[name.toLowerCase()];
            },
            getHeaders: () => {
                return { ...responseHeaders };
            },
            hasHeader: (name) => {
                return name.toLowerCase() in responseHeaders;
            },
            removeHeader: (name) => {
                delete responseHeaders[name.toLowerCase()];
                return expressRes;
            },
            
            // Content-type helper
            type: (type) => {
                responseHeaders['content-type'] = type;
                return expressRes;
            },
            
            // End and write methods
            end: () => expressRes,
            write: (chunk) => {
                if (!responseData) responseData = '';
                responseData += chunk;
                return true;
            },
            writeHead: (status, headers) => {
                responseStatus = status;
                if (headers) {
                    Object.entries(headers).forEach(([key, value]) => {
                        responseHeaders[key.toLowerCase()] = value;
                    });
                }
                return expressRes;
            },
            
            // Vary method (fixes the CORS error)
            vary: (field) => {
                const value = responseHeaders['vary'] || '';
                if (!value.includes(field)) {
                    responseHeaders['vary'] = value ? `${value}, ${field}` : field;
                }
                return expressRes;
            },
            
            // Flush methods
            flushHeaders: () => {},
            
            // Event emitter methods
            on: () => {},
            once: () => {},
            emit: () => {},
            
            // Properties that might be accessed
            headersSent: false,
            statusCode: responseStatus,
            locals: {}
        };

        // Let Express handle the request
        await expressApp(expressReq, expressRes);

        return {
            status: responseStatus,
            headers: responseHeaders,
            body: responseData
        };
    }
});

console.log('✅ Azure Functions v4 app initialized with Express integration');
console.log('📡 API endpoints available at:');
console.log('   GET  /api/health');
console.log('   GET  /api/forms');
console.log('   GET  /api/contracts');
console.log('   GET  /api/invoices');
console.log('   GET  /api/receipts');
console.log('   POST /api/forms');
console.log('   POST /api/contracts');
console.log('   POST /api/invoices');
console.log('   POST /api/receipts/upload');