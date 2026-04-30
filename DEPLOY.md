# 🚀 Guía de Despliegue — Paso a Paso

Sin servidores, sin tarjeta de crédito, sin requisito de edad.

Stack: **GitHub → Koyeb** (backend + frontend) + **Neon** (PostgreSQL) + **Upstash** (Redis)

---

## PASO 1 — Subir el código a GitHub (5 min)

1. Ve a https://github.com → inicia sesión → botón verde **"New"**
2. Nombre del repo: `ai-platform` → **Create repository**
3. En tu ordenador, descomprime el ZIP y abre una terminal en la carpeta:

```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/ai-platform.git
git push -u origin main
```

---

## PASO 2 — Crear la base de datos en Neon (3 min)

1. Ve a https://neon.tech → **Start for free**
2. Crea un proyecto llamado `ai-platform`
3. Selecciona región **EU Central (Frankfurt)**
4. En el panel, busca **Connection string** → copia la URL (empieza por `postgresql://...`)
5. **Guárdala**, la necesitarás en el Paso 5

---

## PASO 3 — Ejecutar la migración SQL en Neon (2 min)

1. En Neon, ve a **SQL Editor**
2. Abre el archivo `scripts/migrations/001_init.sql` de tu proyecto
3. Copia todo su contenido y pégalo en el SQL Editor de Neon
4. Pulsa **Run** → verás "Success"

---

## PASO 4 — Crear Redis en Upstash (2 min)  *(opcional al principio)*

1. Ve a https://upstash.com → **Start for free**
2. **Create Database** → nombre `ai-platform` → región `eu-west-1`
3. Copia la **REST URL** → la necesitarás en el Paso 5

---

## PASO 5 — Desplegar en Koyeb (10 min)

### 5a — Crear cuenta
1. Ve a https://koyeb.com → **Get started for free**
2. Regístrate con GitHub

### 5b — Desplegar el Backend
1. Panel de Koyeb → **Create Service**
2. Selecciona **GitHub** → elige tu repo `ai-platform`
3. Configuración:
   - **Branch:** `main`
   - **Build command:** `cd backend && npm ci && npm run build`
   - **Run command:** `cd backend && node dist/server.js`
   - **Port:** `8000`
4. Baja hasta **Environment variables** → añade una a una:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `8000` |
| `DATABASE_URL` | *(la URL de Neon del Paso 2)* |
| `JWT_SECRET` | *(genera en https://generate-secret.vercel.app/64)* |
| `ANTHROPIC_API_KEY` | *(tu clave de Anthropic)* |
| `DEFAULT_AI_PROVIDER` | `anthropic` |
| `DEFAULT_MODEL` | `claude-sonnet-4-20250514` |
| `LEMONSQUEEZY_API_KEY` | *(del Paso 6)* |
| `LEMONSQUEEZY_STORE_ID` | *(del Paso 6)* |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | *(del Paso 6)* |
| `LS_VARIANT_STARTER` | *(del Paso 6)* |
| `LS_VARIANT_PRO` | *(del Paso 6)* |
| `LS_VARIANT_CREDITS` | *(del Paso 6)* |
| `PINECONE_API_KEY` | *(del Paso 7)* |
| `PINECONE_INDEX` | `ai-platform-memory` |
| `VECTOR_DB_PROVIDER` | `pinecone` |
| `FREE_CREDITS_ON_SIGNUP` | `100` |
| `CREDITS_PER_1K_TOKENS` | `1` |

5. Pulsa **Deploy** → espera 3-5 minutos
6. Koyeb te dará una URL como `https://ai-platform-backend-xxx.koyeb.app` → **cópiala**

### 5c — Desplegar el Frontend
1. **Create Service** → mismo repo
2. Configuración:
   - **Build command:** `cd frontend && npm ci && npm run build`
   - **Run command:** `cd frontend && node .next/standalone/server.js`
   - **Port:** `3000`
3. Variables de entorno:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `NEXT_PUBLIC_API_URL` | *(URL del backend del paso 5b)* |

4. Vuelve al servicio de **backend** → añade también:

| Variable | Valor |
|---|---|
| `FRONTEND_URL` | *(URL del frontend que acaba de darte Koyeb)* |

5. Pulsa **Redeploy** en el backend

---

## PASO 6 — Configurar LemonSqueezy (10 min)

1. Ve a https://app.lemonsqueezy.com → crea cuenta
2. **Stores** → crea una tienda
3. **Products** → crea 3 productos:
   - `Starter Pack` → 9,99€ → precio único
   - `Pro Pack` → 29,99€ → precio único
   - `Credits Pack` → 4,99€ → precio único
4. De cada producto copia el **Variant ID** (número en la URL)
5. **Settings → API** → **Create API key** → cópiala
6. **Webhooks** → **Add webhook**:
   - URL: `https://TU-BACKEND.koyeb.app/api/billing/webhook`
   - Eventos: `order_created`, `subscription_created`, `subscription_cancelled`
   - Copia el **Signing secret**

---

## PASO 7 — Configurar Pinecone (5 min)

1. Ve a https://pinecone.io → crea cuenta gratis
2. **Create Index**:
   - Nombre: `ai-platform-memory`
   - Dimensions: `1536`
   - Metric: `cosine`
3. **API Keys** → copia tu API key

---

## ✅ Verificación final

Abre en el navegador: `https://TU-BACKEND.koyeb.app/api/health`

Deberías ver:
```json
{ "status": "ok", "services": { "database": "ok" } }
```

Si aparece eso, **todo está funcionando**. 🎉

Tu frontend estará en: `https://TU-FRONTEND.koyeb.app`
