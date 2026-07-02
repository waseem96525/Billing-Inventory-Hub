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
let authUsers = [];  // Will be populated in initializeApp
let cart = [];
let lastReceipt = null;
let heldBills = [];
let activeDiscount = 0;
let priceOverride = null;
let shopId = 'default-shop'; // Shop ID for multi-device sync
let globalHeldBills = []; // Holds all bills from all devices
let customers = []; // Customer profiles with loyalty points
let selectedCustomerForDetail = null; // Track customer detail view
let returns = []; // Return/refund records
let pendingReturnTransaction = null; // Transaction selected for return
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
let lastCloudSaveTime = 0;
let isApplyingRemoteState = false;  // Flag to prevent recursive saves
let cloudSaveTimeout = null;

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
  if (!firebaseEnabled || !username || isApplyingRemoteState) return;
  
  try {
    // Debounce: don't save more than once per 500ms
    const now = Date.now();
    if (now - lastCloudSaveTime < 500) {
      // Clear existing timeout and set a new one
      if (cloudSaveTimeout) clearTimeout(cloudSaveTimeout);
      cloudSaveTimeout = setTimeout(() => {
        cloudSaveState(state, username);
      }, 500);
      return;
    }
    
    lastCloudSaveTime = now;
    const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
    const payload = { 
      state, 
      lastUpdated: Date.now(),
      device: Math.random().toString(36).substr(2, 9)  // device ID to detect conflicts
    };
    ref.set(payload).catch((e) => console.warn('cloudSaveState failed', e));
  } catch (e) {
    console.warn('cloudSaveState error', e);
  }
}

function cloudLoadInitialState(username) {
  if (!firebaseEnabled || !username) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const ref = window.firebase.database().ref(`/users/${encodeURIComponent(username)}/state`);
      ref.once('value', (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          resolve(val.state || val);
        } else {
          resolve(null);
        }
      }).catch((e) => {
        console.warn('cloudLoadInitialState failed', e);
        resolve(null);
      });
    } catch (e) {
      console.warn('cloudLoadInitialState error', e);
      resolve(null);
    }
  });
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
        // Set flag to prevent recursive saves when applying remote state
        isApplyingRemoteState = true;
        onUpdate(val.state || val);
        // Reset flag after a tick
        setTimeout(() => { isApplyingRemoteState = false; }, 100);
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

function cloudSaveAuthUsers(users) {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref('/global/authUsers');
    ref.set({ users, lastUpdated: Date.now() }).catch((e) => console.warn('cloudSaveAuthUsers failed', e));
  } catch (e) {
    console.warn('cloudSaveAuthUsers error', e);
  }
}

function cloudLoadAuthUsers() {
  if (!firebaseEnabled) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const ref = window.firebase.database().ref('/global/authUsers');
      ref.once('value', (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          resolve(val.users || null);
        } else {
          resolve(null);
        }
      }).catch((e) => {
        console.warn('cloudLoadAuthUsers failed', e);
        resolve(null);
      });
    } catch (e) {
      console.warn('cloudLoadAuthUsers error', e);
      resolve(null);
    }
  });
}

// Device ID for tracking which device the bill came from
function getDeviceId() {
  if (typeof window === 'undefined') return 'node-env';
  let deviceId = localStorage.getItem('device-id');
  if (!deviceId) {
    deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('device-id', deviceId);
  }
  return deviceId;
}

// Cloud sync for held bills (shared across all devices in shop)
function cloudSaveHeldBills(bills, shopId = 'default-shop') {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
    const billsWithMetadata = bills.map((bill, idx) => ({
      ...bill,
      id: bill.id || `bill_${Date.now()}_${idx}`,
      deviceId: bill.deviceId || getDeviceId(),
      cashier: bill.cashier || currentUser?.displayName || 'Unknown',
      createdAt: bill.createdAt || Date.now(),
      status: bill.status || 'open'
    }));
    ref.set(billsWithMetadata).catch((e) => console.warn('cloudSaveHeldBills failed', e));
  } catch (e) {
    console.warn('cloudSaveHeldBills error', e);
  }
}

function cloudLoadHeldBills(shopId = 'default-shop') {
  if (!firebaseEnabled) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
      ref.once('value', (snap) => {
        if (snap.exists()) {
          const val = snap.val();
          resolve(Array.isArray(val) ? val : Object.values(val));
        } else {
          resolve([]);
        }
      }).catch((e) => {
        console.warn('cloudLoadHeldBills error', e);
        resolve([]);
      });
    } catch (e) {
      console.warn('cloudLoadHeldBills error', e);
      resolve([]);
    }
  });
}

let heldBillsListener = null;
function cloudSubscribeHeldBills(shopId = 'default-shop', onUpdate) {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
    heldBillsListener = ref.on('value', (snap) => {
      const val = snap.val();
      const bills = val ? (Array.isArray(val) ? val : Object.values(val)) : [];
      onUpdate(bills);
    });
  } catch (e) {
    console.warn('cloudSubscribeHeldBills error', e);
  }
}

