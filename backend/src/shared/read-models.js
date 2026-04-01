import {
  buildPgOrderFilters,
  calculateProcurementCosting,
  formatChatTimestamp,
  formatCny,
  formatMoney,
  getTodayDateKey,
  toNumber,
} from "./common.js";
import {
  diffMinutesFromNow,
  formatElapsedMinutes,
  queuePriorityForOrder,
  queueProgressByStatus,
  sanitizeIssueSummary,
  sanitizeOrderTitle,
} from "./order-display.js";
import { getDefaultCommunicationMessages } from "./order-workflow.js";

export function createReadModels({ pgOne, pgQuery, pgGetSuppliers }) {
  const statusMeta = {
    pending: { label: "待处理", tone: "warning" },
    in_progress: { label: "维修中", tone: "primary" },
    completed: { label: "已完成", tone: "success" },
    picked_up: { label: "已取件", tone: "neutral" },
  };

  const baseOrderSelect = `
    SELECT
      o.id,
      o.order_no AS "orderNo",
      o.title,
      o.device_name AS "deviceName",
      o.status,
      o.technician,
      o.scheduled_date AS "scheduledDate",
      o.amount,
      o.deposit,
      o.issue_summary AS "issueSummary",
      o.notes,
      c.id AS "customerId",
      c.name AS "customerName",
      c.phone AS "customerPhone",
      c.email AS "customerEmail",
      c.tier AS "customerTier"
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
  `;

  function mapOrder(order) {
    const id = toNumber(order.id, order.id);
    const customerId = toNumber(order.customerId, order.customerId);
    const amount = toNumber(order.amount);
    const deposit = toNumber(order.deposit);
    const balanceDue = Math.max(0, amount - deposit);
    return {
      ...order,
      id,
      customerId,
      amount,
      deposit,
      title: sanitizeOrderTitle(order),
      issueSummary: sanitizeIssueSummary(order),
      statusMeta: statusMeta[order.status] ?? { label: order.status, tone: "neutral" },
      amountFormatted: formatMoney(amount),
      depositFormatted: formatMoney(deposit),
      balanceDue,
      balanceDueFormatted: formatMoney(balanceDue),
    };
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

  async function pgGetOrderById(id) {
    const raw = String(id ?? "").trim();
    if (!raw) return null;

    const byOrderNo = await pgOne(`${baseOrderSelect} WHERE o.order_no = $1`, [raw]);
    if (byOrderNo) return byOrderNo;

    if (/^\d+$/.test(raw)) {
      return pgOne(`${baseOrderSelect} WHERE o.id = $1`, [Number(raw)]);
    }

    return null;
  }

  async function pgGetOrderParts(orderId) {
    return pgQuery(`
      SELECT
        p.id,
        p.name,
        p.sku,
        op.quantity,
        op.unit_price AS "unitPrice",
        op.quantity * op.unit_price AS subtotal
      FROM order_parts op
      JOIN parts p ON p.id = op.part_id
      WHERE op.order_id = $1
      ORDER BY p.name ASC
    `, [orderId]);
  }

  async function pgGetStoredPhotos(orderId) {
    return pgQuery(`
      SELECT
        id,
        stage,
        image_url AS image,
        note,
        created_at AS "createdAt"
      FROM order_photos
      WHERE order_id = $1
      ORDER BY id DESC
    `, [orderId]);
  }

  async function pgGetOrderIntake(orderId) {
    return pgOne(`
      SELECT
        order_id AS "orderId",
        intake_code AS "intakeCode",
        imei_serial AS "imeiSerial",
        customer_signature AS "customerSignature",
        created_at AS "createdAt"
      FROM order_intake
      WHERE order_id = $1
    `, [orderId]);
  }

  async function pgGetRepairQueue(status = "all", search = "") {
    const { whereClause, params } = buildPgOrderFilters(status, search);
    const rows = await pgQuery(`${baseOrderSelect} ${whereClause} ORDER BY o.scheduled_date DESC, o.id DESC`, params);

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
        revenueEstimate: formatMoney(queueRows.reduce((sum, item) => sum + Number(item.amount), 0)),
      },
      rows: queueRows,
    };
  }

  async function pgGetCustomerAvatar(customerId) {
    const row = await pgOne(`
      SELECT
        op.image_url AS "imageUrl"
      FROM order_photos op
      JOIN orders o ON o.id = op.order_id
      WHERE o.customer_id = $1
        AND op.stage = '客户照片'
      ORDER BY op.id DESC
      LIMIT 1
    `, [customerId]);

    return row?.imageUrl ?? null;
  }

  async function pgGetFollowupRows(customerId) {
    const rows = await pgQuery(`
      SELECT
        f.id,
        f.customer_id AS "customerId",
        f.order_id AS "orderId",
        f.channel,
        f.note,
        f.created_at AS "createdAt",
        o.order_no AS "orderNo"
      FROM customer_followups f
      LEFT JOIN orders o ON o.id = f.order_id
      WHERE f.customer_id = $1
      ORDER BY f.id DESC
    `, [customerId]);

    return rows.map((row) => ({
      ...row,
      createdLabel: formatChatTimestamp(row.createdAt),
    }));
  }

  async function pgGetCustomers() {
    const rows = await pgQuery(`
      SELECT
        c.id,
        c.name,
        c.phone,
        c.email,
        c.tier,
        COUNT(o.id) AS "orderCount",
        COALESCE(SUM(o.amount), 0) AS "lifetimeValue"
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id
      ORDER BY COALESCE(SUM(o.amount), 0) DESC, c.name ASC
    `);

    return Promise.all(rows.map(async (row) => ({
      ...row,
      orderCount: toNumber(row.orderCount),
      lifetimeValue: toNumber(row.lifetimeValue),
      avatarPhoto: await pgGetCustomerAvatar(row.id),
      lifetimeValueFormatted: formatMoney(toNumber(row.lifetimeValue)),
    })));
  }

  async function pgGetCustomerById(customerId) {
    const customer = await pgOne(`
      SELECT
        c.id,
        c.name,
        c.phone,
        c.email,
        c.tier,
        MIN(o.scheduled_date) AS "registeredSince",
        COUNT(o.id) AS "orderCount",
        COALESCE(SUM(o.amount), 0) AS "lifetimeValue"
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      WHERE c.id = $1
      GROUP BY c.id
    `, [customerId]);

    if (!customer) return null;

    const records = await pgQuery(`
      SELECT
        o.id,
        o.order_no AS "orderNo",
        o.title,
        o.device_name AS "deviceName",
        o.status,
        o.scheduled_date AS "scheduledDate",
        o.amount
      FROM orders o
      WHERE o.customer_id = $1
      ORDER BY o.scheduled_date DESC, o.id DESC
    `, [customerId]);

    return {
      ...customer,
      orderCount: toNumber(customer.orderCount),
      lifetimeValue: toNumber(customer.lifetimeValue),
      avatarPhoto: await pgGetCustomerAvatar(customer.id),
      address: customer.id % 2 === 0 ? "利尼大道，维拉港" : "库穆大道，维拉港",
      registeredSince: customer.registeredSince ?? "2026-01-01",
      customerRank: toNumber(customer.lifetimeValue) >= 30000 ? "高价值客户" : "标准客户",
      lifetimeValueFormatted: formatMoney(toNumber(customer.lifetimeValue)),
      records: records.map((row) => ({
        ...row,
        amount: toNumber(row.amount),
        amountFormatted: formatMoney(toNumber(row.amount)),
        statusMeta: statusMeta[row.status] ?? { label: row.status, tone: "neutral" },
        serviceTag: sanitizeOrderTitle(row),
      })),
    };
  }

  async function pgGetCustomerHistory(customerId) {
    const customer = await pgOne(`
      SELECT
        c.id,
        c.name,
        COUNT(o.id) AS "totalOrders",
        COALESCE(SUM(o.amount), 0) AS "totalSpend",
        SUM(CASE WHEN o.status = 'completed' OR o.status = 'picked_up' THEN 1 ELSE 0 END) AS "completedOrders"
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      WHERE c.id = $1
      GROUP BY c.id
    `, [customerId]);

    if (!customer) return null;

    const records = await pgQuery(`
      SELECT
        o.id,
        o.order_no AS "orderNo",
        o.device_name AS "deviceName",
        o.title,
        o.status,
        o.scheduled_date AS "scheduledDate",
        o.amount
      FROM orders o
      WHERE o.customer_id = $1
      ORDER BY o.scheduled_date DESC, o.id DESC
    `, [customerId]);

    return {
      ...customer,
      totalOrders: toNumber(customer.totalOrders),
      totalSpend: toNumber(customer.totalSpend),
      completedOrders: toNumber(customer.completedOrders),
      avatarPhoto: await pgGetCustomerAvatar(customer.id),
      totalSpendFormatted: formatMoney(toNumber(customer.totalSpend)),
      followups: await pgGetFollowupRows(customerId),
      records: records.map((row) => ({
        ...row,
        amount: toNumber(row.amount),
        title: sanitizeOrderTitle(row),
        amountFormatted: formatMoney(toNumber(row.amount)),
        statusMeta: statusMeta[row.status] ?? { label: row.status, tone: "neutral" },
        serviceTag: sanitizeOrderTitle(row),
      })),
    };
  }

  async function pgGetParts() {
    const rows = await pgQuery(`
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
      ORDER BY stock ASC, name ASC
    `);

    return rows.map((row) => mapPart({
      ...row,
      stock: toNumber(row.stock),
      reorderLevel: toNumber(row.reorderLevel),
      unitPrice: toNumber(row.unitPrice),
      costPrice: toNumber(row.costPrice),
    }));
  }

  async function pgGetPartById(id) {
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
    `, [id]);

    if (!part) return null;

    const movementHistory = await pgQuery(`
      SELECT id, movement_type AS "movementType", quantity, note, created_at AS "createdAt"
      FROM inventory_movements
      WHERE part_id = $1
      ORDER BY id DESC
      LIMIT 8
    `, [id]);

    const orderUsage = await pgQuery(`
      SELECT
        o.id,
        o.order_no AS "orderNo",
        o.device_name AS "deviceName",
        o.scheduled_date AS "scheduledDate",
        op.quantity,
        op.quantity * op.unit_price AS "totalAmount"
      FROM order_parts op
      JOIN orders o ON o.id = op.order_id
      WHERE op.part_id = $1
      ORDER BY o.scheduled_date DESC, o.id DESC
    `, [id]);

    const recentProcurements = await pgQuery(`
      SELECT
        procurement_no AS "procurementNo",
        supplier,
        quantity,
        unit_price AS "unitPrice",
        source_currency AS "sourceCurrency",
        source_unit_price AS "sourceUnitPrice",
        exchange_rate AS "exchangeRate",
        shipping_fee AS "shippingFee",
        customs_fee AS "customsFee",
        other_fee AS "otherFee",
        status,
        created_at AS "createdAt"
      FROM procurements
      WHERE part_id = $1
      ORDER BY id DESC
      LIMIT 5
    `, [id]);

    const inboundBatchHistory = await pgQuery(`
      SELECT
        ib.batch_no AS "batchNo",
        ibi.quantity,
        ibi.supplier_name AS "supplierName",
        ibi.source_unit_price AS "sourceUnitPrice",
        ibi.landed_unit_cost AS "landedUnitCost",
        ib.source_currency AS "sourceCurrency",
        ib.exchange_rate AS "exchangeRate",
        ib.shipping_fee AS "shippingFee",
        ib.customs_fee AS "customsFee",
        ib.declaration_fee AS "declarationFee",
        ib.other_fee AS "otherFee",
        ib.created_at AS "createdAt"
      FROM inbound_batch_items ibi
      JOIN inbound_batches ib ON ib.id = ibi.batch_id
      WHERE ibi.part_id = $1
      ORDER BY ibi.id DESC
      LIMIT 10
    `, [id]);

    const suppliers = await pgGetSuppliers();
    const supplierId = suppliers.find((item) => item.name === part.supplier)?.id ?? "SUP-1";
    const normalizedPart = mapPart({
      ...part,
      stock: toNumber(part.stock),
      reorderLevel: toNumber(part.reorderLevel),
      unitPrice: toNumber(part.unitPrice),
      costPrice: toNumber(part.costPrice),
    });

    return {
      ...normalizedPart,
      supplierId,
      location: `Rack A-${String(normalizedPart.id).padStart(2, "0")}-0${(Number(normalizedPart.id) % 5) + 1}`,
      stockTurnover: `${(1 + Number(normalizedPart.stock) / Math.max(normalizedPart.reorderLevel, 1)).toFixed(1)}x`,
      stockStatus: Number(normalizedPart.stock) <= Number(normalizedPart.reorderLevel) ? "低库存" : "库存充足",
      movementHistory: movementHistory.map((row) => ({ ...row, quantity: toNumber(row.quantity) })),
      recentProcurements: recentProcurements.map((row) => ({
        ...row,
        quantity: toNumber(row.quantity),
        unitPrice: toNumber(row.unitPrice),
        sourceUnitPrice: toNumber(row.sourceUnitPrice),
        exchangeRate: Number(row.exchangeRate ?? 1),
        shippingFee: toNumber(row.shippingFee),
        customsFee: toNumber(row.customsFee),
        otherFee: toNumber(row.otherFee),
        supplierId,
        unitPriceFormatted: formatMoney(toNumber(row.unitPrice)),
        landedUnitCostFormatted: formatMoney(toNumber(row.unitPrice)),
      })),
      inboundBatchHistory: inboundBatchHistory.map((row) => ({
        ...row,
        quantity: toNumber(row.quantity),
        sourceUnitPrice: Number(row.sourceUnitPrice ?? 0),
        landedUnitCost: toNumber(row.landedUnitCost),
        exchangeRate: Number(row.exchangeRate ?? 1),
        shippingFee: toNumber(row.shippingFee),
        customsFee: toNumber(row.customsFee),
        declarationFee: toNumber(row.declarationFee),
        otherFee: toNumber(row.otherFee),
        sourceUnitPriceFormatted: row.sourceCurrency === "CNY" ? formatCny(row.sourceUnitPrice) : formatMoney(toNumber(row.sourceUnitPrice)),
        landedUnitCostFormatted: formatMoney(toNumber(row.landedUnitCost)),
        shippingFeeFormatted: formatMoney(toNumber(row.shippingFee)),
        customsFeeFormatted: formatMoney(toNumber(row.customsFee)),
        declarationFeeFormatted: formatMoney(toNumber(row.declarationFee)),
        otherFeeFormatted: formatMoney(toNumber(row.otherFee)),
        createdLabel: formatChatTimestamp(row.createdAt),
      })),
      orderUsage: orderUsage.map((row) => ({
        ...row,
        quantity: toNumber(row.quantity),
        totalAmount: toNumber(row.totalAmount),
        totalAmountFormatted: formatMoney(toNumber(row.totalAmount)),
      })),
    };
  }

  async function pgGetRecentMovements() {
    const rows = await pgQuery(`
      SELECT
        m.id,
        m.part_id AS "partId",
        p.name AS "partName",
        p.sku,
        m.movement_type AS "movementType",
        m.quantity,
        m.note,
        m.created_at AS "createdAt"
      FROM inventory_movements m
      JOIN parts p ON p.id = m.part_id
      ORDER BY m.id DESC
      LIMIT 8
    `);

    return rows.map((row) => ({ ...row, quantity: toNumber(row.quantity) }));
  }

  async function pgGetStaffPerformanceRows() {
    const rows = await pgQuery(`
      SELECT
        technician AS "staffName",
        COUNT(*) AS "completedOrders",
        COALESCE(SUM(amount), 0) AS "totalRevenue",
        ROUND(AVG(CASE WHEN status = 'completed' THEN 38 ELSE 45 END), 0) AS "avgRepairMinutes",
        ROUND(AVG(CASE WHEN status = 'completed' THEN 4.9 ELSE 4.6 END), 1) AS rating
      FROM orders
      GROUP BY technician
      ORDER BY COALESCE(SUM(amount), 0) DESC, COUNT(*) DESC
    `);

    return rows.map((row, index) => ({
      staffId: `TECH-${index + 1}`,
      staffName: row.staffName,
      completedOrders: toNumber(row.completedOrders),
      totalRevenue: toNumber(row.totalRevenue),
      totalRevenueFormatted: formatMoney(toNumber(row.totalRevenue)),
      avgRepairMinutes: toNumber(row.avgRepairMinutes),
      rating: Number(row.rating ?? 0),
      rank: index + 1,
    }));
  }

  async function pgGetFinanceReport() {
    const totals = await pgOne(`
      SELECT
        COUNT(*) AS "totalOrders",
        COALESCE(SUM(amount), 0) AS "totalRevenue",
        COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE amount * 0.85 END), 0) AS "settledRevenue"
      FROM orders
    `);

    const rows = await pgQuery(`
      SELECT
        id,
        order_no AS "orderNo",
        title,
        device_name AS "deviceName",
        status,
        scheduled_date AS "scheduledDate",
        amount
      FROM orders
      ORDER BY scheduled_date DESC, id DESC
    `);

    const normalizedRows = rows.map((row) => ({ ...row, amount: toNumber(row.amount) }));
    const todayKey = getTodayDateKey();
    const totalOrders = toNumber(totals?.totalOrders);
    const totalRevenue = toNumber(totals?.totalRevenue);
    const settledRevenue = toNumber(totals?.settledRevenue);
    const todayRevenue = normalizedRows.filter((row) => row.scheduledDate === todayKey).reduce((sum, row) => sum + row.amount, 0);
    const completedOrders = normalizedRows.filter((row) => row.status === "completed" || row.status === "picked_up").length;
    const averageTicket = totalOrders ? Math.round(totalRevenue / totalOrders) : 0;

    const byChannel = [
      { channel: "现金", amount: Math.round(totalRevenue * 0.36) },
      { channel: "银行转账", amount: Math.round(totalRevenue * 0.55) },
      { channel: "支票", amount: Math.round(totalRevenue * 0.09) },
    ];

    const categoryMap = new Map([["Smartphone", 0], ["Laptop", 0], ["Tablet", 0], ["Other", 0]]);
    const serviceMap = new Map();

    normalizedRows.forEach((row) => {
      const device = String(row.deviceName ?? "").toLowerCase();
      const title = sanitizeOrderTitle(row).toLowerCase();
      let category = "Other";
      if (device.includes("iphone") || device.includes("phone") || device.includes("galaxy") || device.includes("pixel")) category = "Smartphone";
      else if (device.includes("macbook") || device.includes("laptop")) category = "Laptop";
      else if (device.includes("ipad") || device.includes("tablet")) category = "Tablet";
      categoryMap.set(category, categoryMap.get(category) + row.amount);

      let service = "综合维修";
      if (title.includes("screen") || title.includes("lcd")) service = "屏幕维修";
      else if (title.includes("battery")) service = "电池服务";
      else if (title.includes("camera")) service = "摄像头维修";
      else if (title.includes("water")) service = "进液损坏";
      serviceMap.set(service, (serviceMap.get(service) ?? 0) + row.amount);
    });

    const categories = Array.from(categoryMap.entries()).map(([name, amount]) => ({
      name,
      amount,
      amountFormatted: formatMoney(amount),
      percent: totalRevenue ? Math.round((amount / totalRevenue) * 100) : 0,
    }));

    const topServices = Array.from(serviceMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, amount]) => ({
      name,
      amount,
      amountFormatted: formatMoney(amount),
    }));

    return {
      summary: {
        totalOrders,
        totalRevenue,
        totalRevenueFormatted: formatMoney(totalRevenue),
        settledRevenue,
        settledRevenueFormatted: formatMoney(settledRevenue),
        todayRevenue,
        todayRevenueFormatted: formatMoney(todayRevenue),
        completedOrders,
        averageTicket,
        averageTicketFormatted: formatMoney(averageTicket),
      },
      byChannel: byChannel.map((item) => ({
        ...item,
        amountFormatted: formatMoney(item.amount),
        percent: totalRevenue ? Math.round((item.amount / totalRevenue) * 100) : 0,
      })),
      categories,
      topServices,
      transactions: normalizedRows.map((row) => ({
        ...row,
        title: sanitizeOrderTitle(row),
        amountFormatted: formatMoney(row.amount),
        statusMeta: statusMeta[row.status] ?? { label: row.status, tone: "neutral" },
      })),
    };
  }

  async function pgGetOrderMessages(order) {
    const stored = await pgQuery(`
      SELECT
        id,
        sender,
        type,
        body,
        meta_json AS "metaJson",
        created_at AS "createdAt"
      FROM order_messages
      WHERE order_id = $1
      ORDER BY id ASC
    `, [order.id]);

    if (stored.length) {
      return stored.map((row) => ({
        id: `db-${row.id}`,
        sender: row.sender,
        type: row.type,
        body: row.body,
        ...parseJson(row.metaJson, {}),
        time: formatChatTimestamp(row.createdAt),
      }));
    }

    return getDefaultCommunicationMessages(order);
  }

  async function pgGetOrderExecutionRecord(orderId) {
    return pgOne(`
      SELECT order_id AS "orderId", phase, checklist_json AS "checklistJson", elapsed_minutes AS "elapsedMinutes", updated_at AS "updatedAt"
      FROM order_execution
      WHERE order_id = $1
    `, [orderId]);
  }

  async function pgGetOrderCompletionRecord(orderId) {
    return pgOne(`
      SELECT order_id AS "orderId", warranty, checklist_json AS "checklistJson", final_notes AS "finalNotes", updated_at AS "updatedAt"
      FROM order_completion
      WHERE order_id = $1
    `, [orderId]);
  }

  async function pgGetReceiptMeta(orderId) {
    return pgOne(`
      SELECT order_id AS "orderId", printed_at AS "printedAt", picked_up_at AS "pickedUpAt"
      FROM receipt_meta
      WHERE order_id = $1
    `, [orderId]);
  }

  return {
    statusMeta,
    baseOrderSelect,
    mapOrder,
    mapPart,
    pgGetCustomerAvatar,
    pgGetCustomerById,
    pgGetCustomerHistory,
    pgGetCustomers,
    pgGetFinanceReport,
    pgGetFollowupRows,
    pgGetOrderById,
    pgGetOrderCompletionRecord,
    pgGetOrderExecutionRecord,
    pgGetOrderIntake,
    pgGetOrderMessages,
    pgGetOrderParts,
    pgGetPartById,
    pgGetParts,
    pgGetRecentMovements,
    pgGetReceiptMeta,
    pgGetRepairQueue,
    pgGetStaffPerformanceRows,
    pgGetStoredPhotos,
  };
}
