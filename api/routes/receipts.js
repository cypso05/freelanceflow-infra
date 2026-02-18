const express = require('express');
const multer = require('multer');
const Joi = require('joi');
const { 
  authMiddleware, 
  initCosmosDB, 
  initBlobStorage, 
  generateId, 
  validate, 
  asyncHandler,
  AppError 
} = require('../_lib/config');

const router = express.Router();
router.use(authMiddleware);

// Configure multer for memory storage
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Invalid file type. Only JPEG, PNG, GIF and PDF are allowed.', 400));
    }
  }
});

// Validation schemas
const receiptMetadataSchema = Joi.object({
  category: Joi.string().valid('office', 'travel', 'software', 'hardware', 'services', 'other').default('other'),
  notes: Joi.string().allow('').max(500),
  tags: Joi.array().items(Joi.string()).optional()
});

// POST upload receipt
router.post('/upload', 
  upload.single('receipt'), 
  validate(receiptMetadataSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError('No file uploaded', 400);
    }

    const { containerClient } = initBlobStorage();
    const { containers } = await initCosmosDB();

    // Generate unique blob name
    const timestamp = Date.now();
    const sanitizedName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const blobName = `${req.user?.id || 'anonymous'}/${timestamp}-${sanitizedName}`;
    
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload to blob storage with metadata
    const metadata = {
      uploadedBy: req.user?.id || 'anonymous',
      originalName: req.file.originalname,
      category: req.body.category || 'other'
    };

    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype },
      metadata: metadata
    });

    // Save receipt metadata to Cosmos DB
    const receiptRecord = {
      id: generateId(),
      fileName: req.file.originalname,
      blobName: blobName,
      url: blockBlobClient.url,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      category: req.body.category || 'other',
      notes: req.body.notes || '',
      tags: req.body.tags || [],
      uploadedAt: new Date().toISOString(),
      uploadedBy: req.user?.id || 'anonymous',
      status: 'pending', // pending, processing, completed, failed
      ocrData: null,
      processedAt: null
    };

    const { resource } = await containers.receipts.items.create(receiptRecord);

    // Trigger async OCR processing (in production, use queue)
    // For now, simulate with setTimeout
    setTimeout(() => processReceiptOCR(resource.id), 100);

    res.status(201).json({ 
      message: 'Receipt uploaded successfully', 
      receipt: {
        id: resource.id,
        fileName: resource.fileName,
        url: resource.url,
        status: resource.status
      }
    });
}));

// GET all receipts for current user
router.get('/', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.uploadedBy = @userId ORDER BY c.uploadedAt DESC',
    parameters: [{ name: '@userId', value: req.user?.id || 'anonymous' }]
  };

  const { resources } = await containers.receipts.items.query(querySpec).fetchAll();
  res.json(resources);
}));

// GET receipt by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource } = await containers.receipts.item(req.params.id, req.params.id).read();
    if (!resource) {
      throw new AppError('Receipt not found', 404);
    }
    
    // Check ownership
    if (resource.uploadedBy !== req.user?.id && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }
    
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Receipt not found', 404);
    }
    throw error;
  }
}));

// POST trigger OCR processing
router.post('/:id/process', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: receipt } = await containers.receipts.item(req.params.id, req.params.id).read();
  if (!receipt) {
    throw new AppError('Receipt not found', 404);
  }

  // Check ownership
  if (receipt.uploadedBy !== req.user?.id && req.user?.role !== 'admin') {
    throw new AppError('Access denied', 403);
  }

  // Update status
  receipt.status = 'processing';
  await containers.receipts.item(req.params.id).replace(receipt);

  // Start async processing
  processReceiptOCR(req.params.id);

  res.json({ message: 'Receipt processing started', receiptId: req.params.id });
}));

// POST generate expense report
router.post('/report/generate', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.body;
  
  if (!startDate || !endDate) {
    throw new AppError('startDate and endDate are required', 400);
  }

  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.uploadedBy = @userId AND c.uploadedAt >= @start AND c.uploadedAt <= @end AND c.status = @status',
    parameters: [
      { name: '@userId', value: req.user?.id || 'anonymous' },
      { name: '@start', value: startDate },
      { name: '@end', value: endDate },
      { name: '@status', value: 'completed' }
    ]
  };

  const { resources } = await containers.receipts.items.query(querySpec).fetchAll();

  // Calculate totals by category
  const categoryTotals = {};
  let totalAmount = 0;

  resources.forEach(receipt => {
    if (receipt.ocrData?.total) {
      const amount = parseFloat(receipt.ocrData.total);
      const category = receipt.category || 'other';
      
      categoryTotals[category] = (categoryTotals[category] || 0) + amount;
      totalAmount += amount;
    }
  });

  const report = {
    generatedAt: new Date().toISOString(),
    generatedBy: req.user?.id,
    period: { startDate, endDate },
    summary: {
      totalReceipts: resources.length,
      totalAmount: totalAmount.toFixed(2),
      processedCount: resources.filter(r => r.status === 'completed').length,
      categoryTotals
    },
    receipts: resources.map(r => ({
      id: r.id,
      fileName: r.fileName,
      date: r.ocrData?.date,
      vendor: r.ocrData?.vendor,
      total: r.ocrData?.total,
      category: r.category,
      url: r.url
    }))
  };

  res.json(report);
}));

// Helper function for OCR processing (mock implementation)
async function processReceiptOCR(receiptId) {
  try {
    const { containers, initCosmosDB } = require('../_lib/config');
    const { containerClient } = initBlobStorage();
    const { containers: dbContainers } = await initCosmosDB();

    // Get receipt record
    const { resource: receipt } = await dbContainers.receipts.item(receiptId, receiptId).read();
    if (!receipt) return;

    // In production, call Azure Computer Vision API here
    // For now, simulate OCR with mock data
    const mockOCRData = {
      vendor: 'Sample Vendor',
      date: new Date().toISOString().split('T')[0],
      total: (Math.random() * 200 + 20).toFixed(2),
      items: ['Item 1', 'Item 2'],
      tax: (Math.random() * 20).toFixed(2),
      currency: 'USD'
    };

    // Update receipt with OCR data
    receipt.ocrData = mockOCRData;
    receipt.status = 'completed';
    receipt.processedAt = new Date().toISOString();

    await dbContainers.receipts.item(receiptId).replace(receipt);
    console.log(`Receipt ${receiptId} processed successfully`);
  } catch (error) {
    console.error(`Failed to process receipt ${receiptId}:`, error);
    
    // Update status to failed
    try {
      const { containers } = await initCosmosDB();
      const { resource: receipt } = await containers.receipts.item(receiptId, receiptId).read();
      if (receipt) {
        receipt.status = 'failed';
        receipt.error = error.message;
        await containers.receipts.item(receiptId).replace(receipt);
      }
    } catch (updateError) {
      console.error('Failed to update receipt status:', updateError);
    }
  }
}

module.exports = router;