# Setting Up Your .env File

## ⚠️ SECURITY WARNING
**NEVER commit your `.env` file to git!** It contains sensitive credentials.

## Quick Setup Steps

1. **Copy the example file:**
   ```bash
   cd backend
   copy .env.example .env
   ```

2. **Open `.env` file and update these values:**

   ```env
   # Shopify Configuration
   SHOPIFY_SHOP_DOMAIN=marketplace.vectra-intl.com
   SHOPIFY_API_KEY=af6fff6d297f5f0cfbcece46ecaf3f51
   SHOPIFY_API_SECRET=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
   SHOPIFY_WEBHOOK_SECRET=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
   ```

   **Note:** Using your API secret as webhook secret is fine for now. You can generate a separate secret later if needed.

3. **Generate a JWT Secret:**
   
   Using PowerShell:
   ```powershell
   [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
   ```
   
   Or using Node.js:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   
   Add it to `.env`:
   ```env
   JWT_SECRET=your_generated_secret_here
   ```

4. **Verify your setup:**
   ```bash
   node scripts/test-shopify-connection.js
   ```

## Complete .env File Template

```env
# Server Configuration
PORT=3001
NODE_ENV=development

# MongoDB
MONGODB_URI=mongodb://localhost:27017/lms
# Or MongoDB Atlas: mongodb+srv://username:password@cluster.mongodb.net/lms

# Shopify Configuration
SHOPIFY_SHOP_DOMAIN=marketplace.vectra-intl.com
SHOPIFY_API_KEY=af6fff6d297f5f0cfbcece46ecaf3f51
SHOPIFY_API_SECRET=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
SHOPIFY_WEBHOOK_SECRET=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

# JWT Secret (generate a random secret)
JWT_SECRET=your_generated_jwt_secret_here

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:3000

# Backend API URL
BACKEND_URL=http://localhost:3001
```

## Next Steps

1. ✅ Create `.env` file with your credentials
2. ✅ Generate and set JWT_SECRET
3. ✅ Install MongoDB (or set up MongoDB Atlas)
4. ✅ Install backend dependencies: `npm install`
5. ✅ Test connection: `node scripts/test-shopify-connection.js`
6. ✅ Start backend: `npm run dev`

## Important Notes

- **Access Token**: After installing your Shopify app, you'll get an Access Token. Store it securely if needed for direct API calls.
- **Webhooks**: Set up webhooks in Shopify Admin → Settings → Notifications
- **MongoDB**: Make sure MongoDB is running before starting the backend
