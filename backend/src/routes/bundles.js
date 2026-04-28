const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');
const { sendPayment, getBalance } = require('../utils/stellar');

// GET /api/bundles
router.get('/', async (_req, res) => {
  const { rows: bundles } = await db.query(
    `SELECT b.*, u.name as farmer_name FROM bundles b
     JOIN users u ON b.farmer_id = u.id
     ORDER BY b.created_at DESC`
  );

  const data = await Promise.all(bundles.map(async (b) => {
    const { rows: items } = await db.query(
      `SELECT bi.*, p.name as product_name, p.unit, p.quantity as stock
       FROM bundle_items bi JOIN products p ON bi.product_id = p.id
       WHERE bi.bundle_id = $1`,
      [b.id]
    );
    return { ...b, items };
  }));

  res.json({ success: true, data });
});

// POST /api/bundles
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Only farmers can create bundles', 'forbidden');

  const { name, description, price, items } = req.body;
  if (!name || !name.trim()) return err(res, 400, 'name is required', 'validation_error');
  const bundlePrice = parseFloat(price);
  if (isNaN(bundlePrice) || bundlePrice <= 0) return err(res, 400, 'price must be a positive number', 'validation_error');
  if (!Array.isArray(items) || items.length === 0) return err(res, 400, 'items must be a non-empty array', 'validation_error');

  for (const item of items) {
    if (!item.product_id || !Number.isInteger(item.quantity) || item.quantity < 1)
      return err(res, 400, 'Each item needs product_id and a positive integer quantity', 'validation_error');
    const { rows } = await db.query('SELECT id, farmer_id FROM products WHERE id = $1', [item.product_id]);
    if (!rows[0]) return err(res, 404, `Product ${item.product_id} not found`, 'not_found');
    if (rows[0].farmer_id !== req.user.id) return err(res, 403, `Product ${item.product_id} does not belong to you`, 'forbidden');
  }

  const { rows: bRows } = await db.query(
    'INSERT INTO bundles (farmer_id, name, description, price) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.user.id, name.trim(), description || null, bundlePrice]
  );
  const bundleId = bRows[0].id;

  for (const item of items) {
    await db.query(
      'INSERT INTO bundle_items (bundle_id, product_id, quantity) VALUES ($1,$2,$3)',
      [bundleId, item.product_id, item.quantity]
    );
  }

  res.status(201).json({ success: true, id: bundleId });
});

// DELETE /api/bundles/:id
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const { rows } = await db.query(
    'SELECT * FROM bundles WHERE id = $1 AND farmer_id = $2',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return err(res, 404, 'Bundle not found or not yours', 'not_found');
  await db.query('DELETE FROM bundles WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// POST /api/bundles/purchase
router.post('/purchase', auth, async (req, res) => {
  if (req.user.role !== 'buyer') return err(res, 403, 'Only buyers can purchase bundles', 'forbidden');

  const { bundle_id } = req.body;
  if (!bundle_id) return err(res, 400, 'bundle_id is required', 'validation_error');

  const { rows: bRows } = await db.query(
    `SELECT b.*, u.stellar_public_key as farmer_wallet
     FROM bundles b JOIN users u ON b.farmer_id = u.id
     WHERE b.id = $1`,
    [bundle_id]
  );
  const bundle = bRows[0];
  if (!bundle) return err(res, 404, 'Bundle not found', 'not_found');

  const { rows: items } = await db.query(
    `SELECT bi.*, p.quantity as stock, p.name as product_name
     FROM bundle_items bi JOIN products p ON bi.product_id = p.id
     WHERE bi.bundle_id = $1`,
    [bundle_id]
  );

  for (const item of items) {
    if (item.stock < item.quantity)
      return err(res, 400, `Insufficient stock for "${item.product_name}"`, 'insufficient_stock');
  }

  const { rows: buyerRows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const buyer = buyerRows[0];
  const balance = await getBalance(buyer.stellar_public_key);
  if (balance < bundle.price + 0.00001)
    return res.status(402).json({ success: false, message: 'Insufficient XLM balance', code: 'insufficient_balance' });

  // Decrement stock for all items
  for (const item of items) {
    const { rowCount } = await db.query(
      'UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1',
      [item.quantity, item.product_id]
    );
    if (rowCount === 0)
      return err(res, 400, `Insufficient stock for "${item.product_name}"`, 'insufficient_stock');
  }

  const { rows: oRows } = await db.query(
    'INSERT INTO bundle_orders (buyer_id, bundle_id, total_price, status) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.user.id, bundle_id, bundle.price, 'pending']
  );
  const orderId = oRows[0].id;

  try {
    const txHash = await sendPayment({
      senderSecret: buyer.stellar_secret_key,
      receiverPublicKey: bundle.farmer_wallet,
      amount: bundle.price,
      memo: `Bundle#${orderId}`,
    });
    await db.query(
      'UPDATE bundle_orders SET status = $1, stellar_tx_hash = $2 WHERE id = $3',
      ['paid', txHash, orderId]
    );
    res.json({ success: true, orderId, txHash, totalPrice: bundle.price });
  } catch (e) {
    await db.query('UPDATE bundle_orders SET status = $1 WHERE id = $2', ['failed', orderId]);
    for (const item of items)
      await db.query('UPDATE products SET quantity = quantity + $1 WHERE id = $2', [item.quantity, item.product_id]);
    res.status(402).json({ success: false, message: 'Payment failed: ' + e.message, code: 'payment_failed', orderId });
  }
});

// GET /api/bundles/orders
router.get('/orders', auth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT bo.*, b.name as bundle_name, b.description as bundle_description
     FROM bundle_orders bo JOIN bundles b ON bo.bundle_id = b.id
     WHERE bo.buyer_id = $1
     ORDER BY bo.created_at DESC`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
});

module.exports = router;
