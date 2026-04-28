const BASE = "/api";

// Access token lives in memory only — never in localStorage
let accessToken = null;

export function setAccessToken(token) {
  accessToken = token;
}

export function clearAccessToken() {
  accessToken = null;
}

function getCsrfToken() {
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrf_token="));
  return match ? match.trim().split("=")[1] : null;
}

// Lazily fetches a CSRF token from the server if the cookie is missing
let csrfReady = null;
function ensureCsrfToken() {
  if (getCsrfToken()) return Promise.resolve();
  if (!csrfReady) {
    csrfReady = fetch(`${BASE}/csrf-token`, { credentials: "include" })
      .then((r) => r.json())
      .catch(() => null)
      .finally(() => { csrfReady = null; });
  }
  return csrfReady;
}

// Attempt to get a fresh access token using the HttpOnly refresh cookie
async function refreshAccessToken() {
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = await res.json();
  accessToken = data.token;
  return accessToken;
}

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
const CSRF_EXEMPT = ["/auth/login", "/auth/register"];

async function request(path, options = {}, retry = true) {
  const method = (options.method || "GET").toUpperCase();
  const needsCsrf = MUTATING.includes(method) && !CSRF_EXEMPT.includes(path);

  if (needsCsrf) await ensureCsrfToken();

  const csrfToken = needsCsrf ? getCsrfToken() : null;
  const isFormData = options.body instanceof FormData;

  const headers = {};
  if (!isFormData) headers["Content-Type"] = "application/json";
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  Object.assign(headers, options.headers || {});

  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    body: isFormData
      ? options.body
      : options.body
        ? JSON.stringify(options.body)
        : undefined,
  });

  // Silent refresh on 401
  if (res.status === 401 && retry) {
    const newToken = await refreshAccessToken();
    if (newToken) return request(path, options, false);
    clearAccessToken();
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Session expired");
  }

  // Rate limited — surface a friendly message
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    const msg = retryAfter
      ? `Too many requests. Please wait ${retryAfter} seconds and try again.`
      : "Too many requests. Please slow down and try again shortly.";
    throw Object.assign(new Error(msg), { code: "rate_limited", status: 429 });
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || "Request failed");
  return data;
}

/** Build a query string from a params object, omitting empty/null values. */
function toQs(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== "" && v != null);
  return entries.length ? "?" + new URLSearchParams(entries).toString() : "";
}