function cloudUnsubscribeHeldBills(shopId = 'default-shop') {
  if (!firebaseEnabled) return;
  try {
    const ref = window.firebase.database().ref(`/shops/${shopId}/heldBills`);
    ref.off();
  } catch (e) { }
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
  // Also sync to Firebase if enabled
  if (firebaseEnabled) {
    cloudSaveAuthUsers(users);
  }
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

export function addUser(username, password, role) {
  const trimmedUsername = String(username || '').trim();
  const trimmedPassword = String(password || '').trim();

  if (!trimmedUsername || !trimmedPassword) {
    return { success: false, message: 'Username and password required.' };
  }

  if (authUsers.some((user) => user.username === trimmedUsername)) {
    return { success: false, message: 'Username already exists.' };
  }

  const newUser = {
    username: trimmedUsername,
    password: trimmedPassword,
    role: role || 'cashier',
    displayName: trimmedUsername.charAt(0).toUpperCase() + trimmedUsername.slice(1)
  };

  authUsers.push(newUser);
  persistAuthUsers(authUsers);
  return { success: true, message: `User ${trimmedUsername} created successfully.` };
}

export function deleteUser(username) {
  if (username === 'admin' || username === 'cashier') {
    return { success: false, message: 'Cannot delete default users.' };
  }

  authUsers = authUsers.filter((user) => user.username !== username);
  persistAuthUsers(authUsers);
  return { success: true, message: `User ${username} deleted.` };
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

function persistAuth(user, password, rememberMe = false) {
  if (typeof window === 'undefined') return;
  if (user && password) {
    try {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ username: user, password, rememberMe }));
    } catch (e) {}
    dbSet(AUTH_STORAGE_KEY, JSON.stringify({ username: user, password, rememberMe })).catch(() => {});
  } else {
    try { window.localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
    dbDelete(AUTH_STORAGE_KEY).catch(() => {});
  }
}

