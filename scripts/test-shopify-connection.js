import dotenv from 'dotenv';
import axios from 'axios';
import crypto from 'crypto';

// Load environment variables
dotenv.config({ path: '.env' });

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

console.log('🔍 Testing Shopify Connection...\n');
console.log('Shop Domain:', SHOPIFY_SHOP_DOMAIN);
console.log('API Key:', SHOPIFY_API_KEY ? `${SHOPIFY_API_KEY.substring(0, 10)}...` : 'NOT SET');
console.log('API Secret:', SHOPIFY_API_SECRET ? 'SET ✓' : 'NOT SET ✗');
console.log('');

// Note: Admin API requires an Access Token, not just API key/secret
// The access token is generated when you install the app
// For now, we'll test if credentials are set correctly

if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
  console.error('❌ Missing Shopify credentials in .env file');
  console.log('\nPlease ensure your .env file contains:');
  console.log('SHOPIFY_SHOP_DOMAIN=marketplace.vectra-intl.com');
  console.log('SHOPIFY_API_KEY=your_api_key');
  console.log('SHOPIFY_API_SECRET=your_api_secret');
  process.exit(1);
}

console.log('✅ Credentials found in .env file\n');

// Test webhook signature verification
console.log('Testing webhook signature verification...');
const testPayload = JSON.stringify({ test: 'data' });
const hmac = crypto
  .createHmac('sha256', SHOPIFY_API_SECRET)
  .update(testPayload)
  .digest('base64');

console.log('✅ Webhook signature generation works');
console.log('Sample HMAC:', hmac.substring(0, 20) + '...\n');

console.log('📝 Next Steps:');
console.log('1. Install your Shopify app to get an Access Token');
console.log('2. Use the Access Token for Admin API calls');
console.log('3. Set up webhooks in Shopify Admin → Settings → Notifications');
console.log('4. Test webhook endpoints with Shopify webhook tester\n');

console.log('🔗 Useful Links:');
console.log(`- Shopify Admin: https://${SHOPIFY_SHOP_DOMAIN}/admin`);
console.log(`- Apps Settings: https://${SHOPIFY_SHOP_DOMAIN}/admin/settings/apps`);
console.log(`- Webhooks: https://${SHOPIFY_SHOP_DOMAIN}/admin/settings/notifications`);
