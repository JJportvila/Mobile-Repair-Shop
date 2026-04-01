const money = new Intl.NumberFormat("en-US");

const cnyMoney = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value) {
  return `${money.format(value)} VUV`;
}

export function formatCny(value) {
  return `¥${cnyMoney.format(Number(value) || 0)}`;
}

export function calculateProcurementCosting({
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

export function getTodayDateKey() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function parseJson(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function formatChatTimestamp(value) {
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

export function buildPgOrderFilters(status = "all", search = "") {
  const clauses = [];
  const params = [];

  if (status !== "all") {
    params.push(status);
    clauses.push(`o.status = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    const ref = `$${params.length}`;
    clauses.push(`(o.order_no ILIKE ${ref} OR o.device_name ILIKE ${ref} OR c.name ILIKE ${ref} OR c.phone ILIKE ${ref})`);
  }

  return {
    whereClause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