function shouldAutoLogin() {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed.rememberMe === true;
  } catch (e) {
    return false;
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

// Held Bills Management Functions
export function addHeldBill(items, branchId, discount = 0) {
  const bill = {
    id: `bill_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    items: [...items],
    branchId,
    discount,
    deviceId: getDeviceId(),
    cashier: currentUser?.displayName || 'Unknown',
    createdAt: Date.now(),
    status: 'open'
  };
  heldBills.push(bill);
  globalHeldBills.push(bill);
  cloudSaveHeldBills(globalHeldBills, shopId);
  return bill;
}

export function removeHeldBill(billId) {
  heldBills = heldBills.filter((b) => b.id !== billId);
  globalHeldBills = globalHeldBills.filter((b) => b.id !== billId);
  cloudSaveHeldBills(globalHeldBills, shopId);
}

export function restoreHeldBill(billId) {
  const bill = globalHeldBills.find((b) => b.id === billId);
  if (!bill) return false;
  cart = [...bill.items];
  activeDiscount = bill.discount || 0;
  removeHeldBill(billId);
  return true;
}

export function transferHeldBill(billId, toCashier) {
  const bill = globalHeldBills.find((b) => b.id === billId);
  if (!bill) return false;
  bill.cashier = toCashier;
  bill.transferredAt = Date.now();
  cloudSaveHeldBills(globalHeldBills, shopId);
  return true;
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
  const returnsCountEl = document.getElementById('returns-count');
  if (returnsCountEl) returnsCountEl.textContent = returns.length.toString();

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
  if (currentUser?.role === 'admin') return ['admin', 'cashier', 'queue', 'customers', 'returns', 'analytics', 'settings'];
  if (currentUser?.role === 'cashier') return ['cashier', 'queue', 'customers', 'returns'];
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

function renderUsersList() {
  const usersList = document.getElementById('users-list');
  if (!usersList) return;

  usersList.innerHTML = authUsers.map((user) => `
    <div style="padding: 8px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <strong>${escapeHtml(user.username)}</strong>
        <span style="margin-left: 10px; color: #666; font-size: 0.9em;">${escapeHtml(user.role)}</span>
      </div>
      ${user.username !== 'admin' && user.username !== 'cashier' ? `
        <button class="delete-user-btn" data-username="${escapeHtml(user.username)}" style="padding: 5px 10px; background: #ff6b6b; color: white; border: none; border-radius: 3px; cursor: pointer;">Delete</button>
      ` : ''}
    </div>
  `).join('');

  // Add delete user event listeners
  usersList.querySelectorAll('.delete-user-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const username = btn.getAttribute('data-username');
      if (confirm(`Delete user "${username}"?`)) {
        const result = deleteUser(username);
        alert(result.message);
        renderUsersList();
      }
    });
  });
}

function renderView(state) {
  const allowedViews = getAllowedViews();
  if (!allowedViews.includes(currentView)) {
    currentView = allowedViews[0] || 'cashier';
  }

  document.getElementById('admin-panel').classList.toggle('hidden', currentView !== 'admin');
  document.getElementById('cashier-panel').classList.toggle('hidden', currentView !== 'cashier');
  document.getElementById('queue-panel').classList.toggle('hidden', currentView !== 'queue');
  document.getElementById('customers-panel').classList.toggle('hidden', currentView !== 'customers');
  document.getElementById('returns-panel').classList.toggle('hidden', currentView !== 'returns');
  document.getElementById('analytics-panel').classList.toggle('hidden', currentView !== 'analytics');
  document.getElementById('settings-panel').classList.toggle('hidden', currentView !== 'settings');
  document.querySelectorAll('.view-btn').forEach((button) => {
    const allowed = allowedViews.includes(button.dataset.view);
    button.classList.toggle('hidden', !allowed);
    button.classList.toggle('active', button.dataset.view === currentView && allowed);
  });
  renderAdmin(state);
  renderCashier(state, document.getElementById('cashier-branch')?.value || state.branches[0]?.id);
  renderQueue(state);
  renderCustomers(state);
  renderReturns(state);
  renderAnalytics(state);
  renderSettings(state);
}

// Analytics & Reporting Functions
function getAnalyticsPeriod() {
  return document.getElementById('analytics-period')?.value || 'month';
}

function filterTransactionsByPeriod(transactions, period) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  if (period === 'today') {
    return transactions.filter(t => {
      const tDate = new Date(t.timestamp);
      const tDay = new Date(tDate.getFullYear(), tDate.getMonth(), tDate.getDate());
      return tDay.getTime() === today.getTime();
    });
  } else if (period === 'week') {
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return transactions.filter(t => new Date(t.timestamp) >= weekAgo);
  } else if (period === 'month') {
    const monthAgo = new Date(today);
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    return transactions.filter(t => new Date(t.timestamp) >= monthAgo);
  }
  return transactions;
}

function calculateAnalytics(state, period) {
  const allTransactions = state.transactions || [];
  const transactions = filterTransactionsByPeriod(allTransactions, period);
  
  const totalRevenue = transactions.reduce((sum, t) => sum + (Number(t.total) || 0), 0);
  const totalTransactions = transactions.length;
  const totalItems = transactions.reduce((sum, t) => sum + (t.items || []).reduce((s, item) => s + Number(item.qty || 0), 0), 0);
  const avgBill = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;

  // Branch Performance
  const branchMap = {};
  const branches = state.branches || [];
  branches.forEach(branch => {
    branchMap[branch.id] = { name: branch.name, revenue: 0, count: 0, items: 0 };
  });
  transactions.forEach(t => {
    if (branchMap[t.branchId]) {
      branchMap[t.branchId].revenue += Number(t.total) || 0;
      branchMap[t.branchId].count += 1;
      branchMap[t.branchId].items += (t.items || []).reduce((s, item) => s + Number(item.qty || 0), 0);
    }
  });

  // Top Products
  const productMap = {};
  transactions.forEach(t => {
    (t.items || []).forEach(item => {
      if (!productMap[item.id]) {
        productMap[item.id] = { name: item.name, qty: 0, revenue: 0 };
      }
      productMap[item.id].qty += Number(item.qty) || 0;
      productMap[item.id].revenue += Number(item.qty || 0) * Number(item.rate || 0);
    });
  });

  // Cashier Performance
  const cashierMap = {};
  transactions.forEach(t => {
    const cashier = t.cashierName || 'Unknown';
    if (!cashierMap[cashier]) {
      cashierMap[cashier] = { count: 0, revenue: 0 };
    }
    cashierMap[cashier].count += 1;
    cashierMap[cashier].revenue += Number(t.total) || 0;
  });

  // Payment Methods
  const paymentMap = {};
  transactions.forEach(t => {
    const method = t.paymentMethod || 'Unknown';
    if (!paymentMap[method]) {
      paymentMap[method] = { count: 0, amount: 0 };
    }
    paymentMap[method].count += 1;
    paymentMap[method].amount += Number(t.total) || 0;
  });

  return {
    totalRevenue,
    totalTransactions,
    totalItems,
    avgBill,
    branches: Object.values(branchMap).sort((a, b) => b.revenue - a.revenue),
    topProducts: Object.entries(productMap)
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10),
    cashiers: Object.entries(cashierMap)
      .map(([name, data]) => ({ name, ...data, avgBill: data.count > 0 ? data.revenue / data.count : 0 }))
      .sort((a, b) => b.revenue - a.revenue),
    paymentMethods: Object.entries(paymentMap)
      .map(([method, data]) => ({ method, ...data, percentage: totalRevenue > 0 ? (data.amount / totalRevenue * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)
  };
}

function drawSalesTrendChart(transactions, period) {
  const canvas = document.getElementById('sales-trend-chart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const now = new Date();
  const data = [];
  const labels = [];
  
  let days = 7;
  if (period === 'month') days = 30;
  if (period === 'all') days = 90;
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    labels.push(date.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }));
    
    const dayTotal = transactions
      .filter(t => t.timestamp.substring(0, 10) === dateStr)
      .reduce((sum, t) => sum + (Number(t.total) || 0), 0);
    data.push(dayTotal);
  }
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw simple line chart
  const maxValue = Math.max(...data, 1);
  const padding = 40;
  const width = canvas.width - 2 * padding;
  const height = canvas.height - 2 * padding;
  const pointSpacing = width / (data.length - 1 || 1);
  
  // Draw grid
  ctx.strokeStyle = '#e0e0e0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding + (height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(canvas.width - padding, y);
    ctx.stroke();
  }
  
  // Draw line
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((value, index) => {
    const x = padding + index * pointSpacing;
    const y = canvas.height - padding - (value / maxValue) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  
  // Draw points
  ctx.fillStyle = '#2563eb';
  data.forEach((value, index) => {
    const x = padding + index * pointSpacing;
    const y = canvas.height - padding - (value / maxValue) * height;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2 * Math.PI);
    ctx.fill();
  });
  
  // Draw labels (every 3rd)
  ctx.fillStyle = '#666';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((label, index) => {
    if (index % Math.ceil(labels.length / 4) === 0) {
      const x = padding + index * pointSpacing;
      ctx.fillText(label, x, canvas.height - 10);
    }
  });
}

function renderAnalytics(state) {
  const period = getAnalyticsPeriod();
  const analytics = calculateAnalytics(state, period);
  
  // Update summary cards
  document.getElementById('analytics-revenue').textContent = formatCurrency(analytics.totalRevenue);
  document.getElementById('analytics-trans-count').textContent = analytics.totalTransactions;
  document.getElementById('analytics-items-count').textContent = analytics.totalItems;
  document.getElementById('analytics-avg-bill').textContent = formatCurrency(analytics.avgBill);
  
  // Draw chart
  drawSalesTrendChart(state.transactions || [], period);
  
  // Branch Performance Table
  const branchTable = document.getElementById('branch-performance-table');
  branchTable.innerHTML = analytics.branches.map(branch => `
    <tr>
      <td><strong>${escapeHtml(branch.name)}</strong></td>
      <td>${formatCurrency(branch.revenue)}</td>
      <td>${branch.count}</td>
      <td>${formatCurrency(branch.count > 0 ? branch.revenue / branch.count : 0)}</td>
    </tr>
  `).join('');
  
  // Top Products Table
  const productsTable = document.getElementById('top-products-table');
  productsTable.innerHTML = analytics.topProducts.map((product, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td><strong>${escapeHtml(product.name)}</strong></td>
      <td>${product.qty}</td>
      <td>${formatCurrency(product.revenue)}</td>
    </tr>
  `).join('');
  
  // Cashier Performance Table
  const cashierTable = document.getElementById('cashier-performance-table');
  cashierTable.innerHTML = analytics.cashiers.map(cashier => `
    <tr>
      <td><strong>${escapeHtml(cashier.name)}</strong></td>
      <td>${cashier.count}</td>
      <td>${formatCurrency(cashier.revenue)}</td>
      <td>${formatCurrency(cashier.avgBill)}</td>
    </tr>
  `).join('');
  
  // Payment Methods Table
  const paymentTable = document.getElementById('payment-methods-table');
  paymentTable.innerHTML = analytics.paymentMethods.map(payment => `
    <tr>
      <td><strong>${escapeHtml(payment.method)}</strong></td>
      <td>${payment.count}</td>
      <td>${formatCurrency(payment.amount)}</td>
      <td>${payment.percentage.toFixed(1)}%</td>
    </tr>
  `).join('');
}

// Returns & Refund Functions
function loadReturns() {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem('billing-inventory-hub-returns');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveReturns() {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem('billing-inventory-hub-returns', JSON.stringify(returns)); } catch (e) {}
}

function renderReturns(state) {
  const historyList = document.getElementById('returns-history-list');
  if (!historyList) return;

  if (!returns.length) {
    historyList.innerHTML = '<p class="muted" style="padding:16px;">No returns processed yet.</p>';
    return;
  }

  historyList.innerHTML = returns
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(ret => {
      const reasonLabels = {
        defective: 'Defective / Damaged',
        wrong_item: 'Wrong Item',
        customer_change: 'Customer Changed Mind',
        quality: 'Quality Issue',
        other: 'Other'
      };
      const refundLabels = {
        full: 'Full Refund',
        partial: 'Partial Refund',
        store_credit: 'Store Credit',
        exchange: 'Exchange Only'
      };
      return `
        <div class="return-history-item">
          <div class="return-history-header">
            <div>
              <strong class="return-bill-ref">Return #${ret.id}</strong>
              <span class="return-original-ref">→ Original: ${escapeHtml(ret.originalBillNumber)}</span>
            </div>
            <span class="return-date">${ret.date}</span>
          </div>
          <div class="return-history-body">
            <div class="return-history-items">
              ${ret.items.map(i => `<span class="return-item-tag">${escapeHtml(i.name)} × ${i.qty}</span>`).join('')}
            </div>
            <div class="return-history-meta">
              <span class="return-reason-tag">${reasonLabels[ret.reason] || ret.reason}</span>
              <span class="return-refund-tag">${refundLabels[ret.refundType] || ret.refundType}</span>
              <strong class="return-refund-amount">-${formatCurrency(ret.refundAmount)}</strong>
            </div>
          </div>
          ${ret.notes ? `<div class="return-notes-display">${escapeHtml(ret.notes)}</div>` : ''}
        </div>
      `;
    }).join('');
}

function processReturn(state, originalTransaction, selectedItems, reason, refundType, notes) {
  if (!originalTransaction || !selectedItems.length) return null;

  // Calculate refund amount from selected items
  const originalItemsMap = {};
  originalTransaction.items.forEach(item => {
    originalItemsMap[item.name] = item;
  });

  let refundAmount = 0;
  selectedItems.forEach(item => {
    const originalPrice = item.unitPrice || 0;
    refundAmount += originalPrice * item.qty;
  });

  // Apply original discount to refund
  if (originalTransaction.discountPercent) {
    refundAmount -= refundAmount * (originalTransaction.discountPercent / 100);
  }

  // Restore stock for returned items
  const newInventory = state.inventory.map(invItem => {
    const returnedItem = selectedItems.find(si => si.inventoryId === invItem.id);
    if (returnedItem) {
      return { ...invItem, stock: invItem.stock + returnedItem.qty };
    }
    return invItem;
  });

  // Create return record
  const returnRecord = {
    id: `RET-${Date.now()}`,
    originalTransactionId: originalTransaction.id,
    originalBillNumber: originalTransaction.billNumber || originalTransaction.id,
    date: new Date().toLocaleString(),
    items: selectedItems.map(i => ({ name: i.name, qty: i.qty })),
    refundAmount,
    reason,
    refundType,
    notes: notes || ''
  };

  returns.unshift(returnRecord);
  saveReturns();

  // Update state with new inventory
  const newState = { ...state, inventory: newInventory };
  return { returnRecord, newState, refundAmount };
}

// Customer Management & Loyalty Functions
function getOrCreateCustomer(phone, transactionDetails = null) {
  if (!phone || phone.trim() === '') return null;
  
  const cleanPhone = phone.trim();
  let customer = customers.find(c => c.phone === cleanPhone);
  
  if (!customer) {
    customer = {
      id: `cust_${Date.now()}`,
      phone: cleanPhone,
      name: transactionDetails?.customerName || 'Customer ' + cleanPhone.slice(-4),
      createdAt: new Date().toISOString(),
      totalSpent: 0,
      transactionCount: 0,
      loyaltyPoints: 0,
      transactions: []
    };
    customers.push(customer);
    saveCustomers();
  }
  
  return customer;
}

function addCustomerTransaction(customerId, transactionData) {
  const customer = customers.find(c => c.id === customerId);
  if (!customer) return;
  
  const pointsEarned = Math.floor(transactionData.total);
  
  customer.totalSpent += transactionData.total;
  customer.transactionCount += 1;
  customer.loyaltyPoints += pointsEarned;
  customer.transactions.push({
    id: transactionData.id,
    date: transactionData.timestamp,
    amount: transactionData.total,
    items: (transactionData.items || []).map(i => `${i.name} (${i.qty})`).join(', '),
    pointsEarned
  });
  
  saveCustomers();
}

function saveCustomers() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('billing-inventory-hub-customers', JSON.stringify(customers));
  } catch (e) {}
}

