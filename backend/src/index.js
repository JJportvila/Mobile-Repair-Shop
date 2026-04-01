import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BlobNotFoundError, head, put } from "@vercel/blob";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import selfsigned from "selfsigned";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const frontendDistPath = path.resolve(backendRoot, "..", "frontend", "dist");
const isVercelRuntime = Boolean(process.env.VERCEL);
const localDbPath = path.resolve(backendRoot, process.env.DATABASE_PATH ?? "./data/stitch.sqlite");
const dbPath = isVercelRuntime
  ? path.join(os.tmpdir(), "stitch-vercel.sqlite")
  : localDbPath;
const certsDir = path.resolve(backendRoot, "certs");
const httpsKeyPath = path.resolve(certsDir, "localhost-key.pem");
const httpsCertPath = path.resolve(certsDir, "localhost-cert.pem");
const blobSnapshotPath = process.env.DB_BLOB_PATH ?? "database/stitch.sqlite";
const blobPersistenceEnabled = isVercelRuntime && Boolean(process.env.BLOB_READ_WRITE_TOKEN);

if (isVercelRuntime && !fs.existsSync(dbPath)) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (fs.existsSync(localDbPath)) {
    fs.copyFileSync(localDbPath, dbPath);
  }
}

let blobSnapshotUrl = null;
let persistQueue = Promise.resolve();

await ensurePersistentDatabaseReady();

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function getLocalHostnames() {
  const hosts = new Set(["localhost", "127.0.0.1"]);
  const machineName = os.hostname()?.trim();

  if (machineName) {
    hosts.add(machineName);
  }

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) {
        hosts.add(entry.address);
      }
    }
  }

  return Array.from(hosts);
}

function ensureHttpsCertificate() {
  fs.mkdirSync(certsDir, { recursive: true });

  if (fs.existsSync(httpsKeyPath) && fs.existsSync(httpsCertPath)) {
    return {
      key: fs.readFileSync(httpsKeyPath, "utf8"),
      cert: fs.readFileSync(httpsCertPath, "utf8"),
      hosts: getLocalHostnames(),
    };
  }

  const altNames = getLocalHostnames().map((value) => {
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
    return isIp ? { type: 7, ip: value } : { type: 2, value };
  });

  const generated = selfsigned.generate(
    [{ name: "commonName", value: "stitch-repair.local" }],
    {
      algorithm: "sha256",
      days: 825,
      keySize: 2048,
      extensions: [
        {
          name: "basicConstraints",
          cA: false,
        },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
        },
        {
          name: "subjectAltName",
          altNames,
        },
      ],
    },
  );

  fs.writeFileSync(httpsKeyPath, generated.private, "utf8");
  fs.writeFileSync(httpsCertPath, generated.cert, "utf8");

  return {
    key: generated.private,
    cert: generated.cert,
    hosts: getLocalHostnames(),
  };
}

async function ensurePersistentDatabaseReady() {
  if (!blobPersistenceEnabled) {
    return;
  }

  try {
    const existing = await head(blobSnapshotPath);
    blobSnapshotUrl = existing.url;

    const response = await fetch(existing.downloadUrl, {
      headers: {
        Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Unable to download persisted database: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(arrayBuffer));
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) {
      console.warn("Failed to restore Vercel Blob database snapshot:", error);
    }
  }
}

async function persistDatabaseSnapshot(reason = "update") {
  if (!blobPersistenceEnabled || !fs.existsSync(dbPath)) {
    return;
  }

  const fileBuffer = fs.readFileSync(dbPath);
  const uploaded = await put(blobSnapshotPath, fileBuffer, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/x-sqlite3",
  });

  blobSnapshotUrl = uploaded.url;
  console.log(`Persisted database snapshot (${reason}) to ${uploaded.pathname}`);
}

