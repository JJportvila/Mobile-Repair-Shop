import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import pg from "pg";
import selfsigned from "selfsigned";
import {
  buildPgOrderFilters,
  calculateProcurementCosting,
  formatChatTimestamp,
  formatCny,
  formatMoney,
  getTodayDateKey,
  parseJson,
  toNumber,
} from "./shared/common.js";
import {
  diffMinutesFromNow,
  formatElapsedMinutes,
  queuePriorityForOrder,
  queueProgressByStatus,
  sanitizeIssueSummary,
  sanitizeOrderTitle,
} from "./shared/order-display.js";
import {
  allocateBatchExtraFees,
  getDefaultCommunicationMessages,
  getDefaultCompletionChecklist,
  getDefaultExecutionChecklist,
  getDefaultUploadPhotos,
  getExecutionPhaseLabel,
  getOrderTimeline,
  normalizeCompletionChecklist,
  normalizeExecutionChecklist,
} from "./shared/order-workflow.js";
import {
  pgCreateOrderFormBrand,
  pgCreateOrderFormIssue,
  pgCreateOrderFormModel,
  pgCreateOrderFormTechnician,
  pgCreateStaffPermission,
  pgDeleteOrderFormOption,
  pgDeleteStaffPermission,
  pgGetBusinessHoursSettings,
  pgGetLanguageSettings,
  pgGetOrderFormOptionsInternal,
  pgGetPrintSettings,
  pgGetStaffPermissionSettings,
  pgGetStoreSettings,
  pgUpdateBusinessHoursSettings,
  pgUpdateLanguageSettings,
  pgUpdateOrderFormOption,
  pgUpdatePrintSettings,
  pgUpdateReorderSettings,
  pgUpdateStaffPermission,
  pgUpdateStoreSettings,
} from "./shared/settings.js";
import { createProcurementModels } from "./shared/procurement-models.js";
import { createSystemModels } from "./shared/system-models.js";
import { createReadModels } from "./shared/read-models.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const frontendDistPath = path.resolve(backendRoot, "..", "frontend", "dist");
const certsDir = path.resolve(backendRoot, "certs");
const httpsKeyPath = path.resolve(certsDir, "localhost-key.pem");
const httpsCertPath = path.resolve(certsDir, "localhost-cert.pem");
const isVercelRuntime = Boolean(process.env.VERCEL);
const usePostgresRuntime = Boolean(process.env.DATABASE_URL);

const { Pool } = pg;
const allowedOrigins = (process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!usePostgresRuntime) {
  throw new Error("DATABASE_URL is required. SQLite compatibility mode has been removed.");
}

const pgPool = usePostgresRuntime
  ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  })
  : null;

async function pgQuery(text, params = []) {
  if (!pgPool) {
    throw new Error("Postgres runtime is not configured");
  }

  const result = await pgPool.query(text, params);
  return result.rows;
}

async function pgOne(text, params = []) {
  const rows = await pgQuery(text, params);
  return rows[0] ?? null;
}

