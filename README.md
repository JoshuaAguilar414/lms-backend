# LMS Backend API

Express + MongoDB backend for the VECTRA LMS system.

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Start MongoDB:**
   - Local: Make sure MongoDB is running on `mongodb://localhost:27017`
   - Or use MongoDB Atlas and update `MONGODB_URI` in `.env`

4. **Run the server:**
   ```bash
   npm run dev  # Development mode with auto-reload
   # or
   npm start    # Production mode
   ```

## API Endpoints

### Authentication
- `POST /api/auth/shopify-verify` - Verify Shopify session token; returns LMS JWT and user (body: `{ token: "<shopify-session-jwt>" }` or `Authorization: Bearer <token>`)
- `POST /api/auth/sync-user` - Sync user profile from Shopify token (body or Bearer)

### Courses
- `GET /api/courses` - List all active courses
- `GET /api/courses/:id` - Get course by ID
- `GET /api/courses/shopify/:productId` - Get course by Shopify product ID
- `POST /api/courses` - Create/update course (admin)

### Enrollments
- `GET /api/enrollments` - Get user's enrollments
- `GET /api/enrollments/:id` - Get enrollment details
- `POST /api/enrollments` - Create enrollment

### Progress
- `GET /api/progress/:enrollmentId` - Get progress for enrollment
- `POST /api/progress` - Update course progress
- `PUT /api/progress/:enrollmentId` - Update progress (alternative)

### Webhooks (all data comes from Shopify)

- **Orders:** `order-created`, `order-updated` – sync order data, create/update enrollments
- **Products/Courses:** `product-created`, `product-updated` – sync products as courses
- **Users/Customers:** `customers-create`, `customers-update` – sync customers as users

| Endpoint | Shopify topic | Purpose |
|----------|----------------|---------|
| `POST /api/webhooks/shopify/order-created` | orders/create | Sync customer, create enrollments from line items |
| `POST /api/webhooks/shopify/order-updated` | orders/updated | Update enrollment status (e.g. refund/cancel) |
| `POST /api/webhooks/shopify/product-created` | products/create | Create course from product |
| `POST /api/webhooks/shopify/product-updated` | products/update | Update course from product |
| `POST /api/webhooks/shopify/customers-create` | customers/create | Sync new customer to User |
| `POST /api/webhooks/shopify/customers-update` | customers/update | Sync customer updates to User |

## Database Models (synced from Shopify)

- **User** – Shopify customers (synced via order customer data + customers/create, customers/update)
- **Course** – Shopify products (synced via products/create, products/update)
- **Enrollment** – Derived from Shopify orders (order line items → course access)
- **Progress** – LMS-only: learning progress and SCORM data

## Shopify Integration

### Setting up Shopify Webhooks

1. Go to Shopify Admin → Settings → Notifications
2. Add webhook endpoints (format: JSON):
   - Orders: `.../api/webhooks/shopify/order-created`, `.../api/webhooks/shopify/order-updated`
   - Products: `.../api/webhooks/shopify/product-created`, `.../api/webhooks/shopify/product-updated`
   - Customers: `.../api/webhooks/shopify/customers-create`, `.../api/webhooks/shopify/customers-update`

3. In Shopify Admin, subscribe each URL to the matching topic (e.g. orders/create → order-created)
4. Copy webhook secret to `.env` as `SHOPIFY_WEBHOOK_SECRET` (or use `SHOPIFY_API_SECRET`; raw body is used for HMAC verification)

### Shopify API Setup

1. Create a Shopify app in Partners Dashboard
2. Get API credentials (API Key & Secret)
3. Add to `.env`:
   ```
   SHOPIFY_API_KEY=your_api_key
   SHOPIFY_API_SECRET=your_api_secret
   ```

## Development

The server runs on `http://localhost:3001` by default.

Health check: `GET http://localhost:3001/health`

## Next Steps

1. Add SCORM data parsing and storage
3. Implement certificate generation
4. Add analytics endpoints
5. Set up proper error logging
