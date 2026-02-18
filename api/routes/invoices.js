const express = require('express');
const Joi = require('joi');
const { 
  authMiddleware, 
  initCosmosDB, 
  generateId, 
  validate, 
  asyncHandler,
  AppError 
} = require('../_lib/config');

const router = express.Router();
router.use(authMiddleware);

// Validation schemas
const invoiceItemSchema = Joi.object({
  description: Joi.string().required().max(500),
  quantity: Joi.number().positive().required(),
  unitPrice: Joi.number().positive().required(),
  amount: Joi.number().positive().optional(),
  taxRate: Joi.number().min(0).max(100).default(0)
});

const invoiceSchema = Joi.object({
  invoiceNumber: Joi.string().required().pattern(/^INV-\d{4}-\d+$/).messages({
    'string.pattern.base': 'Invoice number must follow format: INV-YYYY-####'
  }),
  clientName: Joi.string().required().min(2).max(100),
  clientEmail: Joi.string().email().required(),
  clientAddress: Joi.string().allow('').max(500),
  clientCompany: Joi.string().allow('').max(100),
  items: Joi.array().items(invoiceItemSchema).required().min(1),
  taxRate: Joi.number().min(0).max(100).default(0),
  discount: Joi.number().min(0).max(100).default(0),
  status: Joi.string().valid('draft', 'sent', 'paid', 'overdue', 'cancelled').default('draft'),
  dueDate: Joi.date().iso().required(),
  issueDate: Joi.date().iso().default(() => new Date().toISOString().split('T')[0]),
  notes: Joi.string().allow('').max(1000),
  termsAndConditions: Joi.string().allow('').max(2000),
  currency: Joi.string().length(3).default('USD'),
  paymentMethod: Joi.string().valid('bank_transfer', 'credit_card', 'paypal', 'cash', 'check').optional()
});

// Helper function to calculate invoice totals
const calculateInvoiceTotals = (invoice) => {
  // Calculate subtotal from items
  const subtotal = invoice.items.reduce((sum, item) => {
    const itemAmount = item.quantity * item.unitPrice;
    return sum + itemAmount;
  }, 0);

  // Apply discount
  const discountAmount = subtotal * (invoice.discount / 100);
  const afterDiscount = subtotal - discountAmount;

  // Apply tax
  const taxAmount = afterDiscount * (invoice.taxRate / 100);
  const total = afterDiscount + taxAmount;

  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    taxAmount: parseFloat(taxAmount.toFixed(2)),
    total: parseFloat(total.toFixed(2))
  };
};

// GET all invoices for current user
router.get('/', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.userId = @userId ORDER BY c.issueDate DESC',
    parameters: [{ name: '@userId', value: req.user?.id || 'anonymous' }]
  };

  const { resources } = await containers.invoices.items.query(querySpec).fetchAll();
  res.json(resources);
}));

// GET invoice by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource } = await containers.invoices.item(req.params.id, req.params.id).read();
    if (!resource) {
      throw new AppError('Invoice not found', 404);
    }
    
    // Check ownership
    if (resource.userId !== req.user?.id && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }
    
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Invoice not found', 404);
    }
    throw error;
  }
}));

// GET invoice by invoice number
router.get('/number/:invoiceNumber', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.invoiceNumber = @invoiceNumber AND c.userId = @userId',
    parameters: [
      { name: '@invoiceNumber', value: req.params.invoiceNumber },
      { name: '@userId', value: req.user?.id || 'anonymous' }
    ]
  };

  const { resources } = await containers.invoices.items.query(querySpec).fetchAll();
  
  if (resources.length === 0) {
    throw new AppError('Invoice not found', 404);
  }
  
  res.json(resources[0]);
}));