function queueDatabaseSnapshot(reason) {
  if (!blobPersistenceEnabled) {
    return;
  }

  persistQueue = persistQueue
    .catch(() => undefined)
    .then(() => persistDatabaseSnapshot(reason))
    .catch((error) => {
      console.error("Failed to persist Vercel Blob database snapshot:", error);
    });
}

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'standard'
  );

  CREATE TABLE IF NOT EXISTS parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE,
    stock INTEGER NOT NULL,
    reorder_level INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    cost_price INTEGER NOT NULL DEFAULT 0,
    supplier TEXT NOT NULL DEFAULT 'Core Parts Supply'
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    device_name TEXT NOT NULL,
    status TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    technician TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    deposit INTEGER NOT NULL DEFAULT 0,
    issue_summary TEXT NOT NULL,
    notes TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id)
  );

  CREATE TABLE IF NOT EXISTS order_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    part_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders (id),
    FOREIGN KEY (part_id) REFERENCES parts (id)
  );

  CREATE TABLE IF NOT EXISTS inventory_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id INTEGER NOT NULL,
    movement_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (part_id) REFERENCES parts (id)
  );

  CREATE TABLE IF NOT EXISTS inbound_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL UNIQUE,
    source_currency TEXT NOT NULL DEFAULT 'VUV',
    exchange_rate REAL NOT NULL DEFAULT 1,
    shipping_fee INTEGER NOT NULL DEFAULT 0,
    customs_fee INTEGER NOT NULL DEFAULT 0,
    declaration_fee INTEGER NOT NULL DEFAULT 0,
    other_fee INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inbound_batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    part_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    supplier_name TEXT NOT NULL DEFAULT '',
    source_unit_price REAL NOT NULL DEFAULT 0,
    landed_unit_cost INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (batch_id) REFERENCES inbound_batches (id),
    FOREIGN KEY (part_id) REFERENCES parts (id)
  );

  CREATE TABLE IF NOT EXISTS order_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    sender TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    body TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS order_completion (
    order_id INTEGER PRIMARY KEY,
    warranty TEXT NOT NULL DEFAULT 'Standard Warranty Applied',
    checklist_json TEXT NOT NULL DEFAULT '[]',
    final_notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS order_execution (
    order_id INTEGER PRIMARY KEY,
    phase TEXT NOT NULL DEFAULT 'diagnosis',
    checklist_json TEXT NOT NULL DEFAULT '[]',
    elapsed_minutes INTEGER NOT NULL DEFAULT 45,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS order_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    stage TEXT NOT NULL DEFAULT '维修后',
    image_url TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS receipt_meta (
    order_id INTEGER PRIMARY KEY,
    printed_at TEXT,
    picked_up_at TEXT,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'original',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    review TEXT NOT NULL,
    reply TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS customer_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    order_id INTEGER,
    channel TEXT NOT NULL DEFAULT 'phone',
    note TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers (id),
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    tone TEXT NOT NULL DEFAULT 'primary',
    message TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS procurements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    procurement_no TEXT NOT NULL UNIQUE,
    supplier TEXT NOT NULL,
    part_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    source_currency TEXT NOT NULL DEFAULT 'VUV',
    source_unit_price REAL NOT NULL DEFAULT 0,
    exchange_rate REAL NOT NULL DEFAULT 1,
    shipping_fee INTEGER NOT NULL DEFAULT 0,
    customs_fee INTEGER NOT NULL DEFAULT 0,
    other_fee INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT '运输中',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (part_id) REFERENCES parts (id)
  );

  CREATE TABLE IF NOT EXISTS inventory_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_id INTEGER NOT NULL,
    adjustment_type TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit TEXT NOT NULL DEFAULT 'PCS',
    note TEXT NOT NULL DEFAULT '',
    operator TEXT NOT NULL DEFAULT 'Inventory Manager',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (part_id) REFERENCES parts (id)
  );

  CREATE TABLE IF NOT EXISTS inventory_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_no TEXT NOT NULL,
    part_id INTEGER NOT NULL,
    system_stock INTEGER NOT NULL,
    actual_stock INTEGER NOT NULL,
    discrepancy INTEGER NOT NULL,
    operator TEXT NOT NULL DEFAULT 'Aiden',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (part_id) REFERENCES parts (id)
  );

  CREATE TABLE IF NOT EXISTS order_intake (
    order_id INTEGER PRIMARY KEY,
    intake_code TEXT NOT NULL UNIQUE,
    imei_serial TEXT NOT NULL,
    customer_signature TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders (id)
  );

  CREATE TABLE IF NOT EXISTS notification_reads (
    notification_id TEXT PRIMARY KEY,
    read_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS order_form_brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    market TEXT NOT NULL DEFAULT 'Vanuatu',
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS order_form_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (brand_id, name),
    FOREIGN KEY (brand_id) REFERENCES order_form_brands (id)
  );

  CREATE TABLE IF NOT EXISTS order_form_technicians (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS order_form_issue_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings_store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    store_name TEXT NOT NULL,
    store_code TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    address TEXT NOT NULL,
    cover_image TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings_business_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_label TEXT NOT NULL,
    hours_value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings_business_rules (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holiday_enabled INTEGER NOT NULL DEFAULT 1,
    holiday_hours TEXT NOT NULL DEFAULT '10:00 - 15:00',
    holiday_note TEXT NOT NULL DEFAULT '节假日统一调整为 10:00 - 15:00，并在订单页显示公告。'
  );

  CREATE TABLE IF NOT EXISTS settings_staff (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    scope TEXT NOT NULL,
    can_edit_orders INTEGER NOT NULL DEFAULT 1,
    can_adjust_inventory INTEGER NOT NULL DEFAULT 0,
    can_view_finance INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings_language (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    primary_language TEXT NOT NULL DEFAULT 'zh-CN',
    external_language TEXT NOT NULL DEFAULT 'en',
    local_language TEXT NOT NULL DEFAULT 'bi',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings_print (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paper_size TEXT NOT NULL DEFAULT '58mm',
    qr_enabled INTEGER NOT NULL DEFAULT 1,
    default_receipt_enabled INTEGER NOT NULL DEFAULT 1,
    footer_brand_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const partColumns = db.prepare("PRAGMA table_info(parts)").all();
const hasSupplierColumn = partColumns.some((column) => column.name === "supplier");
const hasCostPriceColumn = partColumns.some((column) => column.name === "cost_price");
const orderColumns = db.prepare("PRAGMA table_info(orders)").all();
const hasDepositColumn = orderColumns.some((column) => column.name === "deposit");
const procurementColumns = db.prepare("PRAGMA table_info(procurements)").all();
const hasProcurementSourceCurrency = procurementColumns.some((column) => column.name === "source_currency");
const hasProcurementSourceUnitPrice = procurementColumns.some((column) => column.name === "source_unit_price");
const hasProcurementExchangeRate = procurementColumns.some((column) => column.name === "exchange_rate");
const hasProcurementShippingFee = procurementColumns.some((column) => column.name === "shipping_fee");
const hasProcurementCustomsFee = procurementColumns.some((column) => column.name === "customs_fee");
const hasProcurementOtherFee = procurementColumns.some((column) => column.name === "other_fee");

if (!hasSupplierColumn) {
  db.exec("ALTER TABLE parts ADD COLUMN supplier TEXT NOT NULL DEFAULT 'Core Parts Supply'");
}

if (!hasCostPriceColumn) {
  db.exec("ALTER TABLE parts ADD COLUMN cost_price INTEGER NOT NULL DEFAULT 0");
}

if (!hasDepositColumn) {
  db.exec("ALTER TABLE orders ADD COLUMN deposit INTEGER NOT NULL DEFAULT 0");
}

if (!hasProcurementSourceCurrency) {
  db.exec("ALTER TABLE procurements ADD COLUMN source_currency TEXT NOT NULL DEFAULT 'VUV'");
}

if (!hasProcurementSourceUnitPrice) {
  db.exec("ALTER TABLE procurements ADD COLUMN source_unit_price REAL NOT NULL DEFAULT 0");
}

if (!hasProcurementExchangeRate) {
  db.exec("ALTER TABLE procurements ADD COLUMN exchange_rate REAL NOT NULL DEFAULT 1");
}

if (!hasProcurementShippingFee) {
  db.exec("ALTER TABLE procurements ADD COLUMN shipping_fee INTEGER NOT NULL DEFAULT 0");
}

if (!hasProcurementCustomsFee) {
  db.exec("ALTER TABLE procurements ADD COLUMN customs_fee INTEGER NOT NULL DEFAULT 0");
}

if (!hasProcurementOtherFee) {
  db.exec("ALTER TABLE procurements ADD COLUMN other_fee INTEGER NOT NULL DEFAULT 0");
}

db.exec(`
  UPDATE parts
  SET cost_price = CASE WHEN cost_price IS NULL OR cost_price = 0 THEN unit_price ELSE cost_price END
`);

db.exec(`
  UPDATE procurements
  SET
    source_currency = COALESCE(NULLIF(trim(source_currency), ''), 'VUV'),
    source_unit_price = CASE WHEN source_unit_price IS NULL OR source_unit_price = 0 THEN unit_price ELSE source_unit_price END,
    exchange_rate = CASE WHEN exchange_rate IS NULL OR exchange_rate <= 0 THEN 1 ELSE exchange_rate END,
    shipping_fee = COALESCE(shipping_fee, 0),
    customs_fee = COALESCE(customs_fee, 0),
    other_fee = COALESCE(other_fee, 0)
`);

db.exec(`
  UPDATE parts
  SET supplier = CASE
    WHEN lower(name) LIKE '%screen%' OR lower(name) LIKE '%display%' OR lower(name) LIKE '%oled%' THEN 'Pacific Screen Supply'
    WHEN lower(name) LIKE '%battery%' THEN 'Battery Hub Vanuatu'
    WHEN lower(name) LIKE '%port%' OR lower(name) LIKE '%flex%' THEN 'Connector Works'
    ELSE 'Core Parts Supply'
  END
  WHERE supplier IS NULL OR trim(supplier) = '' OR supplier = 'Core Parts Supply'
`);

const orderFormBrandsSeed = [
  { name: "Apple", market: "Vanuatu", sortOrder: 1, models: ["iPhone 11", "iPhone 12", "iPhone 13", "iPhone 14", "iPhone 15 Pro Max"] },
  { name: "Samsung", market: "Vanuatu", sortOrder: 2, models: ["Galaxy A14", "Galaxy A24", "Galaxy A34", "Galaxy S23", "Galaxy S24 Ultra"] },
  { name: "Oppo", market: "Vanuatu", sortOrder: 3, models: ["A17", "A58", "Reno8 T", "Reno10"] },
  { name: "Vivo", market: "Vanuatu", sortOrder: 4, models: ["Y16", "Y27", "Y36", "V29"] },
  { name: "Xiaomi", market: "Vanuatu", sortOrder: 5, models: ["Redmi 12", "Redmi Note 13", "Poco X5"] },
  { name: "Tecno", market: "Vanuatu", sortOrder: 6, models: ["Spark 10", "Camon 20", "Pova 5"] },
  { name: "Infinix", market: "Vanuatu", sortOrder: 7, models: ["Smart 8", "Hot 30", "Note 30"] },
];

const orderFormTechniciansSeed = [
  { name: "Aiden", sortOrder: 1 },
  { name: "Noel", sortOrder: 2 },
  { name: "Mara", sortOrder: 3 },
  { name: "Jean", sortOrder: 4 },
];

const orderFormIssueTemplatesSeed = [
  { title: "屏幕破裂 / 触控失灵", sortOrder: 1 },
  { title: "无法充电 / 尾插故障", sortOrder: 2 },
  { title: "电池续航差 / 自动关机", sortOrder: 3 },
  { title: "进水不开机", sortOrder: 4 },
  { title: "听筒 / 麦克风异常", sortOrder: 5 },
  { title: "摄像头模糊 / 无法对焦", sortOrder: 6 },
  { title: "Face ID / 指纹异常", sortOrder: 7 },
];

const orderFormBrandCount = db.prepare("SELECT COUNT(*) AS count FROM order_form_brands").get().count;

if (orderFormBrandCount === 0) {
  const insertBrand = db.prepare(`
    INSERT INTO order_form_brands (name, market, sort_order)
    VALUES (@name, @market, @sortOrder)
  `);
  const insertModel = db.prepare(`
    INSERT INTO order_form_models (brand_id, name, sort_order)
    VALUES (@brandId, @name, @sortOrder)
  `);

  db.transaction(() => {
    orderFormBrandsSeed.forEach((brand) => {
      const result = insertBrand.run(brand);
      const brandId = Number(result.lastInsertRowid);
      brand.models.forEach((model, index) => {
        insertModel.run({ brandId, name: model, sortOrder: index + 1 });
      });
    });
  })();
}

const orderFormTechnicianCount = db.prepare("SELECT COUNT(*) AS count FROM order_form_technicians").get().count;
if (orderFormTechnicianCount === 0) {
  const insertTechnician = db.prepare(`
    INSERT INTO order_form_technicians (name, sort_order)
    VALUES (@name, @sortOrder)
  `);
  db.transaction(() => {
    orderFormTechniciansSeed.forEach((row) => insertTechnician.run(row));
  })();
}

const orderFormIssueCount = db.prepare("SELECT COUNT(*) AS count FROM order_form_issue_templates").get().count;
if (orderFormIssueCount === 0) {
  const insertIssue = db.prepare(`
    INSERT INTO order_form_issue_templates (title, sort_order)
    VALUES (@title, @sortOrder)
  `);
  db.transaction(() => {
    orderFormIssueTemplatesSeed.forEach((row) => insertIssue.run(row));
  })();
}

const storeSettingsCount = db.prepare("SELECT COUNT(*) AS count FROM settings_store").get().count;
if (storeSettingsCount === 0) {
  db.prepare(`
    INSERT INTO settings_store (id, store_name, store_code, phone, email, address, cover_image)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    "Vila Port Cyan 维修中心",
    "VC-001",
    "+678 555 0198",
    "service@vilaportcyan.vu",
    "Port Vila Main Street, Efate, Vanuatu",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuCOu0n-lkDpLphp_c8oRv47VhiBjFWBXPatjFVdtrLevcB80hnJzGYYA2pkuDRf8qb9w2_erWMTiajFoIG7-98ZR6eqbd4JMe2Y2n1GMP9HMxpVcQEmiVO6Zz4MSpk-5moHaMgCTM2CwmujP0WBQiQ9UbJYsxReRRFyhJARAUL_UyYRBfRahx_LZEsKv5wq3JM-Y_jPxXAd_rhDQ6biuZ0-o0pFZ6CPyNYd79Yc1Pocns264Ol2aOe2vwoIKbGW-08Vqqo1sNy1O7DC",
  );
}

const businessHoursCount = db.prepare("SELECT COUNT(*) AS count FROM settings_business_hours").get().count;
if (businessHoursCount === 0) {
  const insertBusinessHour = db.prepare(`
    INSERT INTO settings_business_hours (day_label, hours_value, note, sort_order)
    VALUES (?, ?, ?, ?)
  `);
  db.transaction(() => {
    insertBusinessHour.run("周一至周五", "08:30 - 19:30", "高峰时段", 1);
    insertBusinessHour.run("周六", "09:00 - 18:00", "预约优先", 2);
    insertBusinessHour.run("周日", "10:00 - 16:00", "仅接待", 3);
  })();
}

const businessRulesCount = db.prepare("SELECT COUNT(*) AS count FROM settings_business_rules").get().count;
if (businessRulesCount === 0) {
  db.prepare(`
    INSERT INTO settings_business_rules (id, holiday_enabled, holiday_hours, holiday_note)
    VALUES (1, 1, '10:00 - 15:00', '节假日统一调整为 10:00 - 15:00，并在订单页显示公告。')
  `).run();
}

const staffSettingsCount = db.prepare("SELECT COUNT(*) AS count FROM settings_staff").get().count;
if (staffSettingsCount === 0) {
  const insertStaffSetting = db.prepare(`
    INSERT INTO settings_staff
      (name, role, scope, can_edit_orders, can_adjust_inventory, can_view_finance, is_active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    insertStaffSetting.run("Aiden", "系统管理员", "全部", 1, 1, 1, 1, 1);
    insertStaffSetting.run("Noel", "高级维修技师", "维修", 1, 1, 0, 1, 2);
    insertStaffSetting.run("Mara", "前台客服", "前台", 0, 0, 0, 1, 3);
  })();
}

const languageSettingsCount = db.prepare("SELECT COUNT(*) AS count FROM settings_language").get().count;
if (languageSettingsCount === 0) {
  db.prepare(`
    INSERT INTO settings_language (id, primary_language, external_language, local_language)
    VALUES (1, 'zh-CN', 'en', 'bi')
  `).run();
}

const printSettingsCount = db.prepare("SELECT COUNT(*) AS count FROM settings_print").get().count;
if (printSettingsCount === 0) {
  db.prepare(`
    INSERT INTO settings_print (id, paper_size, qr_enabled, default_receipt_enabled, footer_brand_enabled)
    VALUES (1, '58mm', 1, 1, 1)
  `).run();
}

const orderCount = db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;

if (orderCount === 0) {
  const insertCustomer = db.prepare(
    "INSERT INTO customers (name, phone, email, tier) VALUES (@name, @phone, @email, @tier)",
  );
  const insertPart = db.prepare(
    "INSERT INTO parts (name, sku, stock, reorder_level, unit_price, supplier) VALUES (@name, @sku, @stock, @reorder_level, @unit_price, @supplier)",
  );
  const insertOrder = db.prepare(
    `INSERT INTO orders
      (order_no, title, device_name, status, customer_id, technician, scheduled_date, amount, issue_summary, notes)
      VALUES (@order_no, @title, @device_name, @status, @customer_id, @technician, @scheduled_date, @amount, @issue_summary, @notes)`,
  );
  const insertOrderPart = db.prepare(
    "INSERT INTO order_parts (order_id, part_id, quantity, unit_price) VALUES (@order_id, @part_id, @quantity, @unit_price)",
  );
  const insertInventoryMovement = db.prepare(
    "INSERT INTO inventory_movements (part_id, movement_type, quantity, note) VALUES (@part_id, @movement_type, @quantity, @note)",
  );

  db.transaction(() => {
    insertCustomer.run({ name: "Zhang Wei", phone: "+678 555 1234", email: "wei.zhang@email.vu", tier: "vip" });
    insertCustomer.run({ name: "Lina Tari", phone: "+678 555 1108", email: "lina.tari@email.vu", tier: "standard" });
    insertCustomer.run({ name: "Marie Noah", phone: "+678 555 2060", email: "marie.noah@email.vu", tier: "business" });

    insertPart.run({ name: "iPhone 14 Pro OLED Display Assembly", sku: "IP14P-SCR-01", stock: 6, reorder_level: 3, unit_price: 32500, supplier: "Pacific Screen Supply" });
    insertPart.run({ name: "MacBook Air M2 Battery Pack", sku: "MBA-M2-BAT-02", stock: 2, reorder_level: 4, unit_price: 28000, supplier: "Battery Hub Vanuatu" });
    insertPart.run({ name: "Samsung Tab USB-C Port Flex", sku: "STAB-USBC-07", stock: 12, reorder_level: 5, unit_price: 7200, supplier: "Connector Works" });
    insertPart.run({ name: "Universal Adhesive Seal Kit", sku: "SEAL-KIT-03", stock: 18, reorder_level: 8, unit_price: 1800, supplier: "Core Parts Supply" });

    insertOrder.run({
      order_no: "RO-88294",
      title: "iPhone 14 Pro screen replacement",
      device_name: "iPhone 14 Pro",
      status: "in_progress",
      customer_id: 1,
      technician: "Alex",
      scheduled_date: "2026-03-31",
      amount: 45000,
      issue_summary: "Bottom-left display crack with intermittent touch loss. Face ID passes diagnostics.",
      notes: "Internal cleaning completed. Waterproof seal replaced and display calibration verified.",
    });
    insertOrder.run({
      order_no: "RO-88295",
      title: "MacBook Air M2 battery service",
      device_name: "MacBook Air M2",
      status: "pending",
      customer_id: 2,
      technician: "Sera",
      scheduled_date: "2026-04-01",
      amount: 38000,
      issue_summary: "Battery cycles high, rapid drain reported during video editing.",
      notes: "Need customer approval before final replacement.",
    });
    insertOrder.run({
      order_no: "RO-88296",
      title: "Samsung Galaxy Tab charging repair",
      device_name: "Samsung Galaxy Tab",
      status: "completed",
      customer_id: 3,
      technician: "Mika",
      scheduled_date: "2026-03-29",
      amount: 8200,
      issue_summary: "USB-C charging port loose and inconsistent.",
      notes: "Port flex replaced, charging test passed, final QA completed.",
    });

    insertOrderPart.run({ order_id: 1, part_id: 1, quantity: 1, unit_price: 32500 });
    insertOrderPart.run({ order_id: 1, part_id: 4, quantity: 1, unit_price: 1800 });
    insertOrderPart.run({ order_id: 2, part_id: 2, quantity: 1, unit_price: 28000 });
    insertOrderPart.run({ order_id: 3, part_id: 3, quantity: 1, unit_price: 7200 });

    insertInventoryMovement.run({ part_id: 1, movement_type: "in", quantity: 6, note: "Initial seed load" });
    insertInventoryMovement.run({ part_id: 2, movement_type: "in", quantity: 2, note: "Initial seed load" });
    insertInventoryMovement.run({ part_id: 3, movement_type: "in", quantity: 12, note: "Initial seed load" });
    insertInventoryMovement.run({ part_id: 4, movement_type: "in", quantity: 18, note: "Initial seed load" });
  })();
}

if (db.prepare("SELECT COUNT(*) AS count FROM reviews").get().count === 0) {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO reviews (order_id, rating, review, reply)
      VALUES (?, ?, ?, ?)
    `).run(1, 5, "技术员非常专业，维修速度快，配件说明也很清楚。", "感谢您的反馈，我们会继续保持服务质量。");
    db.prepare(`
      INSERT INTO reviews (order_id, rating, review, reply)
      VALUES (?, ?, ?, ?)
    `).run(2, 4, "接待流程顺畅，沟通及时，整体体验很好。", "");
    db.prepare(`
      INSERT INTO reviews (order_id, rating, review, reply)
      VALUES (?, ?, ?, ?)
    `).run(3, 4, "维修完成后效果不错，但希望下次能更快一些。", "");
  })();
}

if (db.prepare("SELECT COUNT(*) AS count FROM refunds").get().count === 0) {
  db.prepare(`
    INSERT INTO refunds (order_id, amount, reason, method, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(3, 2000, "客户反馈充电线额外收费需部分退回", "original", "approved");
}

if (db.prepare("SELECT COUNT(*) AS count FROM customer_followups").get().count === 0) {
  db.transaction(() => {
    db.prepare(`
      INSERT INTO customer_followups (customer_id, order_id, channel, note)
      VALUES (?, ?, ?, ?)
    `).run(1, 1, "phone", "回访确认屏幕触控正常，客户表示满意。");
    db.prepare(`
      INSERT INTO customer_followups (customer_id, order_id, channel, note)
      VALUES (?, ?, ?, ?)
    `).run(2, 2, "sms", "提醒客户电池保修期与取机时间。");
  })();
}

if (db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count === 0) {
  db.transaction(() => {
    appendAuditLog({ actor: "Technician A", type: "Modification", tone: "primary", message: "Modified Order #RO-88294 details", meta: "IP: 192.168.1.45" });
    appendAuditLog({ actor: "Admin", type: "System Update", tone: "warning", message: "Updated store hours for Main Branch", meta: "IP: 10.0.0.1" });
    appendAuditLog({ actor: "Cashier", type: "Refund", tone: "danger", message: "Processed a refund of 2,000 VUV", meta: "Terminal: POS-02" });
    appendAuditLog({ actor: "Inventory Bot", type: "Stock Move", tone: "success", message: "Inventory movement recorded for Universal Adhesive Seal Kit", meta: "AUTO" });
  })();
}

if (db.prepare("SELECT COUNT(*) AS count FROM procurements").get().count === 0) {
  db.prepare(`
    INSERT INTO procurements (procurement_no, supplier, part_id, quantity, unit_price, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("PO-20260001", "Pacific Screen Supply", 1, 7, 32500, "已交付");
}

const app = express();
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin not allowed by CORS"));
  },
}));

app.use((req, res, next) => {
  if (!blobPersistenceEnabled) {
    next();
    return;
  }

  res.on("finish", () => {
    if (
      req.path.startsWith("/api/")
      && !["GET", "HEAD", "OPTIONS"].includes(req.method)
      && res.statusCode < 400
    ) {
      queueDatabaseSnapshot(`${req.method} ${req.path}`);
    }
  });

  next();
});
app.use(express.json());

const money = new Intl.NumberFormat("en-US");
const statusMeta = {
  pending: { label: "待处理", tone: "warning" },
  in_progress: { label: "维修中", tone: "primary" },
  completed: { label: "已完成", tone: "success" },
  picked_up: { label: "已取件", tone: "neutral" },
};

const baseOrderSelect = `
  SELECT
    o.id,
    o.order_no AS orderNo,
    o.title,
    o.device_name AS deviceName,
    o.status,
    o.technician,
    o.scheduled_date AS scheduledDate,
    o.amount,
    o.deposit,
    o.issue_summary AS issueSummary,
    o.notes,
    c.id AS customerId,
    c.name AS customerName,
    c.phone AS customerPhone,
    c.email AS customerEmail,
    c.tier AS customerTier
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
`;

function formatMoney(value) {
  return `${money.format(value)} VUV`;
}

const cnyMoney = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatCny(value) {
  return `¥${cnyMoney.format(Number(value) || 0)}`;
}

function calculateProcurementCosting({
  quantity = 0,
  sourceUnitPrice = 0,
  exchangeRate = 1,
  shippingFee = 0,
  customsFee = 0,
  otherFee = 0,
}) {
  const safeQuantity = Math.max(1, Number(quantity) || 0);
  const safeSourceUnitPrice = Math.max(0, Number(sourceUnitPrice) || 0);
  const safeExchangeRate = Math.max(0.000001, Number(exchangeRate) || 1);
  const safeShippingFee = Math.max(0, Math.round(Number(shippingFee) || 0));
  const safeCustomsFee = Math.max(0, Math.round(Number(customsFee) || 0));
  const safeOtherFee = Math.max(0, Math.round(Number(otherFee) || 0));
  const purchaseAmountCny = safeQuantity * safeSourceUnitPrice;
  const purchaseAmountVuv = Math.round(purchaseAmountCny * safeExchangeRate);
  const extraFees = safeShippingFee + safeCustomsFee + safeOtherFee;
  const totalLandedCost = purchaseAmountVuv + extraFees;
  const landedUnitCost = Math.round(totalLandedCost / safeQuantity);

  return {
    quantity: safeQuantity,
    sourceUnitPrice: safeSourceUnitPrice,
    exchangeRate: safeExchangeRate,
    shippingFee: safeShippingFee,
    customsFee: safeCustomsFee,
    otherFee: safeOtherFee,
    purchaseAmountCny,
    purchaseAmountVuv,
    extraFees,
    totalLandedCost,
    landedUnitCost,
    purchaseAmountCnyFormatted: formatCny(purchaseAmountCny),
    purchaseAmountVuvFormatted: formatMoney(purchaseAmountVuv),
    shippingFeeFormatted: formatMoney(safeShippingFee),
    customsFeeFormatted: formatMoney(safeCustomsFee),
    otherFeeFormatted: formatMoney(safeOtherFee),
    extraFeesFormatted: formatMoney(extraFees),
    totalLandedCostFormatted: formatMoney(totalLandedCost),
    landedUnitCostFormatted: formatMoney(landedUnitCost),
    sourceUnitPriceFormatted: formatCny(safeSourceUnitPrice),
  };
}

function getTodayDateKey() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function parseJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatChatTimestamp(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function getOrderParts(orderId) {
  return db.prepare(`
    SELECT
      p.id,
      p.name,
      p.sku,
      op.quantity,
      op.unit_price AS unitPrice,
      op.quantity * op.unit_price AS subtotal
    FROM order_parts op
    JOIN parts p ON p.id = op.part_id
    WHERE op.order_id = ?
    ORDER BY p.name ASC
  `).all(orderId);
}

function getDefaultCommunicationMessages(order) {
  return [
    {
      id: `${order.id}-seed-1`,
      sender: "customer",
      type: "text",
      time: `${order.scheduledDate} 09:15`,
      body: `您好，我的 ${order.deviceName} 从今天早上开始出现${order.issueSummary.slice(0, 18)}，今天能处理吗？`,
    },
    {
      id: `${order.id}-seed-2`,
      sender: "staff",
      type: "text",
      time: `${order.scheduledDate} 09:22`,
      body: `可以的，我们已经安排 ${order.technician} 检测，初步判断需要进一步拆机确认。`,
    },
    {
      id: `${order.id}-seed-3`,
      sender: "internal",
      type: "note",
      time: `${order.scheduledDate} 09:40`,
      body: `${order.notes} 请同步核对库存和客户报价。`,
    },
    {
      id: `${order.id}-seed-4`,
      sender: "customer",
      type: "photos",
      time: `${order.scheduledDate} 10:05`,
      body: "这里是客户补充上传的故障照片。",
      photos: [
        "https://lh3.googleusercontent.com/aida-public/AB6AXuAdYOE8bAZ5X4WwF4pQ7wbh4Af7XBOicokH50jBPp3YdI10K6B1TgLvAeMNeMOwgXOkkJi8sotwP-u1ppMTrfdUCoq0qKMpk4j3X8Uvq8AtG0Epb7XVWpjrqu6lZE-DtP91llBEKQcxGnHkalkS8SClj0I07eNAPx3H6MglvLhyCjQuPc7-X7KBx8vnNWOLjWVppALnyXqTvtHvrRXHUHxgW_vSUcp5pQe3fZBxZGUw0nQ3MRzom-ZMc8YnApzQMZn1nuX8RHWTeJW0",
        "https://lh3.googleusercontent.com/aida-public/AB6AXuCQ7S9qafprSgo7OcbS7Ry9cKb77Dx1aICwq0GdLGb_Fhzu6_TiIIWUMVw_9KLsQP0Ch99V74fLUMmXKRecN9gfSXAR_WvDQAInS83ra06dwuFdO65FVCnLLS9PkoIwOmS1z9FRdUwbwDZUqW3RRvbCnz0DfMFOy4cdHAN23OtVkR-xHxDbApgIewuNmibXjbXzf7TErpRmmTkCY7c5TvWN1rvZ8fd7g_jFb-QCDk-Gi8RL1q4HVZpZx7NzGfMpCDYnIujqNlqFP1EN",
      ],
    },
    {
      id: `${order.id}-seed-5`,
      sender: "staff",
      type: "voice",
      time: `${order.scheduledDate} 10:45`,
      body: "语音说明已发送",
      duration: "0:12",
    },
  ];
}

function getOrderMessages(order) {
  const storedMessages = db.prepare(`
    SELECT
      id,
      sender,
      type,
      body,
      meta_json AS metaJson,
      created_at AS createdAt
    FROM order_messages
    WHERE order_id = ?
    ORDER BY id ASC
  `).all(order.id).map((row) => ({
    id: `db-${row.id}`,
    sender: row.sender,
    type: row.type,
    body: row.body,
    time: formatChatTimestamp(row.createdAt),
    ...parseJson(row.metaJson, {}),
  }));

  return [...getDefaultCommunicationMessages(order), ...storedMessages];
}

function getDefaultCompletionChecklist(order) {
  return [
    { id: "display", label: "Display & Touch responsive", checked: true },
    { id: "battery", label: "Charging & Battery stability", checked: true },
    { id: "signal", label: "Signal & Wi-Fi connectivity", checked: true },
    { id: "camera", label: "Camera & Audio functions", checked: true },
    { id: "cleaning", label: "Housing & External cleaning", checked: order.status !== "pending" },
  ];
}

function getOrderCompletionRecord(orderId) {
  return db.prepare(`
    SELECT
      order_id AS orderId,
      warranty,
      checklist_json AS checklistJson,
      final_notes AS finalNotes,
      updated_at AS updatedAt
    FROM order_completion
    WHERE order_id = ?
  `).get(orderId);
}

function getDefaultExecutionChecklist() {
  return [
    { id: "display", label: "显示屏 / Display", checked: true },
    { id: "face_id", label: "Face ID", checked: true },
    { id: "truetone", label: "TrueTone", checked: false },
    { id: "battery", label: "电池健康 / Battery", checked: false },
    { id: "seal", label: "密封完整性 / Seal", checked: false },
  ];
}

function getOrderExecutionRecord(orderId) {
  return db.prepare(`
    SELECT
      order_id AS orderId,
      phase,
      checklist_json AS checklistJson,
      elapsed_minutes AS elapsedMinutes,
      updated_at AS updatedAt
    FROM order_execution
    WHERE order_id = ?
  `).get(orderId);
}

function getExecutionPhaseLabel(phase) {
  return phase === "diagnosis"
    ? "Diagnosis"
    : phase === "repair"
      ? "Repair"
      : phase === "qa"
        ? "QA"
        : phase === "completed"
          ? "Completed"
          : "Repair";
}

function getDefaultUploadPhotos() {
  return [
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDn7g_GFjZ1XweOpPCpvDcL7OLpLH6WsZ-8mhDBzUOmGEolCjYDGvd3ub5Tpr5lpDbRCv0HVJIDXqIrX-dUWvSaPtZpbZ0bj2Us7xTt0aTvV7kUFH_qfqZLGop7NW9w7fS_KRvpWNJKxvIVBBRSANXR-TCxXYMTGUjXkWZsG4v3PfUuPPIBDF97psNQW_i6CZ1X4_TG4S0I1NruKd4uva6vsWPFhItnfwhROyu9GBpzhSUF_ohcioTmq1BWWLZxqEo2wHwbIISkaEpJ",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDIkq-dqnseQ9ugvWshqUxAYW5jzRjMlOdvdc5Skxvto6Zxcj9DB_ZP_88FiDWWHEnSiooJYZ5lI1ml4_lpR8aoSacGDq8AxVxPYcTV636UkO_rVr6lCb6LLJPUCx64khUVmAP01mlGviDGNrRU9WEUbJTlPKmyNZwgJT0WIdHs8S5gyYngxV_tgd_Ii5cquLtUeTjVoZHlqfJ_hbfIvsdcuOl2NOhfxwE2jwDiY0ytaiEq2yEPLk9gJz2wD76vRxbI2y_fwk5x2kAa",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuCrtiB6C-cjwQTXJ015mN9mylPtTUHdB_PH1SR44Ezrj9ylMW5AfWKSmfZ8-tZotHzNYZNfrAOXruEez6GFo_h5oVFA9Rl82zpq51nvAVXogvvbNGskC7NABZ6rm5zu9AmYyGrD3PpekNzLFbEGviUyK1eeyLvrFja5JzJ1OrwRkFHZp_nvGQZZSVkMDiwYvXaqqQS80BX3qn0CxQLfjWltJ2IJANpGBURyvfUePMKvN8musvjo8beikLXxJpj5G6LkikQJXsnlX_0D",
  ];
}

function getStoredPhotos(orderId) {
  return db.prepare(`
    SELECT
      id,
      stage,
      image_url AS image,
      note,
      created_at AS createdAt
    FROM order_photos
    WHERE order_id = ?
    ORDER BY id DESC
  `).all(orderId);
}

function getStoredPhotosByStages(orderId, stages = []) {
  const rows = getStoredPhotos(orderId);
  if (!stages.length) return rows;
  return rows.filter((row) => stages.includes(row.stage));
}

function getCustomerAvatar(customerId) {
  const row = db.prepare(`
    SELECT
      op.image_url AS imageUrl
    FROM order_photos op
    JOIN orders o ON o.id = op.order_id
    WHERE o.customer_id = ?
      AND op.stage = '客户照片'
    ORDER BY op.id DESC
    LIMIT 1
  `).get(customerId);

  return row?.imageUrl ?? null;
}

function getReceiptMeta(orderId) {
  return db.prepare(`
    SELECT
      order_id AS orderId,
      printed_at AS printedAt,
      picked_up_at AS pickedUpAt
    FROM receipt_meta
    WHERE order_id = ?
  `).get(orderId);
}

function getRefundRows() {
  return db.prepare(`
    SELECT
      r.id,
      r.order_id AS orderId,
      r.amount,
      r.reason,
      r.method,
      r.status,
      r.created_at AS createdAt,
      o.order_no AS orderNo,
      o.title,
      o.scheduled_date AS scheduledDate,
      c.name AS customerName
    FROM refunds r
    JOIN orders o ON o.id = r.order_id
    JOIN customers c ON c.id = o.customer_id
    ORDER BY r.id DESC
  `).all().map((row) => ({
    ...row,
    amountFormatted: formatMoney(row.amount),
    createdLabel: formatChatTimestamp(row.createdAt),
  }));
}

function getReviewRows() {
  return db.prepare(`
    SELECT
      rv.id,
      rv.order_id AS orderId,
      rv.rating,
      rv.review,
      rv.reply,
      rv.created_at AS createdAt,
      o.order_no AS orderNo,
      o.scheduled_date AS scheduledDate,
      c.name AS customerName
    FROM reviews rv
    JOIN orders o ON o.id = rv.order_id
    JOIN customers c ON c.id = o.customer_id
    ORDER BY rv.id DESC
  `).all().map((row) => ({
    ...row,
    createdLabel: formatChatTimestamp(row.createdAt),
    status: row.reply ? "已回复" : "待回复",
  }));
}

function getFollowupRows(customerId) {
  return db.prepare(`
    SELECT
      f.id,
      f.customer_id AS customerId,
      f.order_id AS orderId,
      f.channel,
      f.note,
      f.created_at AS createdAt,
      o.order_no AS orderNo
    FROM customer_followups f
    LEFT JOIN orders o ON o.id = f.order_id
    WHERE f.customer_id = ?
    ORDER BY f.id DESC
  `).all(customerId).map((row) => ({
    ...row,
    createdLabel: formatChatTimestamp(row.createdAt),
  }));
}

function appendAuditLog({ actor, type, tone = "primary", message, meta = "" }) {
  db.prepare(`
    INSERT INTO audit_logs (actor, type, tone, message, meta)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor, type, tone, message, meta);
}

function getAuditLogs() {
  return db.prepare(`
    SELECT
      id,
      actor,
      type,
      tone,
      message,
      meta,
      created_at AS createdAt
    FROM audit_logs
    ORDER BY id DESC
    LIMIT 50
  `).all().map((row) => ({
    ...row,
    meta: row.meta ? `${formatChatTimestamp(row.createdAt)} · ${row.meta}` : formatChatTimestamp(row.createdAt),
  }));
}

function buildNotifications() {
  const readIds = new Set(
    db.prepare("SELECT notification_id AS notificationId FROM notification_reads").all().map((row) => row.notificationId),
  );
  const todayKey = getTodayDateKey();
  const lowStockParts = db.prepare(`
    SELECT id, name, sku, stock, reorder_level AS reorderLevel
    FROM parts
    WHERE stock <= reorder_level
    ORDER BY stock ASC, name ASC
    LIMIT 3
  `).all();
  const recentOrders = db.prepare(`
    SELECT
      o.id,
      o.order_no AS orderNo,
      o.status,
      o.created_at AS createdAt,
      o.scheduled_date AS scheduledDate,
      c.name AS customerName
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    ORDER BY o.id DESC
    LIMIT 4
  `).all();
  const recentAuditLogs = db.prepare(`
    SELECT id, type, tone, message, created_at AS createdAt
    FROM audit_logs
    ORDER BY id DESC
    LIMIT 4
  `).all();

  const notifications = [];

  lowStockParts.forEach((part) => {
    notifications.push({
      id: `inventory-${part.id}`,
      category: "inventory",
      title: "库存预警",
      body: `${part.name} 当前库存 ${part.stock}，低于补货阈值 ${part.reorderLevel}。`,
      tone: part.stock <= 2 ? "warning" : "secondary",
      tag: "紧急补货",
      time: todayKey,
      link: "/low-stock-alerts",
    });
  });

  recentOrders.forEach((order) => {
    notifications.push({
      id: `order-${order.id}`,
      category: "order",
      title: order.status === "completed" || order.status === "picked_up" ? "订单进度更新" : "订单提醒",
      body: `订单 #${order.orderNo} (${order.customerName}) 当前状态：${statusMeta[order.status]?.label ?? order.status}。`,
      tone: order.status === "completed" || order.status === "picked_up" ? "success" : "primary",
      tag: order.status === "completed" || order.status === "picked_up" ? "已完工" : "新订单",
      time: formatChatTimestamp(order.createdAt),
      link: `/orders/${order.id}`,
    });
  });

  recentAuditLogs.forEach((log) => {
    notifications.push({
      id: `audit-${log.id}`,
      category: "system",
      title: log.type,
      body: log.message,
      tone: log.tone === "danger" ? "warning" : log.tone,
      tag: "系统日志",
      time: formatChatTimestamp(log.createdAt),
      link: "/audit-logs",
    });
  });

  return notifications
    .map((item) => ({
      ...item,
      isRead: readIds.has(item.id),
    }))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

function getNextProcurementNo() {
  const rows = db.prepare("SELECT procurement_no AS procurementNo FROM procurements").all();
  const maxNumeric = rows.reduce((currentMax, row) => {
    const match = /(\d+)$/.exec(row.procurementNo ?? "");
    return Math.max(currentMax, match ? Number(match[1]) : 0);
  }, 20260000);

  return `PO-${maxNumeric + 1}`;
}

function getNextInboundBatchNo() {
  const rows = db.prepare("SELECT batch_no AS batchNo FROM inbound_batches").all();
  const maxNumeric = rows.reduce((currentMax, row) => {
    const match = /(\d+)$/.exec(row.batchNo ?? "");
    return Math.max(currentMax, match ? Number(match[1]) : 0);
  }, 20260000);

  return `IB-${maxNumeric + 1}`;
}

function allocateBatchExtraFees(items, totalExtraFees) {
  if (!items.length) return [];
  const normalizedTotalExtraFees = Math.max(0, Math.round(Number(totalExtraFees) || 0));
  const totalPurchaseValue = items.reduce((sum, item) => sum + item.purchaseValueVuv, 0);
  if (normalizedTotalExtraFees <= 0 || totalPurchaseValue <= 0) {
    return items.map(() => 0);
  }

  let allocated = 0;
  return items.map((item, index) => {
    if (index === items.length - 1) {
      return normalizedTotalExtraFees - allocated;
    }
    const share = Math.round(normalizedTotalExtraFees * (item.purchaseValueVuv / totalPurchaseValue));
    allocated += share;
    return share;
  });
}

function getNextAuditSessionNo() {
  const rows = db.prepare("SELECT session_no AS sessionNo FROM inventory_audits").all();
  const maxNumeric = rows.reduce((currentMax, row) => {
    const match = /(\d+)$/.exec(row.sessionNo ?? "");
    return Math.max(currentMax, match ? Number(match[1]) : 0);
  }, 20260000);

  return `AD-${maxNumeric + 1}`;
}

function getNextIntakeCode() {
  const rows = db.prepare("SELECT intake_code AS intakeCode FROM order_intake").all();
  const maxNumeric = rows.reduce((currentMax, row) => {
    const match = /(\d+)$/.exec(row.intakeCode ?? "");
    return Math.max(currentMax, match ? Number(match[1]) : 0);
  }, 20260000);

  return `IN-${maxNumeric + 1}`;
}

function getOrderIntake(orderId) {
  return db.prepare(`
    SELECT
      order_id AS orderId,
      intake_code AS intakeCode,
      imei_serial AS imeiSerial,
      customer_signature AS customerSignature,
      created_at AS createdAt
    FROM order_intake
    WHERE order_id = ?
  `).get(orderId);
}

function diffMinutesFromNow(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function formatElapsedMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m elapsed`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m elapsed`;
}

function queueProgressByStatus(status) {
  if (status === "pending") return 22;
  if (status === "in_progress") return 64;
  if (status === "completed") return 100;
  if (status === "picked_up") return 100;
  return 0;
}

function queuePriorityForOrder(order, elapsedMinutes) {
  if (order.status === "completed" || order.status === "picked_up") return "done";
  if (order.status === "pending" && elapsedMinutes >= 60) return "urgent";
  if (order.status === "in_progress" && elapsedMinutes >= 45) return "high";
  return "normal";
}

function getRepairQueue(status = "all", search = "") {
  const clauses = [];
  const params = {};

  if (status !== "all") {
    clauses.push("o.status = @status");
    params.status = status;
  }

  if (search) {
    clauses.push("(o.order_no LIKE @search OR o.device_name LIKE @search OR c.name LIKE @search OR c.phone LIKE @search)");
    params.search = `%${search}%`;
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`${baseOrderSelect} ${whereClause} ORDER BY o.scheduled_date DESC, o.id DESC`).all(params);

  const queueRows = rows.map((row) => {
    const elapsedMinutes = diffMinutesFromNow(`${row.scheduledDate}T09:00:00`);
    const priority = queuePriorityForOrder(row, elapsedMinutes);
    const progress = queueProgressByStatus(row.status);
    const isDone = row.status === "completed" || row.status === "picked_up";

    return {
      ...mapOrder(row),
      elapsedMinutes,
      elapsedLabel: isDone ? "已完成" : formatElapsedMinutes(elapsedMinutes),
      progress,
      priority,
      priorityLabel: priority === "urgent" ? "加急" : priority === "high" ? "高优先级" : priority === "done" ? "已完成" : "普通",
      footerText: row.status === "pending"
        ? `已分配: ${row.technician}`
        : isDone
          ? `完结技师: ${row.technician}`
          : `在店时长: ${formatElapsedMinutes(elapsedMinutes)}`,
    };
  });

  return {
    metrics: {
      active: queueRows.filter((item) => item.status === "in_progress").length,
      pending: queueRows.filter((item) => item.status === "pending").length,
      urgent: queueRows.filter((item) => item.priority === "urgent").length,
      revenueEstimate: formatMoney(queueRows.reduce((sum, item) => sum + item.amount, 0)),
    },
    rows: queueRows,
  };
}

function getOrderTimeline(order, phase = "repair") {
  const isCompleted = order.status === "completed" || order.status === "picked_up";
  const isPickedUp = order.status === "picked_up";

  const phaseToState = {
    diagnosis: ["done", "current", "future", "future"],
    repair: ["done", "done", isCompleted ? "done" : "current", isPickedUp ? "done" : "future"],
    qa: ["done", "done", "done", isPickedUp ? "done" : "current"],
    completed: ["done", "done", "done", isPickedUp ? "done" : "current"],
  };

  const states = phaseToState[phase] ?? phaseToState.repair;

  return [
    {
      title: "受理订单",
      time: `${order.scheduledDate} 09:15`,
      description: "客服已接单并录入系统",
      state: states[0],
    },
    {
      title: "技师检测",
      time: `${order.scheduledDate} 11:30`,
      description: `技师 ${order.technician} 已完成初步评估`,
      state: states[1],
    },
    {
      title: order.status === "pending" ? "待维修" : "维修处理",
      time: isCompleted ? `${order.scheduledDate} 14:20` : "正在处理中",
      description: isCompleted ? "维修已完成并进入质检阶段" : "当前维修任务正在处理中",
      state: states[2],
    },
    {
      title: "质检与交付",
      time: isPickedUp ? `${order.scheduledDate} 16:30` : "预计 16:30 完成",
      description: isPickedUp ? "客户已取件，工单闭环" : "待最终验机和客户交付",
      state: states[3],
    },
  ];
}

function escapePdfText(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimplePdf(lines) {
  const contentLines = [
    "BT",
    "/F1 18 Tf",
    "50 800 Td",
  ];

  lines.forEach((line, index) => {
    const safeLine = escapePdfText(line);
    if (index === 0) {
      contentLines.push(`(${safeLine}) Tj`);
    } else {
      contentLines.push("0 -22 Td");
      contentLines.push(`(${safeLine}) Tj`);
    }
  });
  contentLines.push("ET");

  const stream = contentLines.join("\n");
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${object}\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "utf8");
}

function looksBrokenText(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  const semanticChars = raw.replace(/[\s?？/\\|_.\-()[\]{}:;,，。!！]+/g, "");
  return /^\?+$/.test(raw.replace(/\s+/g, ""))
    || /�/.test(raw)
    || /\?{2,}/.test(raw)
    || !/[A-Za-z0-9\u4e00-\u9fff]/.test(semanticChars);
}

function sanitizeIssueSummary(order) {
  const rawIssueSummary = String(order?.issueSummary ?? "").trim();
  if (!looksBrokenText(rawIssueSummary)) return rawIssueSummary;

  const notes = String(order?.notes ?? "").trim();
  if (notes && !looksBrokenText(notes)) return notes;

  return "待检测故障";
}

function sanitizeOrderTitle(order) {
  const rawTitle = String(order?.title ?? "").trim();
  const issueSummary = sanitizeIssueSummary(order);
  const deviceName = String(order?.deviceName ?? order?.device_name ?? "").trim();
  const titleLooksBroken = looksBrokenText(rawTitle);

  if (!titleLooksBroken) return rawTitle;

  return [deviceName, issueSummary].filter(Boolean).join(" · ") || deviceName || issueSummary || "维修订单";
}

function mapOrder(order) {
  const deposit = Number(order.deposit ?? 0);
  const balanceDue = Math.max(0, Number(order.amount ?? 0) - deposit);
  return {
    ...order,
    title: sanitizeOrderTitle(order),
    issueSummary: sanitizeIssueSummary(order),
    statusMeta: statusMeta[order.status] ?? { label: order.status, tone: "neutral" },
    amountFormatted: formatMoney(order.amount),
    depositFormatted: formatMoney(deposit),
    balanceDue,
    balanceDueFormatted: formatMoney(balanceDue),
  };
}

function getOrderFormOptions() {
  return getOrderFormOptionsInternal(false);
}

function getOrderFormOptionsInternal(includeInactive = false) {
  const activeClause = includeInactive ? "" : "WHERE is_active = 1";
  const brands = db.prepare(`
    SELECT
      id,
      name,
      market,
      is_active AS isActive,
      sort_order AS sortOrder
    FROM order_form_brands
    ${activeClause}
    ORDER BY sort_order ASC, id ASC
  `).all();

  const models = db.prepare(`
    SELECT
      id,
      brand_id AS brandId,
      name,
      is_active AS isActive,
      sort_order AS sortOrder
    FROM order_form_models
    ${activeClause}
    ORDER BY brand_id ASC, sort_order ASC, id ASC
  `).all();

  const technicians = db.prepare(`
    SELECT
      id,
      name,
      is_active AS isActive,
      sort_order AS sortOrder
    FROM order_form_technicians
    ${activeClause}
    ORDER BY sort_order ASC, id ASC
  `).all();

  const issueTemplates = db.prepare(`
    SELECT
      id,
      title,
      is_active AS isActive,
      sort_order AS sortOrder
    FROM order_form_issue_templates
    ${activeClause}
    ORDER BY sort_order ASC, id ASC
  `).all();

  return { brands, models, technicians, issueTemplates };
}

function getLanguageSettings() {
  return db.prepare(`
    SELECT
      primary_language AS primaryLanguage,
      external_language AS externalLanguage,
      local_language AS localLanguage,
      updated_at AS updatedAt
    FROM settings_language
    WHERE id = 1
  `).get();
}

function getPrintSettings() {
  const row = db.prepare(`
    SELECT
      paper_size AS paperSize,
      qr_enabled AS qrEnabled,
      default_receipt_enabled AS defaultReceiptEnabled,
      footer_brand_enabled AS footerBrandEnabled,
      updated_at AS updatedAt
    FROM settings_print
    WHERE id = 1
  `).get();

  return {
    ...row,
    qrEnabled: Boolean(row?.qrEnabled),
    defaultReceiptEnabled: Boolean(row?.defaultReceiptEnabled),
    footerBrandEnabled: Boolean(row?.footerBrandEnabled),
  };
}

function getStoreSettings() {
  return db.prepare(`
    SELECT
      store_name AS storeName,
      store_code AS storeCode,
      phone,
      email,
      address,
      cover_image AS coverImage,
      updated_at AS updatedAt
    FROM settings_store
    WHERE id = 1
  `).get();
}

function getBusinessHoursSettings() {
  const rows = db.prepare(`
    SELECT
      id,
      day_label AS dayLabel,
      hours_value AS hoursValue,
      note,
      sort_order AS sortOrder
    FROM settings_business_hours
    ORDER BY sort_order ASC, id ASC
  `).all();
  const holidayRule = db.prepare(`
    SELECT
      holiday_enabled AS holidayEnabled,
      holiday_hours AS holidayHours,
      holiday_note AS holidayNote
    FROM settings_business_rules
    WHERE id = 1
  `).get();

  return {
    rows,
    holidayRule: {
      holidayEnabled: Boolean(holidayRule?.holidayEnabled),
      holidayHours: holidayRule?.holidayHours ?? "10:00 - 15:00",
      holidayNote: holidayRule?.holidayNote ?? "",
    },
  };
}

function getStaffPermissionSettings() {
  return db.prepare(`
    SELECT
      id,
      name,
      role,
      scope,
      can_edit_orders AS canEditOrders,
      can_adjust_inventory AS canAdjustInventory,
      can_view_finance AS canViewFinance,
      is_active AS isActive,
      sort_order AS sortOrder
    FROM settings_staff
    ORDER BY sort_order ASC, id ASC
  `).all().map((row) => ({
    ...row,
    canEditOrders: Boolean(row.canEditOrders),
    canAdjustInventory: Boolean(row.canAdjustInventory),
    canViewFinance: Boolean(row.canViewFinance),
    isActive: Boolean(row.isActive),
  }));
}

function mapPart(row) {
  const costPrice = Number(row.costPrice ?? 0);
    return {
      ...row,
      unitPriceFormatted: formatMoney(row.unitPrice),
      costPrice,
      costPriceFormatted: formatMoney(costPrice),
      needsReorder: row.stock <= row.reorderLevel,
    };
  }

function getOrderById(id) {
  const raw = String(id ?? "").trim();
  if (!raw) return null;

  const byOrderNo = db.prepare(`${baseOrderSelect} WHERE o.order_no = ?`).get(raw);
  if (byOrderNo) return byOrderNo;

  if (/^\d+$/.test(raw)) {
    return db.prepare(`${baseOrderSelect} WHERE o.id = ?`).get(Number(raw));
  }

  return null;
}

function getPartById(id) {
  return db.prepare(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS reorderLevel,
        unit_price AS unitPrice,
        cost_price AS costPrice,
        supplier
      FROM parts
      WHERE id = ?
    `).get(id);
}

function getRecentMovements() {
  return db.prepare(`
    SELECT
      m.id,
      m.part_id AS partId,
      p.name AS partName,
      p.sku,
      m.movement_type AS movementType,
      m.quantity,
      m.note,
      m.created_at AS createdAt
    FROM inventory_movements m
    JOIN parts p ON p.id = m.part_id
    ORDER BY m.id DESC
    LIMIT 8
  `).all();
}

function getStaffPerformanceRows() {
  return db.prepare(`
    SELECT
      technician AS staffName,
      COUNT(*) AS completedOrders,
      COALESCE(SUM(amount), 0) AS totalRevenue,
      ROUND(AVG(CASE WHEN status = 'completed' THEN 38 ELSE 45 END), 0) AS avgRepairMinutes,
      ROUND(AVG(CASE WHEN status = 'completed' THEN 4.9 ELSE 4.6 END), 1) AS rating
    FROM orders
    GROUP BY technician
    ORDER BY totalRevenue DESC, completedOrders DESC
  `).all().map((row, index) => ({
    staffId: `TECH-${index + 1}`,
    staffName: row.staffName,
    completedOrders: row.completedOrders,
    totalRevenue: row.totalRevenue,
    totalRevenueFormatted: formatMoney(row.totalRevenue),
    avgRepairMinutes: row.avgRepairMinutes,
    rating: row.rating,
    rank: index + 1,
  }));
}

function getFinanceReport() {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalOrders,
      COALESCE(SUM(amount), 0) AS totalRevenue,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE amount * 0.85 END), 0) AS settledRevenue
    FROM orders
  `).get();

  const rows = db.prepare(`
    SELECT
      id,
      order_no AS orderNo,
      title,
      device_name AS deviceName,
      status,
      scheduled_date AS scheduledDate,
      amount
    FROM orders
    ORDER BY scheduled_date DESC, id DESC
  `).all();

  const todayKey = getTodayDateKey();
  const todayRevenue = rows
    .filter((row) => row.scheduledDate === todayKey)
    .reduce((sum, row) => sum + row.amount, 0);
  const completedOrders = rows.filter((row) => row.status === "completed" || row.status === "picked_up").length;
  const averageTicket = totals.totalOrders ? Math.round(totals.totalRevenue / totals.totalOrders) : 0;

  const byChannel = [
    { channel: '现金', amount: Math.round(totals.totalRevenue * 0.36) },
    { channel: '银行转账', amount: Math.round(totals.totalRevenue * 0.55) },
    { channel: '支票', amount: Math.round(totals.totalRevenue * 0.09) },
  ];

  const channelNames = byChannel.map((item) => item.channel);
  const categoryMap = new Map([
    ["Smartphone", 0],
    ["Laptop", 0],
    ["Tablet", 0],
    ["Other", 0],
  ]);
  const serviceMap = new Map();

  rows.forEach((row) => {
    const device = String(row.deviceName ?? "").toLowerCase();
    const title = String(row.title ?? "").toLowerCase();
    let category = "Other";
    if (device.includes("iphone") || device.includes("phone") || device.includes("galaxy") || device.includes("pixel")) {
      category = "Smartphone";
    } else if (device.includes("macbook") || device.includes("laptop") || device.includes("book")) {
      category = "Laptop";
    } else if (device.includes("ipad") || device.includes("tablet")) {
      category = "Tablet";
    }
    categoryMap.set(category, (categoryMap.get(category) ?? 0) + row.amount);

    const serviceName = title.split("·")[1]?.trim() || title.split("-")[1]?.trim() || title.trim() || "通用维修";
    serviceMap.set(serviceName, (serviceMap.get(serviceName) ?? 0) + row.amount);
  });

  const categorySplit = Array.from(categoryMap.entries())
    .map(([name, amount]) => ({
      name,
      amount,
      amountFormatted: formatMoney(amount),
      percent: totals.totalRevenue ? Math.round((amount / totals.totalRevenue) * 100) : 0,
    }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  const topServices = Array.from(serviceMap.entries())
    .map(([name, amount]) => ({
      name,
      amount,
      amountFormatted: formatMoney(amount),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);

  return {
    summary: {
      totalRevenue: totals.totalRevenue,
      totalRevenueFormatted: formatMoney(totals.totalRevenue),
      todayRevenue: todayRevenue,
      todayRevenueFormatted: formatMoney(todayRevenue),
      pendingBalanceFormatted: formatMoney(Math.max(0, totals.totalRevenue - totals.settledRevenue)),
      averageTicket,
      averageTicketFormatted: formatMoney(averageTicket),
      transactionCount: totals.totalOrders,
      completedOrders,
      growthRate: '+12.5%',
    },
    channels: byChannel.map((item) => ({
      ...item,
      amountFormatted: formatMoney(item.amount),
      percent: totals.totalRevenue ? Math.round((item.amount / totals.totalRevenue) * 100) : 0,
    })),
    rows: rows.map((row, index) => ({
      id: `${row.orderNo}-${index}`,
      title: row.title,
      subtitle: `${row.scheduledDate} · ${statusMeta[row.status]?.label ?? row.status}`,
      channel: channelNames[index % channelNames.length],
      amount: row.status === 'completed' ? row.amount : -Math.round(row.amount * 0.25),
      amountFormatted: `${row.status === 'completed' ? '+' : '-'} ${formatMoney(Math.round(row.status === 'completed' ? row.amount : row.amount * 0.25))}`,
      statusLabel: row.status === 'completed' ? '已入账' : '处理中',
      statusTone: row.status === 'completed' ? 'success' : 'warning',
    })),
    categorySplit,
    topServices,
  };
}

function getSuppliers() {
  const rows = db.prepare(`
    SELECT
      supplier,
      COUNT(*) AS partCount,
      COALESCE(SUM(stock * unit_price), 0) AS procurementValue,
      SUM(CASE WHEN stock <= reorder_level THEN 1 ELSE 0 END) AS lowStockItems
    FROM parts
    GROUP BY supplier
    ORDER BY procurementValue DESC, supplier ASC
  `).all();

  return rows.map((row, index) => ({
    id: `SUP-${index + 1}`,
    name: row.supplier,
    manager: index === 0 ? 'Jean Kalmet' : index === 1 ? 'Marie Noah' : 'Supplier Lead',
    phone: index === 0 ? '+678 555 3001' : index === 1 ? '+678 555 3018' : '+678 555 3099',
    tag: index === 0 ? '核心伙伴' : row.lowStockItems > 0 ? '待评估' : '常规',
    categories: index === 0 ? ['Screens', 'Assemblies'] : index === 1 ? ['Batteries', 'Flex Cables'] : ['Parts'],
    partCount: row.partCount,
    procurementValue: row.procurementValue,
    procurementValueFormatted: formatMoney(row.procurementValue),
    lowStockItems: row.lowStockItems,
  }));
}

function getSupplierHistory() {
  const stored = db.prepare(`
    SELECT
      pr.procurement_no AS procurementNo,
      pr.supplier,
      pr.status,
      pr.created_at AS createdAt,
      pr.quantity,
      pr.unit_price AS unitPrice,
      p.name AS partName
    FROM procurements pr
    JOIN parts p ON p.id = pr.part_id
    ORDER BY pr.id DESC
  `).all();

  if (stored.length) {
    return stored.map((row) => ({
      id: row.procurementNo,
      supplierName: row.supplier,
      date: formatChatTimestamp(row.createdAt).slice(0, 10),
      amountFormatted: formatMoney(row.quantity * row.unitPrice),
      status: row.status,
      partName: row.partName,
      supplierId: `SUP-${Math.max(1, getSuppliers().findIndex((item) => item.name === row.supplier) + 1)}`,
    }));
  }

  return db.prepare(`
    SELECT
      p.supplier,
      p.name AS partName,
      p.unit_price AS amount,
      p.stock,
      p.id
    FROM parts p
    ORDER BY p.unit_price DESC, p.id ASC
    LIMIT 6
  `).all().map((row, index) => ({
    id: `PO-${20260000 + index + 1}`,
    supplierName: row.supplier,
    date: `2026-03-${String(31 - index).padStart(2, '0')}`,
    amountFormatted: formatMoney(row.amount * Math.max(1, row.stock)),
    status: index % 2 === 0 ? '已交付' : '运输中',
    partName: row.partName,
    supplierId: `SUP-${getSuppliers().findIndex((item) => item.name === row.supplier) + 1}`,
  }));
}

function getSupplierById(id) {
  const supplier = getSuppliers().find((item) => item.id === id);

  if (!supplier) {
    return null;
  }

  const products = db.prepare(`
    SELECT
      id,
      name,
      sku,
      stock,
      reorder_level AS reorderLevel,
      unit_price AS unitPrice
    FROM parts
    WHERE supplier = ?
    ORDER BY unit_price DESC, name ASC
  `).all(supplier.name).map((row) => ({
    ...mapPart(row),
    stockStatus: row.stock <= row.reorderLevel ? '低库存' : '库存充足',
  }));

  const recentOrders = getSupplierHistory().filter((item) => item.supplierName === supplier.name);

  return {
    ...supplier,
    companyEnglishName: supplier.name.toUpperCase(),
    yearsOfCooperation: 5,
    rating: 5,
    city: 'Port Vila Industrial Zone',
    address: 'Lot 42, Teouma St, Port Vila',
    email: `${supplier.name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')}@supplier.vu`,
    notes: `${supplier.name} 是当前最稳定的 ${supplier.categories.join(' / ')} 供应商，交付速度和配件一致性都维持在高水平。`,
    products,
    recentOrders,
  };
}

function getProcurementById(id) {
  const historyItem = getSupplierHistory().find((item) => item.id === id);

  if (!historyItem) {
    return null;
  }

  const procurementRow = db.prepare(`
    SELECT
      procurement_no AS procurementNo,
      supplier,
      part_id AS partId,
      quantity,
      unit_price AS unitPrice,
      source_currency AS sourceCurrency,
      source_unit_price AS sourceUnitPrice,
      exchange_rate AS exchangeRate,
      shipping_fee AS shippingFee,
      customs_fee AS customsFee,
      other_fee AS otherFee,
      status,
      created_at AS createdAt
    FROM procurements
    WHERE procurement_no = ?
  `).get(id);

  const supplier = getSuppliers().find((item) => item.name === historyItem.supplierName);
  const items = procurementRow
    ? db.prepare(`
      SELECT
        id,
        name,
        sku,
        stock,
        unit_price AS unitPrice
      FROM parts
      WHERE id = ?
    `).all(procurementRow.partId)
    : db.prepare(`
      SELECT
        id,
        name,
        sku,
        stock,
        unit_price AS unitPrice
      FROM parts
      WHERE supplier = ?
      ORDER BY unit_price DESC, id ASC
      LIMIT 3
    `).all(historyItem.supplierName);

  const rows = items.map((item, index) => {
    const quantity = procurementRow ? procurementRow.quantity : Math.max(1, Math.min(12, item.stock + index + 1));
    const unitPrice = procurementRow ? procurementRow.unitPrice : item.unitPrice;
    const totalAmount = quantity * unitPrice;

    return {
      id: `${id}-${item.id}`,
      partId: item.id,
      name: item.name,
      sku: item.sku,
      quantity,
      unitPrice,
      unitPriceFormatted: formatMoney(unitPrice),
      totalAmount,
      totalAmountFormatted: formatMoney(totalAmount),
    };
  });

  const totalAmount = rows.reduce((sum, item) => sum + item.totalAmount, 0);
  const status = procurementRow?.status ?? historyItem.status;
  const isDelivered = status === "已交付";
  const orderDate = procurementRow?.createdAt ? formatChatTimestamp(procurementRow.createdAt).slice(0, 10) : historyItem.date;
  const costing = calculateProcurementCosting({
    quantity: procurementRow?.quantity ?? rows[0]?.quantity ?? 1,
    sourceUnitPrice: procurementRow?.sourceUnitPrice ?? procurementRow?.unitPrice ?? rows[0]?.unitPrice ?? 0,
    exchangeRate: procurementRow?.exchangeRate ?? 1,
    shippingFee: procurementRow?.shippingFee ?? 0,
    customsFee: procurementRow?.customsFee ?? 0,
    otherFee: procurementRow?.otherFee ?? 0,
  });

  return {
    id: historyItem.id,
    status,
    statusLabel: isDelivered ? 'Received / 已入库' : 'In Transit / 运输中',
    amountFormatted: formatMoney(totalAmount),
    supplier: supplier ?? null,
    orderDate,
    operator: 'James Doe',
    currency: 'VUV',
    paymentMethod: 'Bank Wire Transfer',
    costing: {
      sourceCurrency: procurementRow?.sourceCurrency ?? "VUV",
      sourceUnitPrice: costing.sourceUnitPrice,
      sourceUnitPriceFormatted: procurementRow?.sourceCurrency === "CNY" ? costing.sourceUnitPriceFormatted : formatMoney(costing.sourceUnitPrice),
      exchangeRate: costing.exchangeRate,
      shippingFee: costing.shippingFee,
      customsFee: costing.customsFee,
      otherFee: costing.otherFee,
      shippingFeeFormatted: costing.shippingFeeFormatted,
      customsFeeFormatted: costing.customsFeeFormatted,
      otherFeeFormatted: costing.otherFeeFormatted,
      purchaseAmountCnyFormatted: costing.purchaseAmountCnyFormatted,
      purchaseAmountVuvFormatted: costing.purchaseAmountVuvFormatted,
      extraFeesFormatted: costing.extraFeesFormatted,
      totalLandedCost: costing.totalLandedCost,
      totalLandedCostFormatted: costing.totalLandedCostFormatted,
      landedUnitCost: costing.landedUnitCost,
      landedUnitCostFormatted: costing.landedUnitCostFormatted,
    },
    items: rows,
    delivery: {
      courier: 'Pacific Logistics',
      trackingNumber: `PL-${historyItem.id.replace('PO-', '')}`,
      deliveryTime: `${orderDate} 14:30`,
      location: isDelivered ? 'Port Vila Warehouse' : 'Port Vila Inbound Hub',
    },
  };
}

function getNextOrderNo() {
  const rows = db.prepare("SELECT order_no AS orderNo FROM orders").all();
  const maxNumeric = rows.reduce((currentMax, row) => {
    const match = /(\d+)$/.exec(row.orderNo ?? "");
    const numeric = match ? Number(match[1]) : 0;
    return Math.max(currentMax, numeric);
  }, 0);

  return `RO-${maxNumeric + 1}`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/api/order-form-options", (_req, res) => {
  res.json(getOrderFormOptions());
});

app.get("/api/order-form-options/admin", (_req, res) => {
  res.json(getOrderFormOptionsInternal(true));
});

app.get("/api/settings/store", (_req, res) => {
  res.json(getStoreSettings());
});

app.patch("/api/settings/store", (req, res) => {
  const storeName = String(req.body?.storeName ?? "").trim();
  const storeCode = String(req.body?.storeCode ?? "").trim();
  const phone = String(req.body?.phone ?? "").trim();
  const email = String(req.body?.email ?? "").trim();
  const address = String(req.body?.address ?? "").trim();
  const coverImage = String(req.body?.coverImage ?? "").trim();

  if (!storeName || !storeCode || !phone || !email || !address) {
    res.status(400).json({ message: "Store name, code, phone, email and address are required" });
    return;
  }

  db.prepare(`
    UPDATE settings_store
    SET store_name = ?, store_code = ?, phone = ?, email = ?, address = ?, cover_image = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(storeName, storeCode, phone, email, address, coverImage);

  appendAuditLog({ actor: "System Admin", type: "Store Settings", message: `Updated store settings for ${storeName}`, meta: "Settings" });
  res.json(getStoreSettings());
});

app.get("/api/settings/business-hours", (_req, res) => {
  res.json(getBusinessHoursSettings());
});

app.get("/api/settings/language", (_req, res) => {
  res.json(getLanguageSettings());
});

app.patch("/api/settings/language", (req, res) => {
  const primaryLanguage = String(req.body?.primaryLanguage ?? "").trim();
  const externalLanguage = String(req.body?.externalLanguage ?? "").trim();
  const localLanguage = String(req.body?.localLanguage ?? "").trim();

  if (!primaryLanguage || !externalLanguage || !localLanguage) {
    res.status(400).json({ message: "Language settings are required" });
    return;
  }

  db.prepare(`
    UPDATE settings_language
    SET primary_language = ?, external_language = ?, local_language = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(primaryLanguage, externalLanguage, localLanguage);

  appendAuditLog({ actor: "System Admin", type: "Language Settings", message: "Updated language settings", meta: primaryLanguage });
  res.json(getLanguageSettings());
});

app.get("/api/settings/print", (_req, res) => {
  res.json(getPrintSettings());
});

app.patch("/api/settings/print", (req, res) => {
  const paperSize = String(req.body?.paperSize ?? "").trim();
  const qrEnabled = req.body?.qrEnabled ? 1 : 0;
  const defaultReceiptEnabled = req.body?.defaultReceiptEnabled ? 1 : 0;
  const footerBrandEnabled = req.body?.footerBrandEnabled ? 1 : 0;

  if (!paperSize) {
    res.status(400).json({ message: "Paper size is required" });
    return;
  }

  db.prepare(`
    UPDATE settings_print
    SET paper_size = ?, qr_enabled = ?, default_receipt_enabled = ?, footer_brand_enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(paperSize, qrEnabled, defaultReceiptEnabled, footerBrandEnabled);

  appendAuditLog({ actor: "System Admin", type: "Print Settings", message: "Updated print settings", meta: paperSize });
  res.json(getPrintSettings());
});

app.put("/api/settings/business-hours", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const holidayEnabled = req.body?.holidayEnabled ? 1 : 0;
  const holidayHours = String(req.body?.holidayHours ?? "").trim();
  const holidayNote = String(req.body?.holidayNote ?? "").trim();

  if (!rows.length || rows.some((row) => !String(row.dayLabel ?? "").trim() || !String(row.hoursValue ?? "").trim())) {
    res.status(400).json({ message: "Business hours rows are required" });
    return;
  }

  db.transaction(() => {
    db.prepare("DELETE FROM settings_business_hours").run();
    const insertHour = db.prepare(`
      INSERT INTO settings_business_hours (day_label, hours_value, note, sort_order)
      VALUES (?, ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      insertHour.run(String(row.dayLabel).trim(), String(row.hoursValue).trim(), String(row.note ?? "").trim(), index + 1);
    });
    db.prepare(`
      INSERT INTO settings_business_rules (id, holiday_enabled, holiday_hours, holiday_note)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        holiday_enabled = excluded.holiday_enabled,
        holiday_hours = excluded.holiday_hours,
        holiday_note = excluded.holiday_note
    `).run(holidayEnabled, holidayHours || "10:00 - 15:00", holidayNote);
  })();

  appendAuditLog({ actor: "System Admin", type: "Business Hours", message: "Updated business hours", meta: "Settings" });
  res.json(getBusinessHoursSettings());
});

app.get("/api/settings/staff-permissions", (_req, res) => {
  res.json(getStaffPermissionSettings());
});

app.post("/api/settings/staff-permissions", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const role = String(req.body?.role ?? "").trim();
  const scope = String(req.body?.scope ?? "").trim();
  const canEditOrders = req.body?.canEditOrders ? 1 : 0;
  const canAdjustInventory = req.body?.canAdjustInventory ? 1 : 0;
  const canViewFinance = req.body?.canViewFinance ? 1 : 0;
  const isActive = req.body?.isActive === false ? 0 : 1;

  if (!name || !role || !scope) {
    res.status(400).json({ message: "Name, role and scope are required" });
    return;
  }

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM settings_staff").get().value;
  db.prepare(`
    INSERT INTO settings_staff (name, role, scope, can_edit_orders, can_adjust_inventory, can_view_finance, is_active, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, role, scope, canEditOrders, canAdjustInventory, canViewFinance, isActive, nextSort);

  appendAuditLog({ actor: "System Admin", type: "Staff Permission", message: `Added staff profile ${name}`, meta: role });
  res.status(201).json(getStaffPermissionSettings());
});

app.patch("/api/settings/staff-permissions/:id", (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM settings_staff WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ message: "Staff profile not found" });
    return;
  }

  const name = String(req.body?.name ?? "").trim();
  const role = String(req.body?.role ?? "").trim();
  const scope = String(req.body?.scope ?? "").trim();
  const canEditOrders = req.body?.canEditOrders ? 1 : 0;
  const canAdjustInventory = req.body?.canAdjustInventory ? 1 : 0;
  const canViewFinance = req.body?.canViewFinance ? 1 : 0;
  const isActive = req.body?.isActive ? 1 : 0;

  if (!name || !role || !scope) {
    res.status(400).json({ message: "Name, role and scope are required" });
    return;
  }

  db.prepare(`
    UPDATE settings_staff
    SET name = ?, role = ?, scope = ?, can_edit_orders = ?, can_adjust_inventory = ?, can_view_finance = ?, is_active = ?
    WHERE id = ?
  `).run(name, role, scope, canEditOrders, canAdjustInventory, canViewFinance, isActive, id);

  appendAuditLog({ actor: "System Admin", type: "Staff Permission", message: `Updated staff profile ${name}`, meta: role });
  res.json(getStaffPermissionSettings());
});

app.delete("/api/settings/staff-permissions/:id", (req, res) => {
  const id = Number(req.params.id);
  const staff = db.prepare("SELECT name FROM settings_staff WHERE id = ?").get(id);
  if (!staff) {
    res.status(404).json({ message: "Staff profile not found" });
    return;
  }

  db.prepare("DELETE FROM settings_staff WHERE id = ?").run(id);
  appendAuditLog({ actor: "System Admin", type: "Staff Permission", message: `Deleted staff profile ${staff.name}`, meta: "Delete" });
  res.json(getStaffPermissionSettings());
});

app.patch("/api/settings/reorder", (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) {
    res.status(400).json({ message: "Reorder items are required" });
    return;
  }

  db.transaction(() => {
    const update = db.prepare("UPDATE parts SET reorder_level = ? WHERE id = ?");
    items.forEach((item) => {
      const id = Number(item.id);
      const reorderLevel = Number(item.reorderLevel);
      if (Number.isInteger(id) && Number.isInteger(reorderLevel) && reorderLevel >= 0) {
        update.run(reorderLevel, id);
      }
    });
  })();

  appendAuditLog({ actor: "System Admin", type: "Reorder Settings", message: "Updated reorder thresholds", meta: "Inventory" });
  const rows = db.prepare(`
    SELECT
      id,
      name,
      sku,
      stock,
      reorder_level AS reorderLevel,
      unit_price AS unitPrice,
      supplier
    FROM parts
    ORDER BY stock ASC, name ASC
  `).all();
  res.json(rows.map(mapPart));
});

app.post("/api/order-form-options/brands", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const market = String(req.body?.market ?? "Vanuatu").trim() || "Vanuatu";

  if (!name) {
    res.status(400).json({ message: "Brand name is required" });
    return;
  }

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_brands").get().value;
  const result = db.prepare(`
    INSERT INTO order_form_brands (name, market, sort_order)
    VALUES (?, ?, ?)
  `).run(name, market, nextSort);
  res.status(201).json(db.prepare(`
    SELECT id, name, market, sort_order AS sortOrder
    FROM order_form_brands
    WHERE id = ?
  `).get(result.lastInsertRowid));
});

app.post("/api/order-form-options/models", (req, res) => {
  const brandId = Number(req.body?.brandId);
  const name = String(req.body?.name ?? "").trim();

  if (!Number.isInteger(brandId) || !name) {
    res.status(400).json({ message: "Brand and model name are required" });
    return;
  }

  const brand = db.prepare("SELECT id FROM order_form_brands WHERE id = ? AND is_active = 1").get(brandId);
  if (!brand) {
    res.status(404).json({ message: "Brand not found" });
    return;
  }

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_models WHERE brand_id = ?").get(brandId).value;
  const result = db.prepare(`
    INSERT INTO order_form_models (brand_id, name, sort_order)
    VALUES (?, ?, ?)
  `).run(brandId, name, nextSort);
  res.status(201).json(db.prepare(`
    SELECT id, brand_id AS brandId, name, sort_order AS sortOrder
    FROM order_form_models
    WHERE id = ?
  `).get(result.lastInsertRowid));
});

app.post("/api/order-form-options/technicians", (req, res) => {
  const name = String(req.body?.name ?? "").trim();

  if (!name) {
    res.status(400).json({ message: "Technician name is required" });
    return;
  }

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_technicians").get().value;
  const result = db.prepare(`
    INSERT INTO order_form_technicians (name, sort_order)
    VALUES (?, ?)
  `).run(name, nextSort);
  res.status(201).json(db.prepare(`
    SELECT id, name, sort_order AS sortOrder
    FROM order_form_technicians
    WHERE id = ?
  `).get(result.lastInsertRowid));
});

app.post("/api/order-form-options/issues", (req, res) => {
  const title = String(req.body?.title ?? "").trim();

  if (!title) {
    res.status(400).json({ message: "Issue title is required" });
    return;
  }

  const nextSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_issue_templates").get().value;
  const result = db.prepare(`
    INSERT INTO order_form_issue_templates (title, sort_order)
    VALUES (?, ?)
  `).run(title, nextSort);
  res.status(201).json(db.prepare(`
    SELECT id, title, sort_order AS sortOrder
    FROM order_form_issue_templates
    WHERE id = ?
  `).get(result.lastInsertRowid));
});

app.patch("/api/order-form-options/:collection/:id", (req, res) => {
  const collection = String(req.params.collection ?? "");
  const id = Number(req.params.id);

  const collectionMap = {
    brands: { table: "order_form_brands", nameColumn: "name" },
    models: { table: "order_form_models", nameColumn: "name" },
    technicians: { table: "order_form_technicians", nameColumn: "name" },
    issues: { table: "order_form_issue_templates", nameColumn: "title" },
  };

  const target = collectionMap[collection];
  if (!target || !Number.isInteger(id)) {
    res.status(400).json({ message: "Unsupported option collection" });
    return;
  }

  const current = db.prepare(`SELECT id, is_active AS isActive, sort_order AS sortOrder, ${target.nameColumn} AS label FROM ${target.table} WHERE id = ?`).get(id);
  if (!current) {
    res.status(404).json({ message: "Option not found" });
    return;
  }

  const isActive = req.body?.isActive === undefined ? current.isActive : (req.body.isActive ? 1 : 0);
  const direction = req.body?.direction;

  db.transaction(() => {
    if (direction === "up" || direction === "down") {
      const operator = direction === "up" ? "<" : ">";
      const ordering = direction === "up" ? "DESC" : "ASC";
      const neighbor = db.prepare(`
        SELECT id, sort_order AS sortOrder
        FROM ${target.table}
        WHERE id != ? AND sort_order ${operator} ?
        ORDER BY sort_order ${ordering}, id ${ordering}
        LIMIT 1
      `).get(id, current.sortOrder);

      if (neighbor) {
        db.prepare(`UPDATE ${target.table} SET sort_order = ? WHERE id = ?`).run(neighbor.sortOrder, current.id);
        db.prepare(`UPDATE ${target.table} SET sort_order = ? WHERE id = ?`).run(current.sortOrder, neighbor.id);
      }
    }

    if (req.body?.direction !== "up" && req.body?.direction !== "down") {
      const sortOrder = Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : current.sortOrder;
      db.prepare(`UPDATE ${target.table} SET is_active = ?, sort_order = ? WHERE id = ?`).run(isActive, sortOrder, id);
    } else {
      db.prepare(`UPDATE ${target.table} SET is_active = ? WHERE id = ?`).run(isActive, id);
    }
  })();

  appendAuditLog({ actor: "System Admin", type: "Order Options", message: `Updated ${current.label}`, meta: collection });
  res.json(getOrderFormOptions());
});

app.delete("/api/order-form-options/:collection/:id", (req, res) => {
  const collection = String(req.params.collection ?? "");
  const id = Number(req.params.id);

  const collectionMap = {
    brands: { table: "order_form_brands" },
    models: { table: "order_form_models" },
    technicians: { table: "order_form_technicians" },
    issues: { table: "order_form_issue_templates" },
  };

  const target = collectionMap[collection];
  if (!target || !Number.isInteger(id)) {
    res.status(400).json({ message: "Unsupported option collection" });
    return;
  }

  db.transaction(() => {
    if (collection === "brands") {
      db.prepare("DELETE FROM order_form_models WHERE brand_id = ?").run(id);
    }
    db.prepare(`DELETE FROM ${target.table} WHERE id = ?`).run(id);
  })();

  appendAuditLog({ actor: "System Admin", type: "Order Options", message: `Deleted option from ${collection}`, meta: "Delete" });
  res.json(getOrderFormOptions());
});

app.get("/api/dashboard", (_req, res) => {
  const metrics = db.prepare(`
    SELECT
      COUNT(*) AS totalOrders,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingOrders,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inProgressOrders,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedOrders,
      COALESCE(SUM(amount), 0) AS totalRevenue
    FROM orders
  `).get();
  const todayKey = getTodayDateKey();
  const todayOrders = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE scheduled_date = ?`).get(todayKey)?.count ?? 0;
  const inventoryValue = db.prepare(`SELECT COALESCE(SUM(stock * unit_price), 0) AS total FROM parts`).get()?.total ?? 0;
  const pendingProcurements = db.prepare(`SELECT COUNT(*) AS count FROM procurements WHERE status != '已交付'`).get()?.count ?? 0;
  const readyForPickup = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE status = 'completed'`).get()?.count ?? 0;
  const urgentOrders = getRepairQueue("all", "").metrics.urgent;

  const lowStockParts = db.prepare(`
    SELECT id, name, sku, stock, reorder_level AS reorderLevel, unit_price AS unitPrice, supplier
    FROM parts
    WHERE stock <= reorder_level
    ORDER BY stock ASC, name ASC
  `).all();

  res.json({
    metrics: {
      totalOrders: metrics.totalOrders,
      todayOrders,
      pendingOrders: metrics.pendingOrders,
      inProgressOrders: metrics.inProgressOrders,
      completedOrders: metrics.completedOrders,
      urgentOrders,
      pendingProcurements,
      readyForPickup,
      inventoryValue,
      inventoryValueFormatted: formatMoney(inventoryValue),
      totalRevenue: formatMoney(metrics.totalRevenue),
    },
    lowStockParts: lowStockParts.map(mapPart),
    recentMovements: getRecentMovements(),
  });
});

app.get("/api/orders", (req, res) => {
  const { status = "all", search = "" } = req.query;
  const clauses = [];
  const params = {};

  if (status !== "all") {
    clauses.push("o.status = @status");
    params.status = status;
  }

  if (search) {
    clauses.push("(o.order_no LIKE @search OR o.device_name LIKE @search OR c.name LIKE @search OR c.phone LIKE @search)");
    params.search = `%${search}%`;
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`${baseOrderSelect} ${whereClause} ORDER BY o.scheduled_date DESC, o.id DESC`).all(params);
  res.json(rows.map(mapOrder));
});

app.get("/api/repair-queue", (req, res) => {
  const status = String(req.query.status ?? "all");
  const search = String(req.query.search ?? "");
  res.json(getRepairQueue(status, search));
});

app.post("/api/repair-queue/:id/action", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const action = String(req.body?.action ?? "").trim();
  const allowedActions = ["accept", "start", "complete"];
  if (!allowedActions.includes(action)) {
    res.status(400).json({ message: "Unsupported queue action" });
    return;
  }

  const nextStatus = action === "complete" ? "completed" : action === "accept" || action === "start" ? "in_progress" : order.status;
  const nextPhase = action === "complete" ? "completed" : action === "start" ? "repair" : "diagnosis";

  db.transaction(() => {
    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(nextStatus, order.id);

    const execution = getOrderExecutionRecord(order.id);
    db.prepare(`
      INSERT INTO order_execution (order_id, phase, checklist_json, elapsed_minutes, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(order_id) DO UPDATE SET
        phase = excluded.phase,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      order.id,
      nextPhase,
      execution?.checklistJson ?? JSON.stringify(getDefaultExecutionChecklist()),
      execution?.elapsedMinutes ?? 45,
    );
  })();

  const updatedOrder = getOrderById(order.id);
  appendAuditLog({
    actor: updatedOrder.technician,
    type: "Queue Action",
    tone: action === "complete" ? "success" : "primary",
    message: `${action === "accept" ? "Accepted" : action === "start" ? "Started" : "Completed"} ${updatedOrder.orderNo} from repair queue`,
    meta: action,
  });

  res.json({
    ok: true,
    action,
    order: mapOrder(updatedOrder),
    queue: getRepairQueue("all", "").rows.find((item) => item.id === updatedOrder.id) ?? null,
  });
});

app.get("/api/orders/:id", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const parts = getOrderParts(req.params.id);
  const partsTotal = parts.reduce((sum, item) => sum + item.subtotal, 0);
  const laborTotal = Math.max(0, order.amount - partsTotal);
  const balanceDue = Math.max(0, order.amount - Number(order.deposit ?? 0));
  const intakePhotos = getStoredPhotosByStages(order.id, ["手机正面", "手机背面", "客户照片"]);
  const intake = getOrderIntake(order.id);

  const deviceSerial = intake?.imeiSerial || `SN-${String(order.id).padStart(4, "0")}-${order.deviceName.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}`;
  const batteryHealth = order.deviceName.toLowerCase().includes("iphone") ? "92%" : order.deviceName.toLowerCase().includes("macbook") ? "86%" : "89%";
  const storage = order.deviceName.toLowerCase().includes("iphone") ? "256 GB" : order.deviceName.toLowerCase().includes("macbook") ? "512 GB" : "128 GB";
  const execution = getOrderExecutionRecord(order.id);
  const timeline = getOrderTimeline(order, execution?.phase ?? "repair");

  res.json({
    ...mapOrder(order),
    deviceMeta: {
      model: order.deviceName,
      serialNumber: deviceSerial,
      batteryHealth,
      storage,
    },
    intakeMeta: intake ? {
      intakeCode: intake.intakeCode,
      imeiSerial: intake.imeiSerial,
      customerSignature: intake.customerSignature,
      createdAt: formatChatTimestamp(intake.createdAt),
    } : null,
    quickActions: [
      { id: "print", label: "打印结算单", icon: "print" },
      { id: "contact", label: "联系客户", icon: "call" },
    ],
    timeline,
    partsTotal,
    partsTotalFormatted: formatMoney(partsTotal),
    laborTotal,
    laborTotalFormatted: formatMoney(laborTotal),
    depositFormatted: formatMoney(order.deposit ?? 0),
    balanceDue,
    balanceDueFormatted: formatMoney(balanceDue),
    grandTotalFormatted: formatMoney(order.amount),
    intakePhotos: intakePhotos.map((photo) => ({
      stage: photo.stage,
      image: photo.image,
      note: photo.note,
      time: formatChatTimestamp(photo.createdAt),
    })),
    parts: parts.map((part) => ({
      ...part,
      unitPriceFormatted: formatMoney(part.unitPrice),
      subtotalFormatted: formatMoney(part.subtotal),
    })),
  });
});

app.get("/api/orders/:id/communication", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json({
    id: order.id,
    orderNo: order.orderNo,
    amountFormatted: formatMoney(order.amount),
    suggestedReplies: ["等待配件", "可取机", "检测中", "需支付定金"],
    messages: getOrderMessages(order),
  });
});

app.get("/api/orders/:id/intake", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const intake = getOrderIntake(order.id);
  const intakePhotos = getStoredPhotosByStages(order.id, ["手机正面", "手机背面", "客户照片"]);

  res.json({
    ...mapOrder(order),
    intakeCode: intake?.intakeCode ?? `IN-${String(order.id).padStart(8, "0")}`,
    imeiSerial: intake?.imeiSerial ?? "-",
    customerSignature: intake?.customerSignature ?? order.customerName,
    signedAt: intake?.createdAt ? formatChatTimestamp(intake.createdAt) : formatChatTimestamp(new Date().toISOString()),
    intakePhotos: intakePhotos.map((photo) => ({
      stage: photo.stage,
      image: photo.image,
      note: photo.note,
    })),
  });
});

app.get("/api/orders/:id/completion", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const completion = getOrderCompletionRecord(order.id);
  const checklist = completion
    ? parseJson(completion.checklistJson, getDefaultCompletionChecklist(order))
    : getDefaultCompletionChecklist(order);

  res.json({
    id: order.id,
    orderNo: order.orderNo,
    deviceName: order.deviceName,
    amountFormatted: formatMoney(order.amount),
    status: order.status,
    warranty: completion?.warranty ?? "Standard Warranty Applied",
    checklist,
    finalNotes: completion?.finalNotes || order.notes || "Device cleaned and tested. Ready for customer pickup.",
    updatedAt: completion?.updatedAt ?? null,
    photos: [
      "https://lh3.googleusercontent.com/aida-public/AB6AXuA1juwx_eCimFpAOXBwGsUEDhBFT2rAT-7yjZNoNV-3-8UcxFeDFhi3M2H_Rq3UUAIJamb89AkbeUA_pC38ZLnurAf9ehRs0suNJSlj7x6Z_hDCFr5Si-YXSevGZ57OJYwdAQIbe4J95tAQHP5y12nHRaqeInsNT2Ngw7vJFvYfHifvUIRCFUgsugzdUmafCVDn9m3I7-sYmwVIlZEfRMRQY9xchSyQYKVrFDIGTsnTdLwGpM7gD5UOHEr_bhclIRE0qOgDbAK98b3r",
      "https://lh3.googleusercontent.com/aida-public/AB6AXuBNqfprV4eG5jDsOnP_QmLhJ84PZ5sdZcZ2XOxvnQMgO9dPde-f01Q2GmlfUMQ2Sq7vZqf3m34CPLpuq8M-_0ieKAc7afjCRvLsGxd8gm6m-hq2D-1w9eOBIFwEtrxOdt0bkWF_7iQ5IiE6HQMdnFOUHjft0g0d_jlHlkQesLzv2VjOu-vZQnWdSD9L3N1yMBGXHdNafdxYpE-PgAIZObNcS9HfYha3hHYXoMYafw18Scjc82sh1ZukB7t-Ibj0B8j2I5ZBJOrDRqtv",
    ],
  });
});

app.get("/api/orders/:id/execution", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const execution = getOrderExecutionRecord(order.id);
  const checklist = execution
    ? parseJson(execution.checklistJson, getDefaultExecutionChecklist())
    : getDefaultExecutionChecklist();
  const timeline = getOrderTimeline(order, execution?.phase ?? "repair");
  const parts = getOrderParts(order.id).map((part) => ({
    ...part,
    unitPriceFormatted: formatMoney(part.unitPrice),
    subtotalFormatted: formatMoney(part.subtotal),
  }));

  res.json({
    ...mapOrder(order),
    deviceMeta: {
      color: order.deviceName.toLowerCase().includes("iphone") ? "Deep Purple" : order.deviceName.toLowerCase().includes("macbook") ? "Midnight" : "Graphite",
      storage: order.deviceName.toLowerCase().includes("macbook") ? "512GB" : "256GB",
    },
    checklist,
    phase: execution?.phase ?? "repair",
    phaseLabel: getExecutionPhaseLabel(execution?.phase ?? "repair"),
    elapsedMinutes: execution?.elapsedMinutes ?? 45,
    timeline,
    parts,
  });
});

