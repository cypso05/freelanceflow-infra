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
const fieldSchema = Joi.object({
  label: Joi.string().required(),
  type: Joi.string().valid('text', 'number', 'email', 'date', 'select', 'checkbox', 'radio', 'textarea').required(),
  required: Joi.boolean().default(false),
  placeholder: Joi.string().allow(''),
  defaultValue: Joi.any(),
  options: Joi.array().items(Joi.string()).when('type', { 
    is: Joi.valid('select', 'radio', 'checkbox'), 
    then: Joi.required() 
  }),
  validation: Joi.object({
    min: Joi.number(),
    max: Joi.number(),
    pattern: Joi.string()
  }).optional()
});

const formSchema = Joi.object({
  name: Joi.string().required().min(3).max(100),
  description: Joi.string().allow('').max(500),
  fields: Joi.array().items(fieldSchema).required().min(1),
  isActive: Joi.boolean().default(true),
  tags: Joi.array().items(Joi.string()).optional()
});

// GET all forms with optional filtering
router.get('/', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const querySpec = {
    query: 'SELECT * FROM c WHERE c.isActive = @isActive',
    parameters: [{ name: '@isActive', value: true }]
  };

  const { resources } = await containers.forms.items.query(querySpec).fetchAll();
  res.json(resources);
}));

// GET form by ID
router.get('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource } = await containers.forms.item(req.params.id, req.params.id).read();
    if (!resource) {
      throw new AppError('Form not found', 404);
    }
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Form not found', 404);
    }
    throw error;
  }
}));

// CREATE form
router.post('/', validate(formSchema), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  const newForm = {
    id: generateId(),
    ...req.body,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: req.user?.id || 'system',
    version: 1
  };
  
  const { resource } = await containers.forms.items.create(newForm);
  res.status(201).json(resource);
}));

// UPDATE form
router.put('/:id', validate(formSchema), asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource: existing } = await containers.forms.item(req.params.id, req.params.id).read();
    if (!existing) {
      throw new AppError('Form not found', 404);
    }

    const updatedForm = {
      ...existing,
      ...req.body,
      id: req.params.id,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.id || 'system',
      version: (existing.version || 0) + 1
    };
    
    const { resource } = await containers.forms.item(req.params.id).replace(updatedForm);
    res.json(resource);
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Form not found', 404);
    }
    throw error;
  }
}));

// DELETE form (soft delete)
router.delete('/:id', asyncHandler(async (req, res) => {
  const { containers } = await initCosmosDB();
  
  try {
    const { resource: existing } = await containers.forms.item(req.params.id, req.params.id).read();
    if (!existing) {
      throw new AppError('Form not found', 404);
    }

    // Soft delete by setting isActive to false
    existing.isActive = false;
    existing.deletedAt = new Date().toISOString();
    existing.deletedBy = req.user?.id || 'system';
    
    await containers.forms.item(req.params.id).replace(existing);
    res.status(204).send();
  } catch (error) {
    if (error.code === 404) {
      throw new AppError('Form not found', 404);
    }
    throw error;
  }
}));

// GET form submissions
router.get('/:id/submissions', asyncHandler(async (req, res) => {
  // This would be implemented when you have form submissions collection
  res.json({ message: 'Form submissions endpoint', formId: req.params.id });
}));

module.exports = router;