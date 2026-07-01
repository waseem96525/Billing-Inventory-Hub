const STORAGE_KEY = 'billing-inventory-hub-state';
const AUTH_STORAGE_KEY = 'billing-inventory-hub-auth';
const AUTH_USERS_STORAGE_KEY = 'billing-inventory-hub-auth-users';
const REALTIME_CHANNEL = 'billing-inventory-hub-sync';

const DEFAULT_AUTH_USERS = [
  { username: 'admin', password: 'admin123', role: 'admin', displayName: 'Admin' },
  { username: 'cashier', password: 'cashier123', role: 'cashier', displayName: 'Cashier' }
];

let currentView = 'admin';
let currentUser = null;
let authUsers = loadAuthUsers();
let cart = [];
let lastReceipt = null;
let heldBills = [];
let activeDiscount = 0;
let priceOverride = null;
let shopProfile = {
  shopName: 'Billing & Inventory Hub',
  ownerName: '',
  phone: '',
  email: '',
  address: '',
  gst: '',
  website: '',
  footer: 'Thank you for shopping with us!',
  taxName: 'GST',
  taxRate: 0,
  receiptPrefix: 'INV',
  nextReceiptNumber: 1001,
  printLayout: 'standard'
};

function formatCurrency(value) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2
  }).format(value);
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openDBAsync() {
  if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open('billing-hub-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    const db = await openDBAsync();
    if (!db) return;
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    store.put(value, key);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (e) {
    console.warn('IndexedDB set failed', e);
  }
}

async function dbGet(key) {
  if (typeof window === 'undefined' || !window.indexedDB) return null;
  try {
    const db = await openDBAsync();
    if (!db) return null;
    return await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const req = store.get(key);
      req.onsuccess = () => {
        res(req.result);
        db.close();
      };
      req.onerror = () => {
        rej(req.error);
        db.close();
      };
    });
  } catch (e) {
    console.warn('IndexedDB get failed', e);
    return null;
  }
}

async function dbDelete(key) {
  if (typeof window === 'undefined' || !window.indexedDB) return;
  try {
    const db = await openDBAsync();
    if (!db) return;
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    store.delete(key);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  } catch (e) {
    console.warn('IndexedDB delete failed', e);
  }
}

// Firebase Realtime Database sync (client-side). Guarded so tests/node don't execute.
let firebaseEnabled = false;
let firebaseDatabaseRef = null;
let firebaseListener = null;
const firebaseConfig = {
  apiKey: "AIzaSyCBi6GCigBZx5yRTTTW8SXHzSkA1uTAvpM",
  authDomain: "billingsol-e9a83.firebaseapp.com",
  databaseURL: "https://billingsol-e9a83-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "billingsol-e9a83",
  storageBucket: "billingsol-e9a83.firebasestorage.app",
  messagingSenderId: "436716611232",
  appId: "1:436716611232:web:e185ad817d4a67d0f94bc5",
  measurementId: "G-7RG9H1C0BM"
};

function firebaseInit() {
  if (typeof window === 'undefined' || typeof window.firebase === 'undefined') return;
  try {
    if (!window.firebase.apps || !window.firebase.apps.length) {
      window.firebase.initializeApp(firebaseConfig);
    }
    firebaseEnabled = true;
  } catch (e) {
    console.warn('Firebase init failed', e);
    firebaseEnabled = false;
  }
}

function cloudSaveState(state, username) {
  if (!firebaseEnabled || !username) return;
  try {
    const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
    const payload = { state, lastUpdated: Date.now() };
    ref.set(payload).catch((e) => console.warn('cloudSaveState failed', e));
  } catch (e) {
    console.warn('cloudSaveState error', e);
  }
}

function cloudSubscribe(username, onUpdate) {
  if (!firebaseEnabled || !username) return;
  try {
    const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
    firebaseDatabaseRef = ref;
    firebaseListener = ref.on('value', (snap) => {
      const val = snap.val();
      if (!val) return;
      try {
        onUpdate(val.state || val);
      } catch (e) { console.warn('cloud update handler failed', e); }
    });
  } catch (e) {
    console.warn('cloudSubscribe error', e);
  }
}

function cloudUnsubscribe() {
  try {
    if (firebaseDatabaseRef && firebaseListener) {
      firebaseDatabaseRef.off('value', firebaseListener);
    }
  } catch (e) { }
  firebaseDatabaseRef = null;
  firebaseListener = null;
}

function loadAuthUsers() {
  if (typeof window === 'undefined') return [...DEFAULT_AUTH_USERS];
  const raw = window.localStorage.getItem(AUTH_USERS_STORAGE_KEY);
  if (!raw) return [...DEFAULT_AUTH_USERS];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : [...DEFAULT_AUTH_USERS];
  } catch {
    return [...DEFAULT_AUTH_USERS];
  }
}

function persistAuthUsers(users) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTH_USERS_STORAGE_KEY, JSON.stringify(users));
  } catch (e) {}
  dbSet(AUTH_USERS_STORAGE_KEY, JSON.stringify(users)).catch(() => {});
}