app.post("/api/orders/:id/execution", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const allowedPhases = ["diagnosis", "repair", "qa", "completed"];
  const phase = allowedPhases.includes(req.body?.phase) ? req.body.phase : "repair";
  const elapsedMinutes = Number.isInteger(req.body?.elapsedMinutes) ? req.body.elapsedMinutes : Number(req.body?.elapsedMinutes ?? 45);
  const checklist = Array.isArray(req.body?.checklist) ? req.body.checklist : getDefaultExecutionChecklist();
  const normalizedChecklist = checklist.map((item) => ({
    id: String(item.id ?? ""),
    label: String(item.label ?? ""),
    checked: Boolean(item.checked),
  })).filter((item) => item.id && item.label);

  if (!normalizedChecklist.length) {
    res.status(400).json({ message: "Execution checklist is required" });
    return;
  }

  const safeElapsed = Number.isFinite(elapsedMinutes) && elapsedMinutes > 0 ? Math.round(elapsedMinutes) : 45;
  const status = phase === "completed" ? "completed" : phase === "diagnosis" ? "pending" : "in_progress";

  db.transaction(() => {
    db.prepare(`
      INSERT INTO order_execution (order_id, phase, checklist_json, elapsed_minutes, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(order_id) DO UPDATE SET
        phase = excluded.phase,
        checklist_json = excluded.checklist_json,
        elapsed_minutes = excluded.elapsed_minutes,
        updated_at = CURRENT_TIMESTAMP
    `).run(order.id, phase, JSON.stringify(normalizedChecklist), safeElapsed);

    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, order.id);
  })();

  res.json({
    ok: true,
    phase,
    status,
    phaseLabel: getExecutionPhaseLabel(phase),
  });
});

