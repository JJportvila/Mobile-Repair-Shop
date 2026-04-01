export async function pgGetOrderFormOptionsInternal(pgQuery, includeInactive = false) {
  const activeClause = includeInactive ? "" : "WHERE is_active = 1";
  const [brands, models, technicians, issueTemplates] = await Promise.all([
    pgQuery(`
      SELECT
        id,
        name,
        market,
        is_active AS "isActive",
        sort_order AS "sortOrder"
      FROM order_form_brands
      ${activeClause}
      ORDER BY sort_order ASC, id ASC
    `),
    pgQuery(`
      SELECT
        id,
        brand_id AS "brandId",
        name,
        is_active AS "isActive",
        sort_order AS "sortOrder"
      FROM order_form_models
      ${activeClause}
      ORDER BY brand_id ASC, sort_order ASC, id ASC
    `),
    pgQuery(`
      SELECT
        id,
        name,
        is_active AS "isActive",
        sort_order AS "sortOrder"
      FROM order_form_technicians
      ${activeClause}
      ORDER BY sort_order ASC, id ASC
    `),
    pgQuery(`
      SELECT
        id,
        title,
        is_active AS "isActive",
        sort_order AS "sortOrder"
      FROM order_form_issue_templates
      ${activeClause}
      ORDER BY sort_order ASC, id ASC
    `),
  ]);

  return { brands, models, technicians, issueTemplates };
}

export async function pgGetStoreSettings(pgOne) {
  return pgOne(`
    SELECT
      store_name AS "storeName",
      store_code AS "storeCode",
      phone,
      email,
      address,
      cover_image AS "coverImage",
      updated_at AS "updatedAt"
    FROM settings_store
    WHERE id = 1
  `);
}

export async function pgGetLanguageSettings(pgOne) {
  return pgOne(`
    SELECT
      primary_language AS "primaryLanguage",
      external_language AS "externalLanguage",
      local_language AS "localLanguage",
      updated_at AS "updatedAt"
    FROM settings_language
    WHERE id = 1
  `);
}

export async function pgGetPrintSettings(pgOne) {
  const row = await pgOne(`
    SELECT
      paper_size AS "paperSize",
      qr_enabled AS "qrEnabled",
      default_receipt_enabled AS "defaultReceiptEnabled",
      footer_brand_enabled AS "footerBrandEnabled",
      updated_at AS "updatedAt"
    FROM settings_print
    WHERE id = 1
  `);

  return {
    ...row,
    qrEnabled: Boolean(row?.qrEnabled),
    defaultReceiptEnabled: Boolean(row?.defaultReceiptEnabled),
    footerBrandEnabled: Boolean(row?.footerBrandEnabled),
  };
}

export async function pgGetBusinessHoursSettings(pgQuery, pgOne) {
  const rows = await pgQuery(`
    SELECT
      id,
      day_label AS "dayLabel",
      hours_value AS "hoursValue",
      note,
      sort_order AS "sortOrder"
    FROM settings_business_hours
    ORDER BY sort_order ASC, id ASC
  `);
  const holidayRule = await pgOne(`
    SELECT
      holiday_enabled AS "holidayEnabled",
      holiday_hours AS "holidayHours",
      holiday_note AS "holidayNote"
    FROM settings_business_rules
    WHERE id = 1
  `);

  return {
    rows,
    holidayRule: {
      holidayEnabled: Boolean(holidayRule?.holidayEnabled),
      holidayHours: holidayRule?.holidayHours ?? "10:00 - 15:00",
      holidayNote: holidayRule?.holidayNote ?? "",
    },
  };
}

export async function pgGetStaffPermissionSettings(pgQuery) {
  const rows = await pgQuery(`
    SELECT
      id,
      name,
      role,
      scope,
      can_edit_orders AS "canEditOrders",
      can_adjust_inventory AS "canAdjustInventory",
      can_view_finance AS "canViewFinance",
      is_active AS "isActive",
      sort_order AS "sortOrder"
    FROM settings_staff
    ORDER BY sort_order ASC, id ASC
  `);

  return rows.map((row) => ({
    ...row,
    canEditOrders: Boolean(row.canEditOrders),
    canAdjustInventory: Boolean(row.canAdjustInventory),
    canViewFinance: Boolean(row.canViewFinance),
    isActive: Boolean(row.isActive),
  }));
}