export function authenticateUser(username, password) {
  const entry = authUsers.find((user) => user.username === username && user.password === password);
  if (!entry) return null;
  return { username: entry.username, role: entry.role, displayName: entry.displayName };
}

export function updateUserCredentials(currentUsername, currentPassword, newUsername, newPassword) {
  const trimmedUsername = String(newUsername || '').trim();
  const trimmedPassword = String(newPassword || '').trim();

  if (!trimmedUsername || !trimmedPassword) {
    return { success: false, message: 'Please enter a new username and password.' };
  }

  const existingUser = authUsers.find((user) => user.username === currentUsername && user.password === currentPassword);
  if (!existingUser) {
    return { success: false, message: 'Current password is incorrect.' };
  }

  const duplicate = authUsers.some((user) => user.username === trimmedUsername && user.username !== currentUsername);
  if (duplicate) {
    return { success: false, message: 'That username is already taken.' };
  }

  authUsers = authUsers.map((user) => {
    if (user.username === currentUsername) {
      return { ...user, username: trimmedUsername, password: trimmedPassword };
    }
    return user;
  });
  persistAuthUsers(authUsers);
  return {
    success: true,
    message: 'Login credentials updated.',
    user: { username: trimmedUsername, role: existingUser.role, displayName: existingUser.displayName }
  };
}

function getStoredAuth() {
  if (typeof window === 'undefined') return null;
  // try localStorage first for synchronous access
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return authenticateUser(parsed.username, parsed.password) ? parsed : null;
    }
  } catch (e) {
    // continue to indexedDB fallback
  }
  // As a fallback, attempt to read from IndexedDB (async but we return null here).
  // The app will re-hydrate auth after DB load during initialization.
  return null;
}

function persistAuth(user, password) {
  if (typeof window === 'undefined') return;
  if (user && password) {
    try {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ username: user, password }));
    } catch (e) {}
    dbSet(AUTH_STORAGE_KEY, JSON.stringify({ username: user, password })).catch(() => {});
  } else {
    try { window.localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
    dbDelete(AUTH_STORAGE_KEY).catch(() => {});
  }
}