app.get("/api/orders/:id/deductions", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const rows = db.prepare(`
    SELECT
      m.id,
      m.part_id AS partId,
      p.name AS partName,
      p.sku,
      m.quantity,
      m.note,
      m.created_at AS createdAt,
      p.unit_price AS unitPrice
    FROM inventory_movements m
    JOIN parts p ON p.id = m.part_id
    WHERE m.movement_type = 'out' AND m.note LIKE ?
    ORDER BY m.id DESC
  `).all(`%${order.orderNo}%`);

  const totalValue = rows.reduce((sum, row) => sum + (row.unitPrice * row.quantity), 0);

  res.json({
    orderId: order.id,
    orderNo: order.orderNo,
    status: order.status,
    technician: order.technician,
    totalDeductionFormatted: formatMoney(totalValue),
    rows: rows.map((row) => ({
      ...row,
      subtotalFormatted: formatMoney(row.unitPrice * row.quantity),
      createdLabel: formatChatTimestamp(row.createdAt),
    })),
  });
});

app.get("/api/orders/:id/deductions/journal", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const rows = db.prepare(`
    SELECT
      m.id,
      p.name AS partName,
      m.quantity,
      m.note,
      m.created_at AS createdAt
    FROM inventory_movements m
    JOIN parts p ON p.id = m.part_id
    WHERE m.movement_type = 'out' AND m.note LIKE ?
    ORDER BY m.id DESC
  `).all(`%${order.orderNo}%`);

  res.json({
    orderNo: order.orderNo,
    totalDeductions: rows.reduce((sum, row) => sum + row.quantity, 0),
    totalValueFormatted: formatMoney(rows.reduce((sum, row) => sum + row.quantity * 1000, 0)),
    activeOrders: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'in_progress')").get().count,
    rows: rows.map((row) => ({
      ...row,
      createdAt: formatChatTimestamp(row.createdAt),
      reference: order.orderNo,
    })),
  });
});

