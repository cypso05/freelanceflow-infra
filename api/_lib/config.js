const { CosmosClient } = require('@azure/cosmos');
const { BlobServiceClient } = require('@azure/storage-blob');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ==================== Database Clients ====================
let cosmosClient = null;
let database = null;
let containers = {};

const initCosmosDB = async () => {
  if (cosmosClient) return { database, containers };

  const connectionString = process.env.COSMOS_DB_CONNECTION_STRING;
  const databaseName = process.env.COSMOS_DATABASE_NAME || 'freelanceflow-db';

  if (!connectionString) {
    throw new Error('COSMOS_DB_CONNECTION_STRING environment variable not set');
  }

  try {
    cosmosClient = new CosmosClient(connectionString);
    database = (await cosmosClient.databases.createIfNotExists({ id: databaseName })).database;

    // Create containers if they don't exist with appropriate partition keys
    const containerConfigs = [
      { id: 'forms', partitionKey: '/id' },
      { id: 'contracts', partitionKey: '/id' },
      { id: 'invoices', partitionKey: '/id' },
      { id: 'receipts', partitionKey: '/id' },
      { id: 'users', partitionKey: '/id' }
    ];

    for (const config of containerConfigs) {
      const { container } = await database.containers.createIfNotExists(config);
      containers[config.id] = container;
    }

    console.log('Cosmos DB initialized successfully');
    return { database, containers };
  } catch (error) {
    console.error('Failed to initialize Cosmos DB:', error);
    throw error;
  }
};

// ==================== Blob Storage Client ====================
let blobServiceClient = null;
let containerClient = null;

const initBlobStorage = () => {
  if (blobServiceClient) return { blobServiceClient, containerClient };

  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.BLOB_CONTAINER_NAME || 'uploads';

  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING environment variable not set');
  }

  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(containerName);

    // Ensure container exists (async)
    containerClient.createIfNotExists().catch(err => 
      console.error('Failed to create blob container:', err)
    );

    console.log('Blob storage initialized successfully');
    return { blobServiceClient, containerClient };
  } catch (error) {
    console.error('Failed to initialize Blob storage:', error);
    throw error;
  }
};

// ==================== CORS Configuration ====================
const getAllowedOrigins = () => {
  const origins = process.env.ALLOWED_ORIGINS?.split(',') || [];
  return origins.length > 0 ? origins : ['http://localhost:4280'];
};

// ==================== Auth Middleware ====================
const jwt = require('jsonwebtoken');

const authMiddleware = async (req, res, next) => {
  // Skip auth for webhook endpoints
  if (req.path.includes('/webhook/')) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// ==================== Error Handling ====================
class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  console.error(`${new Date().toISOString()} - API Error:`, {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });

  if (err instanceof AppError) {
    return res.status(err.status).json({ 
      error: err.message,
      code: err.status 
    });
  }

  // Cosmos DB specific errors
  if (err.code === 409) {
    return res.status(409).json({ error: 'Resource already exists' });
  }
  if (err.code === 412) {
    return res.status(412).json({ error: 'Precondition failed' });
  }
  if (err.code === 429) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Default error
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal Server Error' 
    : err.message;

  res.status(status).json({ 
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

// ==================== Logging ====================
const logger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `${new Date().toISOString()} - ${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`
    );
  });
  
  next();
};

// ==================== Utility Functions ====================
const generateId = () => {
  const { v4: uuidv4 } = require('uuid');
  return uuidv4();
};

// Validation helper with improved error formatting
const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true
  });
  
  if (error) {
    const errors = error.details.map(detail => ({
      field: detail.path.join('.'),
      message: detail.message
    }));
    return res.status(400).json({ 
      error: 'Validation failed',
      details: errors 
    });
  }
  
  // Replace req.body with validated value
  req.body = value;
  next();
};

// Async wrapper to catch errors in route handlers
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  initCosmosDB,
  initBlobStorage,
  authMiddleware,
  errorHandler,
  logger,
  generateId,
  validate,
  asyncHandler,
  AppError,
  getAllowedOrigins
};