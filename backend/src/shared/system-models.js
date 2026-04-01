export function createSystemModels({
  pgQuery,
  formatChatTimestamp,
  formatMoney,
  getTodayDateKey,
  toNumber,
  readModels,
}) {
  async function pgGetNextSerialValue(tableName, columnName, prefix, seed = 20260000) {
    const rows = await pgQuery(`SELECT ${columnName} AS value FROM ${tableName}`);
    const maxNumeric = rows.reduce((currentMax, row) => {
      const match = /(\d+)$/.exec(String(row.value ?? ""));
      return Math.max(currentMax, match ? Number(match[1]) : 0);
    }, seed);
    return `${prefix}-${maxNumeric + 1}`;
  }

  async function pgGetNextProcurementNo() {
    return pgGetNextSerialValue("procurements", "procurement_no", "PO");
  }

  async function pgGetNextInboundBatchNo() {
    return pgGetNextSerialValue("inbound_batches", "batch_no", "IB");
  }

  async function pgGetNextAuditSessionNo() {
    return pgGetNextSerialValue("inventory_audits", "session_no", "AD");
  }

  async function pgGetNextIntakeCode() {
    return pgGetNextSerialValue("order_intake", "intake_code", "IN");
  }

  async function pgGetNextOrderNo() {
    const rows = await pgQuery(`SELECT order_no AS value FROM orders`);
    const maxNumeric = rows.reduce((currentMax, row) => {
      const match = /(\d+)$/.exec(String(row.value ?? ""));
      return Math.max(currentMax, match ? Number(match[1]) : 0);
    }, 0);
    return `RO-${maxNumeric + 1}`;
  }

  async function pgGetRefundRows() {
    const rows = await pgQuery(`
      SELECT
        r.id,
        r.order_id AS "orderId",
        r.amount,
        r.reason,
        r.method,
        r.status,
        r.created_at AS "createdAt",
        o.order_no AS "orderNo",
        o.title,
        o.scheduled_date AS "scheduledDate",
        c.name AS "customerName"
      FROM refunds r
      JOIN orders o ON o.id = r.order_id
      JOIN customers c ON c.id = o.customer_id
      ORDER BY r.id DESC
    `);

    return rows.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      amountFormatted: formatMoney(toNumber(row.amount)),
      createdLabel: formatChatTimestamp(row.createdAt),
    }));
  }

  async function pgGetReviewRows() {
    const rows = await pgQuery(`
      SELECT
        rv.id,
        rv.order_id AS "orderId",
        rv.rating,
        rv.review,
        rv.reply,
        rv.created_at AS "createdAt",
        o.order_no AS "orderNo",
        o.scheduled_date AS "scheduledDate",
        c.name AS "customerName"
      FROM reviews rv
      JOIN orders o ON o.id = rv.order_id
      JOIN customers c ON c.id = o.customer_id
      ORDER BY rv.id DESC
    `);

    return rows.map((row) => ({
      ...row,
      rating: toNumber(row.rating),
      createdLabel: formatChatTimestamp(row.createdAt),
      status: row.reply ? "已回复" : "待回复",
    }));
  }

  function appendAuditLog({ actor, type, tone = "primary", message, meta = "" }) {
    pgQuery(`
      INSERT INTO audit_logs (actor, type, tone, message, meta)
      VALUES ($1, $2, $3, $4, $5)
    `, [actor, type, tone, message, meta]).catch((error) => {
      console.error("Failed to append audit log:", error?.message ?? error);
    });
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

  async function pgGetAuditLogs() {
    const rows = await pgQuery(`
      SELECT
        id,
        actor,
        type,
        tone,
        message,
        meta,
        created_at AS "createdAt"
      FROM audit_logs
      ORDER BY id DESC
      LIMIT 50
    `);

    return rows.map((row) => ({
      ...row,
      meta: row.meta ? `${formatChatTimestamp(row.createdAt)} · ${row.meta}` : formatChatTimestamp(row.createdAt),
    }));
  }

  async function pgBuildNotifications() {
    const [readRows, lowStockParts, recentOrders, recentAuditLogs] = await Promise.all([
      pgQuery(`SELECT notification_id AS "notificationId" FROM notification_reads`),
      pgQuery(`
        SELECT id, name, sku, stock, reorder_level AS "reorderLevel"
        FROM parts
        WHERE stock <= reorder_level
        ORDER BY stock ASC, name ASC
        LIMIT 3
      `),
      pgQuery(`
        SELECT
          o.id,
          o.order_no AS "orderNo",
          o.status,
          o.created_at AS "createdAt",
          o.scheduled_date AS "scheduledDate",
          c.name AS "customerName"
        FROM orders o
        JOIN customers c ON c.id = o.customer_id
        ORDER BY o.id DESC
        LIMIT 4
      `),
      pgQuery(`
        SELECT id, type, tone, message, created_at AS "createdAt"
        FROM audit_logs
        ORDER BY id DESC
        LIMIT 4
      `),
    ]);

    const readIds = new Set(readRows.map((row) => row.notificationId));
    const todayKey = getTodayDateKey();
    const notifications = [];

    lowStockParts.forEach((part) => {
      notifications.push({
        id: `inventory-${part.id}`,
        category: "inventory",
        title: "库存预警",
        body: `${part.name} 当前库存 ${toNumber(part.stock)}，低于补货阈值 ${toNumber(part.reorderLevel)}。`,
        tone: toNumber(part.stock) <= 2 ? "warning" : "secondary",
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
        body: `订单 #${order.orderNo} (${order.customerName}) 当前状态：${readModels.statusMeta[order.status]?.label ?? order.status}。`,
        tone: order.status === "completed" || order.status === "picked_up" ? "success" : "primary",
        tag: order.status === "completed" || order.status === "picked_up" ? "已完工" : "新订单",
        time: formatChatTimestamp(order.createdAt),
        link: `/orders/${order.orderNo ?? order.id}`,
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

  return {
    pgGetNextSerialValue,
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
  };
}