app.get("/api/orders/:id/receipt", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const parts = getOrderParts(req.params.id);
  const receiptMeta = getReceiptMeta(order.id);

  const partsTotal = parts.reduce((sum, item) => sum + item.subtotal, 0);
  const laborTotal = Math.max(0, order.amount - partsTotal);

  res.json({
    orderId: order.id,
    orderNo: order.orderNo,
    date: `${order.scheduledDate} 14:30`,
    customerName: order.customerName,
    customerPhoneMasked: `${order.customerPhone.slice(0, 4)}****${order.customerPhone.slice(-2)}`,
    totalFormatted: formatMoney(order.amount),
    partsTotalFormatted: formatMoney(partsTotal),
    laborTotalFormatted: formatMoney(laborTotal),
    printed: Boolean(receiptMeta?.printedAt),
    printedAt: receiptMeta?.printedAt ?? null,
    pickedUp: Boolean(receiptMeta?.pickedUpAt) || order.status === "picked_up",
    pickedUpAt: receiptMeta?.pickedUpAt ?? null,
    paymentMethod: order.amount > 10000 ? "银行转账" : "现金",
    items: [
      ...parts.map((item) => ({
        name: item.name,
        amountFormatted: formatMoney(item.subtotal),
        detail: `备件费 ${formatMoney(item.subtotal)} | 工费 0 VUV`,
      })),
      {
        name: "精细维修服务",
        amountFormatted: formatMoney(laborTotal),
        detail: `备件费 0 VUV | 工费 ${formatMoney(laborTotal)}`,
      },
    ],
  });
});

app.get("/api/receipts", (_req, res) => {
  const receipts = db.prepare(`
    SELECT
      o.id,
      o.order_no AS orderNo,
      o.scheduled_date AS scheduledDate,
      o.amount,
      o.status,
      c.name AS customerName,
      rm.printed_at AS printedAt,
      rm.picked_up_at AS pickedUpAt
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN receipt_meta rm ON rm.order_id = o.id
    ORDER BY o.scheduled_date DESC, o.id DESC
  `).all();

  res.json(receipts.map((row, index) => ({
    id: row.id,
    code: index === 0 ? `RE-${row.scheduledDate.replace(/-/g, "")}` : index === 1 ? `CS-${row.scheduledDate.replace(/-/g, "")}` : `TF-${row.scheduledDate.replace(/-/g, "")}`,
    orderId: row.id,
    orderNo: row.orderNo,
    customerName: row.customerName,
    scheduledDate: row.scheduledDate,
    amountFormatted: formatMoney(row.amount),
    printed: Boolean(row.printedAt),
    pickedUp: Boolean(row.pickedUpAt) || row.status === "picked_up",
    type: index === 0 ? "维修工单" : index === 1 ? "收银收据" : "调拨单",
    typeTone: index === 0 ? "primary" : index === 1 ? "orange" : "secondary",
    metaLabel: index === 2 ? "物品数量" : "金额总计",
    metaValue: index === 2 ? `${row.id + 12} Items` : formatMoney(row.amount),
  })));
});

app.get("/api/orders/:id/photo-upload", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const storedPhotos = getStoredPhotosByStages(order.id, ["维修后"]);
  const photos = storedPhotos.length ? storedPhotos.map((item) => item.image) : getDefaultUploadPhotos();

  res.json({
    orderNo: order.orderNo,
    amountFormatted: formatMoney(order.amount),
    selectedCount: photos.length,
    maxCount: 5,
    photos,
  });
});

