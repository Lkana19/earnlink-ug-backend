// EarnLink UG — Pesapal payment backend
//
// WHAT THIS DOES:
// 1. Starts a payment when a buyer wants to purchase a product
// 2. Listens for Pesapal's automatic payment notification (IPN)
// 3. Checks the real payment status with Pesapal
// 4. Only marks an order as "paid" once Pesapal confirms it
//
// YOU NEED TO FILL IN (see the .env file created alongside this):
//   PESAPAL_CONSUMER_KEY
//   PESAPAL_CONSUMER_SECRET
//   PESAPAL_IPN_ID          (you get this after registering your IPN URL — step 2 below)
//   YOUR_DOMAIN             (the real web address this server runs on, once deployed)

const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves your index.html

const PESAPAL_BASE = 'https://pay.pesapal.com/v3'; // use https://cybqa.pesapal.com/pesapalv3 for sandbox/testing

// In-memory order store for demo purposes.
// For real use, replace this with a real database (e.g. a free Postgres/SQLite instance).
const orders = {}; // { orderId: { productId, buyerPhone, status, downloadLink } }

// --- Step A: Get an auth token from Pesapal ---
async function getPesapalToken() {
  const res = await axios.post(`${PESAPAL_BASE}/api/Auth/RequestToken`, {
    consumer_key: process.env.PESAPAL_CONSUMER_KEY,
    consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
  });
  return res.data.token;
}

// --- Step B: Start a payment for a product ---
// Your app's front-end calls this when someone taps "pay"
app.post('/api/start-payment', async (req, res) => {
  try {
    const { productId, productName, price, buyerEmail, buyerPhone } = req.body;
    const token = await getPesapalToken();
    const orderId = 'order_' + Date.now();

    const orderRes = await axios.post(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      {
        id: orderId,
        currency: 'UGX',
        amount: price,
        description: productName,
        callback_url: `${process.env.YOUR_DOMAIN}/payment-complete`,
        notification_id: process.env.PESAPAL_IPN_ID,
        billing_address: {
          email_address: buyerEmail || undefined,
          phone_number: buyerPhone || undefined
        }
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    orders[orderId] = { productId, status: 'PENDING' };

    // Send the buyer to Pesapal's real payment page
    res.json({ redirectUrl: orderRes.data.redirect_url, orderId });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'could not start payment' });
  }
});

// --- Step C: Pesapal calls this automatically after payment (IPN) ---
app.get('/api/ipn', async (req, res) => {
  try {
    const { OrderTrackingId, OrderMerchantReference } = req.query;
    const token = await getPesapalToken();

    const statusRes = await axios.get(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${OrderTrackingId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const status = statusRes.data.payment_status_description; // e.g. "Completed", "Failed"

    if (orders[OrderMerchantReference]) {
      orders[OrderMerchantReference].status = status.toUpperCase();
    }

    // Pesapal expects this exact response shape to confirm receipt
    res.json({
      orderNotificationType: 'IPNCHANGE',
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: 200
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'ipn handling failed' });
  }
});

// --- Step D: Your app's front-end calls this to check "has this order been paid yet?" ---
app.get('/api/order-status/:orderId', (req, res) => {
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json({ status: order.status });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server running on port ${PORT}`));