export async function pgUpdateStoreSettings(pgQuery, payload) {
  const storeName = String(payload?.storeName ?? "").trim();
  const storeCode = String(payload?.storeCode ?? "").trim();
  const phone = String(payload?.phone ?? "").trim();
  const email = String(payload?.email ?? "").trim();
  const address = String(payload?.address ?? "").trim();
  const coverImage = String(payload?.coverImage ?? "").trim();

  if (!storeName || !storeCode || !phone || !email || !address) {
    return { error: "Store name, code, phone, email and address are required", status: 400 };
  }

  await pgQuery(`
    UPDATE settings_store
    SET store_name = $1, store_code = $2, phone = $3, email = $4, address = $5, cover_image = $6, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `, [storeName, storeCode, phone, email, address, coverImage]);

  return { data: await pgGetStoreSettings((text, params) => pgQuery(text, params).then((rows) => rows[0] ?? null)), storeName };
}

export async function pgUpdateLanguageSettings(pgQuery, payload) {
  const primaryLanguage = String(payload?.primaryLanguage ?? "").trim();
  const externalLanguage = String(payload?.externalLanguage ?? "").trim();
  const localLanguage = String(payload?.localLanguage ?? "").trim();

  if (!primaryLanguage || !externalLanguage || !localLanguage) {
    return { error: "Language settings are required", status: 400 };
  }

  await pgQuery(`
    UPDATE settings_language
    SET primary_language = $1, external_language = $2, local_language = $3, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `, [primaryLanguage, externalLanguage, localLanguage]);

  return {
    data: await pgGetLanguageSettings((text, params) => pgQuery(text, params).then((rows) => rows[0] ?? null)),
    primaryLanguage,
  };
}

export async function pgUpdatePrintSettings(pgQuery, payload) {
  const paperSize = String(payload?.paperSize ?? "").trim();
  const qrEnabled = payload?.qrEnabled ? 1 : 0;
  const defaultReceiptEnabled = payload?.defaultReceiptEnabled ? 1 : 0;
  const footerBrandEnabled = payload?.footerBrandEnabled ? 1 : 0;

  if (!paperSize) {
    return { error: "Paper size is required", status: 400 };
  }

  await pgQuery(`
    UPDATE settings_print
    SET paper_size = $1, qr_enabled = $2, default_receipt_enabled = $3, footer_brand_enabled = $4, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `, [paperSize, qrEnabled, defaultReceiptEnabled, footerBrandEnabled]);

  return {
    data: await pgGetPrintSettings((text, params) => pgQuery(text, params).then((rows) => rows[0] ?? null)),
    paperSize,
  };
}

export async function pgUpdateBusinessHoursSettings(pgWithTransaction, pgQuery, payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const holidayEnabled = payload?.holidayEnabled ? 1 : 0;
  const holidayHours = String(payload?.holidayHours ?? "").trim();
  const holidayNote = String(payload?.holidayNote ?? "").trim();

  if (!rows.length || rows.some((row) => !String(row.dayLabel ?? "").trim() || !String(row.hoursValue ?? "").trim())) {
    return { error: "Business hours rows are required", status: 400 };
  }

  await pgWithTransaction(async (client) => {
    await client.query("DELETE FROM settings_business_hours");
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      await client.query(`
        INSERT INTO settings_business_hours (day_label, hours_value, note, sort_order)
        VALUES ($1, $2, $3, $4)
      `, [String(row.dayLabel).trim(), String(row.hoursValue).trim(), String(row.note ?? "").trim(), index + 1]);
    }
    await client.query(`
      INSERT INTO settings_business_rules (id, holiday_enabled, holiday_hours, holiday_note)
      VALUES (1, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        holiday_enabled = EXCLUDED.holiday_enabled,
        holiday_hours = EXCLUDED.holiday_hours,
        holiday_note = EXCLUDED.holiday_note
    `, [holidayEnabled, holidayHours || "10:00 - 15:00", holidayNote]);
  });

  return {
    data: await pgGetBusinessHoursSettings(pgQuery, (text, params) => pgQuery(text, params).then((rows) => rows[0] ?? null)),
  };
}