app.get("/api/orders/:id/photo-archive", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const storedPhotos = getStoredPhotos(order.id);
  const intakeSections = ["手机正面", "手机背面", "客户照片"]
    .map((stage) => {
      const rows = storedPhotos.filter((photo) => photo.stage === stage);
      if (!rows.length) return null;
      return {
        title: stage,
        badge: `${rows.length} 张照片`,
        photos: rows.map((photo) => ({
          image: photo.image,
          note: photo.note || "建单时上传的受理照片。",
          time: formatChatTimestamp(photo.createdAt),
        })),
      };
    })
    .filter(Boolean);
  const repairRows = storedPhotos.filter((photo) => !["手机正面", "手机背面", "客户照片"].includes(photo.stage));
  const uploadedSections = repairRows.length
    ? [{
      title: "维修后",
      badge: `${repairRows.length} 张照片`,
      photos: repairRows.map((photo) => ({
        image: photo.image,
        note: photo.note || "现场上传的维修照片。",
        time: formatChatTimestamp(photo.createdAt),
      })),
    }]
    : [];

  res.json({
    orderNo: order.orderNo,
    deviceName: order.deviceName,
    amountFormatted: formatMoney(order.amount),
    statusLabel: statusMeta[order.status]?.label ?? order.status,
    sections: [
      ...intakeSections,
      {
        title: "维修中",
        badge: "1 张照片",
        photos: [{
          image: "https://lh3.googleusercontent.com/aida-public/AB6AXuB0e-bLjWZVOQBxZCB84ifSVQ89X_lYvhKRc1fL797luv4izeGtvIViyi7GFw97yZcazT2sPFOchumCWvusooe1vqbqy6kySIcP6NEBvbHhKGNHUnPqE09rqzPG8HIgiDX8VPohfR6A54cl0dM1XAyx-0tqEl9RQOVF86SItAkCOXxcFaAZF1UqbneEbnskCnxIKJLWK-jhjsqJV8_xQxVgZP74iHjLzOUKevCzkjoq5Y8LMuX-zE8fB-pV6gkh8NCu1eBGDbZlEXFY",
          note: "正在更换总成并进行内部清洁。",
          time: `${order.scheduledDate} 11:30 AM`,
        }],
      },
      {
        title: "维修后",
        badge: "1 张照片",
        photos: [{
          image: "https://lh3.googleusercontent.com/aida-public/AB6AXuBtRU5FSnNPCbYXxRrOam9j2keOrBm4A_laekmsumhBszi6YrfW6x16BfL_C1dg-gHCJJ3pkDfCx2Gqx5dNpHC91fd0SkmivK9tsNaIXQv-lVz4GSgLN2uQ16QnVJ83DjpWC24CspOcnNbwoyogJlOybULO-l2sqlY72edg73zvhZ9ygw5BfmZFpaF0kkdmUSvRO5AIio8lfZgEPjiGNByjn8fIIywXmJ9A2BOULeRYrhb8RX9mCjq3ZgWrnAngUwtSTZnjVr__kbBw",
          note: "更换完成，亮度与触控测试正常。",
          time: `${order.scheduledDate} 02:45 PM`,
        }],
      },
      ...uploadedSections,
    ],
  });
});

app.get("/api/orders/:id/share-report", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json({
    orderNo: order.orderNo,
    customerName: order.customerName,
    createdDate: order.scheduledDate,
    fileName: `Repair_Report_${order.orderNo}.pdf`,
    fileSize: "1.2 MB",
    previewItems: [
      { label: order.title, amountFormatted: formatMoney(Math.round(order.amount * 0.83)) },
      { label: "Labor Charges", amountFormatted: formatMoney(Math.round(order.amount * 0.17)) },
      { label: "Tempered Glass (Gift)", amountFormatted: "0 VUV", tag: "Gift" },
    ],
    totalFormatted: formatMoney(order.amount),
  });
});

app.get("/api/orders/:id/email-report", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json({
    orderNo: order.orderNo,
    recipient: order.customerEmail,
    subject: `Your Repair Report for ${order.orderNo}`,
    message: `你好 / Hello,\n\n您的设备 (${order.orderNo}) 已维修完成，可以前来领取。\nYour device (${order.orderNo}) is now ready for pickup.\n\n附件中包含详细的维修报告。\nAttached is the detailed repair report for your records.\n\n如有任何疑问，请随时与我们联系。\nIf you have any questions, please feel free to contact us.\n\nBest regards,\nVila Port Repair Team`,
    attachmentName: `Repair_Report_${order.orderNo}.pdf`,
    attachmentSize: "1.2 MB",
  });
});

app.post("/api/orders/:id/email-report/send", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json({
    ok: true,
    orderNo: order.orderNo,
    recipient: order.customerEmail,
    status: "queued",
    queuedAt: new Date().toISOString(),
    message: `邮件已排队发送到 ${order.customerEmail}`,
  });
});

app.get("/api/orders/:id/report.pdf", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const lines = [
    `Repair Report ${order.orderNo}`,
    `Customer: ${order.customerName}`,
    `Device: ${order.deviceName}`,
    `Technician: ${order.technician}`,
    `Scheduled Date: ${order.scheduledDate}`,
    `Status: ${statusMeta[order.status]?.label ?? order.status}`,
    `Amount: ${formatMoney(order.amount)}`,
    `Issue: ${order.issueSummary}`,
  ];

  const pdf = buildSimplePdf(lines);
  const filename = `Repair_Report_${order.orderNo}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(pdf);
});

app.get("/api/refunds", (_req, res) => {
  const rows = getRefundRows();
  res.json({
    rows,
    metrics: {
      completedOrders: db.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('completed', 'picked_up')").get().count,
      totalRefundsFormatted: formatMoney(rows.reduce((sum, row) => sum + row.amount, 0)),
      pendingCount: rows.filter((row) => row.status === "pending").length,
    },
  });
});

app.post("/api/refunds", (req, res) => {
  const orderId = Number(req.body?.orderId);
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason ?? "").trim();
  const method = String(req.body?.method ?? "original").trim() || "original";

  if (!Number.isInteger(orderId) || !Number.isFinite(amount) || amount <= 0 || !reason) {
    res.status(400).json({ message: "Invalid refund payload" });
    return;
  }

  const order = getOrderById(orderId);
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const result = db.prepare(`
    INSERT INTO refunds (order_id, amount, reason, method, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(orderId, Math.round(amount), reason, method);

  const created = getRefundRows().find((row) => row.id === Number(result.lastInsertRowid));
  appendAuditLog({ actor: "Cashier", type: "Refund", tone: "danger", message: `Created refund request for ${order.orderNo}`, meta: method });
  res.status(201).json(created);
});

app.get("/api/reviews", (_req, res) => {
  const rows = getReviewRows();
  const total = rows.length || 1;
  const average = rows.length ? (rows.reduce((sum, row) => sum + row.rating, 0) / rows.length) : 0;
  res.json({
    summary: {
      averageRating: average.toFixed(1),
      totalReviews: rows.length,
      repliedCount: rows.filter((row) => row.reply).length,
      distribution: [5, 4, 3, 2, 1].map((rating) => ({
        rating,
        percent: Math.round((rows.filter((row) => row.rating === rating).length / total) * 100),
      })),
    },
    rows,
  });
});

app.post("/api/reviews/:id/reply", (req, res) => {
  const reviewId = Number(req.params.id);
  const reply = String(req.body?.reply ?? "").trim();

  if (!reviewId || !reply) {
    res.status(400).json({ message: "Reply is required" });
    return;
  }

  const result = db.prepare("UPDATE reviews SET reply = ? WHERE id = ?").run(reply, reviewId);
  if (result.changes === 0) {
    res.status(404).json({ message: "Review not found" });
    return;
  }

  const updated = getReviewRows().find((row) => row.id === reviewId);
  appendAuditLog({ actor: "Support Lead", type: "Review Reply", tone: "primary", message: `Replied to review for ${updated.orderNo}`, meta: "Customer Care" });
  res.json(updated);
});

