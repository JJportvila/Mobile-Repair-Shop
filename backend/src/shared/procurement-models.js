export function createProcurementModels({
  pgOne,
  pgQuery,
  formatChatTimestamp,
  formatMoney,
  toNumber,
  calculateProcurementCosting,
  readModels,
}) {
  async function pgGetSuppliers() {
    const rows = await pgQuery(`
      SELECT
        supplier,
        COUNT(*) AS "partCount",
        COALESCE(SUM(stock * unit_price), 0) AS "procurementValue",
        SUM(CASE WHEN stock <= reorder_level THEN 1 ELSE 0 END) AS "lowStockItems"
      FROM parts
      GROUP BY supplier
      ORDER BY COALESCE(SUM(stock * unit_price), 0) DESC, supplier ASC
    `);

    return rows.map((row, index) => ({
      id: `SUP-${index + 1}`,
      name: row.supplier,
      manager: index === 0 ? "Jean Kalmet" : index === 1 ? "Marie Noah" : "Supplier Lead",
      phone: index === 0 ? "+678 555 3001" : index === 1 ? "+678 555 3018" : "+678 555 3099",
      tag: index === 0 ? "核心伙伴" : toNumber(row.lowStockItems) > 0 ? "待评估" : "常规",
      categories: index === 0 ? ["Screens", "Assemblies"] : index === 1 ? ["Batteries", "Flex Cables"] : ["Parts"],
      partCount: toNumber(row.partCount),
      procurementValue: toNumber(row.procurementValue),
      procurementValueFormatted: formatMoney(toNumber(row.procurementValue)),
      lowStockItems: toNumber(row.lowStockItems),
    }));
  }

  async function pgGetSupplierHistory() {
    const suppliers = await pgGetSuppliers();
    const stored = await pgQuery(`
      SELECT
        pr.procurement_no AS "procurementNo",
        pr.supplier,
        pr.status,
        pr.created_at AS "createdAt",
        pr.quantity,
        pr.unit_price AS "unitPrice",
        p.name AS "partName"
      FROM procurements pr
      JOIN parts p ON p.id = pr.part_id
      ORDER BY pr.id DESC
    `);

    if (stored.length) {
      return stored.map((row) => ({
        id: row.procurementNo,
        supplierName: row.supplier,
        date: formatChatTimestamp(row.createdAt).slice(0, 10),
        amountFormatted: formatMoney(toNumber(row.quantity) * toNumber(row.unitPrice)),
        status: row.status,
        partName: row.partName,
        supplierId: suppliers.find((item) => item.name === row.supplier)?.id ?? "SUP-1",
      }));
    }

    const fallbackRows = await pgQuery(`
      SELECT
        supplier,
        name AS "partName",
        unit_price AS amount,
        stock,
        id
      FROM parts
      ORDER BY unit_price DESC, id ASC
      LIMIT 6
    `);

    return fallbackRows.map((row, index) => ({
      id: `PO-${20260000 + index + 1}`,
      supplierName: row.supplier,
      date: `2026-03-${String(31 - index).padStart(2, "0")}`,
      amountFormatted: formatMoney(toNumber(row.amount) * Math.max(1, toNumber(row.stock))),
      status: index % 2 === 0 ? "已交付" : "运输中",
      partName: row.partName,
      supplierId: suppliers.find((item) => item.name === row.supplier)?.id ?? "SUP-1",
    }));
  }

  async function pgGetSupplierById(id) {
    const suppliers = await pgGetSuppliers();
    const supplier = suppliers.find((item) => item.id === id);

    if (!supplier) {
      return null;
    }

    const productRows = await pgQuery(`
      SELECT
        id,
        name,
        sku,
        stock,
        reorder_level AS "reorderLevel",
        unit_price AS "unitPrice",
        cost_price AS "costPrice"
      FROM parts
      WHERE supplier = $1
      ORDER BY unit_price DESC, name ASC
    `, [supplier.name]);
    const recentOrders = (await pgGetSupplierHistory()).filter((item) => item.supplierName === supplier.name);

    return {
      ...supplier,
      companyEnglishName: supplier.name.toUpperCase(),
      yearsOfCooperation: 5,
      rating: 5,
      city: "维拉港工业区",
      address: "维拉港 Teouma 街 42 号",
      email: `${supplier.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "")}@supplier.vu`,
      notes: `${supplier.name} 是当前最稳定的 ${supplier.categories.join(" / ")} 供应商，交付速度和配件一致性都维持在高水平。`,
      products: productRows.map((row) => ({
        ...readModels.mapPart({
          ...row,
          stock: toNumber(row.stock),
          reorderLevel: toNumber(row.reorderLevel),
          unitPrice: toNumber(row.unitPrice),
          costPrice: toNumber(row.costPrice),
        }),
        stockStatus: toNumber(row.stock) <= toNumber(row.reorderLevel) ? "低库存" : "库存充足",
      })),
      recentOrders,
    };
  }

  async function pgGetProcurementById(id) {
    const historyItem = (await pgGetSupplierHistory()).find((item) => item.id === id);

    if (!historyItem) {
      return null;
    }

    const procurementRow = await pgOne(`
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
        status,
        created_at AS "createdAt"
      FROM procurements
      WHERE procurement_no = $1
    `, [id]);

    const suppliers = await pgGetSuppliers();
    const supplier = suppliers.find((item) => item.name === historyItem.supplierName);
    const items = procurementRow
      ? await pgQuery(`
        SELECT
          id,
          name,
          sku,
          stock,
          unit_price AS "unitPrice"
        FROM parts
        WHERE id = $1
      `, [procurementRow.partId])
      : await pgQuery(`
        SELECT
          id,
          name,
          sku,
          stock,
          unit_price AS "unitPrice"
        FROM parts
        WHERE supplier = $1
        ORDER BY unit_price DESC, id ASC
        LIMIT 3
      `, [historyItem.supplierName]);

    const rows = items.map((item, index) => {
      const quantity = procurementRow ? toNumber(procurementRow.quantity) : Math.max(1, Math.min(12, toNumber(item.stock) + index + 1));
      const unitPrice = procurementRow ? toNumber(procurementRow.unitPrice) : toNumber(item.unitPrice);
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
      quantity: toNumber(procurementRow?.quantity ?? rows[0]?.quantity ?? 1),
      sourceUnitPrice: Number(procurementRow?.sourceUnitPrice ?? procurementRow?.unitPrice ?? rows[0]?.unitPrice ?? 0),
      exchangeRate: Number(procurementRow?.exchangeRate ?? 1),
      shippingFee: toNumber(procurementRow?.shippingFee),
      customsFee: toNumber(procurementRow?.customsFee),
      otherFee: toNumber(procurementRow?.otherFee),
    });

    return {
      procurementNo: id,
      supplierId: supplier?.id ?? historyItem.supplierId,
      supplierName: historyItem.supplierName,
      status,
      orderDate,
      expectedArrival: isDelivered ? orderDate : "2026-04-07",
      totalAmount,
      totalAmountFormatted: formatMoney(totalAmount),
      shippingMethod: "Air Freight",
      trackingNo: `VLI-${String(id).slice(-4)}`,
      warehouseNote: isDelivered ? "已完成入库并同步库存" : "等待供应商发货确认",
      sourceCurrency: procurementRow?.sourceCurrency ?? "CNY",
      sourceUnitPrice: Number(procurementRow?.sourceUnitPrice ?? procurementRow?.unitPrice ?? rows[0]?.unitPrice ?? 0),
      exchangeRate: Number(procurementRow?.exchangeRate ?? 1),
      shippingFee: costing.shippingFee,
      customsFee: costing.customsFee,
      otherFee: costing.otherFee,
      items: rows,
      costing,
    };
  }

  return {
    pgGetSuppliers,
    pgGetSupplierHistory,
    pgGetSupplierById,
    pgGetProcurementById,
  };
}
