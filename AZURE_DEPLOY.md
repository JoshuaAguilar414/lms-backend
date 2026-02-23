# Backend on Azure App Service – Env & "Application Error"

On Azure, **the backend does not use a `.env` file**. The `.env` file is only for local development and is not deployed (it's in `.gitignore`). All configuration in production must come from **Azure Application settings**.

If you see **"Application Error"** on the backend URL, it is usually because required environment variables are missing or wrong in Azure. The app crashes on startup (for example when it cannot connect to MongoDB).

---

## Required: Set these in Azure

In **Azure Portal** → your **LMS-Backend** Web App → **Configuration** → **Application settings**, add these. Then **Save** and **Restart** the app.

| Name | Example value | Notes |
|------|----------------|--------|
| `MONGODB_URI` | `mongodb+srv://user:pass@cluster.mongodb.net/lms?retryWrites=true&w=majority` | **Required.** Without this, the app exits on startup (MongoDB connection failure). Use your Cosmos DB (MongoDB API) or Atlas connection string. |
| `JWT_SECRET` | A long random string (see below) | **Required** for auth (LMS login tokens). LMS-only; does **not** need to match Shopify. |
| `FRONTEND_URL` | Your **frontend** app URL (e.g. `https://training.vectra-intl.com`, `https://lms-frontend.azurewebsites.net`) | **Required** for CORS and for redirect to `/auth/login?jwtToken=...`. No trailing slash. Frontend and backend can be on different domains. |

**How to generate `JWT_SECRET`** (you create it; Shopify does not use it):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use the full output (64 hex characters) as the value. Set it only in the LMS backend (e.g. Azure Application settings); never in Shopify.

---

## Optional but recommended

| Name | Example | Notes |
|------|---------|--------|
| `NODE_ENV` | `production` | So the app runs in production mode. |
| `WEBSITE_NODE_DEFAULT_VERSION` | `~20` | Match the Node version used in the GitHub workflow (currently 20). |
| `BACKEND_URL` | `https://lms-backend.azurewebsites.net` | Used for SCORM/API callbacks; no trailing slash. |

---

## Shopify (if you use Shopify auth / webhooks)

| Name | Notes |
|------|--------|
| `SHOPIFY_SHOP_DOMAIN` | Your Shopify store domain (e.g. `marketplace.vectra-intl.com`). |
| `SHOPIFY_API_KEY` | From Shopify Partner Dashboard → your app → Client credentials. |
| `SHOPIFY_API_SECRET` | **From Shopify** (Client secret in app). Backend uses it to verify Shopify session JWTs; it **must match** the value in your Shopify app. |
| `SHOPIFY_WEBHOOK_SECRET` | From Shopify webhook config (optional; can fall back to `SHOPIFY_API_SECRET`). |

If these are missing, login via Shopify and webhooks may fail, but the app may still start. **Note:** `JWT_SECRET` is for LMS tokens only; `SHOPIFY_API_SECRET` is from Shopify and must match the app.

### My Courses (frontend and backend on different domains)

- **Shopify "My Courses" link:** use the **backend** URL: `https://<your-backend-domain>/api/courses/user/{customerId}/{email}` (e.g. `https://lms-backend.azurewebsites.net/api/courses/user/...`).
- **Backend** redirects to **frontend** after login: set `FRONTEND_URL` to your frontend app URL (e.g. `https://training.vectra-intl.com`). The redirect goes to `{FRONTEND_URL}/auth/login?jwtToken=...`.

### External JWT login (/auth/login?jwtToken=... with ApnaSite JWT)

If "My Courses" on Shopify redirects to `https://training.vectra-intl.com/auth/login?jwtToken=...`, the backend must verify that JWT and issue an LMS token.

| Name | Notes |
|------|--------|
| `EXTERNAL_JWT_SECRET` | Secret used to sign the external JWT (e.g. ApnaSite). Must match the system that issues the `jwtToken`. Required for `POST /api/auth/external-login`. |

---

## Checklist when you see "Application Error"

1. **Log stream** – Web App → **Monitoring** → **Log stream**. Refresh the backend URL and check the first error (e.g. "MongoDB connection failed", "JWT_SECRET", "Cannot find module"). That tells you what is missing or wrong.
2. **Application settings** – Add at least `MONGODB_URI`, `JWT_SECRET`, and `FRONTEND_URL` (see table above). Use your real Cosmos DB / MongoDB connection string.
3. **Node version** – Add `WEBSITE_NODE_DEFAULT_VERSION` = `~20` so Azure uses Node 20 (same as the deploy workflow).
4. **Save and Restart** – After changing Configuration, click **Save** and then **Restart** the app.
5. **Test** – Open `https://lms-backend.azurewebsites.net/health`; you should get `{"status":"ok",...}`.

---

## Summary

- **Yes, it is related to “env”** – not the file, but the **environment variables** that the app reads via `process.env`.
- On Azure, those come only from **Configuration** → **Application settings**. Set them there; do not rely on a `.env` file in the repo or on the server.
