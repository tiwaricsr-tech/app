'use strict';
/**
 * Embedded (SQLite) schema — mirrors /supabase/schema.sql so the same application
 * code runs against Supabase PostgreSQL in production.
 */

const DDL = `
CREATE TABLE IF NOT EXISTS roles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  description   TEXT,
  is_system     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  phone          TEXT,
  role_id        INTEGER NOT NULL REFERENCES roles(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  sku                 TEXT NOT NULL UNIQUE,
  category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  image_url           TEXT,
  description         TEXT,
  purchase_price      REAL NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  selling_price       REAL NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 10 CHECK (low_stock_threshold >= 0),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  quantity_change INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after  INTEGER NOT NULL CHECK (quantity_after >= 0),
  unit_cost       REAL,
  reference_type  TEXT,
  reference_id    INTEGER,
  note            TEXT,
  user_id         INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no      TEXT NOT NULL UNIQUE,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  customer_email  TEXT,
  customer_address TEXT,
  status          TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','cancelled','refunded')),
  subtotal        REAL NOT NULL DEFAULT 0,
  discount_type   TEXT NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','fixed')),
  discount_value  REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_rate        REAL NOT NULL DEFAULT 0,
  tax_amount      REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL DEFAULT 'cash',
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  updated_by      INTEGER REFERENCES users(id),
  cancelled_by    INTEGER REFERENCES users(id),
  cancelled_reason TEXT,
  cancelled_at    TEXT,
  refunded_at     TEXT,
  idempotency_key TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  sku          TEXT NOT NULL,
  unit_price   REAL NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  line_total   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_created ON invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items(product_id);
`;

async function ensureSchema(db) {
  await db.exec(DDL);
}

module.exports = { ensureSchema, DDL };