// POST create invoice
router.post('/', validate(invoiceSchema), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  // Check if invoice number already exists for this user
  const checkQuery = {
    query: 'SELECT * FROM c WHERE c.invoiceNumber = @invoiceNumber AND c.userId = @userId',
    parameters: [
      { name: '@invoiceNumber', value: req.body.invoiceNumber },
      { name: '@userId', value: req.user?.id || 'anonymous' }
    ]
  };
  
  const { resources: existing } = await containers.invoices.items.query(checkQuery).fetchAll();
  if (existing.length > 0) {
    throw new AppError('Invoice number already exists', 409);
  }

  // Calculate amounts for each item
  const itemsWithAmounts = req.body.items.map(item => ({
    ...item,
    amount: parseFloat((item.quantity * item.unitPrice).toFixed(2))
  }));

  const invoiceData = {
    ...req.body,
    items: itemsWithAmounts,
    userId: req.user?.id || 'anonymous'
  };

  const totals = calculateInvoiceTotals(invoiceData);

  const newInvoice = {
    id: generateId(),
    ...invoiceData,
    ...totals,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: req.user?.id || 'system',
    version: 1,
    paymentHistory: []
  };
  
  const { resource } = await containers.invoices.items.create(newInvoice);
  res.status(201).json(resource);
}));

// PUT update invoice
router.put('/:id', validate(invoiceSchema), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource: existing } = await containers.invoices.item(req.params.id, req.params.id).read();
    if (!existing) {
      throw new AppError('Invoice not found', 404);
    }

    // Check ownership
    if (existing.userId !== req.user?.id && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }

    // Check if invoice can be updated (not paid/cancelled)
    if (existing.status === 'paid' || existing.status === 'cancelled') {
      throw new AppError(`Cannot update ${existing.status} invoice`, 400);
    }

    // Calculate amounts for each item
    const itemsWithAmounts = req.body.items.map(item => ({
      ...item,
      amount: parseFloat((item.quantity * item.unitPrice).toFixed(2))
    }));

    const invoiceData = {
      ...req.body,
      items: itemsWithAmounts
    };

    const totals = calculateInvoiceTotals(invoiceData);

    const updatedInvoice = {
      ...existing,
      ...invoiceData,
      ...totals,
      id: req.params.id,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.id || 'system',
      version: (existing.version || 0) + 1
    };
    
    const { resource } = await containers.invoices.item(req.params.id).replace(updatedInvoice);
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Invoice not found', 404);
    }
    throw error;
  }
}));

// PATCH update invoice status
router.patch('/:id/status', validate(Joi.object({
  status: Joi.string().valid('draft', 'sent', 'paid', 'overdue', 'cancelled').required(),
  paymentReference: Joi.string().when('status', { is: 'paid', then: Joi.required() }),
  paymentDate: Joi.date().iso().when('status', { is: 'paid', then: Joi.required() })
})), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: invoice } = await containers.invoices.item(req.params.id, req.params.id).read();
  if (!invoice) {
    throw new AppError('Invoice not found', 404);
  }

  // Check ownership
  if (invoice.userId !== req.user?.id && req.user?.role !== 'admin') {
    throw new AppError('Access denied', 403);
  }

  invoice.status = req.body.status;
  invoice.updatedAt = new Date().toISOString();

  // If marked as paid, record payment
  if (req.body.status === 'paid') {
    invoice.paidAt = req.body.paymentDate || new Date().toISOString();
    invoice.paymentReference = req.body.paymentReference;
    
    // Add to payment history
    if (!invoice.paymentHistory) invoice.paymentHistory = [];
    invoice.paymentHistory.push({
      date: invoice.paidAt,
      amount: invoice.total,
      reference: req.body.paymentReference,
      status: 'completed'
    });
  }

  const { resource } = await containers.invoices.item(req.params.id).replace(invoice);
  res.json(resource);
}));

