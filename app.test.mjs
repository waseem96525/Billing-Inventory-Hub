import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, addInventoryItem, checkoutCart, addToCart, clearCart, buildReceiptHtml, authenticateUser, updateUserCredentials, buildReportData } from './app.js';

test('addInventoryItem adds a record to the target branch', () => {
  const state = createInitialState();
  const updated = addInventoryItem(state, {
    branchId: 'branch-1',
    sku: 'SKU999',
    name: 'Soda',
    costPrice: 20,
    sellingPrice: 30,
    stock: 5,
    lowStock: 2
  });

  assert.equal(updated.inventory.length, state.inventory.length + 1);
  assert.ok(updated.inventory.some((item) => item.name === 'Soda'));
});

test('addInventoryItem preserves additional product metadata', () => {
  const state = createInitialState();
  const updated = addInventoryItem(state, {
    branchId: 'branch-2',
    sku: 'SKU888',
    name: 'Tea Pack',
    costPrice: 80,
    sellingPrice: 120,
    mrp: 140,
    barcode: '8901234567890',
    category: 'Beverages',
    brand: 'GreenLeaf',
    unit: 'Pack',
    description: 'Premium tea',
    stock: 12,
    lowStock: 3
  });

  const created = updated.inventory.find((item) => item.name === 'Tea Pack');
  assert.ok(created);
  assert.equal(created.barcode, '8901234567890');
  assert.equal(created.category, 'Beverages');
  assert.equal(created.mrp, 140);
  assert.equal(created.unit, 'Pack');
});

test('buildReceiptHtml renders a printable bill preview', () => {
  const html = buildReceiptHtml({
    id: 'txn-100',
    subtotal: 90,
    discountPercent: 10,
    total: 81,
    paymentMethod: 'UPI',
    items: [{ name: 'Milk', qty: 2 }],
    timestamp: '2026-07-01 10:00'
  }, 'Downtown Store');

  assert.match(html, /Billing &amp; Inventory Hub/);
  assert.match(html, /txn-100/);
  assert.match(html, /UPI/);
});

test('buildReceiptHtml includes tax, bill number, and layout details', () => {
  const html = buildReceiptHtml({
    id: 'txn-200',
    subtotal: 100,
    discountPercent: 0,
    total: 118,
    taxAmount: 18,
    taxLabel: 'GST',
    billNumber: 'INV-1001',
    layout: 'compact',
    paymentMethod: 'Cash',
    items: [{ name: 'Milk', qty: 2 }],
    timestamp: '2026-07-01 10:00'
  }, 'Downtown Store');

  assert.match(html, /Tax \(GST\)/);
  assert.match(html, /INV-1001/);
  assert.match(html, /data-layout="compact"/);
});

test('authenticateUser allows admin and cashier logins', () => {
  assert.deepEqual(authenticateUser('admin', 'admin123'), { username: 'admin', role: 'admin', displayName: 'Admin' });
  assert.deepEqual(authenticateUser('cashier', 'cashier123'), { username: 'cashier', role: 'cashier', displayName: 'Cashier' });
});

test('authenticateUser rejects invalid credentials', () => {
  assert.equal(authenticateUser('admin', 'wrong-password'), null);
  assert.equal(authenticateUser('unknown', 'anything'), null);
});

test('buildReportData summarizes sales and inventory', () => {
  const state = createInitialState();
  const report = buildReportData(state);
  assert.equal(report.totalTransactions, 1);
  assert.equal(report.totalSales, 90);
  assert.equal(report.totalItemsSold, 2);
  assert.ok(report.inventoryRows.some((item) => item.name === 'Milk'));
});

test('updateUserCredentials changes login details', () => {
  const updated = updateUserCredentials('admin', 'admin123', 'admin2', 'newpass123');
  assert.equal(updated.success, true);
  assert.equal(authenticateUser('admin2', 'newpass123')?.username, 'admin2');
  const reverted = updateUserCredentials('admin2', 'newpass123', 'admin', 'admin123');
  assert.equal(reverted.success, true);
});

test('checkoutCart decreases stock and creates a transaction', () => {
  const state = createInitialState();
  addToCart({ id: 'item-1', branchId: 'branch-1', name: 'Milk', price: 45, qty: 1 });
  const result = checkoutCart(state, 'branch-1', 'Cash');
  assert.equal(result.success, true);
  assert.ok(result.transaction.total > 0);
  clearCart();
});