export const api = {
  // Auth
  register: (body) => request("/auth/register", { method: "POST", body }),
  login: (body) => request("/auth/login", { method: "POST", body }),
  logout: () => request("/auth/logout", { method: "POST" }),
  refresh: () => refreshAccessToken(),
  getMe: () => request("/auth/me"),

  // Products
  getProducts: (filters = {}) => request(`/products${toQs(filters)}`),
  getCategories: () => request("/products/categories"),
  getProduct: (id) => request(`/products/${id}`),
  createProduct: (body) => request("/products", { method: "POST", body }),
  getMyProducts: () => request("/products/mine/list"),
  restockProduct: (id, quantity) =>
    request(`/products/${id}/restock`, { method: "PATCH", body: { quantity } }),
  deleteProduct: (id) => request(`/products/${id}`, { method: "DELETE" }),
  updateProduct: (id, body) => request(`/products/${id}`, { method: "PATCH", body }),
  searchProducts: (q) => request(`/products/search?q=${encodeURIComponent(q)}`),
  getProductReviews: (id) => request(`/products/${id}/reviews`),
  uploadProductImage: (file) => {
    const form = new FormData();
    form.append("image", file);
    return request("/products/upload-image", { method: "POST", body: form });
  },
  bulkUploadProducts: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/products/bulk", { method: "POST", body: form });
  },
  getProductImages: (productId) => request(`/products/${productId}/images`),
  uploadProductImages: (productId, files) => {
    const form = new FormData();
    files.forEach((f) => form.append("images", f));
    return request(`/products/${productId}/images`, { method: "POST", body: form });
  },
  deleteProductImage: (productId, imageId) =>
    request(`/products/${productId}/images/${imageId}`, { method: "DELETE" }),
  reorderProductImages: (productId, order) =>
    request(`/products/${productId}/images/reorder`, { method: "PATCH", body: { order } }),

  // Stock alerts
  setStockAlert: (productId) =>
    request(`/products/${productId}/alert`, { method: "POST" }),
  removeStockAlert: (productId) =>
    request(`/products/${productId}/alert`, { method: "DELETE" }),
  getMyAlert: (productId) => request(`/products/${productId}/alert/status`),

  // Orders
  placeOrder: (body, idempotencyKey) =>
    request("/orders", {
      method: "POST",
      body,
      headers: idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {},
    }),
  getOrder: (id) => request(`/orders/${id}`),
  getOrders: (params = {}) => request(`/orders${toQs(params)}`),
  getSales: (params = {}) => request(`/orders/sales${toQs(params)}`),
  updateOrderStatus: (id, status) =>
    request(`/orders/${id}/status`, { method: "PATCH", body: { status } }),

  // Escrow
  fundEscrow: (orderId) => request(`/orders/${orderId}/escrow`, { method: "POST" }),
  claimEscrow: (orderId) => request(`/orders/${orderId}/claim`, { method: "POST" }),
  claimPreorder: (orderId) =>
    request(`/orders/${orderId}/claim-preorder`, { method: "POST" }),

  // Reviews
  submitReview: (body) => request("/reviews", { method: "POST", body }),

  // Wallet
  getWallet: () => request("/wallet"),
  getTransactions: () => request("/wallet/transactions"),
  fundWallet: () => request("/wallet/fund", { method: "POST" }),
  sendXLM: (body) => request("/wallet/send", { method: "POST", body }),
  getWalletStreamUrl: () =>
    `/api/wallet/stream?token=${encodeURIComponent(accessToken || "")}`,

  // Farmers
  getFarmer: (id) => request(`/farmers/${id}`),
  updateFarmerProfile: (body) => request("/farmers/me", { method: "PATCH", body }),

  // Favorites
  addFavorite: (productId) =>
    request("/favorites", { method: "POST", body: { product_id: productId } }),
  removeFavorite: (productId) =>
    request(`/favorites/${productId}`, { method: "DELETE" }),
  getFavorites: (params = {}) => request(`/favorites${toQs(params)}`),
  checkFavorite: (productId) => request(`/favorites/check/${productId}`),

  // Rates & Analytics
  getXlmRate: () => request("/rates/xlm-usd"),
  getAnalytics: () => request("/analytics/farmer"),

  // Addresses
  getAddresses: () => request("/addresses"),
  createAddress: (body) => request("/addresses", { method: "POST", body }),
  updateAddress: (id, body) => request(`/addresses/${id}`, { method: "PUT", body }),
  deleteAddress: (id) => request(`/addresses/${id}`, { method: "DELETE" }),
  setDefaultAddress: (id) => request(`/addresses/${id}/default`, { method: "PATCH" }),

  // Coupons
  createCoupon: (body) => request("/coupons", { method: "POST", body }),
  getMyCoupons: () => request("/coupons"),
  deleteCoupon: (id) => request(`/coupons/${id}`, { method: "DELETE" }),
  validateCoupon: (body) => request("/coupons/validate", { method: "POST", body }),

  // Bundles
  getBundles: () => request("/bundles"),
  createBundle: (body) => request("/bundles", { method: "POST", body }),
  deleteBundle: (id) => request(`/bundles/${id}`, { method: "DELETE" }),
  purchaseBundle: (bundle_id) =>
    request("/bundles/purchase", { method: "POST", body: { bundle_id } }),
  getBundleOrders: () => request("/bundles/orders"),

  // Subscriptions
  getSubscriptions: () => request("/subscriptions"),
  createSubscription: (body) => request("/subscriptions", { method: "POST", body }),
  cancelSubscription: (id) => request(`/subscriptions/${id}`, { method: "DELETE" }),
  pauseSubscription: (id) => request(`/subscriptions/${id}/pause`, { method: "PATCH" }),
  resumeSubscription: (id) =>
    request(`/subscriptions/${id}/resume`, { method: "PATCH" }),

  // Admin
  adminGetUsers: (page = 1) => request(`/admin/users?page=${page}`),
  adminDeactivateUser: (id) => request(`/admin/users/${id}`, { method: "DELETE" }),
  adminGetStats: () => request("/admin/stats"),
};