app.get("/api/receipts/export.csv", (_req, res) => {
  const rows = db.prepare(`
    SELECT
      o.order_no AS orderNo,
      c.name AS customerName,
      o.scheduled_date AS scheduledDate,
      o.status,
      o.amount
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    ORDER BY o.scheduled_date DESC, o.id DESC
  `).all();

  const csvLines = [
    "order_no,customer_name,scheduled_date,status,amount_vuv",
    ...rows.map((row) => [row.orderNo, row.customerName, row.scheduledDate, row.status, row.amount].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")),
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="receipts_export.csv"');
  res.send(csvLines.join("\n"));
});

app.post("/api/orders", (req, res) => {
  const {
    title,
    deviceName,
    customerName,
    customerPhone,
    customerEmail,
    technician,
    scheduledDate,
    amount,
    deposit,
    issueSummary,
    notes = "",
    imeiSerial,
    customerSignature,
    deviceFrontPhoto,
    deviceBackPhoto,
    customerPhoto,
    status = "pending",
  } = req.body;

  const normalizedDeviceName = String(deviceName ?? "").trim();
  const normalizedIssueSummary = String(issueSummary ?? "").trim();
  const generatedTitle = String(title ?? "").trim() || [normalizedDeviceName, normalizedIssueSummary].filter(Boolean).join(" · ") || "维修订单";

  if (!normalizedDeviceName || !customerName || !customerPhone || !customerEmail || !technician || !scheduledDate || !normalizedIssueSummary || !imeiSerial || !customerSignature || !deviceFrontPhoto || !deviceBackPhoto || !customerPhoto) {
    res.status(400).json({ message: "Missing required fields" });
    return;
  }

  const numericAmount = Number(amount ?? 0);
  const numericDeposit = Number(deposit ?? 0);
  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    res.status(400).json({ message: "Amount must be a valid number" });
    return;
  }

  if (!Number.isFinite(numericDeposit) || numericDeposit < 0) {
    res.status(400).json({ message: "Deposit must be a valid number" });
    return;
  }

  if (numericDeposit > numericAmount) {
    res.status(400).json({ message: "Deposit cannot exceed total amount" });
    return;
  }

  if (!statusMeta[status]) {
    res.status(400).json({ message: "Unsupported status" });
    return;
  }

  const orderNo = getNextOrderNo();
  const intakeCode = getNextIntakeCode();

  const intakePhotos = [
    { stage: "手机正面", imageUrl: String(deviceFrontPhoto).trim(), note: "建单时记录的设备正面照片。" },
    { stage: "手机背面", imageUrl: String(deviceBackPhoto).trim(), note: "建单时记录的设备背面照片。" },
    { stage: "客户照片", imageUrl: String(customerPhoto).trim(), note: "建单时记录的客户照片。" },
  ];

  if (intakePhotos.some((photo) => !photo.imageUrl)) {
    res.status(400).json({ message: "Order intake photos are required" });
    return;
  }

  const result = db.transaction(() => {
    const customerMatch = db.prepare(`
      SELECT id
      FROM customers
      WHERE lower(name) = lower(?)
        AND phone = ?
      LIMIT 1
    `).get(customerName.trim(), customerPhone.trim());

    let customerId = customerMatch?.id;

    if (!customerId) {
      customerId = db.prepare(`
        INSERT INTO customers (name, phone, email, tier)
        VALUES (?, ?, ?, 'standard')
      `).run(customerName.trim(), customerPhone.trim(), customerEmail.trim()).lastInsertRowid;
    } else {
      db.prepare("UPDATE customers SET email = ? WHERE id = ?").run(customerEmail.trim(), customerId);
    }

    const orderId = db.prepare(`
      INSERT INTO orders
      (order_no, title, device_name, status, customer_id, technician, scheduled_date, amount, deposit, issue_summary, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderNo,
      generatedTitle,
      normalizedDeviceName,
      status,
      customerId,
      technician.trim(),
      scheduledDate,
      numericAmount,
      Math.round(numericDeposit),
      normalizedIssueSummary,
      notes.trim(),
    ).lastInsertRowid;

    intakePhotos.forEach((photo) => {
      db.prepare(`
        INSERT INTO order_photos (order_id, stage, image_url, note)
        VALUES (?, ?, ?, ?)
      `).run(orderId, photo.stage, photo.imageUrl, photo.note);
    });

    db.prepare(`
      INSERT INTO order_intake (order_id, intake_code, imei_serial, customer_signature)
      VALUES (?, ?, ?, ?)
    `).run(orderId, intakeCode, String(imeiSerial).trim(), String(customerSignature).trim());

    return Number(orderId);
  })();

  const created = getOrderById(result);
  res.status(201).json(mapOrder(created));
});

app.post("/api/orders/:id/communication", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const rawBody = String(req.body?.body ?? "").trim();
  const sender = ["staff", "customer", "internal"].includes(req.body?.sender) ? req.body.sender : "staff";
  const type = sender === "internal" ? "note" : "text";

  if (!rawBody) {
    res.status(400).json({ message: "Message body is required" });
    return;
  }

  const result = db.prepare(`
    INSERT INTO order_messages (order_id, sender, type, body, meta_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(order.id, sender, type, rawBody, JSON.stringify({}));

  const created = db.prepare(`
    SELECT
      id,
      sender,
      type,
      body,
      meta_json AS metaJson,
      created_at AS createdAt
    FROM order_messages
    WHERE id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({
    id: `db-${created.id}`,
    sender: created.sender,
    type: created.type,
    body: created.body,
    time: formatChatTimestamp(created.createdAt),
    ...parseJson(created.metaJson, {}),
  });
  appendAuditLog({ actor: sender === "internal" ? "Internal Note" : "Technician", type: "Communication", tone: sender === "internal" ? "warning" : "primary", message: `Added communication to ${order.orderNo}`, meta: sender });
});

app.post("/api/orders/:id/parts", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!items.length) {
    res.status(400).json({ message: "At least one part is required" });
    return;
  }

  const normalizedItems = items.map((item) => ({
    partId: Number(item.partId),
    quantity: Number(item.quantity),
  })).filter((item) => Number.isInteger(item.partId) && Number.isInteger(item.quantity) && item.quantity > 0);

  if (!normalizedItems.length || normalizedItems.length !== items.length) {
    res.status(400).json({ message: "Invalid parts payload" });
    return;
  }

  const uniqueIds = [...new Set(normalizedItems.map((item) => item.partId))];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const partRows = db.prepare(`
    SELECT
      id,
      name,
      sku,
      stock,
      reorder_level AS reorderLevel,
      unit_price AS unitPrice
    FROM parts
    WHERE id IN (${placeholders})
  `).all(...uniqueIds);

  if (partRows.length !== uniqueIds.length) {
    res.status(404).json({ message: "One or more parts were not found" });
    return;
  }

  const partMap = new Map(partRows.map((row) => [row.id, row]));
  const stockRequirement = normalizedItems.reduce((acc, item) => {
    acc.set(item.partId, (acc.get(item.partId) ?? 0) + item.quantity);
    return acc;
  }, new Map());

  const insufficientPart = [...stockRequirement.entries()].find(([partId, quantity]) => (partMap.get(partId)?.stock ?? 0) < quantity);
  if (insufficientPart) {
    const [partId] = insufficientPart;
    res.status(400).json({ message: `${partMap.get(partId)?.name ?? "Part"} 库存不足` });
    return;
  }

  db.transaction(() => {
    let addedAmount = 0;

    normalizedItems.forEach((item) => {
      const part = partMap.get(item.partId);
      addedAmount += part.unitPrice * item.quantity;

      const existing = db.prepare(`
        SELECT id, quantity
        FROM order_parts
        WHERE order_id = ? AND part_id = ?
      `).get(order.id, item.partId);

      if (existing) {
        db.prepare(`
          UPDATE order_parts
          SET quantity = ?, unit_price = ?
          WHERE id = ?
        `).run(existing.quantity + item.quantity, part.unitPrice, existing.id);
      } else {
        db.prepare(`
          INSERT INTO order_parts (order_id, part_id, quantity, unit_price)
          VALUES (?, ?, ?, ?)
        `).run(order.id, item.partId, item.quantity, part.unitPrice);
      }

      db.prepare("UPDATE parts SET stock = stock - ? WHERE id = ?").run(item.quantity, item.partId);
      db.prepare(`
        INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
        VALUES (?, 'out', ?, ?)
      `).run(item.partId, item.quantity, `Allocated to order ${order.orderNo}`);
    });

    db.prepare("UPDATE orders SET amount = amount + ? WHERE id = ?").run(addedAmount, order.id);
  })();

  res.status(201).json({
    ok: true,
    order: {
      ...mapOrder(getOrderById(order.id)),
      parts: getOrderParts(order.id).map((part) => ({
        ...part,
        unitPriceFormatted: formatMoney(part.unitPrice),
        subtotalFormatted: formatMoney(part.subtotal),
      })),
    },
  });
  appendAuditLog({ actor: "Inventory Bot", type: "Stock Move", tone: "success", message: `Allocated parts to ${order.orderNo}`, meta: `Items: ${normalizedItems.length}` });
});

app.patch("/api/orders/:id/parts", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const normalizedItems = items
    .map((item) => ({
      partId: Number(item.partId),
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
    }))
    .filter((item) => Number.isInteger(item.partId) && Number.isInteger(item.quantity) && item.quantity > 0 && Number.isFinite(item.unitPrice) && item.unitPrice >= 0);

  if (!normalizedItems.length || normalizedItems.length !== items.length) {
    res.status(400).json({ message: "Invalid parts payload" });
    return;
  }

  const existingItems = getOrderParts(order.id);
  const existingMap = new Map(existingItems.map((item) => [item.id, item]));
  const nextPartIds = normalizedItems.map((item) => item.partId);

  if (nextPartIds.length !== existingItems.length || nextPartIds.some((partId) => !existingMap.has(partId))) {
    res.status(400).json({ message: "Only existing order parts can be edited here" });
    return;
  }

  db.transaction(() => {
    normalizedItems.forEach((item) => {
      db.prepare(`
        UPDATE order_parts
        SET quantity = ?, unit_price = ?
        WHERE order_id = ? AND part_id = ?
      `).run(item.quantity, Math.round(item.unitPrice), order.id, item.partId);
    });

    const refreshedParts = getOrderParts(order.id);
    const partsTotal = refreshedParts.reduce((sum, item) => sum + item.subtotal, 0);
    const laborTotal = Math.max(0, order.amount - existingItems.reduce((sum, item) => sum + item.subtotal, 0));
    db.prepare("UPDATE orders SET amount = ? WHERE id = ?").run(partsTotal + laborTotal, order.id);
  })();

  const updatedOrder = getOrderById(order.id);
  appendAuditLog({
    actor: updatedOrder.technician,
    type: "Parts Update",
    tone: "primary",
    message: `Updated parts pricing for ${updatedOrder.orderNo}`,
    meta: `Items: ${normalizedItems.length}`,
  });

  res.json({
    ok: true,
    order: {
      ...mapOrder(updatedOrder),
      parts: getOrderParts(order.id).map((part) => ({
        ...part,
        unitPriceFormatted: formatMoney(part.unitPrice),
        subtotalFormatted: formatMoney(part.subtotal),
      })),
    },
  });
});

app.delete("/api/orders/:id/parts/:partId", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const partId = Number(req.params.partId);
  if (!Number.isInteger(partId) || partId <= 0) {
    res.status(400).json({ message: "Invalid part id" });
    return;
  }

  const existing = db.prepare(`
    SELECT
      op.id,
      op.part_id AS partId,
      op.quantity,
      op.unit_price AS unitPrice,
      p.name,
      p.stock
    FROM order_parts op
    JOIN parts p ON p.id = op.part_id
    WHERE op.order_id = ? AND op.part_id = ?
  `).get(order.id, partId);

  if (!existing) {
    res.status(404).json({ message: "Order part not found" });
    return;
  }

  const currentParts = getOrderParts(order.id);
  const currentPartsTotal = currentParts.reduce((sum, item) => sum + item.subtotal, 0);
  const laborTotal = Math.max(0, order.amount - currentPartsTotal);

  db.transaction(() => {
    db.prepare("DELETE FROM order_parts WHERE order_id = ? AND part_id = ?").run(order.id, partId);
    db.prepare("UPDATE parts SET stock = stock + ? WHERE id = ?").run(existing.quantity, partId);
    db.prepare(`
      INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
      VALUES (?, 'in', ?, ?)
    `).run(partId, existing.quantity, `Returned from order ${order.orderNo}`);

    const refreshedParts = getOrderParts(order.id);
    const refreshedPartsTotal = refreshedParts.reduce((sum, item) => sum + item.subtotal, 0);
    db.prepare("UPDATE orders SET amount = ? WHERE id = ?").run(refreshedPartsTotal + laborTotal, order.id);
  })();

  const updatedOrder = getOrderById(order.id);
  appendAuditLog({
    actor: updatedOrder.technician,
    type: "Parts Removal",
    tone: "warning",
    message: `Removed ${existing.name} from ${updatedOrder.orderNo}`,
    meta: `Qty: ${existing.quantity}`,
  });

  res.json({
    ok: true,
    order: {
      ...mapOrder(updatedOrder),
      parts: getOrderParts(order.id).map((part) => ({
        ...part,
        unitPriceFormatted: formatMoney(part.unitPrice),
        subtotalFormatted: formatMoney(part.subtotal),
      })),
    },
  });
});

app.post("/api/orders/:id/completion/confirm", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const finalNotes = String(req.body?.finalNotes ?? order.notes ?? "").trim();
  const checklist = Array.isArray(req.body?.checklist) ? req.body.checklist : getDefaultCompletionChecklist(order);
  const normalizedChecklist = checklist.map((item) => ({
    id: String(item.id ?? ""),
    label: String(item.label ?? ""),
    checked: Boolean(item.checked),
  })).filter((item) => item.id && item.label);

  if (!normalizedChecklist.length) {
    res.status(400).json({ message: "Completion checklist is required" });
    return;
  }

  const warranty = String(req.body?.warranty ?? "Standard Warranty Applied").trim() || "Standard Warranty Applied";

  db.transaction(() => {
    db.prepare(`
      INSERT INTO order_completion (order_id, warranty, checklist_json, final_notes, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(order_id) DO UPDATE SET
        warranty = excluded.warranty,
        checklist_json = excluded.checklist_json,
        final_notes = excluded.final_notes,
        updated_at = CURRENT_TIMESTAMP
    `).run(order.id, warranty, JSON.stringify(normalizedChecklist), finalNotes);

    db.prepare(`
      UPDATE orders
      SET status = 'completed', notes = ?
      WHERE id = ?
    `).run(finalNotes, order.id);
  })();

  const updatedOrder = getOrderById(order.id);
  const completion = getOrderCompletionRecord(order.id);

  res.json({
    ok: true,
    order: mapOrder(updatedOrder),
    completion: {
      warranty: completion.warranty,
      checklist: parseJson(completion.checklistJson, normalizedChecklist),
      finalNotes: completion.finalNotes,
      updatedAt: completion.updatedAt,
    },
  });
  appendAuditLog({ actor: "Technician", type: "Completion", tone: "success", message: `Completed repair for ${updatedOrder.orderNo}`, meta: warranty });
});

app.post("/api/orders/:id/photo-upload", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
  const normalizedPhotos = photos
    .map((photo) => ({
      imageUrl: String(photo.imageUrl ?? photo.image ?? "").trim(),
      note: String(photo.note ?? "现场上传的维修照片。").trim(),
      stage: String(photo.stage ?? "维修后").trim() || "维修后",
    }))
    .filter((photo) => photo.imageUrl);

  if (!normalizedPhotos.length) {
    res.status(400).json({ message: "At least one photo is required" });
    return;
  }

  db.transaction(() => {
    normalizedPhotos.forEach((photo) => {
      db.prepare(`
        INSERT INTO order_photos (order_id, stage, image_url, note)
        VALUES (?, ?, ?, ?)
      `).run(order.id, photo.stage, photo.imageUrl, photo.note);
    });
  })();

  res.status(201).json({
    ok: true,
    count: normalizedPhotos.length,
    photos: getStoredPhotos(order.id),
  });
});

app.post("/api/orders/:id/receipt/print", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  db.prepare(`
    INSERT INTO receipt_meta (order_id, printed_at, picked_up_at)
    VALUES (?, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(order_id) DO UPDATE SET
      printed_at = CURRENT_TIMESTAMP
  `).run(order.id);

  res.json({
    ok: true,
    printedAt: new Date().toISOString(),
    message: `结算单 ${order.orderNo} 已标记为已打印`,
  });
});

app.post("/api/orders/:id/pickup", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  db.transaction(() => {
    db.prepare("UPDATE orders SET status = 'picked_up' WHERE id = ?").run(order.id);
    db.prepare(`
      INSERT INTO receipt_meta (order_id, printed_at, picked_up_at)
      VALUES (?, NULL, CURRENT_TIMESTAMP)
      ON CONFLICT(order_id) DO UPDATE SET
        picked_up_at = CURRENT_TIMESTAMP
    `).run(order.id);
  })();

  res.json({
    ok: true,
    status: "picked_up",
    message: `工单 ${order.orderNo} 已完成取机`,
  });
});

app.patch("/api/orders/:id/status", (req, res) => {
  const { status } = req.body;
  const order = getOrderById(req.params.id);

  if (!statusMeta[status]) {
    res.status(400).json({ message: "Unsupported status" });
    return;
  }

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, order.id);
  const updated = getOrderById(order.id);
  res.json(mapOrder(updated));
});

app.patch("/api/orders/:id", (req, res) => {
  const order = getOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const title = String(req.body?.title ?? order.title).trim();
  const technician = String(req.body?.technician ?? order.technician).trim();
  const scheduledDate = String(req.body?.scheduledDate ?? order.scheduledDate).trim();
  const issueSummary = String(req.body?.issueSummary ?? order.issueSummary).trim();
  const notes = String(req.body?.notes ?? order.notes).trim();
  const numericAmount = Number(req.body?.amount ?? order.amount);
  const numericDeposit = Number(req.body?.deposit ?? order.deposit ?? 0);
  const customerName = String(req.body?.customerName ?? order.customerName).trim();
  const customerPhone = String(req.body?.customerPhone ?? order.customerPhone).trim();
  const customerEmail = String(req.body?.customerEmail ?? order.customerEmail).trim();
  const imeiSerial = String(req.body?.imeiSerial ?? getOrderIntake(order.id)?.imeiSerial ?? "").trim();
  const customerSignature = String(req.body?.customerSignature ?? getOrderIntake(order.id)?.customerSignature ?? order.customerName).trim();
  const intakeCode = getOrderIntake(order.id)?.intakeCode ?? getNextIntakeCode();

  if (!title || !technician || !scheduledDate || !issueSummary || !customerName || !customerPhone || !customerEmail || !imeiSerial || !customerSignature) {
    res.status(400).json({ message: "Title, technician, scheduled date, customer and intake fields are required" });
    return;
  }

  if (!Number.isFinite(numericAmount) || numericAmount < 0) {
    res.status(400).json({ message: "Amount must be a valid number" });
    return;
  }

  if (!Number.isFinite(numericDeposit) || numericDeposit < 0) {
    res.status(400).json({ message: "Deposit must be a valid number" });
    return;
  }

  if (numericDeposit > numericAmount) {
    res.status(400).json({ message: "Deposit cannot exceed total amount" });
    return;
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE orders
      SET title = ?, technician = ?, scheduled_date = ?, amount = ?, deposit = ?, issue_summary = ?, notes = ?
      WHERE id = ?
    `).run(title, technician, scheduledDate, Math.round(numericAmount), Math.round(numericDeposit), issueSummary, notes, order.id);

    db.prepare(`
      UPDATE customers
      SET name = ?, phone = ?, email = ?
      WHERE id = ?
    `).run(customerName, customerPhone, customerEmail, order.customerId);

    db.prepare(`
      INSERT INTO order_intake (order_id, intake_code, imei_serial, customer_signature)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET
        imei_serial = excluded.imei_serial,
        customer_signature = excluded.customer_signature
    `).run(order.id, intakeCode, imeiSerial, customerSignature);
  })();

  const updated = getOrderById(order.id);
  appendAuditLog({
    actor: updated.technician,
    type: "Order Update",
    tone: "primary",
    message: `Updated order details for ${updated.orderNo}`,
    meta: "Detail Management",
  });

  res.json(mapOrder(updated));
});

app.get("/api/customers", (_req, res) => {
  const rows = db.prepare(`
    SELECT
      c.id,
      c.name,
      c.phone,
      c.email,
      c.tier,
      COUNT(o.id) AS orderCount,
      COALESCE(SUM(o.amount), 0) AS lifetimeValue
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    GROUP BY c.id
    ORDER BY lifetimeValue DESC, c.name ASC
  `).all();

  res.json(rows.map((row) => ({
    ...row,
    avatarPhoto: getCustomerAvatar(row.id),
    lifetimeValueFormatted: formatMoney(row.lifetimeValue),
  })));
});

app.get("/api/customers/:id", (req, res) => {
  const customer = db.prepare(`
    SELECT
      c.id,
      c.name,
      c.phone,
      c.email,
      c.tier,
      MIN(o.scheduled_date) AS registeredSince,
      COUNT(o.id) AS orderCount,
      COALESCE(SUM(o.amount), 0) AS lifetimeValue
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(req.params.id);

  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  const records = db.prepare(`
    SELECT
      o.id,
      o.order_no AS orderNo,
      o.title,
      o.device_name AS deviceName,
      o.status,
      o.scheduled_date AS scheduledDate,
      o.amount
    FROM orders o
    WHERE o.customer_id = ?
    ORDER BY o.scheduled_date DESC, o.id DESC
  `).all(req.params.id);

  res.json({
    ...customer,
    avatarPhoto: getCustomerAvatar(customer.id),
    address: customer.id % 2 === 0 ? "Lini Highway, Port Vila" : "Kumul Highway, Port Vila",
    registeredSince: customer.registeredSince ?? "2026-01-01",
    customerRank: customer.lifetimeValue >= 40000 ? "TOP 5%" : customer.lifetimeValue >= 15000 ? "TOP 20%" : "成长客户",
    lifetimeValueFormatted: formatMoney(customer.lifetimeValue),
    records: records.map((row) => ({
      ...row,
      title: sanitizeOrderTitle(row),
      amountFormatted: formatMoney(row.amount),
      statusMeta: statusMeta[row.status] ?? { label: row.status, tone: "neutral" },
    })),
  });
});

app.get("/api/customers/:id/history", (req, res) => {
  const customer = db.prepare(`
    SELECT
      c.id,
      c.name,
      COUNT(o.id) AS totalOrders,
      COALESCE(SUM(o.amount), 0) AS totalSpend,
      SUM(CASE WHEN o.status = 'completed' OR o.status = 'picked_up' THEN 1 ELSE 0 END) AS completedOrders
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(req.params.id);

  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  const records = db.prepare(`
    SELECT
      o.id,
      o.order_no AS orderNo,
      o.device_name AS deviceName,
      o.title,
      o.status,
      o.scheduled_date AS scheduledDate,
      o.amount
    FROM orders o
    WHERE o.customer_id = ?
    ORDER BY o.scheduled_date DESC, o.id DESC
  `).all(req.params.id);

  const followups = getFollowupRows(req.params.id);

  res.json({
    ...customer,
    avatarPhoto: getCustomerAvatar(customer.id),
    totalSpendFormatted: formatMoney(customer.totalSpend),
    followups,
    records: records.map((row) => ({
      ...row,
      title: sanitizeOrderTitle(row),
      amountFormatted: formatMoney(row.amount),
      statusMeta: statusMeta[row.status] ?? { label: row.status, tone: "neutral" },
      serviceTag: sanitizeOrderTitle(row),
    })),
  });
});

app.post("/api/customers/:id/followups", (req, res) => {
  const customerId = Number(req.params.id);
  const note = String(req.body?.note ?? "").trim();
  const channel = String(req.body?.channel ?? "phone").trim() || "phone";
  const orderId = req.body?.orderId ? Number(req.body.orderId) : null;

  if (!customerId || !note) {
    res.status(400).json({ message: "Follow-up note is required" });
    return;
  }

  const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId);
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  const result = db.prepare(`
    INSERT INTO customer_followups (customer_id, order_id, channel, note)
    VALUES (?, ?, ?, ?)
  `).run(customerId, orderId, channel, note);

  const created = getFollowupRows(customerId).find((row) => row.id === Number(result.lastInsertRowid));
  appendAuditLog({ actor: "Customer Care", type: "Follow-up", tone: "primary", message: `Logged follow-up for customer #${customerId}`, meta: channel });
  res.status(201).json(created);
});

app.get("/api/audit/logs", (_req, res) => {
  const rows = getAuditLogs();
  res.json({
    rows,
    count: rows.length,
  });
});

app.get("/api/notifications", (req, res) => {
  const filter = String(req.query.filter ?? "all");
  const rows = buildNotifications().filter((item) => (filter === "all" ? true : item.category === filter));
  res.json({
    rows,
    unreadCount: rows.filter((item) => !item.isRead).length,
  });
});

app.post("/api/notifications/read-all", (_req, res) => {
  const rows = buildNotifications();
  const insert = db.prepare(`
    INSERT INTO notification_reads (notification_id, read_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(notification_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
  `);
  const run = db.transaction(() => {
    rows.forEach((item) => insert.run(item.id));
  });
  run();
  res.json({ ok: true, count: rows.length });
});

app.post("/api/notifications/:id/read", (req, res) => {
  db.prepare(`
    INSERT INTO notification_reads (notification_id, read_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(notification_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
  `).run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/parts/movements", (req, res) => {
  const partId = Number(req.body?.partId);
  const movementType = String(req.body?.movementType ?? "in");
  const quantity = Number(req.body?.quantity);
  const note = String(req.body?.note ?? "").trim();

  if (!Number.isInteger(partId) || !Number.isInteger(quantity) || quantity <= 0) {
    res.status(400).json({ message: "Invalid movement payload" });
    return;
  }

  if (!["in", "out"].includes(movementType)) {
    res.status(400).json({ message: "Unsupported movement type" });
    return;
  }

  const part = getPartById(partId);
  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const nextStock = movementType === "in" ? part.stock + quantity : part.stock - quantity;
  if (nextStock < 0) {
    res.status(400).json({ message: "Insufficient stock for this movement" });
    return;
  }

  db.transaction(() => {
    db.prepare("UPDATE parts SET stock = ? WHERE id = ?").run(nextStock, partId);
    db.prepare(`
      INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
      VALUES (?, ?, ?, ?)
    `).run(partId, movementType, quantity, note || (movementType === "in" ? "Manual inbound registration" : "Manual outbound registration"));
  })();

  appendAuditLog({
    actor: "Inventory Manager",
    type: movementType === "in" ? "Inbound Registration" : "Outbound Registration",
    tone: movementType === "in" ? "success" : "warning",
    message: `${movementType === "in" ? "Added" : "Removed"} ${quantity} units for ${part.name}`,
    meta: note || part.sku,
  });

  res.status(201).json({
    ok: true,
    part: mapPart({ ...part, stock: nextStock }),
    movementType,
    quantity,
  });
});

app.post("/api/parts/:id/reorder", (req, res) => {
  const part = db.prepare(`
    SELECT
      id,
      name,
      sku,
      stock,
      reorder_level AS reorderLevel,
      unit_price AS unitPrice,
      supplier
    FROM parts
    WHERE id = ?
  `).get(req.params.id);

  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const quantity = Number(req.body?.quantity ?? Math.max(part.reorderLevel * 2, 1));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    res.status(400).json({ message: "Invalid reorder quantity" });
    return;
  }

  const procurementNo = getNextProcurementNo();
  db.prepare(`
    INSERT INTO procurements (procurement_no, supplier, part_id, quantity, unit_price, source_currency, source_unit_price, exchange_rate, shipping_fee, customs_fee, other_fee, status)
    VALUES (?, ?, ?, ?, ?, 'VUV', ?, 1, 0, 0, 0, '运输中')
  `).run(procurementNo, part.supplier, part.id, Math.round(quantity), part.unitPrice, part.unitPrice);

  appendAuditLog({ actor: "Inventory Manager", type: "Reorder", tone: "warning", message: `Created procurement ${procurementNo} for ${part.name}`, meta: part.supplier });

  res.status(201).json({
    ok: true,
    procurementNo,
    supplier: part.supplier,
    quantity: Math.round(quantity),
    amountFormatted: formatMoney(Math.round(quantity) * part.unitPrice),
  });
});

app.get("/api/search", (req, res) => {
  const query = String(req.query.query ?? "").trim();
  const scope = String(req.query.scope ?? "all");

  if (!query) {
    res.json({ orders: [], parts: [], customers: [] });
    return;
  }

  const like = `%${query}%`;
  const orders = scope === "parts"
    ? []
    : db.prepare(`
      SELECT
        o.id,
        o.order_no AS orderNo,
        o.device_name AS deviceName,
        o.title,
        o.status,
        o.amount,
        c.name AS customerName
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_intake oi ON oi.order_id = o.id
      WHERE o.order_no LIKE ? OR o.device_name LIKE ? OR o.title LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR oi.imei_serial LIKE ?
      ORDER BY o.id DESC
      LIMIT 8
    `).all(like, like, like, like, like, like).map((row) => ({
      ...row,
      amountFormatted: formatMoney(row.amount),
      link: `/orders/${row.orderNo ?? row.id}`,
    }));

  const parts = scope === "orders"
    ? []
    : db.prepare(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS reorderLevel,
        unit_price AS unitPrice
      FROM parts
      WHERE sku LIKE ? OR name LIKE ?
      ORDER BY stock ASC, name ASC
      LIMIT 8
    `).all(like, like).map((row) => ({
      ...mapPart(row),
      link: `/parts/${row.id}`,
    }));

  const customers = scope === "parts"
    ? []
    : db.prepare(`
      SELECT
        id,
        name,
        phone,
        email
      FROM customers
      WHERE name LIKE ? OR phone LIKE ? OR email LIKE ?
      ORDER BY id DESC
      LIMIT 8
    `).all(like, like, like).map((row) => ({
      ...row,
      link: `/customers/${row.id}`,
    }));

  res.json({ orders, parts, customers });
});

app.get("/api/parts", (_req, res) => {
  const rows = db.prepare(`
    SELECT
      id,
      name,
      sku,
      stock,
      reorder_level AS reorderLevel,
      unit_price AS unitPrice,
      supplier
    FROM parts
    ORDER BY stock ASC, name ASC
  `).all();

  res.json(rows.map(mapPart));
});

app.get("/api/parts/:id", (req, res) => {
  const part = db.prepare(`
    SELECT
      id,
      name,
      sku,
      stock,
      reorder_level AS reorderLevel,
      unit_price AS unitPrice,
      cost_price AS costPrice,
      supplier
    FROM parts
    WHERE id = ?
  `).get(req.params.id);

  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const movementHistory = db.prepare(`
    SELECT
      id,
      movement_type AS movementType,
      quantity,
      note,
      created_at AS createdAt
    FROM inventory_movements
    WHERE part_id = ?
    ORDER BY id DESC
    LIMIT 8
  `).all(req.params.id);

  const orderUsage = db.prepare(`
    SELECT
      o.id,
      o.order_no AS orderNo,
      o.device_name AS deviceName,
      o.scheduled_date AS scheduledDate,
      op.quantity,
      op.quantity * op.unit_price AS totalAmount
    FROM order_parts op
    JOIN orders o ON o.id = op.order_id
    WHERE op.part_id = ?
    ORDER BY o.scheduled_date DESC, o.id DESC
  `).all(req.params.id);

  const recentProcurements = db.prepare(`
    SELECT
      procurement_no AS procurementNo,
      supplier,
      quantity,
      unit_price AS unitPrice,
      source_currency AS sourceCurrency,
      source_unit_price AS sourceUnitPrice,
      exchange_rate AS exchangeRate,
      shipping_fee AS shippingFee,
      customs_fee AS customsFee,
      other_fee AS otherFee,
      status,
      created_at AS createdAt
    FROM procurements
    WHERE part_id = ?
    ORDER BY id DESC
    LIMIT 5
  `).all(req.params.id);

  const inboundBatchHistory = db.prepare(`
    SELECT
      ib.batch_no AS batchNo,
      ibi.quantity,
      ibi.supplier_name AS supplierName,
      ibi.source_unit_price AS sourceUnitPrice,
      ibi.landed_unit_cost AS landedUnitCost,
      ib.source_currency AS sourceCurrency,
      ib.exchange_rate AS exchangeRate,
      ib.shipping_fee AS shippingFee,
      ib.customs_fee AS customsFee,
      ib.declaration_fee AS declarationFee,
      ib.other_fee AS otherFee,
      ib.created_at AS createdAt
    FROM inbound_batch_items ibi
    JOIN inbound_batches ib ON ib.id = ibi.batch_id
    WHERE ibi.part_id = ?
    ORDER BY ibi.id DESC
    LIMIT 10
  `).all(req.params.id);
  const supplierId = getSuppliers().find((item) => item.name === part.supplier)?.id ?? "SUP-1";

  res.json({
    ...mapPart(part),
    supplierId,
    location: `Rack A-${String(part.id).padStart(2, "0")}-0${(Number(part.id) % 5) + 1}`,
    stockTurnover: `${(1 + Number(part.stock) / Math.max(part.reorderLevel, 1)).toFixed(1)}x`,
    stockStatus: Number(part.stock) <= Number(part.reorderLevel) ? "低库存" : "库存充足",
    movementHistory,
    recentProcurements: recentProcurements.map((row) => ({
      ...row,
      supplierId,
      unitPriceFormatted: formatMoney(row.unitPrice),
      landedUnitCostFormatted: formatMoney(row.unitPrice),
    })),
    inboundBatchHistory: inboundBatchHistory.map((row) => ({
      ...row,
      sourceUnitPriceFormatted: row.sourceCurrency === "CNY" ? formatCny(row.sourceUnitPrice) : formatMoney(row.sourceUnitPrice),
      landedUnitCostFormatted: formatMoney(row.landedUnitCost),
      shippingFeeFormatted: formatMoney(row.shippingFee),
      customsFeeFormatted: formatMoney(row.customsFee),
      declarationFeeFormatted: formatMoney(row.declarationFee),
      otherFeeFormatted: formatMoney(row.otherFee),
      createdLabel: formatChatTimestamp(row.createdAt),
    })),
    orderUsage: orderUsage.map((row) => ({
      ...row,
      totalAmountFormatted: formatMoney(row.totalAmount),
    })),
  });
});

app.patch("/api/parts/:id", (req, res) => {
  const id = Number(req.params.id);
  const current = getPartById(id);

  if (!current) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const reorderLevel = Number(req.body?.reorderLevel ?? current.reorderLevel);
  const unitPrice = Number(req.body?.unitPrice ?? current.unitPrice);
  const supplier = String(req.body?.supplier ?? current.supplier ?? "").trim();

  if (!Number.isInteger(reorderLevel) || reorderLevel < 0 || !Number.isFinite(unitPrice) || unitPrice < 0 || !supplier) {
    res.status(400).json({ message: "Invalid part settings payload" });
    return;
  }

  db.prepare(`
    UPDATE parts
    SET reorder_level = ?, unit_price = ?, supplier = ?
    WHERE id = ?
  `).run(reorderLevel, Math.round(unitPrice), supplier, id);

  const updated = getPartById(id);
  appendAuditLog({
    actor: "Inventory Manager",
    type: "Part Settings",
    tone: "primary",
    message: `Updated inventory settings for ${updated.name}`,
    meta: `Threshold ${reorderLevel} · ${supplier}`,
  });

  res.json(mapPart(updated));
});

app.get("/api/suppliers/:id", (req, res) => {
  const supplier = getSupplierById(req.params.id);

  if (!supplier) {
    res.status(404).json({ message: "Supplier not found" });
    return;
  }

  res.json(supplier);
});

app.get("/api/suppliers", (_req, res) => {
  const suppliers = getSuppliers();
  const history = getSupplierHistory();

  res.json({
    metrics: {
      totalSuppliers: suppliers.length,
      pendingOrders: history.filter((item) => item.status !== '已交付').length,
      procurementValueFormatted: formatMoney(suppliers.reduce((sum, item) => sum + item.procurementValue, 0)),
      onTimeRate: '98%',
    },
    suppliers,
    history,
  });
});

app.get("/api/procurements/:id", (req, res) => {
  const procurement = getProcurementById(req.params.id);

  if (!procurement) {
    res.status(404).json({ message: "Procurement order not found" });
    return;
  }

  res.json(procurement);
});

app.patch("/api/procurements/:id/costing", (req, res) => {
  const procurement = db.prepare(`
    SELECT
      procurement_no AS procurementNo,
      part_id AS partId,
      quantity
    FROM procurements
    WHERE procurement_no = ?
  `).get(req.params.id);

  if (!procurement) {
    res.status(404).json({ message: "Procurement order not found" });
    return;
  }

  const sourceCurrency = String(req.body?.sourceCurrency ?? "CNY").trim().toUpperCase();
  const sourceUnitPrice = Number(req.body?.sourceUnitPrice ?? 0);
  const exchangeRate = Number(req.body?.exchangeRate ?? 1);
  const shippingFee = Number(req.body?.shippingFee ?? 0);
  const customsFee = Number(req.body?.customsFee ?? 0);
  const otherFee = Number(req.body?.otherFee ?? 0);

  if (!["CNY", "VUV"].includes(sourceCurrency) || !Number.isFinite(sourceUnitPrice) || sourceUnitPrice < 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0 || !Number.isFinite(shippingFee) || shippingFee < 0 || !Number.isFinite(customsFee) || customsFee < 0 || !Number.isFinite(otherFee) || otherFee < 0) {
    res.status(400).json({ message: "Invalid procurement costing payload" });
    return;
  }

  const costing = calculateProcurementCosting({
    quantity: procurement.quantity,
    sourceUnitPrice,
    exchangeRate,
    shippingFee,
    customsFee,
    otherFee,
  });

  db.transaction(() => {
    db.prepare(`
      UPDATE procurements
      SET source_currency = ?, source_unit_price = ?, exchange_rate = ?, shipping_fee = ?, customs_fee = ?, other_fee = ?, unit_price = ?
      WHERE procurement_no = ?
    `).run(
      sourceCurrency,
      sourceUnitPrice,
      exchangeRate,
      costing.shippingFee,
      costing.customsFee,
      costing.otherFee,
      costing.landedUnitCost,
      procurement.procurementNo,
    );

    db.prepare(`
      UPDATE parts
      SET cost_price = ?
      WHERE id = ?
    `).run(costing.landedUnitCost, procurement.partId);
  })();

  appendAuditLog({
    actor: "Inventory Manager",
    type: "Costing",
    tone: "primary",
    message: `Updated landed cost for ${procurement.procurementNo}`,
    meta: `${sourceCurrency} ${sourceUnitPrice} · ${costing.landedUnitCostFormatted}/件`,
  });

  res.json(getProcurementById(procurement.procurementNo));
});

app.post("/api/procurements/:id/receive", (req, res) => {
  const procurement = db.prepare(`
    SELECT
      procurement_no AS procurementNo,
      supplier,
      part_id AS partId,
      quantity,
      unit_price AS unitPrice,
      source_currency AS sourceCurrency,
      source_unit_price AS sourceUnitPrice,
      exchange_rate AS exchangeRate,
      shipping_fee AS shippingFee,
      customs_fee AS customsFee,
      other_fee AS otherFee,
      status
    FROM procurements
    WHERE procurement_no = ?
  `).get(req.params.id);

  if (!procurement) {
    res.status(404).json({ message: "Procurement order not found" });
    return;
  }

  if (procurement.status === "已交付") {
    res.json({
      ok: true,
      alreadyReceived: true,
      procurementNo: procurement.procurementNo,
      part: mapPart(getPartById(procurement.partId)),
    });
    return;
  }

  const updatedPart = db.transaction(() => {
    const currentPart = getPartById(procurement.partId);
    const costing = calculateProcurementCosting({
      quantity: procurement.quantity,
      sourceUnitPrice: procurement.sourceUnitPrice || procurement.unitPrice,
      exchangeRate: procurement.exchangeRate || 1,
      shippingFee: procurement.shippingFee || 0,
      customsFee: procurement.customsFee || 0,
      otherFee: procurement.otherFee || 0,
    });
    db.prepare("UPDATE procurements SET status = '已交付' WHERE procurement_no = ?").run(procurement.procurementNo);
    db.prepare("UPDATE parts SET stock = stock + ?, cost_price = ? WHERE id = ?").run(procurement.quantity, costing.landedUnitCost, procurement.partId);
    db.prepare(`
      INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
      VALUES (?, 'in', ?, ?)
    `).run(procurement.partId, procurement.quantity, `Procurement received ${procurement.procurementNo}`);
    return mapPart({ ...currentPart, stock: currentPart.stock + procurement.quantity, costPrice: costing.landedUnitCost });
  })();

  appendAuditLog({
    actor: "Warehouse Clerk",
    type: "Procurement",
    tone: "success",
    message: `Received ${procurement.procurementNo} into stock`,
    meta: procurement.supplier,
  });

  res.json({
    ok: true,
    procurementNo: procurement.procurementNo,
    part: updatedPart,
  });
});

app.post("/api/inventory/adjustments", (req, res) => {
  const {
    partId,
    adjustmentType = "scrap",
    quantity,
    unit = "PCS",
    note = "",
    operator = "Jean-Pierre Kalot",
    source = "manual",
  } = req.body;

  const numericQuantity = Number(quantity);
  if (!partId || !Number.isInteger(numericQuantity) || numericQuantity <= 0) {
    res.status(400).json({ message: "Invalid adjustment payload" });
    return;
  }

  const part = getPartById(partId);
  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const nextStock = part.stock - numericQuantity;
  if (nextStock < 0) {
    res.status(400).json({ message: "Insufficient stock for this adjustment" });
    return;
  }

  const adjustmentId = db.transaction(() => {
    db.prepare("UPDATE parts SET stock = ? WHERE id = ?").run(nextStock, partId);
      db.prepare(`
        INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
        VALUES (?, 'out', ?, ?)
      `).run(partId, numericQuantity, `${source === "requisition" ? "Requisition" : source === "loss" ? "Loss" : "Adjustment"} · ${adjustmentType} · ${note.trim()}`.trim());

    return Number(db.prepare(`
      INSERT INTO inventory_adjustments (part_id, adjustment_type, quantity, unit, note, operator, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(partId, adjustmentType, numericQuantity, unit, note.trim(), operator.trim(), source).lastInsertRowid);
  })();

    appendAuditLog({
      actor: operator.trim(),
      type: source === "requisition" ? "Requisition" : source === "loss" ? "Loss" : "Adjustment",
      tone: "warning",
      message: `${part.name} adjusted by ${numericQuantity} ${unit}`,
      meta: adjustmentType,
    });

  res.status(201).json({
    ok: true,
    adjustmentId,
    part: mapPart(getPartById(partId)),
  });
});

app.get("/api/inventory/loss-records", (_req, res) => {
  const rows = db.prepare(`
    SELECT
      ia.id,
      ia.adjustment_type AS adjustmentType,
      ia.quantity,
      ia.unit,
      ia.note,
      ia.operator,
      ia.source,
      ia.created_at AS createdAt,
      p.id AS partId,
      p.name AS partName,
      p.sku,
      p.unit_price AS unitPrice,
      p.cost_price AS costPrice
    FROM inventory_adjustments ia
    JOIN parts p ON p.id = ia.part_id
    WHERE ia.source = 'loss' OR ia.adjustment_type = 'scrap'
    ORDER BY ia.id DESC
    LIMIT 50
  `).all();

  res.json(rows.map((row) => ({
    ...row,
    unitPriceFormatted: formatMoney(row.unitPrice),
    costPriceFormatted: formatMoney(row.costPrice ?? 0),
    totalLossAmount: row.quantity * (row.costPrice || row.unitPrice || 0),
    totalLossAmountFormatted: formatMoney(row.quantity * (row.costPrice || row.unitPrice || 0)),
    createdLabel: formatChatTimestamp(row.createdAt),
  })));
});

app.post("/api/inventory/audit-session", (req, res) => {
  const {
    operator = "Aiden",
    items = [],
  } = req.body ?? {};

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: "Audit items are required" });
    return;
  }

  const normalizedItems = items
    .map((item) => ({
      partId: Number(item.partId),
      actualStock: Number(item.actualStock),
    }))
    .filter((item) => Number.isInteger(item.partId) && Number.isInteger(item.actualStock) && item.actualStock >= 0);

  if (normalizedItems.length === 0) {
    res.status(400).json({ message: "Invalid audit items" });
    return;
  }

  const sessionNo = getNextAuditSessionNo();
  const discrepancies = [];

  db.transaction(() => {
    normalizedItems.forEach((item) => {
      const part = getPartById(item.partId);
      if (!part) {
        return;
      }

      const discrepancy = item.actualStock - part.stock;
      db.prepare(`
        INSERT INTO inventory_audits (session_no, part_id, system_stock, actual_stock, discrepancy, operator)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(sessionNo, item.partId, part.stock, item.actualStock, discrepancy, operator.trim());

      if (discrepancy !== 0) {
        db.prepare("UPDATE parts SET stock = ? WHERE id = ?").run(item.actualStock, item.partId);
        db.prepare(`
          INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
          VALUES (?, ?, ?, ?)
        `).run(
          item.partId,
          discrepancy > 0 ? "in" : "out",
          Math.abs(discrepancy),
          `Audit ${sessionNo} reconciliation`,
        );
        discrepancies.push({
          partId: item.partId,
          partName: part.name,
          discrepancy,
        });
      }
    });
  })();

  appendAuditLog({
    actor: operator.trim(),
    type: "Audit",
    tone: discrepancies.length ? "warning" : "success",
    message: `Completed audit session ${sessionNo}`,
    meta: discrepancies.length ? `${discrepancies.length} discrepancies reconciled` : "No discrepancies",
  });

  res.status(201).json({
    ok: true,
    sessionNo,
    discrepancies,
  });
});

app.post("/api/parts/movements", (req, res) => {
  const { partId, movementType, quantity, note = "" } = req.body;
  const numericQuantity = Number(quantity);

  if (!partId || !["in", "out"].includes(movementType) || !Number.isInteger(numericQuantity) || numericQuantity <= 0) {
    res.status(400).json({ message: "Invalid movement payload" });
    return;
  }

  const part = getPartById(partId);
  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const nextStock = movementType === "in" ? part.stock + numericQuantity : part.stock - numericQuantity;
  if (nextStock < 0) {
    res.status(400).json({ message: "Insufficient stock for outbound movement" });
    return;
  }

  const result = db.transaction(() => {
    db.prepare("UPDATE parts SET stock = ? WHERE id = ?").run(nextStock, partId);
    const movementId = db.prepare(`
      INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
      VALUES (?, ?, ?, ?)
    `).run(partId, movementType, numericQuantity, note.trim()).lastInsertRowid;

    return Number(movementId);
  })();

  const movement = db.prepare(`
    SELECT
      m.id,
      m.part_id AS partId,
      p.name AS partName,
      p.sku,
      m.movement_type AS movementType,
      m.quantity,
      m.note,
      m.created_at AS createdAt
    FROM inventory_movements m
    JOIN parts p ON p.id = m.part_id
    WHERE m.id = ?
  `).get(result);

  res.status(201).json({
    movement,
    part: mapPart(getPartById(partId)),
  });
});

app.get("/api/inventory-movements", (_req, res) => {
  res.json(getRecentMovements());
});

app.post("/api/inventory/inbound-batch", (req, res) => {
  const sourceCurrency = String(req.body?.sourceCurrency ?? "VUV").trim().toUpperCase();
  const exchangeRate = Math.max(0.000001, Number(req.body?.exchangeRate ?? 1) || 1);
  const shippingFee = Math.max(0, Math.round(Number(req.body?.shippingFee ?? 0) || 0));
  const customsFee = Math.max(0, Math.round(Number(req.body?.customsFee ?? 0) || 0));
  const declarationFee = Math.max(0, Math.round(Number(req.body?.declarationFee ?? 0) || 0));
  const otherFee = Math.max(0, Math.round(Number(req.body?.otherFee ?? 0) || 0));
  const note = String(req.body?.note ?? "").trim();
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  if (!["CNY", "VUV"].includes(sourceCurrency)) {
    res.status(400).json({ message: "Unsupported source currency" });
    return;
  }

  const normalizedItems = rawItems
    .map((item) => ({
      partId: Number(item?.partId),
      quantity: Math.round(Number(item?.quantity)),
      sourceUnitPrice: Math.max(0, Number(item?.sourceUnitPrice ?? 0) || 0),
      supplierName: String(item?.supplierName ?? "").trim(),
    }))
    .filter((item) => Number.isInteger(item.partId) && Number.isInteger(item.quantity) && item.quantity > 0 && item.sourceUnitPrice >= 0);

  if (!normalizedItems.length) {
    res.status(400).json({ message: "At least one inbound item is required" });
    return;
  }

  const itemsWithParts = normalizedItems.map((item) => {
    const part = getPartById(item.partId);
    if (!part) return null;
    const purchaseValueVuv = Math.round(item.sourceUnitPrice * item.quantity * (sourceCurrency === "CNY" ? exchangeRate : 1));
    return {
      ...item,
      part,
      purchaseValueVuv,
    };
  });

  if (itemsWithParts.some((item) => !item)) {
    res.status(404).json({ message: "One or more parts were not found" });
    return;
  }

  const safeItems = itemsWithParts;
  const totalExtraFees = shippingFee + customsFee + declarationFee + otherFee;
  const allocatedExtras = allocateBatchExtraFees(safeItems, totalExtraFees);
  const batchNo = getNextInboundBatchNo();

  const responsePayload = db.transaction(() => {
    const batchId = Number(db.prepare(`
      INSERT INTO inbound_batches (
        batch_no,
        source_currency,
        exchange_rate,
        shipping_fee,
        customs_fee,
        declaration_fee,
        other_fee,
        note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(batchNo, sourceCurrency, exchangeRate, shippingFee, customsFee, declarationFee, otherFee, note).lastInsertRowid);

    const savedItems = safeItems.map((item, index) => {
      const allocatedExtra = allocatedExtras[index] ?? 0;
      const totalLandedCost = item.purchaseValueVuv + allocatedExtra;
      const landedUnitCost = Math.round(totalLandedCost / item.quantity);
      const supplierName = item.supplierName || item.part.supplier || "";

      db.prepare(`
        INSERT INTO inbound_batch_items (
          batch_id,
          part_id,
          quantity,
          supplier_name,
          source_unit_price,
          landed_unit_cost
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(batchId, item.partId, item.quantity, supplierName, item.sourceUnitPrice, landedUnitCost);

      db.prepare(`
        UPDATE parts
        SET
          stock = stock + ?,
          cost_price = ?,
          supplier = CASE WHEN ? != '' THEN ? ELSE supplier END
        WHERE id = ?
      `).run(item.quantity, landedUnitCost, supplierName, supplierName, item.partId);

      db.prepare(`
        INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
        VALUES (?, 'in', ?, ?)
      `).run(
        item.partId,
        item.quantity,
        `Inbound Batch ${batchNo} · ${sourceCurrency} ${item.sourceUnitPrice}/件 · 快递 ${Math.round(allocatedExtra > 0 ? shippingFee * (item.purchaseValueVuv / Math.max(safeItems.reduce((sum, row) => sum + row.purchaseValueVuv, 0), 1)) : 0)} · 落地 ${formatMoney(landedUnitCost)}/件`,
      );

      return {
        partId: item.partId,
        partName: item.part.name,
        quantity: item.quantity,
        supplierName,
        sourceUnitPrice: item.sourceUnitPrice,
        sourceUnitPriceFormatted: sourceCurrency === "CNY" ? formatCny(item.sourceUnitPrice) : formatMoney(item.sourceUnitPrice),
        purchaseValueVuv: item.purchaseValueVuv,
        purchaseValueVuvFormatted: formatMoney(item.purchaseValueVuv),
        allocatedExtra,
        allocatedExtraFormatted: formatMoney(allocatedExtra),
        landedUnitCost,
        landedUnitCostFormatted: formatMoney(landedUnitCost),
        totalLandedCost,
        totalLandedCostFormatted: formatMoney(totalLandedCost),
      };
    });

    return {
      batchNo,
      sourceCurrency,
      exchangeRate,
      shippingFee,
      customsFee,
      declarationFee,
      otherFee,
      totalExtraFees,
      totalExtraFeesFormatted: formatMoney(totalExtraFees),
      note,
      items: savedItems,
      parts: savedItems.map((item) => mapPart(getPartById(item.partId))),
    };
  })();

  appendAuditLog({
    actor: "Warehouse Clerk",
    type: "Inbound Batch",
    tone: "success",
    message: `Recorded inbound batch ${batchNo}`,
    meta: `${responsePayload.items.length} 项 · ${responsePayload.totalExtraFeesFormatted}`,
  });

  res.status(201).json(responsePayload);
});

app.get("/api/staff/performance", (_req, res) => {
  const rows = getStaffPerformanceRows();
  res.json({
    rows,
    topPerformer: rows[0] ?? null,
  });
});

app.get("/api/finance/report", (req, res) => {
  const type = String(req.query.type ?? "all");
  const base = getFinanceReport();

  const rows = type === "income"
    ? base.rows.filter((row) => row.amount >= 0)
    : type === "expense"
      ? base.rows.filter((row) => row.amount < 0)
      : base.rows;

  res.json({
    ...base,
    selectedType: type,
    rows,
  });
});

if (process.env.DISABLE_STATIC_FRONTEND !== "true") {
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
    const requestedFilePath = path.resolve(frontendDistPath, `.${req.path}`);

    if (
      requestedFilePath.startsWith(frontendDistPath)
      && fs.existsSync(requestedFilePath)
      && fs.statSync(requestedFilePath).isFile()
    ) {
      res.sendFile(requestedFilePath);
      return;
    }

    res.sendFile(path.join(frontendDistPath, "index.html"));
  });
}

function startStandaloneServer() {
  const port = Number(process.env.PORT ?? 4100);
  const host = process.env.HOST ?? "0.0.0.0";
  const enableHttps = process.env.ENABLE_HTTPS !== "false";

  if (enableHttps) {
    const { key, cert, hosts } = ensureHttpsCertificate();

    https.createServer({ key, cert }, app).listen(port, host, () => {
      const preferredHosts = hosts
        .filter((value) => value === "localhost" || value === "127.0.0.1" || value.startsWith("192.168."))
        .slice(0, 6);

      console.log(`Stitch backend listening on https://${host}:${port}`);
      console.log(`HTTPS available at: ${preferredHosts.map((value) => `https://${value}:${port}`).join(", ")}`);
    });

    const redirectPort = Number(process.env.HTTP_REDIRECT_PORT ?? 4080);
    http.createServer((req, res) => {
      const requestHost = String(req.headers.host ?? `${host}:${port}`).replace(/:\d+$/, "");
      const redirectTarget = `https://${requestHost}:${port}${req.url ?? "/"}`;

      res.writeHead(301, { Location: redirectTarget });
      res.end();
    }).listen(redirectPort, host, () => {
      console.log(`HTTP redirect listening on http://${host}:${redirectPort}`);
    });
  } else {
    app.listen(port, host, () => {
      console.log(`Stitch backend listening on http://${host}:${port}`);
    });
  }
}

if (blobPersistenceEnabled) {
  queueDatabaseSnapshot("startup");
}

if (!isVercelRuntime) {
  startStandaloneServer();
}

export default app;