export function buildReceiptHtml(receipt = {}, branchName = 'Store') {
  const profile = receipt.shopProfile || shopProfile || {};
  const items = (receipt.items || []).map((entry) => `
    <tr>
      <td>${escapeHtml(entry.name)}</td>
      <td>${entry.qty}</td>
      <td>${formatCurrency(entry.price || 0)}</td>
    </tr>`).join('');

  const subtotal = Number(receipt.subtotal || 0);
  const discountPercent = Number(receipt.discountPercent || 0);
  const discountAmount = Number(receipt.discountAmount || subtotal * (discountPercent / 100));
  const taxRate = Number(receipt.taxRate || profile.taxRate || 0);
  const taxAmount = Number(receipt.taxAmount || (taxRate > 0 ? subtotal * (taxRate / 100) : 0));
  const taxLabel = receipt.taxLabel || profile.taxName || 'Tax';
  const billNumber = receipt.billNumber || receipt.id || 'POS';
  const layout = receipt.layout || profile.printLayout || 'standard';
  const total = Number(receipt.total || subtotal - discountAmount + taxAmount);

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <title>Receipt</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
        body[data-layout="compact"] { padding: 16px; font-size: 13px; }
        h1 { margin-bottom: 4px; }
        .meta { color: #555; font-size: 14px; margin-bottom: 10px; }
        body[data-layout="compact"] .meta { font-size: 12px; margin-bottom: 6px; }
        table { width: 100%; border-collapse: collapse; margin: 12px 0; }
        th, td { padding: 8px 6px; border-bottom: 1px solid #ddd; text-align: left; }
        .totals { margin-top: 12px; font-size: 15px; }
        .totals div { display: flex; justify-content: space-between; margin: 4px 0; }
      </style>
    </head>
    <body data-layout="${escapeHtml(layout)}">
      <h1>${escapeHtml(profile.shopName || 'Billing & Inventory Hub')}</h1>
      <div class="meta">Owner: ${escapeHtml(profile.ownerName || 'N/A')}</div>
      <div class="meta">Phone: ${escapeHtml(profile.phone || 'N/A')}</div>
      <div class="meta">Address: ${escapeHtml(profile.address || 'N/A')}</div>
      <div class="meta">GST: ${escapeHtml(profile.gst || 'N/A')}</div>
      <div class="meta">Branch: ${escapeHtml(branchName)}</div>
      <div class="meta">Bill: ${escapeHtml(billNumber)}</div>
      <div class="meta">Invoice: ${escapeHtml(receipt.id || 'POS')}</div>
      <div class="meta">Date: ${escapeHtml(receipt.timestamp || new Date().toLocaleString())}</div>
      <div class="meta">Payment: ${escapeHtml(receipt.paymentMethod || 'Cash')}</div>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><strong>${formatCurrency(subtotal)}</strong></div>
        <div><span>Discount (${discountPercent}%)</span><strong>${formatCurrency(discountAmount)}</strong></div>
        ${taxAmount > 0 ? `<div><span>Tax (${escapeHtml(taxLabel)})</span><strong>${formatCurrency(taxAmount)}</strong></div>` : ''}
        <div><span>Total</span><strong>${formatCurrency(total)}</strong></div>
      </div>
      <div class="meta" style="margin-top:16px">${escapeHtml(profile.footer || 'Thank you for shopping with us!')}</div>
    </body>
  </html>`;
}

export function createInitialState() {
  return {
    branches: [
      { id: 'branch-1', name: 'Downtown Store', location: 'Downtown', contact: '0412-555-000' },
      { id: 'branch-2', name: 'North Plaza', location: 'North District', contact: '0412-555-111' }
    ],
    inventory: [
      { id: 'item-1', branchId: 'branch-1', sku: 'SKU001', barcode: '8901234567001', name: 'Milk', category: 'Dairy', brand: 'FreshMart', unit: 'Litre', costPrice: 35, mrp: 50, sellingPrice: 45, description: 'Fresh pasteurized milk', stock: 20, lowStock: 5 },
      { id: 'item-2', branchId: 'branch-1', sku: 'SKU002', barcode: '8901234567002', name: 'Bread', category: 'Bakery', brand: 'DailyBake', unit: 'Pack', costPrice: 20, mrp: 32, sellingPrice: 28, description: 'Soft sandwich bread', stock: 10, lowStock: 3 },
      { id: 'item-3', branchId: 'branch-2', sku: 'SKU003', barcode: '8901234567003', name: 'Coffee', category: 'Beverages', brand: 'BeanHouse', unit: 'Pack', costPrice: 70, mrp: 110, sellingPrice: 95, description: 'Arabica coffee beans', stock: 15, lowStock: 4 }
    ],
    transactions: [
      { id: 'txn-1', branchId: 'branch-1', timestamp: '2026-07-01 09:30', total: 90, paymentMethod: 'Cash', items: [{ name: 'Milk', qty: 2 }] }
    ],
    shopProfile: {
      shopName: 'Billing & Inventory Hub',
      ownerName: 'Aarav Sharma',
      phone: '+91 98765 43210',
      email: 'hello@billinghub.com',
      address: '123 Market Street, Delhi',
      gst: '29ABCDE1234F1Z5',
      website: 'www.billinghub.com',
      footer: 'Thank you for shopping with us!',
      taxName: 'GST',
      taxRate: 0,
      receiptPrefix: 'INV',
      nextReceiptNumber: 1001,
      printLayout: 'standard'
    }
  };
}

export function loadState() {
  if (typeof window === 'undefined') return createInitialState();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return createInitialState();
  try {
    const parsed = JSON.parse(raw);
    return {
      ...createInitialState(),
      ...parsed,
      branches: parsed.branches || createInitialState().branches,
      inventory: parsed.inventory || createInitialState().inventory,
      transactions: parsed.transactions || createInitialState().transactions,
      shopProfile: parsed.shopProfile || createInitialState().shopProfile
    };
  } catch {
    return createInitialState();
  }
}

export function saveState(state) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // ignore
  }
  // persist to IndexedDB asynchronously for more robust local storage
  dbSet(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  // also try to persist to Firebase for cross-device sync when signed in
  try {
    if (typeof currentUser !== 'undefined' && currentUser && firebaseEnabled) {
      cloudSaveState(state, currentUser.username);
    }
  } catch (e) {}
  if (typeof window.BroadcastChannel !== 'undefined') {
    const channel = new window.BroadcastChannel(REALTIME_CHANNEL);
    channel.postMessage({ type: 'state-update', state });
    channel.close();
  }
}

export function addBranch(state, payload) {
  const branch = {
    id: `branch-${Date.now()}`,
    name: payload.name,
    location: payload.location,
    contact: payload.contact || 'Pending'
  };
  return { ...state, branches: [...state.branches, branch] };
}

export function addInventoryItem(state, payload) {
  const item = {
    id: `item-${Date.now()}`,
    branchId: payload.branchId,
    sku: payload.sku,
    barcode: payload.barcode,
    name: payload.name,
    category: payload.category,
    brand: payload.brand,
    unit: payload.unit,
    costPrice: Number(payload.costPrice),
    mrp: Number(payload.mrp),
    sellingPrice: Number(payload.sellingPrice),
    description: payload.description,
    stock: Number(payload.stock),
    lowStock: Number(payload.lowStock)
  };
  return { ...state, inventory: [...state.inventory, item] };
}

export function getInventoryForBranch(state, branchId) {
  return state.inventory.filter((item) => item.branchId === branchId);
}

export function checkoutCart(state, branchId, paymentMethod, cashierName = 'Cashier', discountPercent = 0) {
  const selectedItems = cart.filter((entry) => entry.branchId === branchId);
  if (!selectedItems.length) {
    return { success: false, message: 'Cart is empty.' };
  }

  const inventory = [...state.inventory];
  for (const entry of selectedItems) {
    const item = inventory.find((candidate) => candidate.id === entry.id);
    if (!item || item.stock < entry.qty) {
      return { success: false, message: `Insufficient stock for ${entry.name}.` };
    }
    item.stock -= entry.qty;
  }

  const subtotal = selectedItems.reduce((sum, entry) => sum + entry.qty * entry.price, 0);
  const discountAmount = subtotal * (discountPercent / 100);
  const profile = state.shopProfile || {};
  const taxRate = Number(profile.taxRate || 0);
  const taxAmount = subtotal * (taxRate / 100);
  const finalTotal = subtotal - discountAmount + taxAmount;
  const receiptPrefix = String(profile.receiptPrefix || 'INV').trim() || 'INV';
  const nextReceiptNumber = Number(profile.nextReceiptNumber || 1001);
  const billNumber = `${receiptPrefix}${receiptPrefix.endsWith('-') ? '' : '-'}${nextReceiptNumber}`;

  const transaction = {
    id: `txn-${Date.now()}`,
    branchId,
    timestamp: new Date().toLocaleString(),
    subtotal,
    discountPercent,
    discountAmount,
    taxRate,
    taxAmount,
    total: finalTotal,
    billNumber,
    paymentMethod,
    cashierName,
    items: selectedItems.map((entry) => ({ name: entry.name, qty: entry.qty }))
  };

  const nextProfile = {
    ...profile,
    nextReceiptNumber: nextReceiptNumber + 1
  };

  const nextState = {
    ...state,
    inventory,
    transactions: [transaction, ...state.transactions],
    shopProfile: nextProfile
  };

  return { success: true, nextState, transaction };
}

export function addToCart(item, qty = 1) {
  const existing = cart.find((entry) => entry.id === item.id);
  if (existing) {
    existing.qty += qty;
  } else {
    cart.push({ ...item, qty, price: item.price ?? item.sellingPrice });
  }
  return cart;
}

export function updateCartItem(itemId, delta) {
  const existing = cart.find((entry) => entry.id === itemId);
  if (!existing) return cart;
  existing.qty += delta;
  if (existing.qty <= 0) {
    cart = cart.filter((entry) => entry.id !== itemId);
  }
  return cart;
}

export function clearCart() {
  cart = [];
  return cart;
}

export function getCartTotal() {
  return cart.reduce((sum, entry) => sum + entry.qty * entry.price, 0);
}

export function buildReportData(state) {
  const branchLookup = Object.fromEntries((state.branches || []).map((branch) => [branch.id, branch.name]));
  const salesRows = (state.transactions || []).map((transaction) => ({
    id: transaction.id,
    branchName: branchLookup[transaction.branchId] || 'Unknown',
    timestamp: transaction.timestamp,
    paymentMethod: transaction.paymentMethod,
    itemsSold: (transaction.items || []).reduce((sum, item) => sum + Number(item.qty || 0), 0),
    total: Number(transaction.total || 0)
  }));

  const inventoryRows = (state.inventory || []).map((item) => ({
    name: item.name,
    stock: Number(item.stock || 0),
    lowStock: Number(item.lowStock || 0),
    costPrice: Number(item.costPrice || 0),
    sellingPrice: Number(item.sellingPrice || 0),
    stockValue: Number(item.stock || 0) * Number(item.costPrice || 0),
    status: Number(item.stock || 0) <= Number(item.lowStock || 0) ? 'Low stock' : 'Healthy'
  }));

  return {
    totalTransactions: salesRows.length,
    totalSales: salesRows.reduce((sum, row) => sum + row.total, 0),
    totalItemsSold: salesRows.reduce((sum, row) => sum + row.itemsSold, 0),
    inventoryValue: inventoryRows.reduce((sum, row) => sum + row.stockValue, 0),
    lowStockItems: inventoryRows.filter((row) => row.status === 'Low stock').length,
    salesRows,
    inventoryRows
  };
}

function renderAdmin(state) {
  const branchSelect = document.getElementById('inventory-branch');
  const inventoryTable = document.getElementById('inventory-table');
  const inventoryCount = document.getElementById('inventory-count');
  const inventorySummary = document.getElementById('inventory-summary');
  const transactionsList = document.getElementById('transactions-list');
  const reportsSummary = document.getElementById('reports-summary');
  const salesReportList = document.getElementById('sales-report-list');
  const inventoryReportList = document.getElementById('inventory-report-list');
  const branchCount = document.getElementById('branch-count');
  const stockAlertsCount = document.getElementById('stock-alerts-count');
  const revenueCount = document.getElementById('revenue-count');
  const transactionsCount = document.getElementById('transactions-count');

  branchCount.textContent = state.branches.length.toString();
  inventoryCount.textContent = state.inventory.length.toString();
  const lowStockItems = state.inventory.filter((item) => item.stock <= item.lowStock).length;
  stockAlertsCount.textContent = lowStockItems.toString();
  revenueCount.textContent = formatCurrency(state.transactions.reduce((sum, entry) => sum + entry.total, 0));
  transactionsCount.textContent = state.transactions.length.toString();

  branchSelect.innerHTML = state.branches
    .map((branch) => `<option value="${branch.id}" ${branch.id === state.branches[0]?.id ? 'selected' : ''}>${branch.name}</option>`)
    .join('');

  inventorySummary.textContent = `${state.inventory.length} items • ${lowStockItems} require attention`;
  inventoryTable.innerHTML = state.inventory
    .map((item) => {
      const branch = state.branches.find((entry) => entry.id === item.branchId);
      return `
        <tr>
          <td>${item.name}</td>
          <td>${item.barcode || '-'}</td>
          <td>${item.category || '-'}</td>
          <td>${branch ? branch.name : 'Unknown'}</td>
          <td>${item.stock}</td>
          <td>${formatCurrency(item.mrp ?? item.sellingPrice)}</td>
          <td>${formatCurrency(item.sellingPrice)}</td>
        </tr>`;
    })
    .join('');

  transactionsList.innerHTML = state.transactions
    .slice(0, 5)
    .map((transaction) => `
      <div class="list-item">
        <div class="row between">
          <strong>#${transaction.id}</strong>
          <span class="small">${transaction.timestamp}</span>
        </div>
        <div class="small">${transaction.items.map((entry) => `${entry.name} × ${entry.qty}`).join(', ')}</div>
        <div class="small">Payment: ${transaction.paymentMethod} • Total: ${formatCurrency(transaction.total)}</div>
      </div>`)
    .join('');

  const reportData = buildReportData(state);
  reportsSummary.innerHTML = `
    <div class="report-card">
      <p class="stat-label">Sales</p>
      <h3>${formatCurrency(reportData.totalSales)}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Transactions</p>
      <h3>${reportData.totalTransactions}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Items sold</p>
      <h3>${reportData.totalItemsSold}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Inventory value</p>
      <h3>${formatCurrency(reportData.inventoryValue)}</h3>
    </div>
    <div class="report-card">
      <p class="stat-label">Low stock</p>
      <h3>${reportData.lowStockItems}</h3>
    </div>`;

  salesReportList.innerHTML = reportData.salesRows.map((row) => `
    <tr>
      <td>${row.id}</td>
      <td>${row.branchName}</td>
      <td>${row.timestamp}</td>
      <td>${row.itemsSold}</td>
      <td>${formatCurrency(row.total)}</td>
      <td>${row.paymentMethod}</td>
    </tr>`).join('');

  inventoryReportList.innerHTML = reportData.inventoryRows.map((item) => `
    <tr>
      <td>${item.name}</td>
      <td>${item.stock}</td>
      <td>${item.lowStock}</td>
      <td>${formatCurrency(item.costPrice)}</td>
      <td>${formatCurrency(item.sellingPrice)}</td>
      <td>${formatCurrency(item.stockValue)}</td>
      <td>${item.status}</td>
    </tr>`).join('');
}

function renderCashier(state, branchId) {
  const catalog = document.getElementById('cashier-catalog');
  const cartList = document.getElementById('cart-list');
  const cartTotal = document.getElementById('cart-total');
  const branchSelect = document.getElementById('cashier-branch');
  const searchInput = document.getElementById('cashier-search');
  const receiptPreview = document.getElementById('receipt-preview');

  branchSelect.innerHTML = state.branches
    .map((branch) => `<option value="${branch.id}" ${branch.id === branchId ? 'selected' : ''}>${branch.name}</option>`)
    .join('');

  const searchValue = searchInput.value.trim().toLowerCase();
  const items = getInventoryForBranch(state, branchId).filter((item) => {
    const haystack = `${item.name} ${item.sku} ${item.barcode || ''} ${item.category || ''}`.toLowerCase();
    return haystack.includes(searchValue);
  });

  catalog.innerHTML = items.map((item) => `
    <div class="catalog-item">
      <strong>${item.name}</strong>
      <div class="small">${item.sku}</div>
      <div class="small">${item.category || 'General'} • ${item.brand || 'Brand'}</div>
      <div class="small">Stock ${item.stock}</div>
      <div>${formatCurrency(item.sellingPrice)}</div>
      <button class="primary" data-add-item="${item.id}">Add to cart</button>
    </div>`).join('');

  if (!cart.length) {
    cartList.innerHTML = '<div class="small">Cart is empty.</div>';
  } else {
    cartList.innerHTML = cart.map((entry) => `
      <div class="list-item">
        <div class="row between">
          <strong>${entry.name}</strong>
          <span>${formatCurrency(entry.qty * entry.price)}</span>
        </div>
        <div class="row between top-gap">
          <div class="row">
            <button data-change-qty="${entry.id}" data-delta="-1">-</button>
            <span>${entry.qty}</span>
            <button data-change-qty="${entry.id}" data-delta="1">+</button>
          </div>
          <button data-remove-item="${entry.id}">Remove</button>
        </div>
      </div>`).join('');
  }

  const subtotal = getCartTotal();
  const discountAmount = subtotal * (activeDiscount / 100);
  const finalTotal = subtotal - discountAmount;
  cartTotal.textContent = `Subtotal: ${formatCurrency(subtotal)} • Discount: ${activeDiscount}% • Final: ${formatCurrency(finalTotal)}`;

  if (lastReceipt) {
    receiptPreview.innerHTML = `
      <strong>Last receipt</strong>
      <div class="small">${lastReceipt.timestamp}</div>
      <div class="small">${lastReceipt.items.map((entry) => `${entry.name} × ${entry.qty}`).join(', ')}</div>
      <div class="small">Discount: ${lastReceipt.discountPercent}% • Total: ${formatCurrency(lastReceipt.total)}</div>
    `;
  } else {
    receiptPreview.innerHTML = '<div class="small">Checkout completed orders will appear here.</div>';
  }
}

function getAllowedViews() {
  if (currentUser?.role === 'admin') return ['admin', 'cashier', 'settings'];
  if (currentUser?.role === 'cashier') return ['cashier'];
  return [];
}

function renderAuth(state) {
  const loginScreen = document.getElementById('login-screen');
  const appShell = document.getElementById('app-shell');
  const authLabel = document.getElementById('auth-user-label');
  const logoutButton = document.getElementById('logout-btn');
  const viewSwitcher = document.querySelector('.view-switcher');

  if (!currentUser) {
    loginScreen?.classList.remove('hidden');
    appShell?.classList.add('hidden');
    authLabel.textContent = 'Not signed in';
    logoutButton?.classList.add('hidden');
    viewSwitcher?.classList.add('hidden');
    return;
  }

  loginScreen?.classList.add('hidden');
  appShell?.classList.remove('hidden');
  authLabel.textContent = `${currentUser.displayName} (${currentUser.role})`;
  logoutButton?.classList.remove('hidden');
  viewSwitcher?.classList.remove('hidden');
  renderView(state);
}

function renderView(state) {
  const allowedViews = getAllowedViews();
  if (!allowedViews.includes(currentView)) {
    currentView = allowedViews[0] || 'cashier';
  }

  document.getElementById('admin-panel').classList.toggle('hidden', currentView !== 'admin');
  document.getElementById('cashier-panel').classList.toggle('hidden', currentView !== 'cashier');
  document.getElementById('settings-panel').classList.toggle('hidden', currentView !== 'settings');
  document.querySelectorAll('.view-btn').forEach((button) => {
    const allowed = allowedViews.includes(button.dataset.view);
    button.classList.toggle('hidden', !allowed);
    button.classList.toggle('active', button.dataset.view === currentView && allowed);
  });
  renderAdmin(state);
  renderCashier(state, document.getElementById('cashier-branch')?.value || state.branches[0]?.id);
  renderSettings(state);
}

function renderSettings(state) {
  const preview = document.getElementById('settings-preview');
  const profile = state.shopProfile || shopProfile;
  const fields = [
    ['Shop name', profile.shopName],
    ['Owner', profile.ownerName],
    ['Phone', profile.phone],
    ['Email', profile.email],
    ['Address', profile.address],
    ['GST', profile.gst],
    ['Tax name', profile.taxName],
    ['Tax rate', profile.taxRate],
    ['Receipt prefix', profile.receiptPrefix],
    ['Next receipt number', profile.nextReceiptNumber],
    ['Print layout', profile.printLayout],
    ['Website', profile.website],
    ['Footer', profile.footer]
  ];

  preview.innerHTML = fields.map(([label, value]) => `<div class="small"><strong>${label}:</strong> ${value || '—'}</div>`).join('');
  document.getElementById('shop-name').value = profile.shopName || '';
  document.getElementById('shop-owner').value = profile.ownerName || '';
  document.getElementById('shop-phone').value = profile.phone || '';
  document.getElementById('shop-email').value = profile.email || '';
  document.getElementById('shop-address').value = profile.address || '';
  document.getElementById('shop-gst').value = profile.gst || '';
  document.getElementById('shop-tax-name').value = profile.taxName || '';
  document.getElementById('shop-tax-rate').value = profile.taxRate ?? '';
  document.getElementById('shop-receipt-prefix').value = profile.receiptPrefix || '';
  document.getElementById('shop-next-receipt').value = profile.nextReceiptNumber ?? '';
  document.getElementById('shop-print-layout').value = profile.printLayout || 'standard';
  document.getElementById('shop-website').value = profile.website || '';
  document.getElementById('shop-footer').value = profile.footer || '';
}

function printReceipt(receipt, state) {
  const branchSelect = document.getElementById('cashier-branch');
  const branchName = branchSelect?.selectedOptions?.[0]?.text || 'Store';
  const receiptData = receipt || {
    id: `txn-${Date.now()}`,
    subtotal: getCartTotal(),
    discountPercent: activeDiscount,
    discountAmount: getCartTotal() * (activeDiscount / 100),
    total: getCartTotal() - (getCartTotal() * (activeDiscount / 100)),
    paymentMethod: document.getElementById('payment-method').value,
    timestamp: new Date().toLocaleString(),
    items: cart.map((entry) => ({ name: entry.name, qty: entry.qty, price: entry.price })),
    shopProfile: state.shopProfile || shopProfile
  };

  const printWindow = window.open('', '_blank', 'width=700,height=900');
  if (!printWindow) {
    alert('Pop-up blocked. Please allow pop-ups to print the receipt.');
    return;
  }

  printWindow.document.write(buildReceiptHtml(receiptData, branchName));
  printWindow.document.close();
  printWindow.focus();
  setTimeout(() => {
    printWindow.print();
    printWindow.close();
  }, 250);
}

function bindEvents(state) {
  document.getElementById('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const user = authenticateUser(username, password);
    const errorBox = document.getElementById('login-error');
    if (!user) {
      errorBox.textContent = 'Invalid username or password.';
      errorBox.classList.remove('hidden');
      return;
    }
    currentUser = user;
    persistAuth(username, password);
    errorBox.classList.add('hidden');
    document.getElementById('login-form').reset();
    renderAuth(state);
    // initialize firebase and subscribe to user's cloud state
    firebaseInit();
    if (firebaseEnabled) {
      cloudSubscribe(currentUser.username, (remoteState) => {
        try {
          // merge remote state, prefer remote values when available
          state = {
            ...state,
            ...remoteState,
            branches: remoteState.branches || state.branches,
            inventory: remoteState.inventory || state.inventory,
            transactions: remoteState.transactions || state.transactions,
            shopProfile: remoteState.shopProfile || state.shopProfile
          };
          saveState(state);
          renderView(state);
        } catch (e) { console.warn('Error applying remote state', e); }
      });
    }
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    currentUser = null;
    persistAuth(null, null);
    cloudUnsubscribe();
    renderAuth(state);
  });

  document.querySelectorAll('.view-btn').forEach((button) => {
    button.addEventListener('click', () => {
      currentView = button.dataset.view;
      renderView(state);
    });
  });

  document.getElementById('branch-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = document.getElementById('branch-name').value.trim();
    const location = document.getElementById('branch-location').value.trim();
    if (!name || !location) return;
    state = addBranch(state, { name, location });
    saveState(state);
    document.getElementById('branch-form').reset();
    renderView(state);
  });

  document.getElementById('inventory-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const entry = {
      branchId: document.getElementById('inventory-branch').value,
      sku: document.getElementById('inventory-sku').value.trim(),
      barcode: document.getElementById('inventory-barcode').value.trim(),
      name: document.getElementById('inventory-name').value.trim(),
      category: document.getElementById('inventory-category').value.trim(),
      brand: document.getElementById('inventory-brand').value.trim(),
      unit: document.getElementById('inventory-unit').value.trim(),
      costPrice: document.getElementById('inventory-cost').value,
      mrp: document.getElementById('inventory-mrp').value,
      sellingPrice: document.getElementById('inventory-price').value,
      description: document.getElementById('inventory-description').value.trim(),
      stock: document.getElementById('inventory-stock').value,
      lowStock: document.getElementById('inventory-threshold').value
    };
    state = addInventoryItem(state, entry);
    saveState(state);
    document.getElementById('inventory-form').reset();
    renderView(state);
  });

  document.getElementById('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const profile = {
      shopName: document.getElementById('shop-name').value.trim(),
      ownerName: document.getElementById('shop-owner').value.trim(),
      phone: document.getElementById('shop-phone').value.trim(),
      email: document.getElementById('shop-email').value.trim(),
      address: document.getElementById('shop-address').value.trim(),
      gst: document.getElementById('shop-gst').value.trim(),
      taxName: document.getElementById('shop-tax-name').value.trim(),
      taxRate: Number(document.getElementById('shop-tax-rate').value || 0),
      receiptPrefix: document.getElementById('shop-receipt-prefix').value.trim(),
      nextReceiptNumber: Number(document.getElementById('shop-next-receipt').value || 1001),
      printLayout: document.getElementById('shop-print-layout').value,
      website: document.getElementById('shop-website').value.trim(),
      footer: document.getElementById('shop-footer').value.trim()
    };
    shopProfile = profile;
    state = { ...state, shopProfile: profile };
    saveState(state);
    renderView(state);
    alert('Shop settings saved.');
  });

  document.getElementById('account-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const currentPassword = document.getElementById('account-current-password').value;
    const newUsername = document.getElementById('account-new-username').value;
    const newPassword = document.getElementById('account-new-password').value;
    const confirmPassword = document.getElementById('account-confirm-password').value;
    const feedback = document.getElementById('account-feedback');

    if (newPassword !== confirmPassword) {
      feedback.textContent = 'Passwords do not match.';
      feedback.className = 'account-feedback error';
      return;
    }

    const result = updateUserCredentials(currentUser?.username || '', currentPassword, newUsername, newPassword);
    feedback.textContent = result.message;
    feedback.className = `account-feedback ${result.success ? 'success' : 'error'}`;
    if (result.success) {
      currentUser = result.user;
      persistAuth(currentUser.username, newPassword);
      document.getElementById('account-form').reset();
      renderAuth(state);
    }
  });

  document.getElementById('cashier-branch').addEventListener('change', (event) => {
    renderView(state);
    document.getElementById('cashier-search').value = '';
    renderCashier(state, event.target.value);
  });

  document.getElementById('cashier-search').addEventListener('input', () => {
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('cashier-catalog').addEventListener('click', (event) => {
    const button = event.target.closest('[data-add-item]');
    if (!button) return;
    const itemId = button.getAttribute('data-add-item');
    const item = state.inventory.find((entry) => entry.id === itemId);
    if (item) {
      addToCart(item);
      renderCashier(state, document.getElementById('cashier-branch').value);
    }
  });

  document.getElementById('cart-list').addEventListener('click', (event) => {
    const changeButton = event.target.closest('[data-change-qty]');
    if (changeButton) {
      const itemId = changeButton.getAttribute('data-change-qty');
      const delta = Number(changeButton.getAttribute('data-delta'));
      updateCartItem(itemId, delta);
      renderCashier(state, document.getElementById('cashier-branch').value);
      return;
    }
    const removeButton = event.target.closest('[data-remove-item]');
    if (removeButton) {
      const itemId = removeButton.getAttribute('data-remove-item');
      cart = cart.filter((entry) => entry.id !== itemId);
      renderCashier(state, document.getElementById('cashier-branch').value);
    }
  });

  document.getElementById('discount-input').addEventListener('input', (event) => {
    activeDiscount = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('apply-override-btn').addEventListener('click', () => {
    const value = Number(document.getElementById('price-override-input').value);
    if (!cart.length) {
      alert('Cart is empty.');
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      alert('Enter a valid price override.');
      return;
    }
    cart = cart.map((entry) => ({ ...entry, price: value }));
    priceOverride = value;
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('hold-bill-btn').addEventListener('click', () => {
    if (!cart.length) {
      alert('Cart is empty.');
      return;
    }
    heldBills.push({ items: [...cart], branchId: document.getElementById('cashier-branch').value, discount: activeDiscount, timestamp: new Date().toLocaleString() });
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    renderView(state);
    alert('Bill held successfully.');
  });

  document.getElementById('void-cart-btn').addEventListener('click', () => {
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    renderCashier(state, document.getElementById('cashier-branch').value);
  });

  document.getElementById('print-receipt-btn').addEventListener('click', () => {
    if (!lastReceipt && !cart.length) {
      alert('No receipt available to print.');
      return;
    }
    printReceipt(lastReceipt, state);
  });

  document.getElementById('reprint-receipt-btn').addEventListener('click', () => {
    if (!lastReceipt) {
      alert('No reprintable receipt available.');
      return;
    }
    printReceipt(lastReceipt, state);
  });

  document.getElementById('checkout-btn').addEventListener('click', () => {
    const branchId = document.getElementById('cashier-branch').value;
    const paymentMethod = document.getElementById('payment-method').value;
    const result = checkoutCart(state, branchId, paymentMethod, 'Cashier', activeDiscount);
    if (!result.success) {
      alert(result.message);
      return;
    }
    state = result.nextState;
    shopProfile = state.shopProfile || shopProfile;
    lastReceipt = result.transaction;
    saveState(state);
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    renderView(state);
  });

  window.addEventListener('storage', () => {
    const freshState = loadState();
    state = freshState;
    renderView(state);
  });

  if (typeof window.BroadcastChannel !== 'undefined') {
    const channel = new window.BroadcastChannel(REALTIME_CHANNEL);
    channel.addEventListener('message', (event) => {
      if (event.data?.type === 'state-update') {
        state = event.data.state;
        renderView(state);
      }
    });
  }
}

function initializeApp() {
  authUsers = loadAuthUsers();
  const initialState = loadState();
  let state = initialState;
  shopProfile = state.shopProfile || shopProfile;
  const storedAuth = getStoredAuth();
  currentUser = storedAuth ? authenticateUser(storedAuth.username, storedAuth.password) : null;
  renderAuth(state);
  bindEvents(state);
  document.getElementById('connectivity').textContent = navigator.onLine ? 'Realtime ready' : 'Offline mode';
  window.addEventListener('online', () => {
    document.getElementById('connectivity').textContent = 'Realtime ready';
  });
  window.addEventListener('offline', () => {
    document.getElementById('connectivity').textContent = 'Offline mode';
  });

  // Hydrate from IndexedDB in the background so other devices with the same
  // app instance can pick up the latest persisted state (local device only).
  (async () => {
    try {
      const raw = await dbGet(STORAGE_KEY);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        state = {
          ...state,
          ...parsed,
          branches: parsed.branches || state.branches,
          inventory: parsed.inventory || state.inventory,
          transactions: parsed.transactions || state.transactions,
          shopProfile: parsed.shopProfile || state.shopProfile
        };

        const storedUsers = await dbGet(AUTH_USERS_STORAGE_KEY);
        if (storedUsers) {
          try { authUsers = typeof storedUsers === 'string' ? JSON.parse(storedUsers) : storedUsers; } catch { authUsers = storedUsers; }
        }

        const authFromDb = await dbGet(AUTH_STORAGE_KEY);
        if (authFromDb && !currentUser) {
          try {
            const parsedAuth = typeof authFromDb === 'string' ? JSON.parse(authFromDb) : authFromDb;
            currentUser = authenticateUser(parsedAuth.username, parsedAuth.password);
          } catch {}
        }

        saveState(state);
        renderAuth(state);
      }
    } catch (e) {
      console.warn('Failed to hydrate from IndexedDB', e);
    }
  })();
}

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', initializeApp);
}

export { initializeApp };