export async function pgCreateStaffPermission(pgOne, pgQuery, payload) {
  const name = String(payload?.name ?? "").trim();
  const role = String(payload?.role ?? "").trim();
  const scope = String(payload?.scope ?? "").trim();
  const canEditOrders = payload?.canEditOrders ? 1 : 0;
  const canAdjustInventory = payload?.canAdjustInventory ? 1 : 0;
  const canViewFinance = payload?.canViewFinance ? 1 : 0;
  const isActive = payload?.isActive === false ? 0 : 1;

  if (!name || !role || !scope) {
    return { error: "Name, role and scope are required", status: 400 };
  }

  const nextSort = Number((await pgOne("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM settings_staff"))?.value ?? 1);
  await pgQuery(
    `INSERT INTO settings_staff (name, role, scope, can_edit_orders, can_adjust_inventory, can_view_finance, is_active, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [name, role, scope, canEditOrders, canAdjustInventory, canViewFinance, isActive, nextSort],
  );

  return { data: await pgGetStaffPermissionSettings(pgQuery), name, role };
}

export async function pgUpdateStaffPermission(pgOne, pgQuery, id, payload) {
  const existing = await pgOne("SELECT id FROM settings_staff WHERE id = $1", [id]);
  if (!existing) {
    return { error: "Staff profile not found", status: 404 };
  }

  const name = String(payload?.name ?? "").trim();
  const role = String(payload?.role ?? "").trim();
  const scope = String(payload?.scope ?? "").trim();
  const canEditOrders = payload?.canEditOrders ? 1 : 0;
  const canAdjustInventory = payload?.canAdjustInventory ? 1 : 0;
  const canViewFinance = payload?.canViewFinance ? 1 : 0;
  const isActive = payload?.isActive ? 1 : 0;

  if (!name || !role || !scope) {
    return { error: "Name, role and scope are required", status: 400 };
  }

  await pgQuery(
    `UPDATE settings_staff
     SET name = $1, role = $2, scope = $3, can_edit_orders = $4, can_adjust_inventory = $5, can_view_finance = $6, is_active = $7
     WHERE id = $8`,
    [name, role, scope, canEditOrders, canAdjustInventory, canViewFinance, isActive, id],
  );

  return { data: await pgGetStaffPermissionSettings(pgQuery), name, role };
}

export async function pgDeleteStaffPermission(pgOne, pgQuery, id) {
  const staff = await pgOne("SELECT name FROM settings_staff WHERE id = $1", [id]);
  if (!staff) {
    return { error: "Staff profile not found", status: 404 };
  }

  await pgQuery("DELETE FROM settings_staff WHERE id = $1", [id]);
  return { data: await pgGetStaffPermissionSettings(pgQuery), name: staff.name };
}

export async function pgUpdateReorderSettings(pgWithTransaction, pgGetParts, payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    return { error: "Reorder items are required", status: 400 };
  }

  await pgWithTransaction(async (client) => {
    for (const item of items) {
      const id = Number(item.id);
      const reorderLevel = Number(item.reorderLevel);
      if (Number.isInteger(id) && Number.isInteger(reorderLevel) && reorderLevel >= 0) {
        await client.query("UPDATE parts SET reorder_level = $1 WHERE id = $2", [reorderLevel, id]);
      }
    }
  });

  return { data: await pgGetParts() };
}

export async function pgCreateOrderFormBrand(pgOne, payload) {
  const name = String(payload?.name ?? "").trim();
  const market = String(payload?.market ?? "Vanuatu").trim() || "Vanuatu";

  if (!name) {
    return { error: "Brand name is required", status: 400 };
  }

  const nextSort = Number((await pgOne("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_brands"))?.value ?? 1);
  const row = await pgOne(
    `INSERT INTO order_form_brands (name, market, sort_order)
     VALUES ($1, $2, $3)
     RETURNING id, name, market, sort_order AS "sortOrder"`,
    [name, market, nextSort],
  );
  return { data: row };
}

export async function pgCreateOrderFormModel(pgOne, payload) {
  const brandId = Number(payload?.brandId);
  const name = String(payload?.name ?? "").trim();

  if (!Number.isInteger(brandId) || !name) {
    return { error: "Brand and model name are required", status: 400 };
  }

  const brand = await pgOne("SELECT id FROM order_form_brands WHERE id = $1 AND is_active = 1", [brandId]);
  if (!brand) {
    return { error: "Brand not found", status: 404 };
  }

  const nextSort = Number((await pgOne("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_models WHERE brand_id = $1", [brandId]))?.value ?? 1);
  const row = await pgOne(
    `INSERT INTO order_form_models (brand_id, name, sort_order)
     VALUES ($1, $2, $3)
     RETURNING id, brand_id AS "brandId", name, sort_order AS "sortOrder"`,
    [brandId, name, nextSort],
  );
  return { data: row };
}

export async function pgCreateOrderFormTechnician(pgOne, payload) {
  const name = String(payload?.name ?? "").trim();

  if (!name) {
    return { error: "Technician name is required", status: 400 };
  }

  const nextSort = Number((await pgOne("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_technicians"))?.value ?? 1);
  const row = await pgOne(
    `INSERT INTO order_form_technicians (name, sort_order)
     VALUES ($1, $2)
     RETURNING id, name, sort_order AS "sortOrder"`,
    [name, nextSort],
  );
  return { data: row };
}

export async function pgCreateOrderFormIssue(pgOne, payload) {
  const title = String(payload?.title ?? "").trim();

  if (!title) {
    return { error: "Issue title is required", status: 400 };
  }

  const nextSort = Number((await pgOne("SELECT COALESCE(MAX(sort_order), 0) + 1 AS value FROM order_form_issue_templates"))?.value ?? 1);
  const row = await pgOne(
    `INSERT INTO order_form_issue_templates (title, sort_order)
     VALUES ($1, $2)
     RETURNING id, title, sort_order AS "sortOrder"`,
    [title, nextSort],
  );
  return { data: row };
}

export async function pgUpdateOrderFormOption(pgOne, pgWithTransaction, pgQuery, collection, id, payload) {
  const collectionMap = {
    brands: { table: "order_form_brands", nameColumn: "name" },
    models: { table: "order_form_models", nameColumn: "name" },
    technicians: { table: "order_form_technicians", nameColumn: "name" },
    issues: { table: "order_form_issue_templates", nameColumn: "title" },
  };

  const target = collectionMap[collection];
  if (!target || !Number.isInteger(id)) {
    return { error: "Unsupported option collection", status: 400 };
  }

  const current = await pgOne(`SELECT id, is_active AS "isActive", sort_order AS "sortOrder", ${target.nameColumn} AS label FROM ${target.table} WHERE id = $1`, [id]);
  if (!current) {
    return { error: "Option not found", status: 404 };
  }

  const isActive = payload?.isActive === undefined ? current.isActive : (payload.isActive ? 1 : 0);
  const direction = payload?.direction;

  await pgWithTransaction(async (client) => {
    if (direction === "up" || direction === "down") {
      const operator = direction === "up" ? "<" : ">";
      const ordering = direction === "up" ? "DESC" : "ASC";
      const neighbor = (await client.query(
        `
          SELECT id, sort_order AS "sortOrder"
          FROM ${target.table}
          WHERE id != $1 AND sort_order ${operator} $2
          ORDER BY sort_order ${ordering}, id ${ordering}
          LIMIT 1
        `,
        [id, current.sortOrder],
      )).rows[0];

      if (neighbor) {
        await client.query(`UPDATE ${target.table} SET sort_order = $1 WHERE id = $2`, [neighbor.sortOrder, current.id]);
        await client.query(`UPDATE ${target.table} SET sort_order = $1 WHERE id = $2`, [current.sortOrder, neighbor.id]);
      }
    }

    if (direction !== "up" && direction !== "down") {
      const sortOrder = Number.isInteger(payload?.sortOrder) ? payload.sortOrder : current.sortOrder;
        await client.query(`UPDATE ${target.table} SET is_active = $1, sort_order = $2 WHERE id = $3`, [isActive, sortOrder, id]);
      } else {
        await client.query(`UPDATE ${target.table} SET is_active = $1 WHERE id = $2`, [isActive, id]);
      }
  });

  return { data: await pgGetOrderFormOptionsInternal(pgQuery, false), label: current.label };
}

export async function pgDeleteOrderFormOption(pgWithTransaction, pgQuery, collection, id) {
  const collectionMap = {
    brands: { table: "order_form_brands" },
    models: { table: "order_form_models" },
    technicians: { table: "order_form_technicians" },
    issues: { table: "order_form_issue_templates" },
  };

  const target = collectionMap[collection];
  if (!target || !Number.isInteger(id)) {
    return { error: "Unsupported option collection", status: 400 };
  }

  await pgWithTransaction(async (client) => {
    if (collection === "brands") {
      await client.query("DELETE FROM order_form_models WHERE brand_id = $1", [id]);
    }
    await client.query(`DELETE FROM ${target.table} WHERE id = $1`, [id]);
  });

  return { data: await pgGetOrderFormOptionsInternal(pgQuery, false) };
}