// POST send invoice (would integrate with email service)
router.post('/:id/send', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: invoice } = await containers.invoices.item(req.params.id, req.params.id).read();
  if (!invoice) {
    throw new AppError('Invoice not found', 404);
  }

  // Check ownership
  if (invoice.userId !== req.user?.id && req.user?.role !== 'admin') {
    throw new AppError('Access denied', 403);
  }

  // Update status to sent if it's draft
  if (invoice.status === 'draft') {
    invoice.status = 'sent';
    invoice.sentAt = new Date().toISOString();
    invoice.updatedAt = new Date().toISOString();
    await containers.invoices.item(req.params.id).replace(invoice);
  }

  // In production, trigger email sending here
  // await emailService.sendInvoice(invoice);

  res.json({ 
    message: 'Invoice marked as sent', 
    invoiceId: invoice.id,
    sentAt: invoice.sentAt 
  });
}));

// DELETE invoice (soft delete)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource: existing } = await containers.invoices.item(req.params.id, req.params.id).read();
    if (!existing) {
      throw new AppError('Invoice not found', 404);
    }

    // Check ownership
    if (existing.userId !== req.user?.id && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }

    // Check if invoice can be deleted (only draft or cancelled)
    if (existing.status !== 'draft' && existing.status !== 'cancelled') {
      throw new AppError(`Cannot delete invoice with status: ${existing.status}`, 400);
    }

    // Soft delete
    existing.isActive = false;
    existing.deletedAt = new Date().toISOString();
    existing.deletedBy = req.user?.id || 'system';
    
    await containers.invoices.item(req.params.id).replace(existing);
    res.status(204).send();
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Invoice not found', 404);
    }
    throw error;
  }
}));

// Webhook for payment processing (no auth required)
router.post('/webhook/payment', asyncHandler(async (req, res) => {
  // Verify webhook signature in production
  const { invoiceId, transactionId, amount, paymentMethod, status } = req.body;

  if (!invoiceId || !transactionId || !status) {
    throw new AppError('Missing required fields', 400);
  }

  const { containers } = await initCosmosDB();

  try {
    const { resource: invoice } = await containers.invoices.item(invoiceId, invoiceId).read();
    if (!invoice) {
      throw new AppError('Invoice not found', 404);
    }

    if (status === 'completed' || status === 'succeeded') {
      invoice.status = 'paid';
      invoice.paidAt = new Date().toISOString();
      invoice.transactionId = transactionId;
      invoice.paymentMethod = paymentMethod || invoice.paymentMethod;
      
      if (!invoice.paymentHistory) invoice.paymentHistory = [];
      invoice.paymentHistory.push({
        date: invoice.paidAt,
        amount: amount || invoice.total,
        transactionId,
        status: 'completed'
      });

      await containers.invoices.item(invoiceId).replace(invoice);
    }

    res.status(200).json({ 
      message: 'Payment webhook processed', 
      invoiceId,
      status: invoice.status 
    });
  } catch (error) {
    console.error('Payment webhook error:', error);
    // Always return 200 to acknowledge receipt
    res.status(200).json({ message: 'Webhook received', error: error.message });
  }
}));

// GET invoice statistics
router.get('/stats/summary', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.userId = @userId',
    parameters: [{ name: '@userId', value: req.user?.id || 'anonymous' }]
  };

  const { resources } = await containers.invoices.items.query(querySpec).fetchAll();

  const stats = {
    total: resources.length,
    byStatus: {
      draft: resources.filter(i => i.status === 'draft').length,
      sent: resources.filter(i => i.status === 'sent').length,
      paid: resources.filter(i => i.status === 'paid').length,
      overdue: resources.filter(i => i.status === 'overdue').length,
      cancelled: resources.filter(i => i.status === 'cancelled').length
    },
    financial: {
      totalPaid: resources
        .filter(i => i.status === 'paid')
        .reduce((sum, i) => sum + (i.total || 0), 0),
      totalOutstanding: resources
        .filter(i => i.status === 'sent' || i.status === 'overdue')
        .reduce((sum, i) => sum + (i.total || 0), 0),
      totalDraft: resources
        .filter(i => i.status === 'draft')
        .reduce((sum, i) => sum + (i.total || 0), 0)
    }
  };

  res.json(stats);
}));

module.exports = router;