async function pgWithTransaction(callback) {
  if (!pgPool) {
    throw new Error("Postgres runtime is not configured");
  }

  const client = await pgPool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

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

app.use(express.json());

let procurementModels;
const readModels = createReadModels({
  pgOne,
  pgQuery,
  pgGetSuppliers: (...args) => procurementModels.pgGetSuppliers(...args),
});
procurementModels = createProcurementModels({
  pgOne,
  pgQuery,
  formatChatTimestamp,
  formatMoney,
  toNumber,
  calculateProcurementCosting,
  readModels,
});
const {
  pgGetSuppliers,
  pgGetSupplierHistory,
  pgGetSupplierById,
  pgGetProcurementById,
} = procurementModels;
const {
  pgGetNextProcurementNo,
  pgGetNextInboundBatchNo,
  pgGetNextAuditSessionNo,
  pgGetNextIntakeCode,
  pgGetNextOrderNo,
  pgGetRefundRows,
  pgGetReviewRows,
  appendAuditLog,
  buildSimplePdf,
  pgGetAuditLogs,
  pgBuildNotifications,
} = createSystemModels({
  pgQuery,
  formatChatTimestamp,
  formatMoney,
  getTodayDateKey,
  toNumber,
  readModels,
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get("/api/order-form-options", async (_req, res) => {
  res.json(await pgGetOrderFormOptionsInternal(pgQuery, false));
});

app.get("/api/order-form-options/admin", async (_req, res) => {
  res.json(await pgGetOrderFormOptionsInternal(pgQuery, true));
});

app.get("/api/settings/store", async (_req, res) => {
  res.json(await pgGetStoreSettings(pgOne));
});

app.patch("/api/settings/store", async (req, res) => {
  const result = await pgUpdateStoreSettings(pgQuery, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Store Settings", message: `Updated store settings for ${result.storeName}`, meta: "Settings" });
  res.json(result.data);
});

app.get("/api/settings/business-hours", async (_req, res) => {
  res.json(await pgGetBusinessHoursSettings(pgQuery, pgOne));
});

app.get("/api/settings/language", async (_req, res) => {
  res.json(await pgGetLanguageSettings(pgOne));
});

app.patch("/api/settings/language", async (req, res) => {
  const result = await pgUpdateLanguageSettings(pgQuery, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Language Settings", message: "Updated language settings", meta: result.primaryLanguage });
  res.json(result.data);
});

app.get("/api/settings/print", async (_req, res) => {
  res.json(await pgGetPrintSettings(pgOne));
});

app.patch("/api/settings/print", async (req, res) => {
  const result = await pgUpdatePrintSettings(pgQuery, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Print Settings", message: "Updated print settings", meta: result.paperSize });
  res.json(result.data);
});

app.put("/api/settings/business-hours", async (req, res) => {
  const result = await pgUpdateBusinessHoursSettings(pgWithTransaction, pgQuery, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Business Hours", message: "Updated business hours", meta: "Settings" });
  res.json(result.data);
});

app.get("/api/settings/staff-permissions", async (_req, res) => {
  res.json(await pgGetStaffPermissionSettings(pgQuery));
});

app.post("/api/settings/staff-permissions", async (req, res) => {
  const result = await pgCreateStaffPermission(pgOne, pgQuery, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Staff Permission", message: `Added staff profile ${result.name}`, meta: result.role });
  res.status(201).json(result.data);
});

app.patch("/api/settings/staff-permissions/:id", async (req, res) => {
  const id = Number(req.params.id);
  const result = await pgUpdateStaffPermission(pgOne, pgQuery, id, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Staff Permission", message: `Updated staff profile ${result.name}`, meta: result.role });
  res.json(result.data);
});

app.delete("/api/settings/staff-permissions/:id", async (req, res) => {
  const id = Number(req.params.id);
  const result = await pgDeleteStaffPermission(pgOne, pgQuery, id);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Staff Permission", message: `Deleted staff profile ${result.name}`, meta: "Delete" });
  res.json(result.data);
});

app.patch("/api/settings/reorder", async (req, res) => {
  const result = await pgUpdateReorderSettings(pgWithTransaction, readModels.pgGetParts, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Reorder Settings", message: "Updated reorder thresholds", meta: "Inventory" });
  res.json(result.data);
});

app.post("/api/order-form-options/brands", async (req, res) => {
  const result = await pgCreateOrderFormBrand(pgOne, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  res.status(201).json(result.data);
});

app.post("/api/order-form-options/models", async (req, res) => {
  const result = await pgCreateOrderFormModel(pgOne, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  res.status(201).json(result.data);
});

app.post("/api/order-form-options/technicians", async (req, res) => {
  const result = await pgCreateOrderFormTechnician(pgOne, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  res.status(201).json(result.data);
});

app.post("/api/order-form-options/issues", async (req, res) => {
  const result = await pgCreateOrderFormIssue(pgOne, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  res.status(201).json(result.data);
});

app.patch("/api/order-form-options/:collection/:id", async (req, res) => {
  const collection = String(req.params.collection ?? "");
  const id = Number(req.params.id);
  const result = await pgUpdateOrderFormOption(pgOne, pgWithTransaction, pgQuery, collection, id, req.body);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Order Options", message: `Updated ${result.label}`, meta: collection });
  res.json(result.data);
});

app.delete("/api/order-form-options/:collection/:id", async (req, res) => {
  const collection = String(req.params.collection ?? "");
  const id = Number(req.params.id);
  const result = await pgDeleteOrderFormOption(pgWithTransaction, pgQuery, collection, id);
  if (result.error) {
    res.status(result.status).json({ message: result.error });
    return;
  }
  appendAuditLog({ actor: "System Admin", type: "Order Options", message: `Deleted option from ${collection}`, meta: "Delete" });
  res.json(result.data);
});

app.get("/api/dashboard", async (_req, res) => {
  const metrics = await pgOne(`
    SELECT
      COUNT(*)::int AS "totalOrders",
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::int AS "pendingOrders",
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END)::int AS "inProgressOrders",
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS "completedOrders",
      COALESCE(SUM(amount), 0)::int AS "totalRevenue"
    FROM orders
  `);
  const todayKey = getTodayDateKey();
  const todayOrders = (await pgOne(`SELECT COUNT(*)::int AS count FROM orders WHERE scheduled_date = $1`, [todayKey]))?.count ?? 0;
  const inventoryValue = (await pgOne(`SELECT COALESCE(SUM(stock * unit_price), 0)::int AS total FROM parts`))?.total ?? 0;
  const pendingProcurements = (await pgOne(`SELECT COUNT(*)::int AS count FROM procurements WHERE status != '已交付'`))?.count ?? 0;
  const readyForPickup = (await pgOne(`SELECT COUNT(*)::int AS count FROM orders WHERE status = 'completed'`))?.count ?? 0;
  const urgentOrders = (await readModels.pgGetRepairQueue("all", "")).metrics.urgent;

  const lowStockParts = await pgQuery(`
    SELECT id, name, sku, stock, reorder_level AS "reorderLevel", unit_price AS "unitPrice", supplier
    FROM parts
    WHERE stock <= reorder_level
    ORDER BY stock ASC, name ASC
    LIMIT 4
  `);

  res.json({
    metrics: {
      ...metrics,
      todayOrders,
      urgentOrders,
      pendingProcurements,
      readyForPickup,
      inventoryValue,
      inventoryValueFormatted: formatMoney(inventoryValue),
      totalRevenueFormatted: formatMoney(metrics.totalRevenue),
    },
    lowStockParts: lowStockParts.map(readModels.mapPart),
    recentMovements: await readModels.pgGetRecentMovements(),
  });
});

app.get("/api/orders", async (req, res) => {
  const { status = "all", search = "" } = req.query;
  const queue = await readModels.pgGetRepairQueue(String(status), String(search));
  res.json(queue.rows.map(({ elapsedMinutes, elapsedLabel, progress, priority, priorityLabel, footerText, ...order }) => order));
});

app.get("/api/repair-queue", async (req, res) => {
  const status = String(req.query.status ?? "all");
  const search = String(req.query.search ?? "");
  res.json(await readModels.pgGetRepairQueue(status, search));
});

app.post("/api/repair-queue/:id/action", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

  const execution = await pgOne(`
    SELECT
      order_id AS "orderId",
      phase,
      checklist_json AS "checklistJson",
      elapsed_minutes AS "elapsedMinutes",
      updated_at AS "updatedAt"
    FROM order_execution
    WHERE order_id = $1
  `, [order.id]);

  await pgQuery(`UPDATE orders SET status = $1 WHERE id = $2`, [nextStatus, order.id]);
  await pgQuery(`
    INSERT INTO order_execution (order_id, phase, checklist_json, elapsed_minutes, updated_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (order_id) DO UPDATE
    SET phase = EXCLUDED.phase,
        checklist_json = EXCLUDED.checklist_json,
        elapsed_minutes = EXCLUDED.elapsed_minutes,
        updated_at = CURRENT_TIMESTAMP
  `, [
    order.id,
    nextPhase,
    execution?.checklistJson ?? JSON.stringify(getDefaultExecutionChecklist()),
    execution?.elapsedMinutes ?? 45,
  ]);

  const updatedOrder = await readModels.pgGetOrderById(order.id);
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
    order: readModels.mapOrder(updatedOrder),
    queue: (await readModels.pgGetRepairQueue("all", "")).rows.find((item) => item.id === updatedOrder.id) ?? null,
  });
});

app.get("/api/orders/:id", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const parts = await readModels.pgGetOrderParts(order.id);
  const partsTotal = parts.reduce((sum, item) => sum + item.subtotal, 0);
  const laborTotal = Math.max(0, order.amount - partsTotal);
  const balanceDue = Math.max(0, order.amount - Number(order.deposit ?? 0));
  const storedPhotos = await readModels.pgGetStoredPhotos(order.id);
  const intakePhotos = storedPhotos.filter((photo) => ["手机正面", "手机背面", "客户照片"].includes(photo.stage));
  const intake = await readModels.pgGetOrderIntake(order.id);

  const deviceSerial = intake?.imeiSerial || `SN-${String(order.id).padStart(4, "0")}-${order.deviceName.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase()}`;
  const batteryHealth = order.deviceName.toLowerCase().includes("iphone") ? "92%" : order.deviceName.toLowerCase().includes("macbook") ? "86%" : "89%";
  const storage = order.deviceName.toLowerCase().includes("iphone") ? "256 GB" : order.deviceName.toLowerCase().includes("macbook") ? "512 GB" : "128 GB";
  const execution = await readModels.pgGetOrderExecutionRecord(order.id);
  const timeline = getOrderTimeline(order, execution?.phase ?? "repair");

  res.json({
    ...readModels.mapOrder(order),
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

app.get("/api/orders/:id/communication", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  res.json({
    id: order.id,
    orderNo: order.orderNo,
    amountFormatted: formatMoney(order.amount),
    suggestedReplies: ["等待配件", "可取机", "检测中", "需支付定金"],
    messages: await readModels.pgGetOrderMessages(order),
  });
});

app.get("/api/orders/:id/intake", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const intake = await readModels.pgGetOrderIntake(order.id);
  const intakePhotos = (await readModels.pgGetStoredPhotos(order.id))
    .filter((photo) => ["手机正面", "手机背面", "客户照片"].includes(photo.stage));

  res.json({
    ...readModels.mapOrder(order),
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

app.get("/api/orders/:id/completion", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const completion = await readModels.pgGetOrderCompletionRecord(order.id);
  const checklist = completion
    ? normalizeCompletionChecklist(parseJson(completion.checklistJson, getDefaultCompletionChecklist(order)), order)
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

app.get("/api/orders/:id/execution", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const execution = await readModels.pgGetOrderExecutionRecord(order.id);
  const checklist = execution
    ? normalizeExecutionChecklist(parseJson(execution.checklistJson, getDefaultExecutionChecklist()))
    : getDefaultExecutionChecklist();
  const timeline = getOrderTimeline(order, execution?.phase ?? "repair");
  const parts = (await readModels.pgGetOrderParts(order.id)).map((part) => ({
    ...part,
    unitPriceFormatted: formatMoney(part.unitPrice),
    subtotalFormatted: formatMoney(part.subtotal),
  }));

  res.json({
    ...readModels.mapOrder(order),
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

app.post("/api/orders/:id/execution", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const allowedPhases = ["diagnosis", "repair", "qa", "completed"];
  const phase = allowedPhases.includes(req.body?.phase) ? req.body.phase : "repair";
  const elapsedMinutes = Number.isInteger(req.body?.elapsedMinutes) ? req.body.elapsedMinutes : Number(req.body?.elapsedMinutes ?? 45);
  const checklist = Array.isArray(req.body?.checklist) ? req.body.checklist : getDefaultExecutionChecklist();
  const normalizedChecklist = normalizeExecutionChecklist(checklist);

  if (!normalizedChecklist.length) {
    res.status(400).json({ message: "Execution checklist is required" });
    return;
  }

  const safeElapsed = Number.isFinite(elapsedMinutes) && elapsedMinutes > 0 ? Math.round(elapsedMinutes) : 45;
  const status = phase === "completed" ? "completed" : phase === "diagnosis" ? "pending" : "in_progress";

  await pgWithTransaction(async (client) => {
    await client.query(`
      INSERT INTO order_execution (order_id, phase, checklist_json, elapsed_minutes, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (order_id) DO UPDATE SET
        phase = EXCLUDED.phase,
        checklist_json = EXCLUDED.checklist_json,
        elapsed_minutes = EXCLUDED.elapsed_minutes,
        updated_at = CURRENT_TIMESTAMP
    `, [order.id, phase, JSON.stringify(normalizedChecklist), safeElapsed]);

    await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, order.id]);
  });

  res.json({
    ok: true,
    phase,
    status,
    phaseLabel: getExecutionPhaseLabel(phase),
  });
});

app.get("/api/orders/:id/deductions", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const rows = await pgQuery(`
      SELECT
        m.id,
        m.part_id AS "partId",
        p.name AS "partName",
        p.sku,
        m.quantity,
        m.note,
        m.created_at AS "createdAt",
        p.unit_price AS "unitPrice"
      FROM inventory_movements m
      JOIN parts p ON p.id = m.part_id
      WHERE m.movement_type = 'out' AND m.note ILIKE $1
      ORDER BY m.id DESC
    `, [`%${order.orderNo}%`]);

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

app.get("/api/orders/:id/deductions/journal", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const rows = await pgQuery(`
      SELECT
        m.id,
        p.name AS "partName",
        m.quantity,
        m.note,
        m.created_at AS "createdAt"
      FROM inventory_movements m
      JOIN parts p ON p.id = m.part_id
      WHERE m.movement_type = 'out' AND m.note ILIKE $1
      ORDER BY m.id DESC
    `, [`%${order.orderNo}%`]);

  const activeOrders = Number((await pgOne("SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'in_progress')"))?.count ?? 0);

  res.json({
    orderNo: order.orderNo,
    totalDeductions: rows.reduce((sum, row) => sum + row.quantity, 0),
    totalValueFormatted: formatMoney(rows.reduce((sum, row) => sum + row.quantity * 1000, 0)),
    activeOrders,
    rows: rows.map((row) => ({
      ...row,
      createdAt: formatChatTimestamp(row.createdAt),
      reference: order.orderNo,
    })),
  });
});

app.get("/api/orders/:id/receipt", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const parts = await readModels.pgGetOrderParts(order.id);
  const receiptMeta = await readModels.pgGetReceiptMeta(order.id);

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

app.get("/api/receipts", async (_req, res) => {
  const receipts = await pgQuery(`
      SELECT
        o.id,
        o.order_no AS "orderNo",
        o.scheduled_date AS "scheduledDate",
        o.amount,
        o.status,
        c.name AS "customerName",
        rm.printed_at AS "printedAt",
        rm.picked_up_at AS "pickedUpAt"
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN receipt_meta rm ON rm.order_id = o.id
      ORDER BY o.scheduled_date DESC, o.id DESC
    `);

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

app.get("/api/orders/:id/photo-upload", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const storedPhotos = (await readModels.pgGetStoredPhotos(order.id))
    .filter((item) => item.stage === "维修后");
  const photos = storedPhotos.length ? storedPhotos.map((item) => item.image) : getDefaultUploadPhotos();

  res.json({
    orderNo: order.orderNo,
    amountFormatted: formatMoney(order.amount),
    selectedCount: photos.length,
    maxCount: 5,
    photos,
  });
});

app.get("/api/orders/:id/photo-archive", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const storedPhotos = await readModels.pgGetStoredPhotos(order.id);
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
    statusLabel: readModels.statusMeta[order.status]?.label ?? order.status,
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

app.get("/api/orders/:id/share-report", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

app.get("/api/orders/:id/email-report", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

app.post("/api/orders/:id/email-report/send", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

app.get("/api/orders/:id/report.pdf", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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
      `Status: ${readModels.statusMeta[order.status]?.label ?? order.status}`,
    `Amount: ${formatMoney(order.amount)}`,
    `Issue: ${order.issueSummary}`,
  ];

  const pdf = buildSimplePdf(lines);
  const filename = `Repair_Report_${order.orderNo}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(pdf);
});

app.get("/api/refunds", async (_req, res) => {
  const rows = await pgGetRefundRows();
  res.json({
    rows,
    metrics: {
      completedOrders: toNumber((await pgOne("SELECT COUNT(*) AS count FROM orders WHERE status IN ('completed', 'picked_up')"))?.count),
      totalRefundsFormatted: formatMoney(rows.reduce((sum, row) => sum + row.amount, 0)),
      pendingCount: rows.filter((row) => row.status === "pending").length,
    },
  });
});

app.post("/api/refunds", async (req, res) => {
  const orderId = Number(req.body?.orderId);
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason ?? "").trim();
  const method = String(req.body?.method ?? "original").trim() || "original";

  if (!Number.isInteger(orderId) || !Number.isFinite(amount) || amount <= 0 || !reason) {
    res.status(400).json({ message: "Invalid refund payload" });
    return;
  }

  const order = await readModels.pgGetOrderById(orderId);
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const created = await pgOne(`
      INSERT INTO refunds (order_id, amount, reason, method, status)
      VALUES ($1, $2, $3, $4, 'pending')
      RETURNING id
    `, [orderId, Math.round(amount), reason, method]).then(async (row) => {
      const rows = await pgGetRefundRows();
      return rows.find((item) => item.id === row.id);
    });
  appendAuditLog({ actor: "Cashier", type: "Refund", tone: "danger", message: `Created refund request for ${order.orderNo}`, meta: method });
  res.status(201).json(created);
});

app.get("/api/reviews", async (_req, res) => {
  const rows = await pgGetReviewRows();
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

app.post("/api/reviews/:id/reply", async (req, res) => {
  const reviewId = Number(req.params.id);
  const reply = String(req.body?.reply ?? "").trim();

  if (!reviewId || !reply) {
    res.status(400).json({ message: "Reply is required" });
    return;
  }

  const result = await pgOne("UPDATE reviews SET reply = $1 WHERE id = $2 RETURNING id", [reply, reviewId]);
  if (!result) {
    res.status(404).json({ message: "Review not found" });
    return;
  }
  const updated = (await pgGetReviewRows()).find((row) => Number(row.id) === reviewId);

  appendAuditLog({ actor: "Support Lead", type: "Review Reply", tone: "primary", message: `Replied to review for ${updated.orderNo}`, meta: "Customer Care" });
  res.json(updated);
});

app.get("/api/receipts/export.csv", async (_req, res) => {
  const rows = await pgQuery(`
    SELECT
      o.order_no AS "orderNo",
      c.name AS "customerName",
      o.scheduled_date AS "scheduledDate",
      o.status,
      o.amount
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    ORDER BY o.scheduled_date DESC, o.id DESC
  `);

  const csvLines = [
    "order_no,customer_name,scheduled_date,status,amount_vuv",
    ...rows.map((row) => [row.orderNo, row.customerName, row.scheduledDate, row.status, row.amount].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")),
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="receipts_export.csv"');
  res.send(csvLines.join("\n"));
});

app.post("/api/orders", async (req, res) => {
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

  if (!readModels.statusMeta[status]) {
    res.status(400).json({ message: "Unsupported status" });
    return;
  }

  const orderNo = await pgGetNextOrderNo();
  const intakeCode = await pgGetNextIntakeCode();

  const intakePhotos = [
    { stage: "手机正面", imageUrl: String(deviceFrontPhoto).trim(), note: "建单时记录的设备正面照片。" },
    { stage: "手机背面", imageUrl: String(deviceBackPhoto).trim(), note: "建单时记录的设备背面照片。" },
    { stage: "客户照片", imageUrl: String(customerPhoto).trim(), note: "建单时记录的客户照片。" },
  ];

  if (intakePhotos.some((photo) => !photo.imageUrl)) {
    res.status(400).json({ message: "Order intake photos are required" });
    return;
  }

  const result = await pgWithTransaction(async (client) => {
      const customerMatch = await client.query(`
        SELECT id
        FROM customers
        WHERE lower(name) = lower($1)
          AND phone = $2
        LIMIT 1
      `, [customerName.trim(), customerPhone.trim()]);

      let customerId = customerMatch.rows[0]?.id;

      if (!customerId) {
        const insertedCustomer = await client.query(`
          INSERT INTO customers (name, phone, email, tier)
          VALUES ($1, $2, $3, 'standard')
          RETURNING id
        `, [customerName.trim(), customerPhone.trim(), customerEmail.trim()]);
        customerId = insertedCustomer.rows[0]?.id;
      } else {
        await client.query("UPDATE customers SET email = $1 WHERE id = $2", [customerEmail.trim(), customerId]);
      }

      const orderInserted = await client.query(`
        INSERT INTO orders
        (order_no, title, device_name, status, customer_id, technician, scheduled_date, amount, deposit, issue_summary, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [
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
      ]);
      const orderId = orderInserted.rows[0]?.id;

      for (const photo of intakePhotos) {
        await client.query(`
          INSERT INTO order_photos (order_id, stage, image_url, note)
          VALUES ($1, $2, $3, $4)
        `, [orderId, photo.stage, photo.imageUrl, photo.note]);
      }

      await client.query(`
        INSERT INTO order_intake (order_id, intake_code, imei_serial, customer_signature)
        VALUES ($1, $2, $3, $4)
      `, [orderId, intakeCode, String(imeiSerial).trim(), String(customerSignature).trim()]);

      return Number(orderId);
    });

  const created = await readModels.pgGetOrderById(result);
  res.status(201).json(readModels.mapOrder(created));
});

app.post("/api/orders/:id/communication", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

  const created = await pgOne(`
      INSERT INTO order_messages (order_id, sender, type, body, meta_json)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        sender,
        type,
        body,
        meta_json AS "metaJson",
        created_at AS "createdAt"
    `, [order.id, sender, type, rawBody, JSON.stringify({})])
    ;

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

app.post("/api/orders/:id/parts", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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
  const partRows = await pgQuery(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS "reorderLevel",
        unit_price AS "unitPrice"
      FROM parts
      WHERE id = ANY($1::int[])
    `, [uniqueIds]);

  if (partRows.length !== uniqueIds.length) {
    res.status(404).json({ message: "One or more parts were not found" });
    return;
  }

  const partMap = new Map(partRows.map((row) => [Number(row.id), {
    ...row,
    id: Number(row.id),
    stock: toNumber(row.stock),
    reorderLevel: toNumber(row.reorderLevel),
    unitPrice: toNumber(row.unitPrice),
  }]));
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

  await pgWithTransaction(async (client) => {
    let addedAmount = 0;
    for (const item of normalizedItems) {
      const part = partMap.get(item.partId);
      addedAmount += part.unitPrice * item.quantity;

      const existing = await client.query(`
        SELECT id, quantity
        FROM order_parts
        WHERE order_id = $1 AND part_id = $2
      `, [order.id, item.partId]);

      if (existing.rows[0]) {
        await client.query(`
          UPDATE order_parts
          SET quantity = $1, unit_price = $2
          WHERE id = $3
        `, [toNumber(existing.rows[0].quantity) + item.quantity, part.unitPrice, existing.rows[0].id]);
      } else {
        await client.query(`
          INSERT INTO order_parts (order_id, part_id, quantity, unit_price)
          VALUES ($1, $2, $3, $4)
        `, [order.id, item.partId, item.quantity, part.unitPrice]);
      }

      await client.query("UPDATE parts SET stock = stock - $1 WHERE id = $2", [item.quantity, item.partId]);
      await client.query(`
        INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
        VALUES ($1, 'out', $2, $3)
      `, [item.partId, item.quantity, `Allocated to order ${order.orderNo}`]);
    }

    await client.query("UPDATE orders SET amount = amount + $1 WHERE id = $2", [addedAmount, order.id]);
  });

  res.status(201).json({
    ok: true,
    order: {
      ...readModels.mapOrder(await readModels.pgGetOrderById(order.id)),
      parts: (await readModels.pgGetOrderParts(order.id)).map((part) => ({
        ...part,
        unitPriceFormatted: formatMoney(part.unitPrice),
        subtotalFormatted: formatMoney(part.subtotal),
      })),
    },
  });
  appendAuditLog({ actor: "Inventory Bot", type: "Stock Move", tone: "success", message: `Allocated parts to ${order.orderNo}`, meta: `Items: ${normalizedItems.length}` });
});

app.patch("/api/orders/:id/parts", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

  const existingItems = await readModels.pgGetOrderParts(order.id);
  const existingMap = new Map(existingItems.map((item) => [Number(item.id), item]));
  const nextPartIds = normalizedItems.map((item) => item.partId);

  if (nextPartIds.length !== existingItems.length || nextPartIds.some((partId) => !existingMap.has(partId))) {
    res.status(400).json({ message: "Only existing order parts can be edited here" });
    return;
  }

  await pgWithTransaction(async (client) => {
    for (const item of normalizedItems) {
      await client.query(`
        UPDATE order_parts
        SET quantity = $1, unit_price = $2
        WHERE order_id = $3 AND part_id = $4
      `, [item.quantity, Math.round(item.unitPrice), order.id, item.partId]);
    }

    const refreshedParts = await client.query(`
      SELECT quantity, unit_price AS "unitPrice", quantity * unit_price AS subtotal
      FROM order_parts
      WHERE order_id = $1
    `, [order.id]);
    const partsTotal = refreshedParts.rows.reduce((sum, item) => sum + toNumber(item.subtotal), 0);
    const laborTotal = Math.max(0, order.amount - existingItems.reduce((sum, item) => sum + toNumber(item.subtotal), 0));
    await client.query("UPDATE orders SET amount = $1 WHERE id = $2", [partsTotal + laborTotal, order.id]);
  });

  const updatedOrder = await readModels.pgGetOrderById(order.id);
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
      ...readModels.mapOrder(updatedOrder),
      parts: (await readModels.pgGetOrderParts(order.id)).map((part) => ({
        ...part,
        unitPriceFormatted: formatMoney(part.unitPrice),
        subtotalFormatted: formatMoney(part.subtotal),
      })),
    },
  });
});

app.delete("/api/orders/:id/parts/:partId", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const partId = Number(req.params.partId);
  if (!Number.isInteger(partId) || partId <= 0) {
    res.status(400).json({ message: "Invalid part id" });
    return;
  }

  const existing = await pgOne(`
      SELECT
        op.id,
        op.part_id AS "partId",
        op.quantity,
        op.unit_price AS "unitPrice",
        p.name,
        p.stock
      FROM order_parts op
      JOIN parts p ON p.id = op.part_id
      WHERE op.order_id = $1 AND op.part_id = $2
    `, [order.id, partId]);

  if (!existing) {
    res.status(404).json({ message: "Order part not found" });
    return;
  }

  const currentParts = await readModels.pgGetOrderParts(order.id);
  const currentPartsTotal = currentParts.reduce((sum, item) => sum + item.subtotal, 0);
  const laborTotal = Math.max(0, order.amount - currentPartsTotal);

  await pgWithTransaction(async (client) => {
    await client.query("DELETE FROM order_parts WHERE order_id = $1 AND part_id = $2", [order.id, partId]);
    await client.query("UPDATE parts SET stock = stock + $1 WHERE id = $2", [toNumber(existing.quantity), partId]);
    await client.query(`
      INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
      VALUES ($1, 'in', $2, $3)
    `, [partId, toNumber(existing.quantity), `Returned from order ${order.orderNo}`]);

    const refreshedParts = await client.query(`
      SELECT quantity * unit_price AS subtotal
      FROM order_parts
      WHERE order_id = $1
    `, [order.id]);
    const refreshedPartsTotal = refreshedParts.rows.reduce((sum, item) => sum + toNumber(item.subtotal), 0);
    await client.query("UPDATE orders SET amount = $1 WHERE id = $2", [refreshedPartsTotal + laborTotal, order.id]);
  });

  const updatedOrder = await readModels.pgGetOrderById(order.id);
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
      ...readModels.mapOrder(updatedOrder),
      parts: (await readModels.pgGetOrderParts(order.id)).map((part) => ({
        ...part,
        unitPriceFormatted: formatMoney(part.unitPrice),
        subtotalFormatted: formatMoney(part.subtotal),
      })),
    },
  });
});

app.post("/api/orders/:id/completion/confirm", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  const finalNotes = String(req.body?.finalNotes ?? order.notes ?? "").trim();
  const checklist = Array.isArray(req.body?.checklist) ? req.body.checklist : getDefaultCompletionChecklist(order);
  const normalizedChecklist = normalizeCompletionChecklist(checklist, order);

  if (!normalizedChecklist.length) {
    res.status(400).json({ message: "Completion checklist is required" });
    return;
  }

  const warranty = String(req.body?.warranty ?? "Standard Warranty Applied").trim() || "Standard Warranty Applied";

  await pgQuery(`
    INSERT INTO order_completion (order_id, warranty, checklist_json, final_notes, updated_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    ON CONFLICT (order_id) DO UPDATE SET
      warranty = EXCLUDED.warranty,
      checklist_json = EXCLUDED.checklist_json,
      final_notes = EXCLUDED.final_notes,
      updated_at = CURRENT_TIMESTAMP
  `, [order.id, warranty, JSON.stringify(normalizedChecklist), finalNotes]);

  await pgQuery(`
    UPDATE orders
    SET status = 'completed', notes = $1
    WHERE id = $2
  `, [finalNotes, order.id]);

  const updatedOrder = await readModels.pgGetOrderById(order.id);
  const completion = await readModels.pgGetOrderCompletionRecord(order.id);

  res.json({
    ok: true,
    order: readModels.mapOrder(updatedOrder),
    completion: {
      warranty: completion.warranty,
      checklist: parseJson(completion.checklistJson, normalizedChecklist),
      finalNotes: completion.finalNotes,
      updatedAt: completion.updatedAt,
    },
  });
  appendAuditLog({ actor: "Technician", type: "Completion", tone: "success", message: `Completed repair for ${updatedOrder.orderNo}`, meta: warranty });
});

app.post("/api/orders/:id/photo-upload", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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

  for (const photo of normalizedPhotos) {
    await pgQuery(`
      INSERT INTO order_photos (order_id, stage, image_url, note)
      VALUES ($1, $2, $3, $4)
    `, [order.id, photo.stage, photo.imageUrl, photo.note]);
  }

  res.status(201).json({
    ok: true,
    count: normalizedPhotos.length,
    photos: await readModels.pgGetStoredPhotos(order.id),
  });
});

app.post("/api/orders/:id/receipt/print", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  await pgQuery(`
    INSERT INTO receipt_meta (order_id, printed_at, picked_up_at)
    VALUES ($1, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT (order_id) DO UPDATE SET
      printed_at = CURRENT_TIMESTAMP
  `, [order.id]);

  res.json({
    ok: true,
    printedAt: new Date().toISOString(),
    message: `结算单 ${order.orderNo} 已标记为已打印`,
  });
});

app.post("/api/orders/:id/pickup", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  await pgQuery("UPDATE orders SET status = 'picked_up' WHERE id = $1", [order.id]);
  await pgQuery(`
    INSERT INTO receipt_meta (order_id, printed_at, picked_up_at)
    VALUES ($1, NULL, CURRENT_TIMESTAMP)
    ON CONFLICT (order_id) DO UPDATE SET
      picked_up_at = CURRENT_TIMESTAMP
  `, [order.id]);

  res.json({
    ok: true,
    status: "picked_up",
    message: `工单 ${order.orderNo} 已完成取机`,
  });
});

app.patch("/api/orders/:id/status", async (req, res) => {
  const { status } = req.body;
  const order = await readModels.pgGetOrderById(req.params.id);

  if (!readModels.statusMeta[status]) {
    res.status(400).json({ message: "Unsupported status" });
    return;
  }

  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  await pgQuery(`UPDATE orders SET status = $1 WHERE id = $2`, [status, order.id]);
  const updated = await readModels.pgGetOrderById(order.id);
  res.json(readModels.mapOrder(updated));
});

app.patch("/api/orders/:id", async (req, res) => {
  const order = await readModels.pgGetOrderById(req.params.id);

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
  const intake = await readModels.pgGetOrderIntake(order.id);
  const imeiSerial = String(req.body?.imeiSerial ?? intake?.imeiSerial ?? "").trim();
  const customerSignature = String(req.body?.customerSignature ?? intake?.customerSignature ?? order.customerName).trim();
  const intakeCode = intake?.intakeCode ?? (await pgGetNextIntakeCode());

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

  await pgQuery(`
    UPDATE orders
    SET title = $1, technician = $2, scheduled_date = $3, amount = $4, deposit = $5, issue_summary = $6, notes = $7
    WHERE id = $8
  `, [title, technician, scheduledDate, Math.round(numericAmount), Math.round(numericDeposit), issueSummary, notes, order.id]);

  await pgQuery(`
    UPDATE customers
    SET name = $1, phone = $2, email = $3
    WHERE id = $4
  `, [customerName, customerPhone, customerEmail, order.customerId]);

  await pgQuery(`
    INSERT INTO order_intake (order_id, intake_code, imei_serial, customer_signature)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (order_id) DO UPDATE SET
      imei_serial = EXCLUDED.imei_serial,
      customer_signature = EXCLUDED.customer_signature
  `, [order.id, intakeCode, imeiSerial, customerSignature]);

  const updated = await readModels.pgGetOrderById(order.id);
  appendAuditLog({
    actor: updated.technician,
    type: "Order Update",
    tone: "primary",
    message: `Updated order details for ${updated.orderNo}`,
    meta: "Detail Management",
  });

  res.json(readModels.mapOrder(updated));
});

app.get("/api/customers", async (_req, res) => {
  res.json(await readModels.pgGetCustomers());
});

app.get("/api/customers/:id", async (req, res) => {
  const customer = await readModels.pgGetCustomerById(Number(req.params.id));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  res.json(customer);
});

app.get("/api/customers/:id/history", async (req, res) => {
  const customer = await readModels.pgGetCustomerHistory(Number(req.params.id));
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }
  res.json(customer);
});

app.post("/api/customers/:id/followups", async (req, res) => {
  const customerId = Number(req.params.id);
  const note = String(req.body?.note ?? "").trim();
  const channel = String(req.body?.channel ?? "phone").trim() || "phone";
  const orderId = req.body?.orderId ? Number(req.body.orderId) : null;

  if (!customerId || !note) {
    res.status(400).json({ message: "Follow-up note is required" });
    return;
  }

  const customer = await pgOne("SELECT id FROM customers WHERE id = $1", [customerId]);
  if (!customer) {
    res.status(404).json({ message: "Customer not found" });
    return;
  }

  const created = await pgOne(`
      INSERT INTO customer_followups (customer_id, order_id, channel, note)
      VALUES ($1, $2, $3, $4)
      RETURNING
        id,
        customer_id AS "customerId",
        order_id AS "orderId",
        channel,
        note,
        created_at AS "createdAt"
    `, [customerId, orderId, channel, note]).then((row) => ({
      ...row,
      createdLabel: formatChatTimestamp(row.createdAt),
    }));
  appendAuditLog({ actor: "Customer Care", type: "Follow-up", tone: "primary", message: `Logged follow-up for customer #${customerId}`, meta: channel });
  res.status(201).json(created);
});

app.get("/api/audit/logs", async (_req, res) => {
  const rows = await pgGetAuditLogs();
  res.json({
    rows,
    count: rows.length,
  });
});

app.get("/api/notifications", async (req, res) => {
  const filter = String(req.query.filter ?? "all");
  const rows = (await pgBuildNotifications()).filter((item) => (filter === "all" ? true : item.category === filter));
  res.json({
    rows,
    unreadCount: rows.filter((item) => !item.isRead).length,
  });
});

app.post("/api/notifications/read-all", async (_req, res) => {
  const rows = await pgBuildNotifications();
  await pgWithTransaction(async (client) => {
    for (const item of rows) {
      await client.query(`
        INSERT INTO notification_reads (notification_id, read_at)
        VALUES ($1, CURRENT_TIMESTAMP)
        ON CONFLICT (notification_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
      `, [item.id]);
    }
  });
  res.json({ ok: true, count: rows.length });
});

app.post("/api/notifications/:id/read", async (req, res) => {
  await pgQuery(`
    INSERT INTO notification_reads (notification_id, read_at)
    VALUES ($1, CURRENT_TIMESTAMP)
    ON CONFLICT (notification_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
  `, [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/parts/movements", async (req, res) => {
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

  const part = await pgOne(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS "reorderLevel",
        unit_price AS "unitPrice",
        cost_price AS "costPrice",
        supplier
      FROM parts
      WHERE id = $1
    `, [partId]);
  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const nextStock = movementType === "in" ? part.stock + quantity : part.stock - quantity;
  if (nextStock < 0) {
    res.status(400).json({ message: "Insufficient stock for this movement" });
    return;
  }

  await pgWithTransaction(async (client) => {
    await client.query("UPDATE parts SET stock = $1 WHERE id = $2", [nextStock, partId]);
    await client.query(`
      INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
      VALUES ($1, $2, $3, $4)
    `, [partId, movementType, quantity, note || (movementType === "in" ? "Manual inbound registration" : "Manual outbound registration")]);
  });

  appendAuditLog({
    actor: "Inventory Manager",
    type: movementType === "in" ? "Inbound Registration" : "Outbound Registration",
    tone: movementType === "in" ? "success" : "warning",
    message: `${movementType === "in" ? "Added" : "Removed"} ${quantity} units for ${part.name}`,
    meta: note || part.sku,
  });

  res.status(201).json({
    ok: true,
    part: readModels.mapPart({ ...part, stock: nextStock }),
    movementType,
    quantity,
  });
});

app.post("/api/parts/:id/reorder", async (req, res) => {
  const part = await pgOne(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS "reorderLevel",
        unit_price AS "unitPrice",
        supplier
      FROM parts
      WHERE id = $1
    `, [Number(req.params.id)]);

  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const quantity = Number(req.body?.quantity ?? Math.max(part.reorderLevel * 2, 1));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    res.status(400).json({ message: "Invalid reorder quantity" });
    return;
  }

  const procurementNo = await pgGetNextProcurementNo();
  await pgQuery(`
    INSERT INTO procurements (procurement_no, supplier, part_id, quantity, unit_price, source_currency, source_unit_price, exchange_rate, shipping_fee, customs_fee, other_fee, status)
    VALUES ($1, $2, $3, $4, $5, 'VUV', $6, 1, 0, 0, 0, '运输中')
  `, [procurementNo, part.supplier, part.id, Math.round(quantity), toNumber(part.unitPrice), toNumber(part.unitPrice)]);

  appendAuditLog({ actor: "Inventory Manager", type: "Reorder", tone: "warning", message: `Created procurement ${procurementNo} for ${part.name}`, meta: part.supplier });

  res.status(201).json({
    ok: true,
    procurementNo,
    supplier: part.supplier,
    quantity: Math.round(quantity),
    amountFormatted: formatMoney(Math.round(quantity) * toNumber(part.unitPrice)),
  });
});

app.get("/api/search", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  const scope = String(req.query.scope ?? "all");

  if (!query) {
    res.json({ orders: [], parts: [], customers: [] });
    return;
  }

  const like = `%${query}%`;
  const orders = scope === "parts"
    ? []
    : (await pgQuery(`
        SELECT
          o.id,
          o.order_no AS "orderNo",
          o.device_name AS "deviceName",
          o.title,
          o.status,
          o.amount,
          c.name AS "customerName"
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        LEFT JOIN order_intake oi ON oi.order_id = o.id
        WHERE o.order_no ILIKE $1 OR o.device_name ILIKE $1 OR o.title ILIKE $1 OR c.name ILIKE $1 OR c.phone ILIKE $1 OR oi.imei_serial ILIKE $1
        ORDER BY o.id DESC
        LIMIT 8
      `, [like]))
      .map((row) => ({
        ...row,
        amountFormatted: formatMoney(toNumber(row.amount)),
        link: `/orders/${row.orderNo ?? row.id}`,
      }));

  const parts = scope === "orders"
    ? []
    : (await pgQuery(`
        SELECT
          id,
          name,
          sku,
          stock,
          reorder_level AS "reorderLevel",
          unit_price AS "unitPrice",
          cost_price AS "costPrice",
          supplier
        FROM parts
        WHERE sku ILIKE $1 OR name ILIKE $1
        ORDER BY stock ASC, name ASC
        LIMIT 8
      `, [like]))
      .map((row) => ({
        ...readModels.mapPart(row),
        link: `/parts/${row.id}`,
      }));

  const customers = scope === "parts"
    ? []
    : (await pgQuery(`
        SELECT
          id,
          name,
          phone,
          email
        FROM customers
        WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1
        ORDER BY id DESC
        LIMIT 8
      `, [like]))
      .map((row) => ({
        ...row,
        link: `/customers/${row.id}`,
      }));

  res.json({ orders, parts, customers });
});

app.get("/api/parts", async (_req, res) => {
  res.json(await readModels.pgGetParts());
});

app.get("/api/parts/:id", async (req, res) => {
  const part = await readModels.pgGetPartById(Number(req.params.id));
  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }
  res.json(part);
});

app.patch("/api/parts/:id", async (req, res) => {
  const id = Number(req.params.id);
  const current = await readModels.pgGetPartById(id);

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

  await pgQuery(`
    UPDATE parts
    SET reorder_level = $1, unit_price = $2, supplier = $3
    WHERE id = $4
  `, [reorderLevel, Math.round(unitPrice), supplier, id]);

  const updated = await readModels.pgGetPartById(id);
  appendAuditLog({
    actor: "Inventory Manager",
    type: "Part Settings",
    tone: "primary",
    message: `Updated inventory settings for ${updated.name}`,
    meta: `Threshold ${reorderLevel} · ${supplier}`,
  });

  res.json(readModels.mapPart(updated));
});

app.get("/api/suppliers/:id", async (req, res) => {
  const supplier = await pgGetSupplierById(req.params.id);

  if (!supplier) {
    res.status(404).json({ message: "Supplier not found" });
    return;
  }

  res.json(supplier);
});

app.get("/api/suppliers", async (_req, res) => {
  const suppliers = await pgGetSuppliers();
  const history = await pgGetSupplierHistory();

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

app.get("/api/procurements/:id", async (req, res) => {
  const procurement = await pgGetProcurementById(req.params.id);

  if (!procurement) {
    res.status(404).json({ message: "Procurement order not found" });
    return;
  }

  res.json(procurement);
});

app.patch("/api/procurements/:id/costing", async (req, res) => {
  const procurement = await pgOne(`
      SELECT
        procurement_no AS "procurementNo",
        part_id AS "partId",
        quantity
      FROM procurements
      WHERE procurement_no = $1
    `, [req.params.id]);

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

  await pgWithTransaction(async (client) => {
    await client.query(`
      UPDATE procurements
      SET source_currency = $1, source_unit_price = $2, exchange_rate = $3, shipping_fee = $4, customs_fee = $5, other_fee = $6, unit_price = $7
      WHERE procurement_no = $8
    `, [
      sourceCurrency,
      sourceUnitPrice,
      exchangeRate,
      costing.shippingFee,
      costing.customsFee,
      costing.otherFee,
      costing.landedUnitCost,
      procurement.procurementNo,
    ]);

    await client.query(`
      UPDATE parts
      SET cost_price = $1
      WHERE id = $2
    `, [costing.landedUnitCost, procurement.partId]);
  });

  appendAuditLog({
    actor: "Inventory Manager",
    type: "Costing",
    tone: "primary",
    message: `Updated landed cost for ${procurement.procurementNo}`,
    meta: `${sourceCurrency} ${sourceUnitPrice} · ${costing.landedUnitCostFormatted}/件`,
  });

  res.json(await pgGetProcurementById(procurement.procurementNo));
});

app.post("/api/procurements/:id/receive", async (req, res) => {
  const procurement = await pgOne(`
      SELECT
        procurement_no AS "procurementNo",
        supplier,
        part_id AS "partId",
        quantity,
        unit_price AS "unitPrice",
        source_currency AS "sourceCurrency",
        source_unit_price AS "sourceUnitPrice",
        exchange_rate AS "exchangeRate",
        shipping_fee AS "shippingFee",
        customs_fee AS "customsFee",
        other_fee AS "otherFee",
        status
      FROM procurements
      WHERE procurement_no = $1
    `, [req.params.id]);

  if (!procurement) {
    res.status(404).json({ message: "Procurement order not found" });
    return;
  }

  if (procurement.status === "已交付") {
    res.json({
      ok: true,
      alreadyReceived: true,
      procurementNo: procurement.procurementNo,
      part: readModels.mapPart(await readModels.pgGetPartById(procurement.partId)),
    });
    return;
  }

  const updatedPart = await pgWithTransaction(async (client) => {
      const currentPart = await pgOne(`
        SELECT
          id,
          name,
          sku,
          stock,
          reorder_level AS "reorderLevel",
          unit_price AS "unitPrice",
          cost_price AS "costPrice",
          supplier
        FROM parts
        WHERE id = $1
      `, [procurement.partId]);
      const costing = calculateProcurementCosting({
        quantity: toNumber(procurement.quantity),
        sourceUnitPrice: Number(procurement.sourceUnitPrice || procurement.unitPrice),
        exchangeRate: Number(procurement.exchangeRate || 1),
        shippingFee: toNumber(procurement.shippingFee),
        customsFee: toNumber(procurement.customsFee),
        otherFee: toNumber(procurement.otherFee),
      });
      await client.query("UPDATE procurements SET status = '已交付' WHERE procurement_no = $1", [procurement.procurementNo]);
      await client.query("UPDATE parts SET stock = stock + $1, cost_price = $2 WHERE id = $3", [toNumber(procurement.quantity), costing.landedUnitCost, procurement.partId]);
      await client.query(`
        INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
        VALUES ($1, 'in', $2, $3)
      `, [procurement.partId, toNumber(procurement.quantity), `Procurement received ${procurement.procurementNo}`]);
      return readModels.mapPart({
        ...currentPart,
        stock: toNumber(currentPart.stock) + toNumber(procurement.quantity),
        reorderLevel: toNumber(currentPart.reorderLevel),
        unitPrice: toNumber(currentPart.unitPrice),
        costPrice: costing.landedUnitCost,
      });
    });

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

app.post("/api/inventory/adjustments", async (req, res) => {
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

  const part = await pgOne(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS "reorderLevel",
        unit_price AS "unitPrice",
        cost_price AS "costPrice",
        supplier
      FROM parts
      WHERE id = $1
    `, [partId]);
  if (!part) {
    res.status(404).json({ message: "Part not found" });
    return;
  }

  const nextStock = part.stock - numericQuantity;
  if (nextStock < 0) {
    res.status(400).json({ message: "Insufficient stock for this adjustment" });
    return;
  }

  const adjustmentId = await pgWithTransaction(async (client) => {
      await client.query("UPDATE parts SET stock = $1 WHERE id = $2", [nextStock, partId]);
      await client.query(`
        INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
        VALUES ($1, 'out', $2, $3)
      `, [partId, numericQuantity, `${source === "requisition" ? "Requisition" : source === "loss" ? "Loss" : "Adjustment"} · ${adjustmentType} · ${note.trim()}`.trim()]);

      const inserted = await client.query(`
        INSERT INTO inventory_adjustments (part_id, adjustment_type, quantity, unit, note, operator, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [partId, adjustmentType, numericQuantity, unit, note.trim(), operator.trim(), source]);
      return Number(inserted.rows[0]?.id);
    });

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
    part: readModels.mapPart(await readModels.pgGetPartById(partId)),
  });
});

app.get("/api/inventory/loss-records", async (_req, res) => {
  const rows = await pgQuery(`
    SELECT
      ia.id,
      ia.adjustment_type AS "adjustmentType",
      ia.quantity,
      ia.unit,
      ia.note,
      ia.operator,
      ia.source,
      ia.created_at AS "createdAt",
      p.id AS "partId",
      p.name AS "partName",
      p.sku,
      p.unit_price AS "unitPrice",
      p.cost_price AS "costPrice"
    FROM inventory_adjustments ia
    JOIN parts p ON p.id = ia.part_id
    WHERE ia.source = 'loss' OR ia.adjustment_type = 'scrap'
    ORDER BY ia.id DESC
    LIMIT 50
  `);

  res.json(rows.map((row) => ({
    ...row,
    unitPriceFormatted: formatMoney(row.unitPrice),
    costPriceFormatted: formatMoney(row.costPrice ?? 0),
    totalLossAmount: row.quantity * (row.costPrice || row.unitPrice || 0),
    totalLossAmountFormatted: formatMoney(row.quantity * (row.costPrice || row.unitPrice || 0)),
    createdLabel: formatChatTimestamp(row.createdAt),
  })));
});

app.post("/api/inventory/audit-session", async (req, res) => {
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

  const sessionNo = await pgGetNextAuditSessionNo();
  const discrepancies = [];

  await pgWithTransaction(async (client) => {
    for (const item of normalizedItems) {
      const part = await pgOne(`
        SELECT id, name, stock
        FROM parts
        WHERE id = $1
      `, [item.partId]);
        if (!part) {
          continue;
        }

      const discrepancy = item.actualStock - toNumber(part.stock);
      await client.query(`
        INSERT INTO inventory_audits (session_no, part_id, system_stock, actual_stock, discrepancy, operator)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [sessionNo, item.partId, toNumber(part.stock), item.actualStock, discrepancy, operator.trim()]);

      if (discrepancy !== 0) {
        await client.query("UPDATE parts SET stock = $1 WHERE id = $2", [item.actualStock, item.partId]);
        await client.query(`
          INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
          VALUES ($1, $2, $3, $4)
        `, [
          item.partId,
          discrepancy > 0 ? "in" : "out",
          Math.abs(discrepancy),
          `Audit ${sessionNo} reconciliation`,
        ]);
        discrepancies.push({
          partId: item.partId,
          partName: part.name,
          discrepancy,
        });
      }
    }
  });

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

app.get("/api/inventory-movements", async (_req, res) => {
  res.json(await readModels.pgGetRecentMovements());
});

app.post("/api/inventory/inbound-batch", async (req, res) => {
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

  const itemsWithParts = [];
  for (const item of normalizedItems) {
    const part = await pgOne(`
        SELECT
          id,
          name,
          sku,
          stock,
          reorder_level AS "reorderLevel",
          unit_price AS "unitPrice",
          cost_price AS "costPrice",
          supplier
        FROM parts
        WHERE id = $1
      `, [item.partId]);
    if (!part) {
      itemsWithParts.push(null);
      continue;
    }
    itemsWithParts.push({
      ...item,
      part: {
        ...part,
        stock: toNumber(part.stock),
        reorderLevel: toNumber(part.reorderLevel),
        unitPrice: toNumber(part.unitPrice),
        costPrice: toNumber(part.costPrice),
      },
      purchaseValueVuv: Math.round(item.sourceUnitPrice * item.quantity * (sourceCurrency === "CNY" ? exchangeRate : 1)),
    });
  }

  if (itemsWithParts.some((item) => !item)) {
    res.status(404).json({ message: "One or more parts were not found" });
    return;
  }

  const safeItems = itemsWithParts;
  const totalExtraFees = shippingFee + customsFee + declarationFee + otherFee;
  const allocatedExtras = allocateBatchExtraFees(safeItems, totalExtraFees);
  const batchNo = await pgGetNextInboundBatchNo();

  const responsePayload = await pgWithTransaction(async (client) => {
      const batchInserted = await client.query(`
        INSERT INTO inbound_batches (
          batch_no,
          source_currency,
          exchange_rate,
          shipping_fee,
          customs_fee,
          declaration_fee,
          other_fee,
          note
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [batchNo, sourceCurrency, exchangeRate, shippingFee, customsFee, declarationFee, otherFee, note]);
      const batchId = Number(batchInserted.rows[0]?.id);

      const savedItems = [];
      for (let index = 0; index < safeItems.length; index += 1) {
        const item = safeItems[index];
        const allocatedExtra = allocatedExtras[index] ?? 0;
        const totalLandedCost = item.purchaseValueVuv + allocatedExtra;
        const landedUnitCost = Math.round(totalLandedCost / item.quantity);
        const supplierName = item.supplierName || item.part.supplier || "";

        await client.query(`
          INSERT INTO inbound_batch_items (
            batch_id,
            part_id,
            quantity,
            supplier_name,
            source_unit_price,
            landed_unit_cost
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `, [batchId, item.partId, item.quantity, supplierName, item.sourceUnitPrice, landedUnitCost]);

        await client.query(`
          UPDATE parts
          SET
            stock = stock + $1,
            cost_price = $2,
            supplier = CASE WHEN $3 != '' THEN $4 ELSE supplier END
          WHERE id = $5
        `, [item.quantity, landedUnitCost, supplierName, supplierName, item.partId]);

        await client.query(`
          INSERT INTO inventory_movements (part_id, movement_type, quantity, note)
          VALUES ($1, 'in', $2, $3)
        `, [
          item.partId,
          item.quantity,
          `Inbound Batch ${batchNo} · ${sourceCurrency} ${item.sourceUnitPrice}/件 · 快递 ${Math.round(allocatedExtra > 0 ? shippingFee * (item.purchaseValueVuv / Math.max(safeItems.reduce((sum, row) => sum + row.purchaseValueVuv, 0), 1)) : 0)} · 落地 ${formatMoney(landedUnitCost)}/件`,
        ]);

        savedItems.push({
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
        });
      }

      const parts = [];
      for (const item of savedItems) {
        parts.push(readModels.mapPart(await readModels.pgGetPartById(item.partId)));
      }

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
        parts,
      };
    });

  appendAuditLog({
    actor: "Warehouse Clerk",
    type: "Inbound Batch",
    tone: "success",
    message: `Recorded inbound batch ${batchNo}`,
    meta: `${responsePayload.items.length} 项 · ${responsePayload.totalExtraFeesFormatted}`,
  });

  res.status(201).json(responsePayload);
});

app.get("/api/staff/performance", async (_req, res) => {
  const rows = await readModels.pgGetStaffPerformanceRows();
  res.json({
    rows,
    topPerformer: rows[0] ?? null,
  });
});

app.get("/api/finance/report", async (req, res) => {
  const type = String(req.query.type ?? "all");
  const base = await readModels.pgGetFinanceReport();

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

if (!isVercelRuntime) {
  startStandaloneServer();
}

export default app;

