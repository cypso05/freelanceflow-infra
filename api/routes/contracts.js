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
const contractClauseSchema = Joi.object({
  title: Joi.string().required(),
  content: Joi.string().required(),
  order: Joi.number().integer().min(0).default(0)
});

const contractPartySchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  company: Joi.string().allow(''),
  address: Joi.string().allow(''),
  role: Joi.string().valid('client', 'contractor', 'both').default('client')
});

const contractSchema = Joi.object({
  title: Joi.string().required().min(3).max(200),
  description: Joi.string().allow('').max(1000),
  contractNumber: Joi.string().required().pattern(/^CTR-\d{4}-\d+$/).messages({
    'string.pattern.base': 'Contract number must follow format: CTR-YYYY-####'
  }),
  type: Joi.string().valid('service', 'nda', 'employment', 'partnership', 'other').required(),
  client: contractPartySchema.required(),
  parties: Joi.array().items(contractPartySchema).min(1),
  content: Joi.string().required(), // HTML or Markdown content
  clauses: Joi.array().items(contractClauseSchema).optional(),
  status: Joi.string().valid('draft', 'sent', 'viewed', 'signed', 'expired', 'cancelled').default('draft'),
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().min(Joi.ref('startDate')).optional(),
  value: Joi.number().positive().optional(),
  currency: Joi.string().length(3).default('USD'),
  paymentTerms: Joi.string().allow('').max(500),
  specialConditions: Joi.string().allow('').max(2000),
  requiresESignature: Joi.boolean().default(true)
});

// GET all contracts for current user
router.get('/', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.userId = @userId ORDER BY c.createdAt DESC',
    parameters: [{ name: '@userId', value: req.user?.id || 'anonymous' }]
  };

  const { resources } = await containers.contracts.items.query(querySpec).fetchAll();
  res.json(resources);
}));

// GET contract by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource } = await containers.contracts.item(req.params.id, req.params.id).read();
    if (!resource) {
      throw new AppError('Contract not found', 404);
    }
    
    // Check ownership or if client
    const isOwner = resource.userId === req.user?.id;
    const isClient = resource.client.email === req.user?.email;
    
    if (!isOwner && !isClient && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }
    
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Contract not found', 404);
    }
    throw error;
  }
}));

// GET contract by contract number
router.get('/number/:contractNumber', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.contractNumber = @contractNumber',
    parameters: [{ name: '@contractNumber', value: req.params.contractNumber }]
  };

  const { resources } = await containers.contracts.items.query(querySpec).fetchAll();
  
  if (resources.length === 0) {
    throw new AppError('Contract not found', 404);
  }
  
  res.json(resources[0]);
}));

// POST create contract
router.post('/', validate(contractSchema), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  // Check if contract number already exists
  const checkQuery = {
    query: 'SELECT * FROM c WHERE c.contractNumber = @contractNumber',
    parameters: [{ name: '@contractNumber', value: req.body.contractNumber }]
  };
  
  const { resources: existing } = await containers.contracts.items.query(checkQuery).fetchAll();
  if (existing.length > 0) {
    throw new AppError('Contract number already exists', 409);
  }

  const newContract = {
    id: generateId(),
    ...req.body,
    userId: req.user?.id || 'anonymous',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: req.user?.id || 'system',
    version: 1,
    signatureHistory: [],
    viewedBy: []
  };
  
  const { resource } = await containers.contracts.items.create(newContract);
  res.status(201).json(resource);
}));

// PUT update contract
router.put('/:id', validate(contractSchema), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource: existing } = await containers.contracts.item(req.params.id, req.params.id).read();
    if (!existing) {
      throw new AppError('Contract not found', 404);
    }

    // Check ownership
    if (existing.userId !== req.user?.id && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }

    // Check if contract can be updated
    if (existing.status === 'signed' || existing.status === 'expired') {
      throw new AppError(`Cannot update ${existing.status} contract`, 400);
    }

    const updatedContract = {
      ...existing,
      ...req.body,
      id: req.params.id,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.id || 'system',
      version: (existing.version || 0) + 1
    };
    
    const { resource } = await containers.contracts.item(req.params.id).replace(updatedContract);
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Contract not found', 404);
    }
    throw error;
  }
}));

// POST send contract to client
router.post('/:id/send', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: contract } = await containers.contracts.item(req.params.id, req.params.id).read();
  if (!contract) {
    throw new AppError('Contract not found', 404);
  }

  // Check ownership
  if (contract.userId !== req.user?.id && req.user?.role !== 'admin') {
    throw new AppError('Access denied', 403);
  }

  // Update status
  contract.status = 'sent';
  contract.sentAt = new Date().toISOString();
  contract.updatedAt = new Date().toISOString();
  
  // Add to history
  if (!contract.statusHistory) contract.statusHistory = [];
  contract.statusHistory.push({
    status: 'sent',
    date: contract.sentAt,
    by: req.user?.id
  });

  // In production, send email with signing link
  // const signingLink = generateSigningLink(contract.id);
  // await emailService.sendContract(contract.client.email, signingLink);

  await containers.contracts.item(req.params.id).replace(contract);

  res.json({ 
    message: 'Contract sent to client', 
    contractId: contract.id,
    sentAt: contract.sentAt
  });
}));

