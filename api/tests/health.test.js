const request = require('supertest');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// Import routes
const formsRouter = require('../routes/forms');
const contractsRouter = require('../routes/contracts');
const invoicesRouter = require('../routes/invoices');
const receiptsRouter = require('../routes/receipts');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/api/forms', formsRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/receipts', receiptsRouter);

describe('API Health Check', () => {
  test('GET /api/health should return 200', async () => {
    const response = await request(app).get('/api/health');
    expect(response.statusCode).toBe(200);
  });
});

describe('Forms API', () => {
  test('GET /api/forms should return array', async () => {
    const response = await request(app).get('/api/forms');
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe('Contracts API', () => {
  test('GET /api/contracts should return array', async () => {
    const response = await request(app).get('/api/contracts');
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe('Invoices API', () => {
  test('GET /api/invoices should return array', async () => {
    const response = await request(app).get('/api/invoices');
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe('Receipts API', () => {
  test('GET /api/receipts should return array', async () => {
    const response = await request(app).get('/api/receipts');
    expect(Array.isArray(response.body)).toBe(true);
  });
});