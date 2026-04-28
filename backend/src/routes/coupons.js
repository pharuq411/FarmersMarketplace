const router = require('express').Router();
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');

async function resolveCoupon(code, farmerId) {
  const { rows } = await db.query('SELECT * FROM coupons WHERE code = $1', [code.toUpperCase()]);
  const coupon = rows[0];
  if (!coupon) return { error: 'Invalid coupon code', code: 'invalid_coupon' };
  if (coupon.farmer_id !== farmerId) return { error: 'Coupon not valid for this product', code: 'invalid_coupon' };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return { error: 'Coupon has expired', code: 'coupon_expired' };
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return { error: 'Coupon usage limit reached', code: 'coupon_exhausted' };
  return { coupon };
}

function calcDiscount(coupon, subtotal) {
  if (coupon.discount_type === 'percent')
    return Math.min(parseFloat((subtotal * coupon.discount_value / 100).toFixed(7)), subtotal);
  return Math.min(coupon.discount_value, subtotal);
}

// POST /api/coupons
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Only farmers can create coupons', 'forbidden');

  const { code, discount_type, discount_value, max_uses, expires_at } = req.body;
  if (!code || !discount_type || !discount_value)
    return err(res, 400, 'code, discount_type, and discount_value are required', 'validation_error');
  if (!['percent', 'fixed'].includes(discount_type))
    return err(res, 400, 'discount_type must be percent or fixed', 'validation_error');
  const value = parseFloat(discount_value);
  if (isNaN(value) || value <= 0)
    return err(res, 400, 'discount_value must be a positive number', 'validation_error');
  if (discount_type === 'percent' && value > 100)
    return err(res, 400, 'Percent discount cannot exceed 100', 'validation_error');

  try {
    const { rows } = await db.query(
      'INSERT INTO coupons (farmer_id, code, discount_type, discount_value, max_uses, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, code.toUpperCase(), discount_type, value, max_uses || null, expires_at || null]
    );
    res.json({ success: true, id: rows[0].id, code: code.toUpperCase() });
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.code === '23505') return err(res, 409, 'Coupon code already exists', 'conflict');
    throw e;
  }
});

// GET /api/coupons
router.get('/', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const { rows } = await db.query(
    'SELECT * FROM coupons WHERE farmer_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ success: true, data: rows });
});

// DELETE /api/coupons/:id
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'farmer') return err(res, 403, 'Farmers only', 'forbidden');
  const { rows } = await db.query(
    'SELECT * FROM coupons WHERE id = $1 AND farmer_id = $2',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return err(res, 404, 'Coupon not found', 'not_found');
  await db.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// POST /api/coupons/validate
router.post('/validate', auth, async (req, res) => {
  const { code, product_id } = req.body;
  if (!code || !product_id) return err(res, 400, 'code and product_id are required', 'validation_error');

  const { rows: pRows } = await db.query(
    'SELECT id, price, farmer_id FROM products WHERE id = $1',
    [product_id]
  );
  if (!pRows[0]) return err(res, 404, 'Product not found', 'not_found');

  const quantity = parseInt(req.body.quantity, 10) || 1;
  const subtotal = pRows[0].price * quantity;

  const { coupon, error, code: errCode } = await resolveCoupon(code, pRows[0].farmer_id);
  if (error) return err(res, 400, error, errCode);

  const discount = calcDiscount(coupon, subtotal);
  res.json({
    success: true,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount,
    final_total: parseFloat((subtotal - discount).toFixed(7)),
  });
});

module.exports = router;
module.exports.resolveCoupon = resolveCoupon;
module.exports.calcDiscount = calcDiscount;