// POST sign contract
router.post('/:id/sign', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: contract } = await containers.contracts.item(req.params.id, req.params.id).read();
  if (!contract) {
    throw new AppError('Contract not found', 404);
  }

  // Check if contract can be signed
  if (contract.status !== 'sent' && contract.status !== 'viewed') {
    throw new AppError(`Contract cannot be signed (status: ${contract.status})`, 400);
  }

  // Verify signer is the client or authorized party
  const isClient = contract.client.email === req.user?.email;
  const isOwner = contract.userId === req.user?.id;
  
  if (!isClient && !isOwner && req.user?.role !== 'admin') {
    throw new AppError('Not authorized to sign this contract', 403);
  }

  // Record signature
  const signature = {
    signedBy: req.user?.email || contract.client.email,
    signedAt: new Date().toISOString(),
    ipAddress: req.ip,
    userAgent: req.get('User-Agent')
  };

  if (!contract.signatureHistory) contract.signatureHistory = [];
  contract.signatureHistory.push(signature);

  // Update status
  contract.status = 'signed';
  contract.signedAt = signature.signedAt;
  contract.signedBy = signature.signedBy;
  contract.updatedAt = new Date().toISOString();

  await containers.contracts.item(req.params.id).replace(contract);

  res.json({ 
    message: 'Contract signed successfully', 
    contractId: contract.id,
    signature: signature
  });
}));

// POST record contract view
router.post('/:id/view', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: contract } = await containers.contracts.item(req.params.id, req.params.id).read();
  if (!contract) {
    throw new AppError('Contract not found', 404);
  }

  // Record view
  const view = {
    viewedBy: req.user?.email || 'anonymous',
    viewedAt: new Date().toISOString(),
    ipAddress: req.ip
  };

  if (!contract.viewedBy) contract.viewedBy = [];
  contract.viewedBy.push(view);

  // Update status if it's still draft/sent
  if (contract.status === 'sent') {
    contract.status = 'viewed';
  }
  
  contract.updatedAt = new Date().toISOString();
  await containers.contracts.item(req.params.id).replace(contract);

  res.json({ message: 'Contract view recorded' });
}));

// POST generate contract from template
router.post('/from-template/:templateId', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  // In production, fetch template from database
  // const { resource: template } = await containers.templates.item(req.params.templateId).read();
  
  // For now, create a basic contract
  const newContract = {
    id: generateId(),
    title: req.body.title || 'New Contract',
    contractNumber: `CTR-${new Date().getFullYear()}-${Math.floor(Math.random() * 10000)}`,
    type: req.body.type || 'service',
    client: req.body.client,
    content: req.body.content || 'Contract content here',
    status: 'draft',
    startDate: new Date().toISOString().split('T')[0],
    userId: req.user?.id || 'anonymous',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const { resource } = await containers.contracts.items.create(newContract);
  res.status(201).json(resource);
}));

// POST renew contract
router.post('/:id/renew', validate(Joi.object({
  newEndDate: Joi.date().iso().required(),
  modifications: Joi.string().allow('')
})), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const { resource: existing } = await containers.contracts.item(req.params.id, req.params.id).read();
  if (!existing) {
    throw new AppError('Contract not found', 404);
  }

  // Check ownership
  if (existing.userId !== req.user?.id && req.user?.role !== 'admin') {
    throw new AppError('Access denied', 403);
  }

  // Create renewal version
  const renewedContract = {
    ...existing,
    id: generateId(), // New ID
    originalContractId: existing.id,
    contractNumber: `${existing.contractNumber}-R${(existing.renewalCount || 0) + 1}`,
    status: 'draft',
    startDate: existing.endDate,
    endDate: req.body.newEndDate,
    renewalCount: (existing.renewalCount || 0) + 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    modifications: req.body.modifications
  };

  delete renewedContract._rid;
  delete renewedContract._self;
  delete renewedContract._etag;
  delete renewedContract._attachments;
  delete renewedContract._ts;

  const { resource } = await containers.contracts.items.create(renewedContract);
  res.status(201).json(resource);
}));

// DELETE contract (soft delete)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource: existing } = await containers.contracts.item(req.params.id, req.params.id).read();
    if (!existing) {
      throw new AppError('Contract not found', 404);
    }

    // Check ownership
    if (existing.userId !== req.user?.id && req.user?.role !== 'admin') {
      throw new AppError('Access denied', 403);
    }

    // Check if contract can be deleted
    if (existing.status === 'signed') {
      throw new AppError('Cannot delete signed contract', 400);
    }

    // Soft delete
    existing.isActive = false;
    existing.deletedAt = new Date().toISOString();
    existing.deletedBy = req.user?.id || 'system';
    
    await containers.contracts.item(req.params.id).replace(existing);
    res.status(204).send();
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Contract not found', 404);
    }
    throw error;
  }
}));

// GET contract statistics
router.get('/stats/summary', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.userId = @userId',
    parameters: [{ name: '@userId', value: req.user?.id || 'anonymous' }]
  };

  const { resources } = await containers.contracts.items.query(querySpec).fetchAll();

  const stats = {
    total: resources.length,
    byStatus: {
      draft: resources.filter(c => c.status === 'draft').length,
      sent: resources.filter(c => c.status === 'sent').length,
      viewed: resources.filter(c => c.status === 'viewed').length,
      signed: resources.filter(c => c.status === 'signed').length,
      expired: resources.filter(c => c.status === 'expired').length,
      cancelled: resources.filter(c => c.status === 'cancelled').length
    },
    byType: resources.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1;
      return acc;
    }, {}),
    totalValue: resources
      .filter(c => c.status === 'signed' && c.value)
      .reduce((sum, c) => sum + (c.value || 0), 0),
    expiringSoon: resources.filter(c => {
      if (!c.endDate || c.status !== 'signed') return false;
      const daysUntilExpiry = Math.ceil((new Date(c.endDate) - new Date()) / (1000 * 60 * 60 * 24));
      return daysUntilExpiry > 0 && daysUntilExpiry <= 30;
    }).length
  };

  res.json(stats);
}));

module.exports = router;