function loadCustomers() {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem('billing-inventory-hub-customers');
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function renderCustomers(state) {
  const detailView = document.getElementById('customer-detail-view');
  const customersList = document.getElementById('customers-list');
  const emptyState = document.getElementById('customers-empty');
  
  if (selectedCustomerForDetail) {
    // Show detail view
    detailView.classList.remove('hidden');
    const customer = customers.find(c => c.id === selectedCustomerForDetail);
    
    if (customer) {
      document.getElementById('detail-customer-name').textContent = customer.name;
      document.getElementById('detail-customer-phone').textContent = '📱 ' + customer.phone;
      document.getElementById('detail-trans-count').textContent = customer.transactionCount;
      document.getElementById('detail-total-spent').textContent = formatCurrency(customer.totalSpent);
      document.getElementById('detail-avg-trans').textContent = formatCurrency(customer.transactionCount > 0 ? customer.totalSpent / customer.transactionCount : 0);
      document.getElementById('detail-loyalty-points').textContent = customer.loyaltyPoints;
      document.getElementById('detail-points-input').value = customer.loyaltyPoints;
      
      // Render transaction history
      const historyTable = document.getElementById('detail-history-table');
      historyTable.innerHTML = (customer.transactions || []).map(trans => `
        <tr>
          <td>${new Date(trans.date).toLocaleDateString('en-IN')}</td>
          <td>${formatCurrency(trans.amount)}</td>
          <td>${escapeHtml(trans.items)}</td>
          <td>+${trans.pointsEarned}</td>
        </tr>
      `).join('');
    }
  } else {
    // Show customers list
    detailView.classList.add('hidden');
    const searchTerm = (document.getElementById('customer-search')?.value || '').toLowerCase();
    
    const filtered = customers.filter(c => 
      c.phone.includes(searchTerm) || c.name.toLowerCase().includes(searchTerm)
    );
    
    if (filtered.length === 0) {
      customersList.innerHTML = '';
      emptyState.classList.remove('hidden');
    } else {
      emptyState.classList.add('hidden');
      customersList.innerHTML = filtered
        .sort((a, b) => b.transactionCount - a.transactionCount)
        .map(customer => `
          <tr>
            <td>${escapeHtml(customer.phone)}</td>
            <td>${escapeHtml(customer.name)}</td>
            <td>${customer.transactionCount}</td>
            <td>${formatCurrency(customer.totalSpent)}</td>
            <td><span class="loyalty-badge">${customer.loyaltyPoints} pts</span></td>
            <td><button class="view-customer-btn" data-customer-id="${customer.id}">View</button></td>
          </tr>
        `).join('');
    }
  }
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
  
  // Render thresholds
  renderThresholds(state);
}

function renderThresholds(state) {
  const container = document.getElementById('thresholds-container');
  if (!container) return;
  
  const items = state.inventory || [];
  if (!items.length) {
    container.innerHTML = '<p class="muted">No inventory items yet. Add items in Admin Console to set thresholds.</p>';
    return;
  }
  
  container.innerHTML = items.map(item => {
    const isLow = item.stock <= item.lowStock;
    const statusClass = isLow ? 'threshold-low' : 'threshold-healthy';
    
    return `
      <div class="threshold-item ${statusClass}">
        <div class="threshold-header">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="threshold-status ${isLow ? 'alert-badge' : 'healthy-badge'}">
            ${isLow ? '🔴 Low' : '✓ Healthy'}
          </span>
        </div>
        <div class="threshold-info">
          <span>Current: <strong>${item.stock}</strong></span>
          <span>•</span>
          <span>Min: <strong>${item.lowStock}</strong></span>
          <span>•</span>
          <span>SKU: ${escapeHtml(item.sku)}</span>
        </div>
        <div class="threshold-input-group">
          <label>Set minimum threshold:</label>
          <input type="number" min="0" value="${item.lowStock}" class="threshold-input" data-item-id="${item.id}" />
          <button class="threshold-save-btn" data-item-id="${item.id}">Update</button>
        </div>
      </div>
    `;
  }).join('');
}

function getLowStockAlerts(state) {
  const items = state.inventory || [];
  return items.filter(item => item.stock <= item.lowStock).map(item => ({
    id: item.id,
    name: item.name,
    sku: item.sku,
    current: item.stock,
    threshold: item.lowStock,
    reorderQty: Math.ceil(item.lowStock * 1.5)
  }));
}

function renderQueue(state) {
  const queueList = document.getElementById('queue-list');
  const queueBadge = document.getElementById('queue-badge');
  const queueStatus = document.getElementById('queue-status');
  const queueTotalBills = document.getElementById('queue-total-bills');
  const queueActiveDevices = document.getElementById('queue-active-devices');
  const queueTotalItems = document.getElementById('queue-total-items');
  const queueTotalValue = document.getElementById('queue-total-value');

  if (!globalHeldBills.length) {
    queueList.innerHTML = '<div class="list-item"><p class="muted">No active bills in queue</p></div>';
    queueBadge.textContent = '0 bills';
    queueStatus.textContent = 'Queue empty';
    queueTotalBills.textContent = '0';
    queueActiveDevices.textContent = '0';
    queueTotalItems.textContent = '0';
    queueTotalValue.textContent = '₹0.00';
    return;
  }

  // Group bills by device
  const billsByDevice = {};
  globalHeldBills.forEach((bill) => {
    if (!billsByDevice[bill.deviceId]) {
      billsByDevice[bill.deviceId] = [];
    }
    billsByDevice[bill.deviceId].push(bill);
  });

  // Calculate statistics
  const totalItems = globalHeldBills.reduce((sum, bill) => sum + (bill.items?.length || 0), 0);
  const totalValue = globalHeldBills.reduce((sum, bill) => {
    const billTotal = bill.items?.reduce((s, item) => s + (item.qty * item.price), 0) || 0;
    return sum + (billTotal - (billTotal * (bill.discount || 0) / 100));
  }, 0);

  // Update statistics
  queueBadge.textContent = `${globalHeldBills.length} bills`;
  queueStatus.textContent = 'Live sync active';
  queueTotalBills.textContent = globalHeldBills.length.toString();
  queueActiveDevices.textContent = Object.keys(billsByDevice).length.toString();
  queueTotalItems.textContent = totalItems.toString();
  queueTotalValue.textContent = formatCurrency(totalValue);

  // Render bills grouped by device
  queueList.innerHTML = Object.entries(billsByDevice)
    .map(([deviceId, deviceBills]) => {
      const deviceShort = deviceId.substring(0, 14) + '...';
      const deviceBillsHtml = deviceBills
        .map((bill) => {
          const billSubtotal = bill.items?.reduce((s, item) => s + (item.qty * item.price), 0) || 0;
          const billDiscount = billSubtotal * ((bill.discount || 0) / 100);
          const billTotal = billSubtotal - billDiscount;
          const itemsText = bill.items?.map((i) => `${i.name} (${i.qty})`).join(', ') || 'No items';
          const createdTime = new Date(bill.createdAt).toLocaleTimeString();
          
          return `
            <div style="padding: 8px; border-left: 3px solid #5b6cff; background: #f9fbff; margin: 6px 0; border-radius: 6px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <strong>${bill.cashier}</strong>
                <span class="muted" style="font-size: 0.8rem;">${createdTime}</span>
              </div>
              <p class="muted" style="margin: 2px 0; font-size: 0.85rem;">${itemsText}</p>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
                <span class="small" style="color: #14213d;">₹${billTotal.toFixed(2)}</span>
                <div style="gap: 6px; display: flex;">
                  <button class="restore-bill-btn" data-bill-id="${bill.id}" style="padding: 4px 8px; font-size: 0.8rem; background: #f0f4ff; color: #1c3b7a; border: none; border-radius: 6px; cursor: pointer;">Restore</button>
                  <button class="transfer-bill-btn" data-bill-id="${bill.id}" style="padding: 4px 8px; font-size: 0.8rem; background: #f0f4ff; color: #1c3b7a; border: none; border-radius: 6px; cursor: pointer;">Transfer</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
      
      return `
        <div class="list-item" style="padding: 10px; margin-bottom: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong style="color: #102445;">📱 Device: ${deviceShort}</strong>
            <span class="pill" style="font-size: 0.8rem;">${deviceBills.length} bills</span>
          </div>
          ${deviceBillsHtml}
        </div>
      `;
    })
    .join('');

  // Add event listeners for restore buttons
  document.querySelectorAll('.restore-bill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const billId = btn.getAttribute('data-bill-id');
      if (restoreHeldBill(billId)) {
        currentView = 'cashier';
        renderView(state);
        alert('Bill restored to cart. Ready for checkout.');
      }
    });
  });

  // Add event listeners for transfer buttons
  document.querySelectorAll('.transfer-bill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const billId = btn.getAttribute('data-bill-id');
      const newCashier = prompt('Enter cashier name to transfer to:');
      if (newCashier && transferHeldBill(billId, newCashier)) {
        alert(`Bill transferred to ${newCashier}`);
        renderQueue(state);
      }
    });
  });
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
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const rememberMe = document.getElementById('login-remember').checked;
    const user = authenticateUser(username, password);
    const errorBox = document.getElementById('login-error');
    if (!user) {
      errorBox.textContent = 'Invalid username or password.';
      errorBox.classList.remove('hidden');
      return;
    }
    currentUser = user;
    persistAuth(username, password, rememberMe);
    errorBox.classList.add('hidden');
    document.getElementById('login-form').reset();
    renderAuth(state);
    // initialize firebase and load user's cloud state
    firebaseInit();
    if (firebaseEnabled) {
      // Load initial state from Firebase on login (for new device scenario)
      const remoteState = await cloudLoadInitialState(currentUser.username);
      if (remoteState) {
        try {
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
        } catch (e) { console.warn('Error applying initial remote state', e); }
      }
      // Subscribe to real-time updates after initial load
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

  // User management (admin only)
  const userForm = document.getElementById('user-form');
  if (userForm) {
    userForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const username = document.getElementById('user-username').value.trim();
      const password = document.getElementById('user-password').value.trim();
      const role = document.getElementById('user-role').value;
      
      const result = addUser(username, password, role);
      alert(result.message);
      
      if (result.success) {
        document.getElementById('user-form').reset();
        renderUsersList();
      }
    });
  }

  document.querySelectorAll('.view-btn').forEach((button) => {
    button.addEventListener('click', () => {
      currentView = button.dataset.view;
      renderView(state);
      // Re-render users list when switching to admin view
      if (button.dataset.view === 'admin') {
        renderUsersList();
      }
    });
  });

  // Analytics period selector
  const analyticsPeriod = document.getElementById('analytics-period');
  if (analyticsPeriod) {
    analyticsPeriod.addEventListener('change', () => {
      renderAnalytics(state);
    });
  }

  // Customer Management event listeners
  const customerSearch = document.getElementById('customer-search');
  if (customerSearch) {
    customerSearch.addEventListener('input', () => {
      renderCustomers(state);
    });
  }

  // Customer list click handler
  document.addEventListener('click', (event) => {
    const viewBtn = event.target.closest('.view-customer-btn');
    if (viewBtn) {
      selectedCustomerForDetail = viewBtn.getAttribute('data-customer-id');
      renderCustomers(state);
      return;
    }

    const closeBtn = document.getElementById('close-customer-detail');
    if (event.target === closeBtn) {
      selectedCustomerForDetail = null;
      renderCustomers(state);
      return;
    }

    const updatePointsBtn = document.getElementById('update-points-btn');
    if (event.target === updatePointsBtn) {
      if (!selectedCustomerForDetail) return;
      const customer = customers.find(c => c.id === selectedCustomerForDetail);
      if (!customer) return;
      
      const newPoints = Number(document.getElementById('detail-points-input').value) || 0;
      customer.loyaltyPoints = newPoints;
      saveCustomers();
      renderCustomers(state);
      return;
    }

    const thresholdSaveBtn = event.target.closest('.threshold-save-btn');
    if (thresholdSaveBtn) {
      const itemId = thresholdSaveBtn.getAttribute('data-item-id');
      const input = thresholdSaveBtn.previousElementSibling;
      const newThreshold = Number(input.value) || 0;
      
      const itemIndex = state.inventory.findIndex(i => i.id === itemId);
      if (itemIndex !== -1) {
        state.inventory[itemIndex].lowStock = newThreshold;
        saveState(state);
        renderThresholds(state);
        
        // Show brief notification
        const btn = thresholdSaveBtn;
        const originalText = btn.textContent;
        btn.textContent = '✓ Saved';
        btn.style.backgroundColor = '#10b981';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.backgroundColor = '';
        }, 1500);
      }
      return;
    }
  });

  // Return search button
  document.getElementById('return-search-btn').addEventListener('click', () => {
    const receiptInput = document.getElementById('return-receipt-input').value.trim();
    const resultDiv = document.getElementById('return-search-result');
    const formCard = document.getElementById('return-form-card');
    const itemsList = document.getElementById('return-items-list');

    if (!receiptInput) {
      resultDiv.innerHTML = '<p class="return-search-error">Please enter a receipt/bill number.</p>';
      resultDiv.classList.remove('hidden');
      formCard.classList.add('hidden');
      return;
    }

    // Find transaction by billNumber or id (case-insensitive)
    const txn = state.transactions.find(t =>
      (t.billNumber || '').toLowerCase() === receiptInput.toLowerCase() ||
      t.id.toLowerCase() === receiptInput.toLowerCase()
    );

    if (!txn) {
      resultDiv.innerHTML = `<p class="return-search-error">No transaction found for "<strong>${escapeHtml(receiptInput)}</strong>". Please check the receipt number.</p>`;
      resultDiv.classList.remove('hidden');
      formCard.classList.add('hidden');
      pendingReturnTransaction = null;
      return;
    }

    // Check if already fully returned
    const existingReturns = returns.filter(r => r.originalTransactionId === txn.id);
    const alreadyReturnedItemNames = existingReturns.flatMap(r => r.items.map(i => i.name));

    pendingReturnTransaction = txn;

    resultDiv.innerHTML = `
      <div class="return-found-info">
        <strong>Found: ${escapeHtml(txn.billNumber || txn.id)}</strong>
        <span>${txn.timestamp}</span>
        <span>Total: ${formatCurrency(txn.total)}</span>
        <span>Payment: ${txn.paymentMethod}</span>
      </div>
    `;
    resultDiv.classList.remove('hidden');

    // Build per-item unit prices from total/subtotal
    const itemCount = txn.items.length;
    const avgPrice = itemCount > 0 ? (txn.subtotal || txn.total) / txn.items.reduce((s, i) => s + i.qty, 0) : 0;

    // Build return items list
    itemsList.innerHTML = txn.items.map((item, index) => {
      // Attempt to find in inventory for accurate price and id
      const invItem = state.inventory.find(inv => inv.name === item.name);
      const unitPrice = invItem ? invItem.sellingPrice : avgPrice;
      const inventoryId = invItem ? invItem.id : '';
      const alreadyReturned = alreadyReturnedItemNames.includes(item.name);

      return `
        <div class="return-item-row ${alreadyReturned ? 'return-item-disabled' : ''}">
          <label class="return-item-check">
            <input type="checkbox" class="return-item-checkbox" 
              data-name="${escapeHtml(item.name)}" 
              data-unit-price="${unitPrice}" 
              data-inventory-id="${inventoryId}"
              data-max-qty="${item.qty}"
              ${alreadyReturned ? 'disabled' : ''}
            />
            <span>${escapeHtml(item.name)}</span>
          </label>
          <div class="return-item-detail">
            <span class="return-unit-price">${formatCurrency(unitPrice)} each</span>
            <label class="return-qty-wrap">
              Qty: <input type="number" min="1" max="${item.qty}" value="${item.qty}" 
                class="return-qty-input" data-index="${index}"
                ${alreadyReturned ? 'disabled' : ''}
              />
              <span class="return-qty-max">/ ${item.qty}</span>
            </label>
          </div>
          ${alreadyReturned ? '<span class="already-returned-tag">Already returned</span>' : ''}
        </div>
      `;
    }).join('');

    formCard.classList.remove('hidden');
    updateReturnSummary();
  });

  // Update summary on checkbox / qty change
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('return-item-checkbox') || e.target.classList.contains('return-qty-input')) {
      updateReturnSummary();
    }
  });

  function updateReturnSummary() {
    const checkboxes = document.querySelectorAll('.return-item-checkbox:checked');
    let totalQty = 0;
    let totalRefund = 0;
    checkboxes.forEach(cb => {
      const row = cb.closest('.return-item-row');
      const qtyInput = row.querySelector('.return-qty-input');
      const qty = Math.min(Number(qtyInput?.value || 1), Number(cb.dataset.maxQty || 1));
      const unitPrice = Number(cb.dataset.unitPrice || 0);
      totalQty += qty;
      totalRefund += qty * unitPrice;
    });
    if (pendingReturnTransaction?.discountPercent) {
      totalRefund -= totalRefund * (pendingReturnTransaction.discountPercent / 100);
    }
    document.getElementById('return-item-count').textContent = totalQty;
    document.getElementById('return-refund-amount').textContent = formatCurrency(totalRefund);
  }

  // Process return button
  document.getElementById('process-return-btn').addEventListener('click', () => {
    if (!pendingReturnTransaction) return;

    const checkboxes = document.querySelectorAll('.return-item-checkbox:checked');
    if (!checkboxes.length) {
      alert('Please select at least one item to return.');
      return;
    }

    const selectedItems = Array.from(checkboxes).map(cb => {
      const row = cb.closest('.return-item-row');
      const qtyInput = row.querySelector('.return-qty-input');
      const qty = Math.min(Number(qtyInput?.value || 1), Number(cb.dataset.maxQty || 1));
      return {
        name: cb.dataset.name,
        qty,
        unitPrice: Number(cb.dataset.unitPrice || 0),
        inventoryId: cb.dataset.inventoryId
      };
    });

    const reason = document.getElementById('return-reason').value;
    const refundType = document.getElementById('return-refund-type').value;
    const notes = document.getElementById('return-notes').value.trim();

    const result = processReturn(state, pendingReturnTransaction, selectedItems, reason, refundType, notes);
    if (!result) return;

    state = result.newState;
    saveState(state);
    renderView(state);

    // Show confirmation
    const formCard = document.getElementById('return-form-card');
    const resultDiv = document.getElementById('return-search-result');
    formCard.classList.add('hidden');
    resultDiv.innerHTML = `
      <div class="return-success-banner">
        <strong>✓ Return processed successfully!</strong>
        <span>Refund: ${formatCurrency(result.refundAmount)} • Items: ${selectedItems.map(i => `${i.name} × ${i.qty}`).join(', ')}</span>
      </div>
    `;
    document.getElementById('return-receipt-input').value = '';
    pendingReturnTransaction = null;
  });

  // Cancel return button
  document.getElementById('cancel-return-btn').addEventListener('click', () => {
    document.getElementById('return-form-card').classList.add('hidden');
    document.getElementById('return-search-result').classList.add('hidden');
    document.getElementById('return-receipt-input').value = '';
    pendingReturnTransaction = null;
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
    const branchId = document.getElementById('cashier-branch').value;
    addHeldBill(cart, branchId, activeDiscount);
    clearCart();
    activeDiscount = 0;
    priceOverride = null;
    document.getElementById('discount-input').value = '0';
    document.getElementById('price-override-input').value = '';
    renderView(state);
    alert('Bill held successfully and synced to cloud.');
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
    const customerPhone = document.getElementById('customer-phone').value;
    
    const result = checkoutCart(state, branchId, paymentMethod, 'Cashier', activeDiscount);
    if (!result.success) {
      alert(result.message);
      return;
    }
    
    // Save customer transaction if phone was provided
    if (customerPhone && customerPhone.trim()) {
      const customer = getOrCreateCustomer(customerPhone);
      if (customer) {
        addCustomerTransaction(customer.id, result.transaction);
      }
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
    document.getElementById('customer-phone').value = '';
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
  // Initialize Firebase first so we can load global auth users
  firebaseInit();
  
  // Load auth users synchronously first, then try to sync from Firebase
  authUsers = loadAuthUsers();
  const initialState = loadState();
  let state = initialState;
  shopProfile = state.shopProfile || shopProfile;
  customers = loadCustomers();
  returns = loadReturns();
  
  // Load auth users from Firebase if available (for cross-device sync)
  if (firebaseEnabled) {
    cloudLoadAuthUsers().then((firebaseUsers) => {
      if (firebaseUsers && firebaseUsers.length > 0) {
        authUsers = firebaseUsers;
        persistAuthUsers(authUsers);
        renderUsersList();
      }
    }).catch((e) => console.warn('Failed to load auth users from Firebase', e));
  }
  
  const storedAuth = getStoredAuth();
  const shouldAutoLoginFlag = storedAuth && shouldAutoLogin();
  
  if (shouldAutoLoginFlag && storedAuth) {
    // Auto-login if "Remember Me" was checked
    currentUser = authenticateUser(storedAuth.username, storedAuth.password);
    if (currentUser) {
      firebaseInit();
      if (firebaseEnabled) {
        cloudLoadInitialState(currentUser.username).then((remoteState) => {
          if (remoteState) {
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
          }
        });
        cloudSubscribe(currentUser.username, (remoteState) => {
          try {
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
        
        // Subscribe to shared held bills for live queue
        cloudLoadHeldBills(shopId).then((bills) => {
          globalHeldBills = bills;
          renderQueue(state);
        });
        cloudSubscribeHeldBills(shopId, (bills) => {
          globalHeldBills = bills;
          renderQueue(state);
        });
      }
    }
  } else {
    currentUser = null;
  }
  
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
