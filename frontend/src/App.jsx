import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import * as XLSX from "xlsx";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

const statusTabs = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待处理" },
  { value: "in_progress", label: "维修中" },
  { value: "completed", label: "已完成" },
  { value: "picked_up", label: "已取件" },
];

const statusChinese = {
  pending: "待处理",
  in_progress: "维修中",
  completed: "已完成",
  picked_up: "已取件",
};

function formatCurrency(value) {
  return `${Math.round(Number(value) || 0).toLocaleString("en-US")} VUV`;
}

function formatDateLabel(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function createQuoteDraft(customers = [], parts = [], options = {}) {
  const firstBrandId = String(options.brands?.[0]?.id ?? "");
  const firstModelId = String(
    options.models?.find((model) => String(model.brandId) === firstBrandId)?.id ?? "",
  );
  const firstIssueTemplateId = String(options.issueTemplates?.[0]?.id ?? "");
  return {
    customerId: String(customers[0]?.id ?? ""),
    customerName: customers[0]?.name ?? "",
    customerPhone: customers[0]?.phone ?? "",
    customerEmail: customers[0]?.email ?? "",
    brandId: firstBrandId,
    modelId: firstModelId,
    issueTemplateId: firstIssueTemplateId,
    deviceName: [options.brands?.[0]?.name, options.models?.find((model) => String(model.id) === firstModelId)?.name]
      .filter(Boolean)
      .join(" "),
    serviceType: options.issueTemplates?.[0]?.title ?? "",
    validUntil: getTodayInputDate(),
    notes: "",
    taxInclusive: true,
    items: [],
  };
}

function createPosDraft(customers = []) {
  return {
    customerId: String(customers[0]?.id ?? ""),
    customerName: customers[0]?.name ?? "",
    customerPhone: customers[0]?.phone ?? "",
    paymentMethod: "Cash",
    note: "",
    items: [],
  };
}

function normalizeImportKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function buildPartSearchLabel(part) {
  return `${part.sku} | ${part.name}`;
}

function getTodayInputDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function createDefaultOrderForm(options = {}) {
  return {
    title: "",
    brandId: String(options.brands?.[0]?.id ?? ""),
    modelId: String(options.models?.find((model) => model.brandId === options.brands?.[0]?.id)?.id ?? ""),
    deviceName: "",
    customerName: "",
    customerPhone: "",
    customerEmail: "",
    technician: options.technicians?.[0]?.name ?? "",
    scheduledDate: getTodayInputDate(),
    amount: "",
    deposit: "",
    issueTemplateId: String(options.issueTemplates?.[0]?.id ?? ""),
    issueSummary: options.issueTemplates?.[0]?.title ?? "",
    notes: "",
    imeiSerial: "",
    customerSignature: "",
    deviceFrontPhoto: "",
    deviceBackPhoto: "",
    customerPhoto: "",
    status: "pending",
  };
}

const defaultMovementForm = {
  partId: "",
  movementType: "in",
  quantity: "",
  note: "",
};

const iconByDevice = {
  iphone: "smartphone",
  samsung: "tablet_android",
  macbook: "laptop_mac",
  ipad: "tablet_mac",
  watch: "watch",
};

const primaryNavItems = [
  { to: "/repairs-hub", icon: "dashboard", label: "工作台" },
  { to: "/repair-queue", icon: "build", label: "维修" },
  { to: "/inventory", icon: "inventory_2", label: "库存" },
  { to: "/customers", icon: "group", label: "客户" },
  { to: "/pos/register", icon: "point_of_sale", label: "POS" },
  { to: "/financial-reports", icon: "payments", label: "财务" },
];

function useIsMobileViewport(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth < breakpoint;
  });

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const syncViewport = (event) => setIsMobile(event.matches);

    setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, [breakpoint]);

  return isMobile;
}

function inferPartCategory(partName = "") {
  const name = partName.toLowerCase();
  if (name.includes("screen") || name.includes("display") || name.includes("digitizer") || name.includes("oled")) return "Screens";
  if (name.includes("battery")) return "Batteries";
  return "Small Parts";
}

function CustomerAvatar({ customer, className, size = "normal" }) {
  const name = customer?.name ?? "";
  const avatarPhoto = customer?.avatarPhoto ?? "";
  if (avatarPhoto) {
    return <img alt={`${name || "客户"}头像`} className={`${className} customer-photo-avatar ${size === "small" ? "small" : ""}`.trim()} src={avatarPhoto} />;
  }
  return <div className={className}>{name.slice(0, 1) || "?"}</div>;
}

function formatPartCategory(category = "") {
  if (category === "Screens") return "屏幕";
  if (category === "Batteries") return "电池";
  if (category === "Small Parts") return "小配件";
  if (category === "All") return "全部";
  return category;
}

function formatChannelLabel(channel = "") {
  if (channel === "Cash") return "现金";
  if (channel === "Bank Transfer") return "银行转账";
  if (channel === "Check") return "支票";
  return channel;
}

function formatCustomerTierLabel(tier = "") {
  const normalized = String(tier ?? "").trim().toLowerCase();
  if (normalized === "vip") return "贵宾";
  if (normalized === "premium") return "高级";
  if (normalized === "standard") return "标准";
  if (normalized === "new") return "新客";
  return normalized ? String(tier).trim() : "标准";
}

function formatWarrantyLabel(warranty = "") {
  const normalized = String(warranty ?? "").trim();
  if (!normalized) return "标准保修";
  if (normalized === "Standard Warranty Applied") return "标准保修已生效";
  return normalized;
}

function formatExecutionPhaseChipLabel(value) {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "diag":
    case "diagnosis":
      return "检测";
    case "repair":
      return "维修";
    case "qa":
      return "质检";
    case "completed":
      return "完成";
    default:
      return value;
  }
}

function formatMinutesLabel(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return `${numeric} 分钟`;
}

function createPartQuery(part) {
  const query = new URLSearchParams();
  if (part?.id) query.set("partId", String(part.id));
  if (part?.supplier) query.set("supplier", String(part.supplier));
  if (part?.unitPrice != null) query.set("unitPrice", String(part.unitPrice));
  if (part?.reorderLevel != null) query.set("reorderLevel", String(part.reorderLevel));
  if (part?.stock != null) query.set("stock", String(part.stock));
  return query.toString() ? `?${query.toString()}` : "";
}

function getInventoryContext(search = "") {
  const query = new URLSearchParams(search);
  return {
    partId: query.get("partId") ?? "",
    supplier: query.get("supplier") ?? "",
    unitPrice: query.get("unitPrice") ?? "",
    reorderLevel: query.get("reorderLevel") ?? "",
    stock: query.get("stock") ?? "",
  };
}

const detailGallery = [
  "https://lh3.googleusercontent.com/aida-public/AB6AXuBqSJbJdy3mlOpn3fiofyT6pb57lc09gxElGULEXjNEtt5YgPGwrY1MpUrLKKBZHjy2hv228EsW7R1tmV4-WzxYdELZ3fFvM8QjJkRsya7BqUmORCy3ZDsxZMYRMxa4uDjW0RXgQg-e7RrOhyWY2J9YF2wsGaxrfmTpnOhzcmpSGGfcfZt10NujVGDTVyClOfpMdvVVwa1iOxFvyW4DNxwJ8zH9xJDmJLu0x5tsyYcfqOVhj9cHLQOpC7eKx6IZCpzaT9CXwzXuzVE2",
  "https://lh3.googleusercontent.com/aida-public/AB6AXuCa9cRlP-twv28iGUYp3IN1yuXryZzyFet_VWueXcudlSTs0tK2WEUqlvoNaAeuxLr4g4-qHkQ9fzqoOL3P7qHXszUAKMMdBJ2UhWuqLZMRvbSjY6CzXAVgzYGTcsq9jCKACeVmZIyw98lZHTalPwkRNIVnHCoSwIdSulIxrNoJOViMIyESL6CvCBtkz4yc4nM8Dac_C1OpU8kFPF8IZXZrarOdOrG1xGQWWVYJ-nVpkcPOxHlDRlIqDWP4DOws3jhyXg1PGj4TOtPf",
];

async function fetchJson(path, options) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const body = await response.json();
      message = body.message ?? message;
    } catch {
      // noop
    }
    throw new Error(message);
  }
  return response.json();
}

function readFileAsDataUrl(file, maxWidth = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, maxWidth / Math.max(image.width, 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");

        if (!context) {
          resolve(String(reader.result ?? ""));
          return;
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.onerror = () => resolve(String(reader.result ?? ""));
      image.src = String(reader.result ?? "");
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function SupplierDetailsAlias() {
  const { id } = useParams();
  return <Navigate to={`/supplier-management/${id}`} replace />;
}

function ProcurementDetailsAlias() {
  const { id } = useParams();
  return <Navigate to={`/procurements/${id}`} replace />;
}

function CustomerDetailsAlias() {
  const { id } = useParams();
  return <Navigate to={`/customers/${id}`} replace />;
}

function PartDetailsAlias() {
  const { id } = useParams();
  return <Navigate to={`/parts/${id}`} replace />;
}

function SupplyOrderDetailsAlias() {
  const { id } = useParams();
  return <Navigate to={`/supply-order-details/${id}`} replace />;
}

function normalizeIdentifier(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 15) return digits.slice(0, 15);
  return raw.toUpperCase();
}

function buildWhatsAppLink(phone = "") {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}` : "";
}

function getOrderRouteId(orderLike, fallback = "1") {
  if (orderLike == null) return fallback;
  if (typeof orderLike === "string" || typeof orderLike === "number") return String(orderLike);
  return String(orderLike.orderNo ?? orderLike.order_no ?? orderLike.id ?? orderLike.orderId ?? fallback);
}

function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [dashboard, setDashboard] = useState(null);
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [parts, setParts] = useState([]);
  const [movements, setMovements] = useState([]);
  const [staffPerformance, setStaffPerformance] = useState({ rows: [], topPerformer: null });
  const [financeReport, setFinanceReport] = useState({ summary: null, channels: [], rows: [] });
  const [suppliersData, setSuppliersData] = useState({ metrics: null, suppliers: [], history: [] });
  const [orderFormOptions, setOrderFormOptions] = useState({ brands: [], models: [], technicians: [], issueTemplates: [] });
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [showMovementForm, setShowMovementForm] = useState(false);
  const [orderForm, setOrderForm] = useState(() => createDefaultOrderForm());
  const [movementForm, setMovementForm] = useState(defaultMovementForm);

  const loadCollections = useCallback(async (status = selectedStatus, keyword = search) => {
    const query = new URLSearchParams();
    query.set("status", status);
    if (keyword.trim()) query.set("search", keyword.trim());

    const [dashboardResult, orderResult, customerResult, partResult, movementResult, staffResult, financeResult, suppliersResult, orderOptionsResult] = await Promise.all([
      fetchJson("/api/dashboard"),
      fetchJson(`/api/orders?${query.toString()}`),
      fetchJson("/api/customers"),
      fetchJson("/api/parts"),
      fetchJson("/api/inventory-movements"),
      fetchJson("/api/staff/performance"),
      fetchJson("/api/finance/report"),
      fetchJson("/api/suppliers"),
      fetchJson("/api/order-form-options"),
    ]);

    setDashboard(dashboardResult);
    setOrders(orderResult);
    setCustomers(customerResult);
    setParts(partResult);
    setMovements(movementResult);
    setStaffPerformance(staffResult);
    setFinanceReport(financeResult);
    setSuppliersData(suppliersResult);
    setOrderFormOptions(orderOptionsResult);
    setMovementForm((current) => ({
      ...current,
      partId: current.partId || String(partResult[0]?.id ?? ""),
    }));
    setOrderForm((current) => {
      const next = { ...createDefaultOrderForm(orderOptionsResult), ...current };
      if (!current.scheduledDate) next.scheduledDate = getTodayInputDate();
      if (!current.technician) next.technician = orderOptionsResult.technicians?.[0]?.name ?? "";
      if (!current.brandId) next.brandId = String(orderOptionsResult.brands?.[0]?.id ?? "");
      const activeBrandId = Number(next.brandId || (orderOptionsResult.brands?.[0]?.id ?? 0));
      const firstModelForBrand = orderOptionsResult.models.find((model) => model.brandId === activeBrandId);
      if (!current.modelId || !orderOptionsResult.models.some((model) => String(model.id) === String(current.modelId))) {
        next.modelId = String(firstModelForBrand?.id ?? "");
      }
      if (!current.issueTemplateId) {
        next.issueTemplateId = String(orderOptionsResult.issueTemplates?.[0]?.id ?? "");
        next.issueSummary = current.issueSummary || orderOptionsResult.issueTemplates?.[0]?.title || "";
      }
      return next;
    });
  }, [search, selectedStatus]);

  useEffect(() => {
    let ignore = false;
    async function boot() {
      try {
        setLoading(true);
        setError("");
        await loadCollections();
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    boot();
    return () => {
      ignore = true;
    };
  }, [loadCollections]);

  const currentSectionTitle = location.pathname.startsWith("/inventory")
    ? "库存"
    : location.pathname.startsWith("/quotes") || location.pathname.startsWith("/create_quote") || location.pathname.startsWith("/quote_")
      ? "报价"
      : location.pathname.startsWith("/pos/")
        ? "收银"
        : location.pathname.startsWith("/invoices") || location.pathname.includes("invoice")
          ? "发票"
    : location.pathname.startsWith("/scanner") || location.pathname.startsWith("/parts-scanner")
      ? "扫码"
    : location.pathname.startsWith("/more-options") || location.pathname.startsWith("/more_options")
      ? "更多"
    : location.pathname.startsWith("/refund")
      ? "退款"
        : location.pathname.startsWith("/audit")
          ? "审计"
          : location.pathname.startsWith("/reviews")
            ? "评价"
            : location.pathname.startsWith("/financial-reports") || location.pathname.startsWith("/reports") || location.pathname.startsWith("/revenue")
              ? "报表"
              : location.pathname.startsWith("/quick-order")
                ? "快捷下单"
                : location.pathname.startsWith("/vila-port-cyan")
                  ? "门店"
                : location.pathname.startsWith("/inventory-adjustment") || location.pathname.startsWith("/inventory-audit")
                  ? "库存"
                  : location.pathname.startsWith("/orders/") && (location.pathname.includes("/execution") || location.pathname.includes("/deductions"))
                    ? "执行"
    : location.pathname.startsWith("/parts-catalog")
      ? "配件"
      : location.pathname.startsWith("/notifications")
        ? "通知"
        : location.pathname.startsWith("/profile")
          ? "个人中心"
          : location.pathname.startsWith("/settings")
            ? "设置"
      : location.pathname.startsWith("/supplier")
        ? "供应商"
      : location.pathname.startsWith("/customers")
        ? "客户"
        : "维修";

  async function refresh(status = selectedStatus, keyword = search) {
    setLoading(true);
    setError("");
    try {
      await loadCollections(status, keyword);
    } catch (refreshError) {
      setError(refreshError.message);
    } finally {
      setLoading(false);
    }
  }

  const availableModels = useMemo(
    () => orderFormOptions.models.filter((model) => String(model.brandId) === String(orderForm.brandId)),
    [orderForm.brandId, orderFormOptions.models],
  );

  const selectedBrand = useMemo(
    () => orderFormOptions.brands.find((brand) => String(brand.id) === String(orderForm.brandId)) ?? null,
    [orderForm.brandId, orderFormOptions.brands],
  );

  const selectedModel = useMemo(
    () => orderFormOptions.models.find((model) => String(model.id) === String(orderForm.modelId)) ?? null,
    [orderForm.modelId, orderFormOptions.models],
  );

  const selectedIssueTemplate = useMemo(
    () => orderFormOptions.issueTemplates.find((item) => String(item.id) === String(orderForm.issueTemplateId)) ?? null,
    [orderForm.issueTemplateId, orderFormOptions.issueTemplates],
  );

  async function handleCreateOrder(event) {
    event.preventDefault();
    try {
      setError("");
      setSuccess("");
      const amount = Number(orderForm.amount || 0);
      const deposit = Number(orderForm.deposit || 0);
      const composedDeviceName = [selectedBrand?.name, selectedModel?.name].filter(Boolean).join(" ");
      if (!orderForm.deviceFrontPhoto || !orderForm.deviceBackPhoto || !orderForm.customerPhoto) {
        setError("请先补齐手机正面、手机背面和客户照片。");
        return;
      }
      if (!selectedBrand || !selectedModel) {
        setError("请先选择品牌和型号。");
        return;
      }
      if (!Number.isFinite(deposit) || deposit < 0) {
        setError("定金金额不正确。");
        return;
      }
      if (deposit > amount) {
        setError("定金不能大于报价。");
        return;
      }
      const created = await fetchJson("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...orderForm,
          deviceName: composedDeviceName,
          issueSummary: orderForm.issueSummary || selectedIssueTemplate?.title || "",
          amount,
          deposit,
        }),
      });
      setSuccess(`已创建订单 ${created.orderNo}`);
      setOrderForm(createDefaultOrderForm(orderFormOptions));
      setShowOrderForm(false);
      setSelectedStatus("all");
      setSearch("");
      await refresh("all", "");
      navigate(`/orders/${getOrderRouteId(created)}/intake`);
    } catch (createError) {
      setError(createError.message);
    }
  }

  async function handleOrderPhotoChange(field, file) {
    if (!file) return;
    try {
      setError("");
      const dataUrl = await readFileAsDataUrl(file);
      setOrderForm((current) => ({ ...current, [field]: dataUrl }));
    } catch (fileError) {
      setError(fileError.message);
    }
  }

  function clearOrderPhoto(field) {
    setOrderForm((current) => ({ ...current, [field]: "" }));
  }

  async function handleMovement(event) {
    event.preventDefault();
    try {
      setError("");
      setSuccess("");
      const result = await fetchJson("/api/parts/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...movementForm,
          partId: Number(movementForm.partId),
          quantity: Number(movementForm.quantity),
        }),
      });
      setSuccess(`库存已更新: ${result.part.name}`);
      setMovementForm((current) => ({ ...current, quantity: "", note: "" }));
      setShowMovementForm(false);
      await refresh();
    } catch (movementError) {
      setError(movementError.message);
    }
  }

  async function handleStatusChange(orderId, status) {
    try {
      setError("");
      setSuccess("");
      await fetchJson(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      setSuccess("订单状态已更新");
      await refresh();
    } catch (updateError) {
      setError(updateError.message);
    }
  }

  const shared = {
    dashboard,
    orders,
    customers,
    parts,
    movements,
    staffPerformance,
    financeReport,
    suppliersData,
    orderFormOptions,
    selectedStatus,
    search,
    loading,
    setSearch,
    setSelectedStatus,
    refresh,
    openOrderForm: () => {
      setOrderForm(createDefaultOrderForm(orderFormOptions));
      setShowOrderForm(true);
    },
    openMovementForm: () => setShowMovementForm(true),
    onStatusChange: handleStatusChange,
  };

  function handlePrimaryAction() {
    if (location.pathname.startsWith("/inventory")) {
      setShowMovementForm(true);
      return;
    }

    setOrderForm(createDefaultOrderForm(orderFormOptions));
    setShowOrderForm(true);
  }

  return (
    <div className={`template-shell ${isMobile ? "mobile-shell" : "desktop-shell"}`}>
      {!isMobile ? (
        <aside className="desktop-sidebar">
          <div className="desktop-brand">
            <div className="desktop-brand-mark">VP</div>
            <div className="desktop-brand-copy">
              <strong>Vila Port Repair</strong>
              <span>Desktop / Tablet Workspace</span>
            </div>
          </div>
          <nav className="desktop-nav">
            {primaryNavItems.map((item) => (
              <NavLink key={item.to} className={({ isActive }) => (isActive ? "desktop-nav-item active" : "desktop-nav-item")} to={item.to}>
                <span className="material-symbols-outlined">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="desktop-sidebar-footer">
            <button className="wide-action secondary" onClick={() => navigate("/more-options")} type="button">更多功能</button>
          </div>
        </aside>
      ) : null}

      <div className={isMobile ? "template-frame" : "desktop-frame"}>
      {isMobile ? (
      <header className="mobile-topbar">
        <div className="topbar-title">
          <button className="icon-button" onClick={() => navigate("/more-options")} type="button">
            <span className="material-symbols-outlined">menu</span>
          </button>
          <div className="topbar-copy">
            <h1>{currentSectionTitle}</h1>
          <p>维拉港维修中心</p>
          </div>
        </div>
        <button
          className="icon-button primary"
          type="button"
          onClick={handlePrimaryAction}
        >
          <span className="material-symbols-outlined">add_circle</span>
        </button>
      </header>
      ) : (
        <header className="desktop-topbar">
          <div className="desktop-topbar-copy">
            <p>电脑 / 平板工作区</p>
            <h1>{currentSectionTitle}</h1>
          </div>
          <div className="desktop-topbar-actions">
            <button className="wide-action secondary" onClick={() => navigate("/documents")} type="button">文档中心</button>
            <button className="wide-action primary" onClick={handlePrimaryAction} type="button">快速新建</button>
          </div>
        </header>
      )}

      <main className={`template-main ${isMobile ? "mobile-main" : "desktop-main"}`}>
        {error ? <div className="message-banner error">{error}</div> : null}
        {success ? <div className="message-banner success">{success}</div> : null}

        <Routes>
          <Route path="/" element={<Navigate to="/repairs-hub" replace />} />
          <Route path="/repairs-hub" element={<RepairsHubPage {...shared} />} />
          <Route path="/vila-port-cyan" element={<VilaPortCyanPage {...shared} />} />
          <Route path="/vila_port_cyan" element={<Navigate to="/vila-port-cyan" replace />} />
          <Route path="/repair-queue" element={<RepairQueuePage {...shared} />} />
      <Route path="/order-list" element={<OrderListPage {...shared} />} />
          <Route path="/order_list" element={<Navigate to="/order-list" replace />} />
          <Route path="/inventory" element={<InventoryPage {...shared} />} />
          <Route path="/inventory-management-dashboard" element={<InventoryPage {...shared} />} />
          <Route path="/inventory_management_dashboard" element={<Navigate to="/inventory-management-dashboard" replace />} />
          <Route path="/inventory/inbound" element={<InboundRegistrationPage {...shared} />} />
          <Route path="/inventory/adjustment" element={<InventoryAdjustmentPage {...shared} />} />
          <Route path="/inventory/loss" element={<InventoryLossPage {...shared} />} />
          <Route path="/inventory/adjustment/requisition" element={<PartsRequisitionPage {...shared} />} />
          <Route path="/inventory/audit-session" element={<InventoryAuditSessionPage {...shared} />} />
          <Route path="/parts-catalog" element={<PartsCatalogPage {...shared} />} />
          <Route path="/parts_catalog" element={<Navigate to="/parts-catalog" replace />} />
          <Route path="/scanner" element={<ScannerPage {...shared} />} />
          <Route path="/parts-scanner" element={<PartsScannerPage {...shared} />} />
          <Route path="/parts_scanner" element={<Navigate to="/parts-scanner" replace />} />
          <Route path="/parts/select" element={<SelectPartsPage {...shared} />} />
          <Route path="/quick-order" element={<QuickOrderPage {...shared} />} />
          <Route path="/quick_order" element={<Navigate to="/quick-order" replace />} />
          <Route path="/low-stock-alerts" element={<LowStockAlertsPage {...shared} />} />
          <Route path="/low_stock_alerts" element={<Navigate to="/low-stock-alerts" replace />} />
          <Route path="/technician-performance" element={<TechnicianPerformancePage {...shared} />} />
          <Route path="/technician_performance" element={<Navigate to="/technician-performance" replace />} />
          <Route path="/financial-reports" element={<FinancialReportsPage {...shared} />} />
          <Route path="/financial_reports" element={<Navigate to="/financial-reports" replace />} />
          <Route path="/financial-reports/daily" element={<ClosingReportPage scope="daily" />} />
          <Route path="/financial-reports/monthly" element={<ClosingReportPage scope="monthly" />} />
          <Route path="/financial-reports/drill-down" element={<FinanceDrillDownPage {...shared} />} />
          <Route path="/finance_drill_down" element={<Navigate to="/financial-reports/drill-down" replace />} />
          <Route path="/reports" element={<ReportsOverviewPage {...shared} />} />
          <Route path="/reports_1" element={<Navigate to="/reports" replace />} />
          <Route path="/reports/advanced" element={<ReportsAdvancedPage {...shared} />} />
          <Route path="/reports_2" element={<Navigate to="/reports/advanced" replace />} />
          <Route path="/revenue-analysis" element={<RevenueAnalysisPage {...shared} />} />
          <Route path="/revenue_analysis_vuv" element={<Navigate to="/revenue-analysis" replace />} />
          <Route path="/revenue-breakdown" element={<RevenueBreakdownPage {...shared} />} />
          <Route path="/revenue_breakdown_vuv" element={<Navigate to="/revenue-breakdown" replace />} />
          <Route path="/reviews" element={<ReviewsSummaryPage {...shared} />} />
          <Route path="/reviews_1" element={<Navigate to="/reviews" replace />} />
          <Route path="/reviews/manage" element={<ReviewsManagePage {...shared} />} />
          <Route path="/reviews_2" element={<Navigate to="/reviews/manage" replace />} />
          <Route path="/refund-management" element={<RefundManagementPage {...shared} />} />
          <Route path="/refund_management" element={<Navigate to="/refund-management" replace />} />
          <Route path="/audit-logs" element={<AuditLogsPage {...shared} />} />
          <Route path="/audit_logs" element={<Navigate to="/audit-logs" replace />} />
          <Route path="/audit-history" element={<AuditHistoryPage {...shared} />} />
          <Route path="/audit_history" element={<Navigate to="/audit-history" replace />} />
          <Route path="/audit-resolution" element={<AuditResolutionPage {...shared} />} />
          <Route path="/audit_resolution" element={<Navigate to="/audit-resolution" replace />} />
          <Route path="/notifications" element={<NotificationsPage {...shared} />} />
          <Route path="/more-options" element={<MoreOptionsPage {...shared} />} />
          <Route path="/more_options" element={<Navigate to="/more-options" replace />} />
          <Route path="/profile" element={<ProfilePage {...shared} />} />
          <Route path="/settings" element={<AppSettingsPage {...shared} />} />
          <Route path="/app_settings" element={<Navigate to="/settings" replace />} />
          <Route path="/settings/store" element={<EditStorePage {...shared} />} />
          <Route path="/edit_store" element={<Navigate to="/settings/store" replace />} />
          <Route path="/settings/business-hours" element={<BusinessHoursSettingsPage {...shared} />} />
          <Route path="/business_hours_settings" element={<Navigate to="/settings/business-hours" replace />} />
          <Route path="/settings/language" element={<LanguageSettingsPage {...shared} />} />
          <Route path="/language_settings" element={<Navigate to="/settings/language" replace />} />
          <Route path="/settings/print" element={<PrintSettingsPage {...shared} />} />
          <Route path="/print_settings" element={<Navigate to="/settings/print" replace />} />
          <Route path="/settings/printer" element={<PrinterSettingsPage {...shared} />} />
          <Route path="/printer_settings_1" element={<Navigate to="/settings/printer-1" replace />} />
          <Route path="/printer_settings_2" element={<Navigate to="/settings/printer-2" replace />} />
          <Route path="/settings/staff-permissions" element={<StaffPermissionsPage {...shared} />} />
          <Route path="/staff_permissions" element={<Navigate to="/settings/staff-permissions" replace />} />
          <Route path="/settings/reorder" element={<ReorderSettingsPage {...shared} />} />
          <Route path="/reorder_settings" element={<Navigate to="/settings/reorder" replace />} />
          <Route path="/settings/order-options" element={<OrderOptionsSettingsPage {...shared} />} />
          <Route path="/order_form_options" element={<Navigate to="/settings/order-options" replace />} />
          <Route path="/supplier-management" element={<SupplierManagementPage {...shared} />} />
          <Route path="/supplier_management" element={<Navigate to="/supplier-management" replace />} />
          <Route path="/supplier-management/:id" element={<SupplierDetailsPage {...shared} />} />
          <Route path="/supplier_details" element={<Navigate to="/supplier-management/SUP-1" replace />} />
          <Route path="/supplier_details/:id" element={<SupplierDetailsAlias />} />
          <Route path="/procurements/:id" element={<ProcurementDetailsPage {...shared} />} />
          <Route path="/procurement_details" element={<Navigate to="/procurements/PO-20260001" replace />} />
          <Route path="/procurement_details/:id" element={<ProcurementDetailsAlias />} />
          <Route path="/customers" element={<CustomerCenterPage {...shared} />} />
          <Route path="/customer_center" element={<Navigate to="/customers" replace />} />
          <Route path="/customers/:id" element={<CustomerDetailsPage {...shared} />} />
          <Route path="/customer_details" element={<Navigate to="/customers/1" replace />} />
          <Route path="/customer_details/:id" element={<CustomerDetailsAlias />} />
          <Route path="/customers/:id/history" element={<MyRepairHistoryPage {...shared} />} />
          <Route path="/my_repair_history" element={<Navigate to="/customers/1/history" replace />} />
          <Route path="/parts/:id" element={<PartDetailsPage {...shared} />} />
          <Route path="/part_details" element={<Navigate to="/parts/1" replace />} />
          <Route path="/part_details/:id" element={<PartDetailsAlias />} />
          <Route path="/orders/:id/add-parts" element={<AddPartsPage {...shared} />} />
          <Route path="/add_parts" element={<Navigate to="/orders/1/add-parts" replace />} />
          <Route path="/orders/:id/parts-usage" element={<OrderPartsUsagePage {...shared} />} />
          <Route path="/order_parts_usage" element={<Navigate to="/orders/1/parts-usage" replace />} />
          <Route path="/orders/:id/execution" element={<RepairExecutionPage {...shared} />} />
          <Route path="/repair_execution_1" element={<Navigate to="/orders/1/execution" replace />} />
          <Route path="/orders/:id/execution-live" element={<RepairExecutionLivePage {...shared} />} />
          <Route path="/repair_execution_2" element={<Navigate to="/orders/1/execution-live" replace />} />
          <Route path="/orders/:id/deductions" element={<DeductionHistoryPage {...shared} />} />
          <Route path="/deduction_history_1" element={<Navigate to="/orders/1/deductions" replace />} />
          <Route path="/orders/:id/deductions/detail" element={<DeductionHistoryPage {...shared} />} />
          <Route path="/deduction_history_detail" element={<Navigate to="/orders/1/deductions/detail" replace />} />
          <Route path="/orders/:id/deductions/journal" element={<DeductionJournalPage {...shared} />} />
          <Route path="/deduction_history_2" element={<Navigate to="/orders/1/deductions/journal" replace />} />
          <Route path="/orders/:id/intake" element={<OrderIntakePage {...shared} />} />
          <Route path="/orders/:id" element={<OrderDetailPage {...shared} />} />
          <Route path="/order_details" element={<Navigate to="/orders/1" replace />} />
          <Route path="/orders/:id/communication" element={<OrderCommunicationPage {...shared} />} />
          <Route path="/order_communication" element={<Navigate to="/orders/1/communication" replace />} />
          <Route path="/orders/:id/completion" element={<RepairCompletionPage {...shared} />} />
          <Route path="/repair_completion" element={<Navigate to="/orders/1/completion" replace />} />
          <Route path="/orders/:id/receipt" element={<ReceiptPage {...shared} />} />
          <Route path="/receipt" element={<Navigate to="/orders/1/receipt" replace />} />
          <Route path="/receipts" element={<ReceiptCenterPage {...shared} />} />
          <Route path="/quotes/new" element={<CreateQuotePage {...shared} />} />
          <Route path="/create_quote" element={<Navigate to="/quotes/new" replace />} />
          <Route path="/quotes/:id" element={<QuotePreviewPage {...shared} />} />
          <Route path="/quote_preview" element={<Navigate to="/quotes/QT-1001" replace />} />
          <Route path="/quote_template" element={<Navigate to="/quotes/QT-1001" replace />} />
          <Route path="/pos/register" element={<PosRegisterPage {...shared} />} />
          <Route path="/pos_pos_register" element={<Navigate to="/pos/register" replace />} />
          <Route path="/pos_refined_register" element={<Navigate to="/pos/register" replace />} />
          <Route path="/pos/checkout" element={<PosCheckoutPage {...shared} />} />
          <Route path="/pos_checkout" element={<Navigate to="/pos/checkout" replace />} />
          <Route path="/pos/sales/:id/receipt" element={<PosReceipt80mmPage {...shared} />} />
          <Route path="/80mm_pos" element={<Navigate to="/pos/sales/POS-1001/receipt" replace />} />
          <Route path="/invoices/:id" element={<OfficialInvoicePage {...shared} />} />
          <Route path="/official_invoice" element={<Navigate to="/invoices/POS-1001" replace />} />
          <Route path="/minimal_invoice" element={<Navigate to="/invoices/POS-1001" replace />} />
          <Route path="/modern_invoice" element={<Navigate to="/invoices/POS-1001" replace />} />
          <Route path="/invoice_template" element={<Navigate to="/invoices/POS-1001" replace />} />
          <Route path="/invoice_distribution" element={<Navigate to="/invoices/POS-1001" replace />} />
          <Route path="/pdf_invoice_pdf_setup" element={<Navigate to="/invoices/POS-1001" replace />} />
          <Route path="/documents" element={<DocumentManagementPage />} />
          <Route path="/document_management" element={<Navigate to="/documents" replace />} />
          <Route path="/doc_management" element={<Navigate to="/documents" replace />} />
          <Route path="/receipt_center_1" element={<Navigate to="/receipt-center-1" replace />} />
          <Route path="/receipt_center_2" element={<Navigate to="/receipt-center-2" replace />} />
          <Route path="/receipt-center-1" element={<ReceiptCenterCompactPage {...shared} />} />
          <Route path="/receipt-center-2" element={<ReceiptCenterPage {...shared} />} />
          <Route path="/orders/:id/share-report" element={<ShareReportPage {...shared} />} />
          <Route path="/pdf_share_pdf_report_1" element={<Navigate to="/orders/1/pdf-report-1" replace />} />
          <Route path="/orders/:id/pdf-report-1" element={<PdfReportPreviewPage {...shared} />} />
          <Route path="/pdf_share_pdf_report_2" element={<Navigate to="/orders/1/pdf-report-2" replace />} />
          <Route path="/orders/:id/pdf-report-2" element={<PdfReportDeliveryPage {...shared} />} />
          <Route path="/orders/:id/pdf-share" element={<ShareReportPage {...shared} />} />
          <Route path="/orders/:id/whatsapp-share" element={<WhatsAppSharePage {...shared} />} />
          <Route path="/whatsapp_whatsapp_share" element={<Navigate to="/orders/1/whatsapp-share" replace />} />
          <Route path="/orders/:id/send-email" element={<SendEmailReportPage {...shared} />} />
          <Route path="/send_email_report" element={<Navigate to="/orders/1/send-email" replace />} />
          <Route path="/orders/:id/photo-upload" element={<PhotoUploadPage {...shared} />} />
          <Route path="/photo_upload" element={<Navigate to="/orders/1/photo-upload" replace />} />
          <Route path="/orders/:id/photo-archive" element={<RepairPhotoArchivePage {...shared} />} />
          <Route path="/repair_photo_archive_1" element={<Navigate to="/orders/1/photo-archive-1" replace />} />
          <Route path="/orders/:id/photo-archive-1" element={<RepairPhotoArchiveCompactPage {...shared} />} />
          <Route path="/repair_photo_archive_2" element={<Navigate to="/orders/1/photo-archive-2" replace />} />
          <Route path="/orders/:id/photo-archive-2" element={<RepairPhotoArchivePage {...shared} />} />
          <Route path="/settings/print-1" element={<PrintSettingsPage {...shared} />} />
          <Route path="/settings/printer-1" element={<PrinterSettingsPage {...shared} />} />
          <Route path="/settings/printer-2" element={<PrinterPairingPage {...shared} />} />
          <Route path="/parts_adjustment_1" element={<Navigate to="/inventory/adjustment" replace />} />
          <Route path="/parts_adjustment_2" element={<Navigate to="/inventory/adjustment/requisition" replace />} />
          <Route path="/parts_adjustment_3" element={<Navigate to="/inventory/adjustment" replace />} />
          <Route path="/inbound" element={<Navigate to="/inventory/inbound" replace />} />
          <Route path="/inventory_loss" element={<Navigate to="/inventory/loss" replace />} />
          <Route path="/inventory_audit" element={<Navigate to="/inventory/audit-session" replace />} />
          <Route path="/select_parts" element={<Navigate to="/parts/select" replace />} />
          <Route path="/repair_queue" element={<Navigate to="/repair-queue" replace />} />
          <Route path="/repairs_hub" element={<Navigate to="/repairs-hub" replace />} />
          <Route path="/_1" element={<LegacyWorkbenchPage {...shared} />} />
          <Route path="/_2" element={<CompactReceiptSettlementPage {...shared} />} />
          <Route path="/_3" element={<SystemSettingsOverviewPage {...shared} />} />
          <Route path="/supply-order-details/:id" element={<ProcurementDetailsPage {...shared} />} />
          <Route path="/supply_order_details" element={<Navigate to="/supply-order-details/PO-20260001" replace />} />
          <Route path="/supply_order_details/:id" element={<SupplyOrderDetailsAlias />} />
        </Routes>
      </main>
      </div>

      {isMobile ? <BottomNav /> : null}

      {showOrderForm ? (
        <Drawer title="新增订单" onClose={() => setShowOrderForm(false)}>
          <form className="sheet-form" onSubmit={handleCreateOrder}>
            <Field label="在售品牌">
              <select
                value={orderForm.brandId}
                onChange={(e) => {
                  const nextBrandId = e.target.value;
                  const firstModel = orderFormOptions.models.find((model) => String(model.brandId) === nextBrandId);
                  setOrderForm((current) => ({
                    ...current,
                    brandId: nextBrandId,
                    modelId: String(firstModel?.id ?? ""),
                  }));
                }}
                required
              >
                <option value="">选择品牌</option>
                {orderFormOptions.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
              </select>
            </Field>
            <Field label="型号">
              <select value={orderForm.modelId} onChange={(e) => setOrderForm({ ...orderForm, modelId: e.target.value })} required>
                <option value="">选择型号</option>
                {availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </Field>
            <Field label="客户姓名"><input value={orderForm.customerName} onChange={(e) => setOrderForm({ ...orderForm, customerName: e.target.value })} required /></Field>
            <Field label="手机号"><input value={orderForm.customerPhone} onChange={(e) => setOrderForm({ ...orderForm, customerPhone: e.target.value })} required /></Field>
            <Field label="邮箱"><input type="email" value={orderForm.customerEmail} onChange={(e) => setOrderForm({ ...orderForm, customerEmail: e.target.value })} required /></Field>
            <Field label="技师">
              <select value={orderForm.technician} onChange={(e) => setOrderForm({ ...orderForm, technician: e.target.value })} required>
                <option value="">选择技师</option>
                {orderFormOptions.technicians.map((technician) => <option key={technician.id} value={technician.name}>{technician.name}</option>)}
              </select>
            </Field>
            <Field label="预约日期"><input type="date" value={orderForm.scheduledDate} onChange={(e) => setOrderForm({ ...orderForm, scheduledDate: e.target.value })} required /></Field>
            <Field label="报价"><input type="number" min="0" value={orderForm.amount} onChange={(e) => setOrderForm({ ...orderForm, amount: e.target.value })} /></Field>
            <Field label="定金"><input type="number" min="0" max={orderForm.amount || undefined} value={orderForm.deposit} onChange={(e) => setOrderForm({ ...orderForm, deposit: e.target.value })} placeholder="默认 0" /></Field>
            <Field label="状态">
              <select value={orderForm.status} onChange={(e) => setOrderForm({ ...orderForm, status: e.target.value })}>
                {statusTabs.filter((tab) => tab.value !== "all").map((tab) => <option key={tab.value} value={tab.value}>{tab.label}</option>)}
              </select>
            </Field>
            <Field label="默认问题">
              <select
                value={orderForm.issueTemplateId}
                onChange={(e) => {
                  const nextTemplateId = e.target.value;
                  const template = orderFormOptions.issueTemplates.find((item) => String(item.id) === nextTemplateId);
                  setOrderForm((current) => ({
                    ...current,
                    issueTemplateId: nextTemplateId,
                    issueSummary: template?.title ?? current.issueSummary,
                  }));
                }}
              >
                <option value="">选择默认问题</option>
                {orderFormOptions.issueTemplates.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </Field>
            <Field label="故障说明" full><textarea value={orderForm.issueSummary} onChange={(e) => setOrderForm({ ...orderForm, issueSummary: e.target.value })} required /></Field>
            <div className="sheet-field full">
              <div className="usage-tags">
                <span className="soft-badge">设备: {[selectedBrand?.name, selectedModel?.name].filter(Boolean).join(" ") || "未选择"}</span>
                <span className="soft-badge">待收尾款: {`${Math.max(0, Number(orderForm.amount || 0) - Number(orderForm.deposit || 0)).toLocaleString("en-US")} VUV`}</span>
              </div>
            </div>
            <Field label="IMEI / 序列号" full>
              <>
                <input value={orderForm.imeiSerial} onChange={(e) => setOrderForm({ ...orderForm, imeiSerial: e.target.value })} placeholder="输入或粘贴 IMEI / Serial" required />
                <div className="inline-upload-actions">
                  <span className="micro-label">支持粘贴识别 15 位 IMEI</span>
                  <button className="small-action-button" onClick={() => setOrderForm((current) => ({ ...current, imeiSerial: normalizeIdentifier(current.imeiSerial) }))} type="button">智能识别</button>
                </div>
              </>
            </Field>
            <Field label="客户签字" full>
              <input value={orderForm.customerSignature} onChange={(e) => setOrderForm({ ...orderForm, customerSignature: e.target.value })} placeholder="请输入客户签字姓名" required />
            </Field>
            <Field label="手机正面照片" full>
              <>
                <input accept="image/*" capture="environment" onChange={(e) => handleOrderPhotoChange("deviceFrontPhoto", e.target.files?.[0])} type="file" />
                {orderForm.deviceFrontPhoto ? (
                  <div className="inline-upload-card">
                    <img alt="手机正面预览" className="upload-preview-inline" src={orderForm.deviceFrontPhoto} />
                    <div className="inline-upload-actions">
                      <span className="soft-badge">已就绪</span>
                      <button className="small-action-button" onClick={() => clearOrderPhoto("deviceFrontPhoto")} type="button">删除重拍</button>
                    </div>
                  </div>
                ) : null}
                <span className="micro-label">请直接拍照或从相册选择</span>
              </>
            </Field>
            <Field label="手机背面照片" full>
              <>
                <input accept="image/*" capture="environment" onChange={(e) => handleOrderPhotoChange("deviceBackPhoto", e.target.files?.[0])} type="file" />
                {orderForm.deviceBackPhoto ? (
                  <div className="inline-upload-card">
                    <img alt="手机背面预览" className="upload-preview-inline" src={orderForm.deviceBackPhoto} />
                    <div className="inline-upload-actions">
                      <span className="soft-badge">已就绪</span>
                      <button className="small-action-button" onClick={() => clearOrderPhoto("deviceBackPhoto")} type="button">删除重拍</button>
                    </div>
                  </div>
                ) : null}
                <span className="micro-label">请直接拍照或从相册选择</span>
              </>
            </Field>
            <Field label="客户照片" full>
              <>
                <input accept="image/*" capture="user" onChange={(e) => handleOrderPhotoChange("customerPhoto", e.target.files?.[0])} type="file" />
                {orderForm.customerPhoto ? (
                  <div className="inline-upload-card">
                    <img alt="客户照片预览" className="upload-preview-inline" src={orderForm.customerPhoto} />
                    <div className="inline-upload-actions">
                      <span className="soft-badge">已就绪</span>
                      <button className="small-action-button" onClick={() => clearOrderPhoto("customerPhoto")} type="button">删除重拍</button>
                    </div>
                  </div>
                ) : null}
                <span className="micro-label">请直接拍照或从相册选择</span>
              </>
            </Field>
            <div className="sheet-field full">
              <div className="usage-tags">
                <span className={orderForm.deviceFrontPhoto ? "soft-badge" : "soft-badge soft-badge-muted"}>正面照片</span>
                <span className={orderForm.deviceBackPhoto ? "soft-badge" : "soft-badge soft-badge-muted"}>背面照片</span>
                <span className={orderForm.customerPhoto ? "soft-badge" : "soft-badge soft-badge-muted"}>客户照片</span>
              </div>
            </div>
            <Field label="备注" full><textarea value={orderForm.notes} onChange={(e) => setOrderForm({ ...orderForm, notes: e.target.value })} /></Field>
            <button className="primary-submit" disabled={!orderForm.brandId || !orderForm.modelId || !orderForm.technician || !orderForm.imeiSerial || !orderForm.customerSignature || !orderForm.deviceFrontPhoto || !orderForm.deviceBackPhoto || !orderForm.customerPhoto} type="submit">创建订单</button>
          </form>
        </Drawer>
      ) : null}

      {showMovementForm ? (
        <Drawer title="配件出入库" onClose={() => setShowMovementForm(false)}>
          <form className="sheet-form" onSubmit={handleMovement}>
            <Field label="配件" full>
              <select value={movementForm.partId} onChange={(e) => setMovementForm({ ...movementForm, partId: e.target.value })} required>
                <option value="">选择配件</option>
                {parts.map((part) => <option key={part.id} value={part.id}>{part.name} ({part.stock})</option>)}
              </select>
            </Field>
            <Field label="类型">
              <select value={movementForm.movementType} onChange={(e) => setMovementForm({ ...movementForm, movementType: e.target.value })}>
                <option value="in">入库</option>
                <option value="out">出库</option>
              </select>
            </Field>
            <Field label="数量"><input type="number" min="1" value={movementForm.quantity} onChange={(e) => setMovementForm({ ...movementForm, quantity: e.target.value })} required /></Field>
            <Field label="备注" full><textarea value={movementForm.note} onChange={(e) => setMovementForm({ ...movementForm, note: e.target.value })} /></Field>
            <button className="primary-submit" type="submit">保存流水</button>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}

function VilaPortCyanPage({ dashboard, orders, customers, financeReport }) {
  const navigate = useNavigate();
  const latestOrders = orders.slice(0, 3);
  return (
    <div className="store-page">
      <section className="store-hero-card">
        <div>
          <span className="soft-badge">维拉港分店</span>
          <h2>维拉港门店总览</h2>
          <p>维拉港 · 埃法特岛 · 瓦努阿图</p>
        </div>
        <div className="store-hero-metrics">
          <div><span className="micro-label">本月收入</span><strong>{financeReport?.summary?.totalRevenueFormatted ?? "-"}</strong></div>
          <div><span className="micro-label">活跃工单</span><strong>{dashboard?.metrics?.activeRepairs ?? 0}</strong></div>
        </div>
      </section>
      <section className="reports-metrics-grid">
        <div className="report-metric-card"><p>客户数</p><strong>{customers.length}</strong><span>门店累计</span></div>
        <div className="report-metric-card"><p>低库存</p><strong>{dashboard?.lowStockParts?.length ?? 0}</strong><span>需补货</span></div>
        <div className="report-metric-card primary"><p>今日收入</p><strong>{financeReport?.summary?.todayRevenueFormatted ?? "-"}</strong><span>实时更新</span></div>
      </section>
      <section className="page-section">
        <div className="section-title-row">
          <h3>今日重点</h3>
          <button className="link-button" onClick={() => navigate("/repairs-hub")} type="button">进入工作台</button>
        </div>
        {latestOrders.map((order) => (
          <button key={order.id} className="movement-card" onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
            <div>
              <strong>{order.title}</strong>
              <p>#{order.orderNo} · {order.deviceName}</p>
            </div>
            <span className="soft-badge">{statusChinese[order.status]}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function LegacyWorkbenchPage({ dashboard, orders, financeReport }) {
  const navigate = useNavigate();
  const activeOrders = orders.slice(0, 3);
  const cards = [
    { label: "今日订单", value: dashboard?.metrics?.todayOrders ?? 0, detail: `累计工单 ${dashboard?.metrics?.totalOrders ?? 0} 单`, icon: "assignment", tone: "teal" },
    { label: "待维修", value: dashboard?.metrics?.pendingOrders ?? 0, detail: `${dashboard?.metrics?.urgentOrders ?? 0} 件为加急`, icon: "build", tone: "orange" },
    { label: "当日收银 (VUV)", value: financeReport?.summary?.todayRevenueFormatted ?? "-", detail: `${financeReport?.summary?.transactionCount ?? 0} 笔交易`, icon: "payments", tone: "green" },
    { label: "采购订货", value: dashboard?.metrics?.pendingProcurements ?? 0, detail: `${dashboard?.lowStockParts?.length ?? 0} 个低库存`, icon: "shopping_cart", tone: "blue" },
  ];

  return (
    <div className="legacy-workbench-page">
      <section className="legacy-workbench-hero">
        <div className="legacy-workbench-avatar"><span className="material-symbols-outlined">account_circle</span></div>
        <div>
          <h2>综合维修管理工作台</h2>
          <p>早安, 维拉港分店</p>
        </div>
        <div className="legacy-workbench-icons">
          <button className="icon-button" onClick={() => navigate("/settings/language")} type="button"><span className="material-symbols-outlined">language</span></button>
          <button className="icon-button" onClick={() => navigate("/notifications")} type="button"><span className="material-symbols-outlined">notifications</span></button>
        </div>
      </section>

      <section className="legacy-workbench-grid">
        {cards.map((card) => (
          <div key={card.label} className="legacy-stat-card">
            <div className="legacy-stat-head">
              <span>{card.label}</span>
              <span className={`material-symbols-outlined tone-${card.tone}`}>{card.icon}</span>
            </div>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </div>
        ))}
        <div className="legacy-transport-card">
          <div>
            <span>待取机/送还</span>
            <strong>{dashboard?.metrics?.readyForPickup ?? 0}</strong>
          </div>
          <div className="legacy-transport-icon"><span className="material-symbols-outlined">done_all</span></div>
        </div>
      </section>

      <div className="legacy-workbench-actions">
        <button className="wide-action secondary" onClick={() => navigate("/orders/1/receipt")} type="button"><span className="material-symbols-outlined">print</span><span>打印票据</span></button>
        <button className="wide-action secondary" onClick={() => navigate("/scanner")} type="button"><span className="material-symbols-outlined">qr_code_scanner</span><span>扫码登记</span></button>
        <button className="wide-action secondary" onClick={() => navigate("/quotes/new")} type="button"><span className="material-symbols-outlined">request_quote</span><span>新增报价</span></button>
        <button className="wide-action secondary" onClick={() => navigate("/documents")} type="button"><span className="material-symbols-outlined">receipt_long</span><span>报价与发票</span></button>
      </div>

      <section className="page-section">
        <div className="section-title-row">
          <h3>进行中任务</h3>
          <button className="link-button" onClick={() => navigate("/repair-queue")} type="button">查看全部</button>
        </div>
        {activeOrders.map((order) => (
          <button key={order.id} className="legacy-task-card" onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
            <div className="legacy-task-icon"><span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span></div>
            <div className="legacy-task-main">
              <strong>{order.title}</strong>
              <p>{order.customerName} · 尾号 {order.customerPhone?.slice(-4) ?? "8892"}</p>
            </div>
            <div className="legacy-task-side">
              <span className={`mini-state ${order.status}`}>{statusChinese[order.status]}</span>
              <strong>{order.amountFormatted}</strong>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}

function RepairsHubPage({ orders, dashboard, financeReport, loading, selectedStatus, search, setSearch, setSelectedStatus, refresh, openOrderForm }) {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const selectedStatusLabel = statusTabs.find((tab) => tab.value === selectedStatus)?.label ?? "全部";
  const todayOrders = dashboard?.metrics?.todayOrders ?? 0;
  const pendingCount = dashboard?.metrics?.pendingOrders ?? 0;
  const inProgressCount = dashboard?.metrics?.inProgressOrders ?? 0;
  const readyCount = dashboard?.metrics?.readyForPickup ?? 0;
  const pendingProcurements = dashboard?.metrics?.pendingProcurements ?? 0;
  const todayRevenue = financeReport?.summary?.todayRevenueFormatted ?? "-";
  const visibleCount = orders.length;
  const visibleRevenue = orders.reduce((sum, order) => sum + (Number(order.amount) || 0), 0);
  const visibleUrgent = orders.filter((order) => String(order.priorityLabel ?? "").includes("加急") || order.status === "pending").length;
  const visibleReady = orders.filter((order) => order.status === "completed" || order.status === "picked_up").length;
  const activeOrders = orders.slice(0, 4);

  function openWorkbenchFilter(nextStatus, options = {}) {
    setSelectedStatus(nextStatus);
    refresh(nextStatus, search);
    navigate("/repair-queue", { state: { presetStatus: nextStatus, presetPriority: options.priority ?? "" } });
  }

  if (!isMobile) {
    return (
      <div className="workbench-desktop-page">
        <section className="workbench-desktop-hero">
          <div className="workbench-desktop-hero-copy">
            <span className="micro-label">Desktop Operations</span>
            <h2>综合维修管理工作台</h2>
            <p>聚焦当日工单、营收与交付状态，适合电脑和平板连续操作。</p>
          </div>
          <div className="workbench-desktop-hero-actions">
            <button className="wide-action secondary" onClick={() => navigate("/notifications")} type="button">通知中心</button>
            <button className="wide-action primary" onClick={openOrderForm} type="button">新增订单</button>
          </div>
        </section>

        <section className="workbench-desktop-controls">
          <div className="repairs-template-search">
            <span className="material-symbols-outlined">search</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索设备、客户、订单号..." type="text" value={search} />
          </div>
          <nav className="repairs-template-filters desktop">
            {statusTabs.map((tab) => (
              <button
                key={tab.value}
                className={selectedStatus === tab.value ? "repairs-template-filter active" : "repairs-template-filter"}
                onClick={() => {
                  setSelectedStatus(tab.value);
                  refresh(tab.value, search);
                }}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </section>

        <section className="workbench-desktop-metrics">
          <button className="workbench-desktop-metric-card" onClick={() => openWorkbenchFilter(selectedStatus === "all" ? "pending" : selectedStatus)} type="button">
            <span>工单总览</span>
            <strong>{selectedStatus === "all" ? todayOrders : visibleCount}</strong>
            <p>{selectedStatus === "all" ? "今日新增工单" : `${selectedStatusLabel} 筛选结果`}</p>
          </button>
          <button className="workbench-desktop-metric-card warning" onClick={() => openWorkbenchFilter(selectedStatus === "all" ? "in_progress" : "all", selectedStatus === "all" ? {} : { priority: "urgent" })} type="button">
            <span>维修关注</span>
            <strong>{selectedStatus === "all" ? pendingCount : visibleUrgent}</strong>
            <p>{selectedStatus === "all" ? `${inProgressCount} 单维修中` : "当前加急关注项"}</p>
          </button>
          <div className="workbench-desktop-metric-card success">
            <span>营收表现</span>
            <strong>{selectedStatus === "all" ? todayRevenue : visibleRevenue.toLocaleString("en-US")}</strong>
            <p>{selectedStatus === "all" ? `${readyCount} 单可交付` : `${visibleReady} 单已完工 / 可交付`}</p>
          </div>
          <button className="workbench-desktop-metric-card info" onClick={() => navigate("/supplier-management")} type="button">
            <span>采购跟进</span>
            <strong>{pendingProcurements}</strong>
            <p>待跟进采购单</p>
          </button>
        </section>

        <section className="workbench-desktop-grid">
          <div className="workbench-desktop-panel">
            <div className="workbench-desktop-panel-head">
              <h3>{selectedStatus === "all" ? "重点工单" : `${selectedStatusLabel} 工单`}</h3>
              <button className="link-button" onClick={() => navigate("/repair-queue")} type="button">查看全部</button>
            </div>
            <div className="workbench-desktop-order-list">
              {loading ? <div className="empty-card">数据同步中...</div> : null}
              {!loading && !activeOrders.length ? <div className="empty-card">当前筛选下暂无工单。</div> : null}
              {activeOrders.map((order) => (
                <button key={order.id} className="workbench-desktop-order-row" onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
                  <div className="workbench-desktop-order-main">
                    <div className="workbench-desktop-order-icon">
                      <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
                    </div>
                    <div>
                      <strong>{order.title}</strong>
                      <p>{order.customerName} · {order.orderNo}</p>
                    </div>
                  </div>
                  <div className="workbench-desktop-order-meta">
                    <span className={`mini-state ${order.status}`}>{statusChinese[order.status] ?? order.status}</span>
                    <strong>{order.amountFormatted}</strong>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="workbench-desktop-side">
            <div className="workbench-desktop-panel">
              <div className="workbench-desktop-panel-head">
                <h3>快捷操作</h3>
              </div>
              <div className="workbench-desktop-actions">
                <button className="wide-action secondary" onClick={() => navigate(`/orders/${orders[0]?.id ?? 1}/receipt`)} type="button">打印票据</button>
                <button className="wide-action secondary" onClick={() => navigate("/scanner")} type="button">扫码登记</button>
                <button className="wide-action secondary" onClick={() => navigate("/quotes/new")} type="button">新增报价</button>
                <button className="wide-action secondary" onClick={() => navigate("/documents")} type="button">报价与发票</button>
              </div>
            </div>
            <div className="workbench-desktop-panel accent">
              <div className="workbench-desktop-panel-head">
                <h3>交付提醒</h3>
              </div>
              <div className="workbench-desktop-delivery">
                <strong>{readyCount}</strong>
                <p>当前待取机 / 待送还设备</p>
                <button className="wide-action primary" onClick={() => openWorkbenchFilter("completed")} type="button">查看交付队列</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="workbench-template-page">
      <section className="workbench-template-header">
        <div className="workbench-template-avatar">
          <span className="material-symbols-outlined">account_circle</span>
        </div>
        <div className="workbench-template-title">
          <h2>综合维修管理工作台</h2>
          <p>早安，维拉港分店</p>
        </div>
        <div className="workbench-template-header-actions">
          <button onClick={() => navigate("/settings/language")} type="button"><span className="material-symbols-outlined">language</span></button>
          <button onClick={() => navigate("/notifications")} type="button"><span className="material-symbols-outlined">notifications</span></button>
        </div>
      </section>

      <section className="repairs-template-search-block">
        <div className="repairs-template-search">
          <span className="material-symbols-outlined">search</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索设备或客户姓名..." type="text" value={search} />
        </div>
      </section>

      <nav className="repairs-template-filters">
        {statusTabs.map((tab) => (
          <button
            key={tab.value}
            className={selectedStatus === tab.value ? "repairs-template-filter active" : "repairs-template-filter"}
            onClick={() => {
              setSelectedStatus(tab.value);
              refresh(tab.value, search);
            }}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <section className="workbench-template-metrics">
        <div className="workbench-template-metric-item metric-orders">
          <button className="workbench-template-metric-card" onClick={() => openWorkbenchFilter(selectedStatus === "all" ? "pending" : selectedStatus)} type="button">
            <div className="workbench-template-metric-body">
              <p className="metric-label metric-label-inline">{selectedStatus === "all" ? "今日订单" : `${selectedStatusLabel}工单`}</p>
              <strong>{selectedStatus === "all" ? todayOrders : visibleCount}</strong>
              <span>{selectedStatus === "all" ? "今日受理工单" : "当前筛选结果"}</span>
            </div>
          </button>
        </div>
        <div className="workbench-template-metric-item metric-pending">
          <button className="workbench-template-metric-card warning" onClick={() => openWorkbenchFilter(selectedStatus === "all" ? "in_progress" : "all", selectedStatus === "all" ? {} : { priority: "urgent" })} type="button">
            <div className="workbench-template-metric-body">
              <p className="metric-label metric-label-inline">{selectedStatus === "all" ? "待维修" : "加急关注"}</p>
              <strong>{selectedStatus === "all" ? pendingCount : visibleUrgent}</strong>
              <span>{selectedStatus === "all" ? `${inProgressCount} 单维修中` : "当前列表中的重点工单"}</span>
            </div>
          </button>
        </div>
        <div className="workbench-template-metric-item metric-revenue">
          <div className="workbench-template-metric-card success">
            <div className="inventory-template-metric-icon primary">
              <span className="material-symbols-outlined">payments</span>
            </div>
            <div className="workbench-template-metric-body">
              <p className="metric-label metric-label-inline">{selectedStatus === "all" ? "当日收银 (VUV)" : "当前金额 (VUV)"}</p>
              <strong>{selectedStatus === "all" ? todayRevenue : visibleRevenue.toLocaleString("en-US")}</strong>
              <span>{selectedStatus === "all" ? `${readyCount} 单可交付` : `${visibleReady} 单已完工/可交付`}</span>
            </div>
          </div>
        </div>
        <div className="workbench-template-metric-item metric-procurement">
          <button className="workbench-template-metric-card blue" onClick={() => navigate("/supplier-management")} type="button">
            <div className="workbench-template-metric-body">
              <p className="metric-label metric-label-inline">采购跟进</p>
              <strong>{pendingProcurements}</strong>
              <span>待跟进采购单</span>
            </div>
          </button>
        </div>
        <button className="workbench-template-metric-card wide metric-delivery" onClick={() => openWorkbenchFilter("completed")} type="button">
          <div>
            <p>待取机 / 送还</p>
            <strong>{readyCount}</strong>
          </div>
          <div className="workbench-template-transport-icon"><span className="material-symbols-outlined">done_all</span></div>
        </button>
      </section>

      <div className="workbench-template-actions">
        <button className="wide-action secondary" onClick={() => navigate(`/orders/${orders[0]?.id ?? 1}/receipt`)} type="button">
          <span className="material-symbols-outlined">print</span>
          <span>打印票据</span>
        </button>
        <button className="wide-action secondary" onClick={() => navigate("/scanner")} type="button">
          <span className="material-symbols-outlined">qr_code_scanner</span>
          <span>扫码登记</span>
        </button>
        <button className="wide-action secondary" onClick={() => navigate("/quotes/new")} type="button">
          <span className="material-symbols-outlined">request_quote</span>
          <span>新增报价</span>
        </button>
        <button className="wide-action secondary" onClick={() => navigate("/documents")} type="button">
          <span className="material-symbols-outlined">receipt_long</span>
          <span>报价与发票</span>
        </button>
      </div>

      <div className="repairs-template-section-head workbench-template-section-head">
        <h2>{selectedStatus === "all" ? "全部工单" : `${selectedStatusLabel}工单`}</h2>
        <button className="link-button" onClick={() => navigate("/repair-queue")} type="button">查看全部</button>
      </div>

      <section className="repairs-template-list workbench-template-list">
        {loading ? <div className="empty-card">数据同步中...</div> : null}
        {!loading && !activeOrders.length ? <div className="empty-card">当前筛选下暂无工单。</div> : null}
        {activeOrders.map((order) => {
          const tone = order.status === "in_progress" ? "primary" : order.status === "pending" ? "warning" : order.status === "picked_up" ? "success" : "primary";
          return (
            <button key={order.id} className={`workbench-template-task-card ${tone}`} onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
              <div className="workbench-template-task-left">
                <div className={`workbench-template-task-icon ${tone}`}>
                    <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
                  </div>
                <div className="workbench-template-task-main">
                    <h3>{order.title}</h3>
                    <p>{order.customerName} · 尾号 {order.customerPhone?.slice(-4) ?? "8892"}</p>
                  </div>
              </div>
              <div className="workbench-template-task-right">
                <span className={`mini-state ${order.status}`}>{statusChinese[order.status] ?? order.status}</span>
                <strong>{order.amountFormatted}</strong>
              </div>
              <span className="material-symbols-outlined workbench-template-chevron">chevron_right</span>
            </button>
          );
        })}
      </section>
      <button className="fab-button" onClick={openOrderForm} type="button">
        <span className="material-symbols-outlined">add</span>
      </button>
    </div>
  );
}

function RepairQueuePage({ selectedStatus, search, setSearch, setSelectedStatus, openOrderForm }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [data, setData] = useState({ metrics: null, rows: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workingId, setWorkingId] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");

  useEffect(() => {
    const presetStatus = String(location.state?.presetStatus ?? "").trim();
    const presetPriority = String(location.state?.presetPriority ?? "").trim();
    if (presetStatus && presetStatus !== selectedStatus) {
      setSelectedStatus(presetStatus);
    }
    if (presetPriority !== priorityFilter) {
      setPriorityFilter(presetPriority);
    }
  }, [location.state, priorityFilter, selectedStatus, setSelectedStatus]);

  const loadQueue = useCallback(async (status = selectedStatus, keyword = search, priority = priorityFilter) => {
    const query = new URLSearchParams();
    query.set("status", status);
    if (keyword.trim()) query.set("search", keyword.trim());
    if (priority) query.set("priority", priority);
    const result = await fetchJson(`/api/repair-queue?${query.toString()}`);
    setData(result);
  }, [priorityFilter, search, selectedStatus]);

  useEffect(() => {
    let ignore = false;
    async function boot() {
      try {
        setLoading(true);
        setError("");
        const query = new URLSearchParams();
        query.set("status", selectedStatus);
        if (search.trim()) query.set("search", search.trim());
        if (priorityFilter) query.set("priority", priorityFilter);
        const result = await fetchJson(`/api/repair-queue?${query.toString()}`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    boot();
    return () => {
      ignore = true;
    };
  }, [priorityFilter, search, selectedStatus]);

  async function handleQueueAction(orderId, action) {
    try {
      setWorkingId(`${orderId}:${action}`);
      setError("");
      await fetchJson(`/api/repair-queue/${orderId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await loadQueue(selectedStatus, search, priorityFilter);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setWorkingId("");
    }
  }

  if (!isMobile) {
    return (
      <div className="repair-queue-desktop-page">
        <section className="repair-queue-desktop-header">
          <div>
            <span className="micro-label">Desktop Queue</span>
            <h2>维修队列看板</h2>
          </div>
          <button className="wide-action primary" onClick={openOrderForm} type="button">新建工单</button>
        </section>

        <section className="repair-queue-desktop-toolbar">
          <div className="repairs-template-search">
            <span className="material-symbols-outlined">search</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索订单、设备或客户..." type="text" value={search} />
          </div>
          <div className="repair-queue-desktop-priority">
            <button className={priorityFilter === "" ? "status-chip active" : "status-chip"} onClick={() => { setPriorityFilter(""); loadQueue(selectedStatus, search, ""); }} type="button">全部优先级</button>
            <button className={priorityFilter === "urgent" ? "status-chip active" : "status-chip"} onClick={() => { setPriorityFilter("urgent"); loadQueue("all", search, "urgent"); setSelectedStatus("all"); }} type="button">仅加急</button>
          </div>
        </section>

        <div className="repair-queue-template-filters desktop">
          {statusTabs.map((tab) => (
            <button
              key={tab.value}
              className={selectedStatus === tab.value ? "repairs-template-filter active" : "repairs-template-filter"}
              onClick={() => {
                setSelectedStatus(tab.value);
                loadQueue(tab.value, search);
              }}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <section className="repair-queue-desktop-metrics">
          <div className="repair-queue-desktop-metric"><span>处理中</span><strong>{data.metrics?.active ?? "-"}</strong></div>
          <div className="repair-queue-desktop-metric"><span>待处理</span><strong>{data.metrics?.pending ?? "-"}</strong></div>
          <div className="repair-queue-desktop-metric danger"><span>加急单</span><strong>{data.metrics?.urgent ?? "-"}</strong></div>
          <div className="repair-queue-desktop-metric success"><span>预估产值</span><strong>{data.metrics?.revenueEstimate ?? "-"}</strong></div>
        </section>

        <section className="repair-queue-desktop-table-wrap">
          {loading ? <div className="empty-card">数据同步中...</div> : null}
          {error ? <div className="message-banner error">{error}</div> : null}
          {!loading && !data.rows.length ? <div className="empty-card">当前筛选下没有订单。</div> : null}
          {data.rows.length ? (
            <div className="repair-queue-desktop-table">
              <div className="repair-queue-desktop-head">
                <span>设备 / 订单</span>
                <span>客户</span>
                <span>状态</span>
                <span>进度</span>
                <span>金额</span>
                <span>操作</span>
              </div>
              {data.rows.map((order) => (
                <div key={order.id} className="repair-queue-desktop-row">
                  <button className="repair-queue-desktop-device" onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
                    <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
                    <div>
                      <strong>{order.deviceName}</strong>
                      <p>{order.orderNo} · {order.elapsedLabel}</p>
                    </div>
                  </button>
                  <div className="repair-queue-desktop-cell">
                    <strong>{order.customerName}</strong>
                    <p>{order.footerText}</p>
                  </div>
                  <div className="repair-queue-desktop-cell">
                    <span className={`mini-state ${order.status === "in_progress" ? "active" : order.priorityLabel?.includes("加急") ? "urgent" : order.status}`}>{order.priorityLabel}</span>
                  </div>
                  <div className="repair-queue-desktop-cell">
                    <div className="repair-queue-desktop-progress">
                      <div><span style={{ width: `${order.progress}%` }} /></div>
                      <strong>{order.progress}%</strong>
                    </div>
                  </div>
                  <div className="repair-queue-desktop-cell">
                    <strong>{order.amountFormatted}</strong>
                  </div>
                  <div className="repair-queue-desktop-actions">
                    {order.status === "pending" ? (
                      <button disabled={workingId === `${order.id}:accept`} onClick={() => handleQueueAction(order.id, "accept")} type="button">接单</button>
                    ) : null}
                    {order.status === "in_progress" ? (
                      <button disabled={workingId === `${order.id}:complete`} onClick={() => handleQueueAction(order.id, "complete")} type="button">完工</button>
                    ) : null}
                    <button className="primary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">详情</button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="repair-queue-template-page">
      <section className="repairs-template-search-block">
        <div className="repairs-template-search">
          <span className="material-symbols-outlined">search</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索订单、设备或客户..." type="text" value={search} />
        </div>
      </section>
      <div className="repair-queue-template-filters">
        {statusTabs.map((tab) => (
          <button
            key={tab.value}
            className={selectedStatus === tab.value ? "repairs-template-filter active" : "repairs-template-filter"}
            onClick={() => {
              setSelectedStatus(tab.value);
              loadQueue(tab.value, search);
            }}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <section className="repair-queue-template-metrics">
        <div className="repair-queue-template-metric-item">
          <button className="repair-queue-template-metric-card" onClick={() => { setPriorityFilter(""); setSelectedStatus("in_progress"); loadQueue("in_progress", search, ""); }} type="button">
            <div className="repair-queue-template-metric-body">
              <p className="metric-label metric-label-inline">处理中</p>
              <strong>{data.metrics?.active ?? "-"}</strong>
            </div>
          </button>
        </div>
        <div className="repair-queue-template-metric-item">
          <button className="repair-queue-template-metric-card" onClick={() => { setPriorityFilter(""); setSelectedStatus("pending"); loadQueue("pending", search, ""); }} type="button">
            <div className="repair-queue-template-metric-body">
              <p className="metric-label metric-label-inline">待处理</p>
              <strong>{data.metrics?.pending ?? "-"}</strong>
            </div>
          </button>
        </div>
        <div className="repair-queue-template-metric-item">
          <button className="repair-queue-template-metric-card" onClick={() => { setPriorityFilter("urgent"); setSelectedStatus("all"); loadQueue("all", search, "urgent"); }} type="button">
            <div className="repair-queue-template-metric-body">
              <p className="metric-label metric-label-inline">加急单</p>
              <strong className="danger">{data.metrics?.urgent ?? "-"}</strong>
            </div>
          </button>
        </div>
        <div className="repair-queue-template-metric-item revenue">
          <div className="repair-queue-template-metric-card">
            <div className="repair-queue-template-metric-body">
              <p className="metric-label metric-label-inline">预估产值</p>
              <strong className="primary">{data.metrics?.revenueEstimate ?? "-"}</strong>
            </div>
          </div>
        </div>
      </section>
      <section className="repair-queue-template-section">
        <h2>当前队列</h2>
        {loading ? <div className="empty-card">数据同步中...</div> : null}
        {error ? <div className="message-banner error">{error}</div> : null}
        {data.rows.map((order) => {
          const tone = order.priorityLabel?.includes("加急") ? "danger" : order.status === "in_progress" ? "primary" : order.status === "pending" ? "warning" : "primary";
          const progressColor = tone === "danger" ? "#ef4444" : tone === "warning" ? "#f7a072" : "#007e85";
          const progressLabel = order.status === "in_progress" ? "维修中" : order.status === "pending" ? "待处理" : order.status === "completed" ? "已完成" : "可交付";
          return (
            <button
              key={order.id}
              className={`repair-queue-template-card ${tone}`}
              onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)}
              type="button"
            >
              <div className="repair-queue-template-card-top">
                <div className="repair-queue-template-device">
                  <div className={`repair-queue-template-icon ${tone}`}>
                    <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
                  </div>
                  <div>
                    <h3>{order.deviceName}</h3>
                    <p>{order.orderNo} · <span>{order.elapsedLabel}</span></p>
                  </div>
                </div>
                <div className="repair-queue-template-side">
                  <span className={`repair-queue-template-badge ${tone}`}>{order.priorityLabel}</span>
                  <p>{order.amountFormatted}</p>
                </div>
              </div>
              <div className="repair-queue-template-progress-wrap">
                <div className="repair-queue-template-progress-head">
                  <span>{progressLabel}</span>
                  <span>{order.progress}%</span>
                </div>
                <div className="repair-queue-template-progress-bar">
                  <div style={{ width: `${order.progress}%`, background: progressColor }} />
                </div>
              </div>
              <div className="repair-queue-template-foot">
                <p>{order.footerText}</p>
                <div className="repair-queue-template-actions">
                  {order.status === "pending" ? (
                    <button disabled={workingId === `${order.id}:accept`} onClick={(event) => { event.stopPropagation(); handleQueueAction(order.id, "accept"); }} type="button">接单</button>
                  ) : null}
                  {order.status === "in_progress" ? (
                    <button disabled={workingId === `${order.id}:complete`} onClick={(event) => { event.stopPropagation(); handleQueueAction(order.id, "complete"); }} type="button">完工</button>
                  ) : null}
              <button className="primary" onClick={(event) => { event.stopPropagation(); navigate(`/orders/${getOrderRouteId(order)}`); }} type="button">详情</button>
                </div>
              </div>
            </button>
          );
        })}
        {!data.rows.length && !loading ? <div className="empty-card">当前筛选下没有订单。</div> : null}
      </section>
      <button className="fab-button" onClick={openOrderForm} type="button">
        <span className="material-symbols-outlined">add</span>
      </button>
    </div>
  );
}

function OrderListPage({ orders, loading, selectedStatus, search, setSearch, setSelectedStatus, refresh, openOrderForm }) {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();

  function resolveAmountLabel(order) {
    if (order.status === "completed") return "最终金额";
    if (order.status === "picked_up") return "结算金额";
    return "预估金额";
  }

  function resolveDateLabel(order) {
    if (order.status === "completed") return "完成日期";
    if (order.status === "picked_up") return "取件日期";
    return "预约日期";
  }

  function resolveTone(order) {
    if (order.status === "pending") return "warning";
    if (order.status === "in_progress") return "primary";
    if (order.status === "completed") return "success";
    return "neutral";
  }

  const listMetrics = useMemo(() => ({
    all: orders.length,
    pending: orders.filter((order) => order.status === "pending").length,
    inProgress: orders.filter((order) => order.status === "in_progress").length,
    completed: orders.filter((order) => order.status === "completed").length,
    pickedUp: orders.filter((order) => order.status === "picked_up").length,
  }), [orders]);

  if (!isMobile) {
    return (
      <div className="order-list-desktop-page">
        <section className="order-list-desktop-hero">
          <div>
            <span className="micro-label">订单总览</span>
            <h2>维修订单列表</h2>
            <p>按状态筛选工单、快速搜索设备与客户，并直接进入收据或详情流程。</p>
          </div>
          <div className="desktop-topbar-actions">
            <button className="wide-action secondary" onClick={() => refresh(selectedStatus, search)} type="button">刷新列表</button>
            <button className="wide-action" onClick={openOrderForm} type="button">新建工单</button>
          </div>
        </section>

        <section className="order-list-desktop-metrics">
          <div className="metric-tile"><div><p>全部订单</p><strong>{listMetrics.all}</strong></div></div>
          <div className="metric-tile warning"><div><p>待维修</p><strong>{listMetrics.pending}</strong></div></div>
          <div className="metric-tile"><div><p>维修中</p><strong>{listMetrics.inProgress}</strong></div></div>
          <div className="metric-tile success"><div><p>已修复</p><strong>{listMetrics.completed + listMetrics.pickedUp}</strong></div></div>
        </section>

        <section className="order-list-desktop-toolbar">
          <div className="repairs-template-search">
            <span className="material-symbols-outlined">search</span>
            <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索设备、客户或订单号..." type="text" value={search} />
          </div>
          <nav className="order-list-desktop-filters">
            <button className={selectedStatus === "all" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("all"); refresh("all", search); }} type="button">全部</button>
            <button className={selectedStatus === "pending" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("pending"); refresh("pending", search); }} type="button">待维修</button>
            <button className={selectedStatus === "in_progress" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("in_progress"); refresh("in_progress", search); }} type="button">维修中</button>
            <button className={selectedStatus === "completed" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("completed"); refresh("completed", search); }} type="button">已修复</button>
            <button className={selectedStatus === "picked_up" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("picked_up"); refresh("picked_up", search); }} type="button">已取件</button>
          </nav>
        </section>

        <div className="order-list-desktop-grid">
          <section className="order-list-desktop-panel">
            {loading ? <div className="empty-card">数据同步中...</div> : null}
            <div className="order-list-desktop-table">
              <div className="order-list-desktop-head">
                <span>设备 / 订单号</span>
                <span>客户</span>
                <span>状态</span>
                <span>日期</span>
                <span>金额</span>
                <span />
              </div>
              {orders.map((order) => {
                const tone = resolveTone(order);
                return (
                  <button key={order.id} className={`order-list-desktop-row ${tone}`} onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
                    <div className="order-list-desktop-device">
                      <div className={`order-list-template-icon ${tone}`}>
                        <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
                      </div>
                      <div>
                        <strong>{order.deviceName}</strong>
                        <p>订单号 {order.orderNo}</p>
                      </div>
                    </div>
                    <div className="order-list-desktop-meta">
                      <strong>{order.customerName}</strong>
                      <p>{order.technician || "待分配技师"}</p>
                    </div>
                    <span className={`order-list-template-badge ${tone}`}>{order.statusMeta?.label ?? order.status}</span>
                    <div className="order-list-desktop-meta">
                      <strong>{order.scheduledDate}</strong>
                      <p>{resolveDateLabel(order)}</p>
                    </div>
                    <div className="order-list-desktop-meta">
                      <strong>{order.amountFormatted}</strong>
                      <p>{resolveAmountLabel(order)}</p>
                    </div>
                    <span className="material-symbols-outlined">chevron_right</span>
                  </button>
                );
              })}
            </div>
            {!orders.length && !loading ? <div className="empty-card">当前筛选下没有订单。</div> : null}
          </section>

          <aside className="order-list-desktop-side">
            <div className="template-card">
              <h3>快捷入口</h3>
              <p>继续常用工作流，减少来回切换。</p>
              <div className="stacked-actions">
                <button className="wide-action" onClick={openOrderForm} type="button">新建维修单</button>
                <button className="wide-action secondary" onClick={() => navigate(`/orders/${orders[0]?.id ?? 1}/receipt`)} type="button">打印最近收据</button>
                <button className="wide-action secondary" onClick={() => navigate("/repair-queue")} type="button">查看维修队列</button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="order-list-template-page">
      <section className="repairs-template-search-block">
        <div className="repairs-template-search">
          <span className="material-symbols-outlined">search</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索设备、客户或订单号..." type="text" value={search} />
        </div>
      </section>

      <nav className="order-list-template-filters">
        <button className={selectedStatus === "all" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("all"); refresh("all", search); }} type="button">全部订单</button>
        <button className={selectedStatus === "pending" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("pending"); refresh("pending", search); }} type="button">待维修</button>
        <button className={selectedStatus === "in_progress" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("in_progress"); refresh("in_progress", search); }} type="button">维修中</button>
        <button className={selectedStatus === "completed" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("completed"); refresh("completed", search); }} type="button">已修复</button>
        <button className={selectedStatus === "picked_up" ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => { setSelectedStatus("picked_up"); refresh("picked_up", search); }} type="button">已取件</button>
      </nav>

      <section className="order-list-template-section">
        {loading ? <div className="empty-card">数据同步中...</div> : null}
        {orders.map((order) => {
          const tone = resolveTone(order);
          return (
          <button key={order.id} className={`order-list-template-card ${tone}`} onClick={() => navigate(`/orders/${getOrderRouteId(order)}`)} type="button">
              <div className="order-list-template-top">
                <div className="order-list-template-device">
                  <div className={`order-list-template-icon ${tone}`}>
                    <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
                  </div>
                  <div>
                    <h3>{order.deviceName}</h3>
                    <p>订单号 {order.orderNo}</p>
                  </div>
                </div>
                <span className={`order-list-template-badge ${tone}`}>{order.statusMeta?.label ?? order.status}</span>
              </div>
              <div className="order-list-template-grid">
                <div>
                  <p>{resolveDateLabel(order)}</p>
                  <strong>{order.scheduledDate}</strong>
                </div>
                <div>
                  <p>客户姓名</p>
                  <strong>{order.customerName}</strong>
                </div>
              </div>
              <div className="order-list-template-bottom">
                <div className="order-list-template-amount">
                  <p>{resolveAmountLabel(order)}</p>
                  <strong>{order.amountFormatted}</strong>
                </div>
                <span className="material-symbols-outlined">chevron_right</span>
              </div>
            </button>
          );
        })}
        {!orders.length && !loading ? <div className="empty-card">当前筛选下没有订单。</div> : null}
      </section>

      <div className="order-list-template-fab-wrap">
        <button className="order-list-template-fab" onClick={() => navigate(`/orders/${orders[0]?.id ?? 1}/receipt`)} type="button">
          <span className="material-symbols-outlined">print</span>
        </button>
      </div>
      <button className="fab-button" onClick={openOrderForm} type="button">
        <span className="material-symbols-outlined">add</span>
      </button>
    </div>
  );
}

function OrderDetailPage({ customers, onStatusChange }) {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [partsSaving, setPartsSaving] = useState(false);
  const [partsForm, setPartsForm] = useState([]);
  const [activePhoto, setActivePhoto] = useState(null);
  const [internalMessages, setInternalMessages] = useState([]);
  const [manageForm, setManageForm] = useState({
    title: "",
    technician: "",
    scheduledDate: "",
    amount: "",
    deposit: "",
    customerName: "",
    customerPhone: "",
    customerEmail: "",
    imeiSerial: "",
    batteryHealth: "",
    storageCapacity: "",
    customerSignature: "",
    issueSummary: "",
    notes: "",
  });
  const [internalNote, setInternalNote] = useState("");

  async function refreshOrderDetail() {
    const detail = await fetchJson(`/api/orders/${id}`);
    setOrder(detail);
    setPartsForm((detail.parts ?? []).map((part) => ({
      partId: part.id,
      name: part.name,
      quantity: String(part.quantity),
      unitPrice: String(part.unitPrice),
    })));
    setManageForm({
      title: detail.title ?? "",
      technician: detail.technician ?? "",
      scheduledDate: detail.scheduledDate ?? "",
      amount: String(detail.amount ?? ""),
      deposit: String(detail.deposit ?? ""),
      customerName: detail.customerName ?? "",
      customerPhone: detail.customerPhone ?? "",
      customerEmail: detail.customerEmail ?? "",
      imeiSerial: detail.intakeMeta?.imeiSerial ?? detail.deviceMeta?.serialNumber ?? "",
      batteryHealth: detail.intakeMeta?.batteryHealth ?? detail.deviceMeta?.batteryHealth ?? "",
      storageCapacity: detail.intakeMeta?.storageCapacity ?? detail.deviceMeta?.storage ?? "",
      customerSignature: detail.intakeMeta?.customerSignature ?? "",
      issueSummary: detail.issueSummary ?? "",
      notes: detail.notes ?? "",
    });
    return detail;
  }

  async function refreshInternalMessages() {
    const communication = await fetchJson(`/api/orders/${id}/communication`);
    setInternalMessages((communication.messages ?? []).filter((message) => message.sender === "internal"));
    return communication;
  }

  useEffect(() => {
    let ignore = false;
    async function loadOrder() {
      try {
        setLoading(true);
        setError("");
        const [detail, communication] = await Promise.all([
          fetchJson(`/api/orders/${id}`),
          fetchJson(`/api/orders/${id}/communication`),
        ]);
        if (!ignore) {
          setOrder(detail);
          setPartsForm((detail.parts ?? []).map((part) => ({
            partId: part.id,
            name: part.name,
            quantity: String(part.quantity),
            unitPrice: String(part.unitPrice),
          })));
          setManageForm({
            title: detail.title ?? "",
            technician: detail.technician ?? "",
            scheduledDate: detail.scheduledDate ?? "",
            amount: String(detail.amount ?? ""),
            deposit: String(detail.deposit ?? ""),
            customerName: detail.customerName ?? "",
            customerPhone: detail.customerPhone ?? "",
            customerEmail: detail.customerEmail ?? "",
            imeiSerial: detail.intakeMeta?.imeiSerial ?? detail.deviceMeta?.serialNumber ?? "",
            batteryHealth: detail.intakeMeta?.batteryHealth ?? detail.deviceMeta?.batteryHealth ?? "",
            storageCapacity: detail.intakeMeta?.storageCapacity ?? detail.deviceMeta?.storage ?? "",
            customerSignature: detail.intakeMeta?.customerSignature ?? "",
            issueSummary: detail.issueSummary ?? "",
            notes: detail.notes ?? "",
          });
          setInternalMessages((communication.messages ?? []).filter((message) => message.sender === "internal"));
        }
      } catch (detailError) {
        if (!ignore) setError(detailError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === order?.customerId) ?? null,
    [customers, order],
  );

  async function handleSaveOrder() {
    try {
      setSaving(true);
      setError("");
      setSaveMessage("");
      await fetchJson(`/api/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...manageForm,
          amount: Number(manageForm.amount || 0),
          deposit: Number(manageForm.deposit || 0),
        }),
      });
      await refreshOrderDetail();
      setSaveMessage("维修单详情已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveParts() {
    try {
      setPartsSaving(true);
      setError("");
      setSaveMessage("");
      await fetchJson(`/api/orders/${id}/parts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: partsForm.map((part) => ({
            partId: part.partId,
            quantity: Number(part.quantity),
            unitPrice: Number(part.unitPrice),
          })),
        }),
      });
      await refreshOrderDetail();
      setSaveMessage("配件明细已保存");
    } catch (partsError) {
      setError(partsError.message);
    } finally {
      setPartsSaving(false);
    }
  }

  async function handleDeletePart(partId) {
    try {
      setPartsSaving(true);
      setError("");
      setSaveMessage("");
      await fetchJson(`/api/orders/${id}/parts/${partId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      await refreshOrderDetail();
      setSaveMessage("配件已从维修单移除");
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setPartsSaving(false);
    }
  }

  async function handleInternalNote() {
    if (!internalNote.trim()) return;
    try {
      setSaving(true);
      setError("");
      setSaveMessage("");
      await fetchJson(`/api/orders/${id}/communication`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: "internal",
          body: internalNote.trim(),
        }),
      });
      await refreshInternalMessages();
      setInternalNote("");
      setSaveMessage("内部备注已写入后台");
    } catch (noteError) {
      setError(noteError.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty-card">订单详情加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!order) return <div className="empty-card">未找到订单。</div>;

  const detailStatusLabel = order.statusMeta?.label ?? statusChinese[order.status] ?? order.status;
  const detailBadgeTone = order.status === "completed" || order.status === "picked_up" ? "success" : order.status === "in_progress" ? "primary" : "warning";
  const devicePhotos = order.devicePhotos ?? order.intakePhotos ?? [];

  if (!isMobile) {
    return (
      <div className="order-detail-desktop-page">
        {saveMessage ? <div className="message-banner success">{saveMessage}</div> : null}
        <section className="order-detail-desktop-hero">
          <div>
            <span className="micro-label">Desktop Order Detail</span>
            <h2>{order.title}</h2>
            <p>订单号 #{order.orderNo} · {detailStatusLabel} · 技师 {order.technician || "-"}</p>
          </div>
          <div className="order-detail-desktop-hero-actions">
            <span className={`mini-state ${detailBadgeTone === "warning" ? "urgent" : detailBadgeTone}`}>{detailStatusLabel}</span>
            <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/execution`)} type="button">执行页</button>
            <button className="wide-action primary" onClick={() => onStatusChange(order.id, order.status === "pending" ? "in_progress" : order.status === "in_progress" ? "completed" : order.status)} type="button">推进状态</button>
          </div>
        </section>

        <section className="order-detail-desktop-grid">
          <div className="order-detail-desktop-main">
            <section className="detail-block">
              <div className="detail-block-head">
                <h4>客户与设备</h4>
                <button className="link-button" onClick={() => navigate(`/customers/${order.customerId}`)} type="button">客户详情</button>
              </div>
              <div className="order-detail-desktop-summary">
                <div>
                  <span>客户</span>
                  <strong>{selectedCustomer?.name ?? manageForm.customerName ?? "-"}</strong>
                  <p>{selectedCustomer?.phone ?? manageForm.customerPhone ?? "-"}</p>
                </div>
                <div>
                  <span>设备</span>
                  <strong>{order.deviceMeta?.model ?? order.deviceName}</strong>
                  <p>IMEI / 序列号 {order.deviceMeta?.serialNumber ?? manageForm.imeiSerial ?? "-"}</p>
                </div>
                <div>
                  <span>价格</span>
                  <strong>{order.grandTotalFormatted ?? order.amountFormatted}</strong>
                  <p>定金 {order.depositFormatted ?? "0 VUV"} · 尾款 {order.balanceDueFormatted ?? order.amountFormatted}</p>
                </div>
              </div>
              <div className="sheet-grid">
                <Field label="客户姓名"><input value={manageForm.customerName} onChange={(e) => setManageForm((current) => ({ ...current, customerName: e.target.value }))} /></Field>
                <Field label="客户电话"><input value={manageForm.customerPhone} onChange={(e) => setManageForm((current) => ({ ...current, customerPhone: e.target.value }))} /></Field>
                <Field label="技师"><input value={manageForm.technician} onChange={(e) => setManageForm((current) => ({ ...current, technician: e.target.value }))} /></Field>
                <Field label="预约日期"><input type="date" value={manageForm.scheduledDate} onChange={(e) => setManageForm((current) => ({ ...current, scheduledDate: e.target.value }))} /></Field>
                <Field label="报价"><input type="number" value={manageForm.amount} onChange={(e) => setManageForm((current) => ({ ...current, amount: e.target.value }))} /></Field>
                <Field label="定金"><input type="number" value={manageForm.deposit} onChange={(e) => setManageForm((current) => ({ ...current, deposit: e.target.value }))} /></Field>
                <Field label="问题描述" full><textarea value={manageForm.issueSummary} onChange={(e) => setManageForm((current) => ({ ...current, issueSummary: e.target.value }))} /></Field>
                <Field label="维修备注" full><textarea value={manageForm.notes} onChange={(e) => setManageForm((current) => ({ ...current, notes: e.target.value }))} /></Field>
              </div>
              <div className="action-row">
                <button className="wide-action primary" disabled={saving} onClick={handleSaveOrder} type="button">{saving ? "保存中..." : "保存订单详情"}</button>
              </div>
            </section>

            <section className="detail-block">
              <div className="detail-block-head">
                <h4>配件明细</h4>
                <button className="link-button" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/add-parts`)} type="button">添加配件</button>
              </div>
              <div className="document-line-items">
                {partsForm.map((part) => (
                  <div key={part.partId} className="document-line-row">
                    <div>
                      <strong>{part.name}</strong>
                      <p>订单配件</p>
                    </div>
                    <div className="pos-qty-stepper">
                      <button onClick={() => setPartsForm((current) => current.map((item) => item.partId === part.partId ? { ...item, quantity: String(Math.max(1, Number(item.quantity || 1) - 1)) } : item))} type="button">-</button>
                      <span>{part.quantity}</span>
                      <button onClick={() => setPartsForm((current) => current.map((item) => item.partId === part.partId ? { ...item, quantity: String(Number(item.quantity || 0) + 1) } : item))} type="button">+</button>
                    </div>
                    <span>{formatCurrency(part.unitPrice)}</span>
                    <div className="pos-cart-line-total">
                      <strong>{formatCurrency((Number(part.quantity) || 0) * (Number(part.unitPrice) || 0))}</strong>
                      <button className="link-button danger" onClick={() => handleDeletePart(part.partId)} type="button">移除</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="action-row">
                <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/parts-usage`)} type="button">使用明细</button>
                <button className="wide-action primary" disabled={partsSaving} onClick={handleSaveParts} type="button">{partsSaving ? "保存中..." : "保存配件"}</button>
              </div>
            </section>
          </div>

          <aside className="order-detail-desktop-side">
            <section className="detail-block">
              <div className="detail-block-head">
                <h4>设备照片</h4>
              </div>
              <div className="repair-photo-template-strip">
                {devicePhotos.length ? devicePhotos.map((photo, index) => (
                  <button key={`${photo.url ?? photo}-${index}`} className="repair-photo-card" onClick={() => setActivePhoto(photo.url ?? photo)} type="button">
                    <img alt={`设备照片 ${index + 1}`} src={photo.url ?? photo} />
                  </button>
                )) : <div className="empty-card">暂无设备照片</div>}
              </div>
            </section>

            <section className="detail-block">
              <div className="detail-block-head">
                <h4>内部备注</h4>
              </div>
              <label className="quote-template-section-label">
                <span>新增内部备注</span>
                <textarea value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
              </label>
              <button className="wide-action primary" disabled={saving || !internalNote.trim()} onClick={handleInternalNote} type="button">写入内部备注</button>
              <div className="order-detail-template-note-history">
                <div className="order-detail-template-note-history-list">
                  {internalMessages.length ? internalMessages.map((message) => (
                    <div key={message.id} className="order-detail-template-note-history-item">
                      <span className="order-detail-template-note-history-time">{message.createdAtLabel ?? message.createdAt}</span>
                      <p>{message.body}</p>
                    </div>
                  )) : <div className="empty-card">暂无内部备注</div>}
                </div>
              </div>
            </section>
          </aside>
        </section>

        {activePhoto ? (
          <Drawer title="设备照片" onClose={() => setActivePhoto(null)}>
            <img alt="设备照片预览" src={activePhoto} style={{ width: "100%", borderRadius: "18px" }} />
          </Drawer>
        ) : null}
      </div>
    );
  }

  return (
    <div className="order-detail-template-page">
      {saveMessage ? <div className="message-banner success">{saveMessage}</div> : null}
      <section className="order-detail-template-header">
        <div className="order-detail-template-heading">
          <div className="order-detail-template-order-no">
            <span>订单编号</span>
            <strong>#{order.orderNo}</strong>
          </div>
          <h2>{order.title}</h2>
        </div>
        <div className={`order-detail-template-status ${detailBadgeTone}`}>
          <span className="material-symbols-outlined">{order.status === "completed" || order.status === "picked_up" ? "verified" : "build"}</span>
          <span>{detailStatusLabel}</span>
        </div>
      </section>

      <section className="order-detail-template-grid">
        <div className="order-detail-template-main">
          <section className="order-detail-template-card">
            <div className="order-detail-template-card-head">
              <h3>设备信息</h3>
              <span className="material-symbols-outlined">smartphone</span>
            </div>
            <div className="order-detail-template-specs">
              <div>
                <p>品牌型号</p>
                <strong>{order.deviceMeta?.model ?? order.deviceName}</strong>
              </div>
              <div>
                <p>序列号 / IMEI</p>
                <strong>{order.deviceMeta?.serialNumber ?? (manageForm.imeiSerial || "-")}</strong>
              </div>
              <div>
                <p>电池健康</p>
                <strong>{order.deviceMeta?.batteryHealth ?? "-"}</strong>
              </div>
              <div>
                <p>存储容量</p>
                <strong>{order.deviceMeta?.storage ?? "-"}</strong>
              </div>
            </div>
          </section>

          <section className="order-detail-template-card">
            <div className="order-detail-template-card-head">
              <h3>客户详情</h3>
              <span className="material-symbols-outlined">person</span>
            </div>
            <div className="order-detail-template-customer">
              <CustomerAvatar customer={{ name: selectedCustomer?.name ?? manageForm.customerName, avatarPhoto: selectedCustomer?.avatarPhoto }} className="order-detail-template-avatar" />
              <div className="order-detail-template-customer-main">
                <strong>{selectedCustomer?.name ?? manageForm.customerName ?? "-"}</strong>
                <div className="order-detail-template-contact">
                  <span><span className="material-symbols-outlined">call</span>{selectedCustomer?.phone ?? manageForm.customerPhone ?? "-"}</span>
                  <span><span className="material-symbols-outlined">mail</span>{selectedCustomer?.email ?? manageForm.customerEmail ?? "-"}</span>
                </div>
              </div>
              <button className="order-detail-template-contact-btn" onClick={() => navigate(`/customers/${order.customerId}`)} type="button">联系客户</button>
            </div>
          </section>

          <section className="order-detail-template-card">
            <div className="order-detail-template-card-head">
              <h3>故障诊断与维修记录</h3>
              <div className="order-detail-template-inline-actions">
                <button className="link-button" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/execution`)} type="button">执行页</button>
                <button className="link-button" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/execution-live`)} type="button">实时执行</button>
              </div>
            </div>
            <div className="order-detail-template-note-panel">
              <p>主要问题诊断</p>
              <div>{order.issueSummary}</div>
            </div>
            <div className="order-detail-template-technician-note">
              <p>{order.notes || "等待技师补充维修备注。"}</p>
              <span>技术员: {order.technician || "-"} · {order.scheduledDate || "-"}</span>
            </div>
          </section>

          <section className="order-detail-template-card">
            <div className="order-detail-template-card-head">
              <h3>更换配件清单</h3>
              <button className="order-detail-template-add-link" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/add-parts`)} type="button">
                <span className="material-symbols-outlined">add_circle</span>
                添加配件
              </button>
            </div>
            <div className="order-detail-template-parts-list">
              {partsForm.map((part) => (
                <div key={part.partId} className="order-detail-template-part-card">
                  <div className="order-detail-template-part-name-row">
                    <strong className="order-detail-template-part-name">{part.name}</strong>
                  </div>
                  <div className="order-detail-template-part-fields">
                    <div className="order-detail-template-part-field">
                      <span>数量</span>
                      <input min="1" onChange={(event) => setPartsForm((current) => current.map((item) => item.partId === part.partId ? { ...item, quantity: event.target.value } : item))} type="number" value={part.quantity} />
                    </div>
                    <div className="order-detail-template-part-field">
                      <span>单价</span>
                      <input min="0" onChange={(event) => setPartsForm((current) => current.map((item) => item.partId === part.partId ? { ...item, unitPrice: event.target.value } : item))} type="number" value={part.unitPrice} />
                    </div>
                    <div className="order-detail-template-part-field total">
                      <span>配件小计</span>
                      <strong>{`${(((Number(part.quantity) || 0) * (Number(part.unitPrice) || 0)).toLocaleString("en-US"))} VUV`}</strong>
                    </div>
                  </div>
                  <div className="order-detail-template-part-actions">
                    <button className="small-action-button" disabled={partsSaving} onClick={() => handleDeletePart(part.partId)} type="button">删除</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="usage-tags order-detail-template-balance-tags">
              <span className="soft-badge">定金: {order.depositFormatted ?? "0 VUV"}</span>
              <span className="soft-badge">待收尾款: {order.balanceDueFormatted ?? order.amountFormatted}</span>
            </div>
            <div className="order-detail-template-totals">
              <div><span>配件小计</span><strong>{order.partsTotalFormatted ?? order.amountFormatted}</strong></div>
              <div><span>工费</span><strong>{order.laborTotalFormatted ?? "0 VUV"}</strong></div>
              <div><span>订单总价</span><strong>{order.grandTotalFormatted ?? order.amountFormatted}</strong></div>
            </div>
            <div className="order-detail-template-inline-actions">
              <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/parts-usage`)} type="button">使用明细</button>
              <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/deductions`)} type="button">扣减历史</button>
              <button className="wide-action primary" disabled={partsSaving || !partsForm.length} onClick={handleSaveParts} type="button">{partsSaving ? "保存中..." : "保存配件明细"}</button>
            </div>
          </section>
        </div>

        <div className="order-detail-template-side">
          <section className="order-detail-template-card order-detail-template-actions-card">
            <h3>快捷操作</h3>
            <div className="order-detail-template-stack">
              <button className="wide-action primary" onClick={() => onStatusChange(order.id, order.status === "completed" ? "picked_up" : "completed")} type="button">
                <span className="material-symbols-outlined">sync</span>
                <span>{order.status === "completed" ? "更新为已取件" : "更新维修状态"}</span>
              </button>
              <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/communication`)} type="button">
                沟通记录
              </button>
              <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/completion`)} type="button">
                完工确认
              </button>
              <button className="wide-action secondary" onClick={() => navigate(`/orders/${getOrderRouteId(order)}/intake`)} type="button">
                受理单
              </button>
              {statusTabs.filter((tab) => tab.value !== "all").map((tab) => (
                <button
                  key={tab.value}
                  className={tab.value === order.status ? "wide-action primary" : "wide-action secondary"}
                  onClick={() => onStatusChange(order.id, tab.value)}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </section>

          <section className="order-detail-template-card">
            <div className="order-detail-template-card-head">
              <h3>后台管理</h3>
              <span className="inline-link">实时保存到后台</span>
            </div>
            <div className="sheet-form compact">
              <Field label="订单标题" full><input value={manageForm.title} onChange={(event) => setManageForm((current) => ({ ...current, title: event.target.value }))} /></Field>
              <Field label="技术员"><input value={manageForm.technician} onChange={(event) => setManageForm((current) => ({ ...current, technician: event.target.value }))} /></Field>
              <Field label="预约日期"><input type="date" value={manageForm.scheduledDate} onChange={(event) => setManageForm((current) => ({ ...current, scheduledDate: event.target.value }))} /></Field>
              <Field label="报价"><input type="number" min="0" value={manageForm.amount} onChange={(event) => setManageForm((current) => ({ ...current, amount: event.target.value }))} /></Field>
              <Field label="定金"><input type="number" min="0" max={manageForm.amount || undefined} value={manageForm.deposit} onChange={(event) => setManageForm((current) => ({ ...current, deposit: event.target.value }))} /></Field>
              <Field label="客户姓名"><input value={manageForm.customerName} onChange={(event) => setManageForm((current) => ({ ...current, customerName: event.target.value }))} /></Field>
              <Field label="客户电话"><input value={manageForm.customerPhone} onChange={(event) => setManageForm((current) => ({ ...current, customerPhone: event.target.value }))} /></Field>
              <Field label="客户邮箱" full><input type="email" value={manageForm.customerEmail} onChange={(event) => setManageForm((current) => ({ ...current, customerEmail: event.target.value }))} /></Field>
              <Field label="IMEI / 序列号" full><input value={manageForm.imeiSerial} onChange={(event) => setManageForm((current) => ({ ...current, imeiSerial: event.target.value }))} /></Field>
              <Field label="电池健康度"><input value={manageForm.batteryHealth} onChange={(event) => setManageForm((current) => ({ ...current, batteryHealth: event.target.value }))} /></Field>
              <Field label="存储容量"><input value={manageForm.storageCapacity} onChange={(event) => setManageForm((current) => ({ ...current, storageCapacity: event.target.value }))} /></Field>
              <Field label="客户签字" full><input value={manageForm.customerSignature} onChange={(event) => setManageForm((current) => ({ ...current, customerSignature: event.target.value }))} /></Field>
              <Field label="故障说明" full><textarea value={manageForm.issueSummary} onChange={(event) => setManageForm((current) => ({ ...current, issueSummary: event.target.value }))} /></Field>
              <Field label="维修备注" full><textarea value={manageForm.notes} onChange={(event) => setManageForm((current) => ({ ...current, notes: event.target.value }))} /></Field>
            </div>
            <button className="primary-submit" disabled={saving} onClick={handleSaveOrder} type="button">
              {saving ? "保存中..." : "保存维修单"}
            </button>
            <div className="sheet-form compact">
              <Field label="内部备注" full><textarea value={internalNote} onChange={(event) => setInternalNote(event.target.value)} placeholder="写入后台沟通记录，不直接展示给客户" /></Field>
            </div>
            <button className="wide-action secondary" disabled={saving || !internalNote.trim()} onClick={handleInternalNote} type="button">
              写入内部备注
            </button>
            {internalMessages.length ? (
              <div className="order-detail-template-note-history">
                <div className="order-detail-template-card-head compact">
                  <h4>最近内部备注</h4>
                  <span>{internalMessages.length} 条</span>
                </div>
                <div className="order-detail-template-note-history-list">
                  {internalMessages.slice(-5).reverse().map((message) => (
                    <div key={message.id} className="order-detail-template-note-history-item">
                      <div className="order-detail-template-note-history-time">{message.time}</div>
                      <p>{message.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="order-detail-template-card">
            <h3>维修进度时间线</h3>
            <div className="timeline-list">
              {(order.timeline ?? []).map((item, index) => (
                <div key={`${item.title}-${index}`} className={item.state === "future" ? "timeline-item future" : item.state === "current" ? "timeline-item active" : "timeline-item"}>
                  <div className={item.state === "current" ? "timeline-dot current" : item.state === "done" ? "timeline-dot done" : "timeline-dot"}>
                    <span className="material-symbols-outlined">{item.state === "current" ? "engineering" : item.state === "done" ? "check_circle" : "flag"}</span>
                  </div>
                  <div className="timeline-content">
                    <strong>{item.title}</strong>
                    <span>{item.time}</span>
                    <p>{item.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="order-detail-template-card">
            <h3>设备实拍</h3>
            {devicePhotos.length ? (
              <>
                <div className="gallery-grid">
                  <button className="gallery-photo-button" onClick={() => setActivePhoto(devicePhotos[0])} type="button">
                    <img alt={devicePhotos[0].stage} src={devicePhotos[0].image} />
                  </button>
                  <div className="gallery-stack">
                    {devicePhotos.slice(1, 4).map((photo) => (
                      <button key={photo.image} className="gallery-photo-button" onClick={() => setActivePhoto(photo)} type="button">
                        <img alt={photo.stage} src={photo.image} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="usage-tags">
                  {devicePhotos.map((photo) => (
                    <button key={`${photo.stage}-${photo.image}`} className="soft-badge soft-badge-button" onClick={() => setActivePhoto(photo)} type="button">{photo.stage}</button>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-card compact">暂无设备实拍，上传后会直接从后台显示。</div>
            )}
          </section>
        </div>
      </section>

      {activePhoto ? (
        <div className="photo-lightbox" onClick={() => setActivePhoto(null)} role="presentation">
          <div className="photo-lightbox-dialog" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label={activePhoto.stage ?? "设备实拍预览"}>
            <button className="photo-lightbox-close" onClick={() => setActivePhoto(null)} type="button">
              <span className="material-symbols-outlined">close</span>
            </button>
            <img alt={activePhoto.stage ?? "设备实拍"} src={activePhoto.image} />
            <div className="photo-lightbox-caption">{activePhoto.stage ?? "设备实拍"}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InventoryPage({ dashboard, parts, movements, openMovementForm, refresh }) {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const lowStockParts = dashboard?.lowStockParts ?? [];
  const outboundThisMonth = useMemo(() => movements.filter((movement) => movement.movementType === "out").reduce((sum, movement) => sum + movement.quantity, 0), [movements]);
  const pendingOrders = dashboard?.metrics?.pendingOrders ?? 0;
  const categoryStats = useMemo(() => {
    const groups = [
      { key: "Screens", label: "屏幕", color: "#007e85" },
      { key: "Batteries", label: "电池", color: "#f7a072" },
      { key: "Small Parts", label: "小配件", color: "#436466" },
      { key: "Others", label: "其他", color: "#bdc9c9" },
    ].map((item) => ({
      ...item,
      count: item.key === "Others"
        ? Math.max(0, parts.length - parts.filter((part) => ["Screens", "Batteries", "Small Parts"].includes(inferPartCategory(part.name))).length)
        : parts.filter((part) => inferPartCategory(part.name) === item.key).length,
    }));
    const total = Math.max(parts.length, 1);
    return groups.map((item) => ({
      ...item,
      percent: Math.round((item.count / total) * 100),
    }));
  }, [parts]);
  const lowStockVisible = lowStockParts.slice(0, 2);
  const latestMovement = movements[0];
  const heroHint = latestMovement ? `最近同步 ${movements.length} 条库存流水` : "库存状态已与后台实时同步";

  if (!isMobile) {
    return (
      <div className="inventory-desktop-page">
        <section className="inventory-desktop-hero">
          <div>
            <span className="micro-label">Desktop Inventory</span>
            <h2>{dashboard?.metrics.inventoryValueFormatted ?? "-"}</h2>
            <p>{heroHint}</p>
          </div>
          <div className="inventory-desktop-hero-actions">
            <button className="wide-action primary" onClick={() => navigate("/inventory/inbound")} type="button">入库登记</button>
            <button className="wide-action secondary" onClick={() => navigate("/inventory/audit-session")} type="button">库存盘点</button>
          </div>
        </section>

        <section className="inventory-desktop-metrics">
          <button className="inventory-desktop-metric" onClick={() => navigate("/parts-catalog")} type="button"><span>配件总数</span><strong>{parts.length}</strong></button>
          <button className="inventory-desktop-metric warning" onClick={() => navigate("/low-stock-alerts")} type="button"><span>低库存</span><strong>{lowStockParts.length}</strong></button>
          <button className="inventory-desktop-metric" onClick={() => navigate("/repair-queue")} type="button"><span>待处理工单</span><strong>{String(pendingOrders).padStart(2, "0")}</strong></button>
          <div className="inventory-desktop-metric success"><span>本月出库</span><strong>{outboundThisMonth}</strong></div>
        </section>

        <section className="inventory-desktop-grid">
          <div className="inventory-desktop-panel">
            <div className="inventory-desktop-panel-head">
              <h3>低库存预警</h3>
              <button className="link-button" onClick={() => navigate("/low-stock-alerts")} type="button">查看全部</button>
            </div>
            <div className="inventory-desktop-low-stock-list">
              {lowStockVisible.map((part) => (
                <button key={part.id} className="inventory-desktop-low-stock-row" onClick={() => navigate(`/parts/${part.id}`)} type="button">
                  <div className="inventory-desktop-low-stock-main">
                    <span className="material-symbols-outlined">{inferPartCategory(part.name) === "Batteries" ? "battery_charging_full" : inferPartCategory(part.name) === "Screens" ? "screenshot" : "inventory_2"}</span>
                    <div>
                      <strong>{part.name}</strong>
                      <p>SKU: {part.sku}</p>
                    </div>
                  </div>
                  <div className="inventory-desktop-low-stock-meta">
                    <span className={part.stock <= 2 ? "inventory-template-state danger" : "inventory-template-state warning"}>{part.stock <= 2 ? "紧急" : "预警"}</span>
                    <strong>{part.stock} / {part.reorderLevel}</strong>
                  </div>
                </button>
              ))}
              {!lowStockVisible.length ? <div className="empty-card">当前没有低库存配件。</div> : null}
            </div>
          </div>

          <div className="inventory-desktop-side">
            <div className="inventory-desktop-panel">
              <div className="inventory-desktop-panel-head">
                <h3>分类拆分</h3>
              </div>
              <div className="inventory-template-breakdown-card desktop">
                <div className="inventory-template-breakdown-bar">
                  {categoryStats.map((item) => (
                    <div key={item.key} style={{ width: `${item.percent}%`, background: item.color }} title={item.label} />
                  ))}
                </div>
                <div className="inventory-template-breakdown-grid">
                  {categoryStats.map((item) => (
                    <button key={item.key} className="inventory-template-breakdown-item" onClick={() => navigate(`/parts-catalog?category=${encodeURIComponent(item.key)}`)} type="button">
                      <span className="inventory-template-dot" style={{ background: item.color }} />
                      <div>
                        <p>{item.label}</p>
                        <span>{item.percent}% · {item.count} 项</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="inventory-desktop-panel accent">
              <div className="inventory-desktop-panel-head">
                <h3>库存快捷操作</h3>
              </div>
              <div className="inventory-desktop-actions">
                <button className="wide-action secondary" onClick={() => navigate("/inventory/loss")} type="button">配件报损</button>
                <button className="wide-action secondary" onClick={() => navigate("/parts-catalog")} type="button">查看配件目录</button>
                <button className="wide-action secondary" onClick={openMovementForm} type="button">记录库存流水</button>
                <button className="wide-action primary" onClick={() => refresh()} type="button">刷新库存数据</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="inventory-template-page">
      <section className="inventory-template-hero">
        <div className="inventory-template-hero-content">
          <span className="inventory-template-kicker">库存总值</span>
          <div className="inventory-template-value-row">
            <h2>{dashboard?.metrics.inventoryValueFormatted?.replace(" VUV", "") ?? "-"}</h2>
            <span>VUV</span>
          </div>
          <div className="inventory-template-trend">
            <span className="material-symbols-outlined">sync</span>
            <span>{heroHint}</span>
          </div>
        </div>
      </section>

      <section className="inventory-template-metrics">
        <div className="inventory-template-metric-item">
          <button className="inventory-template-metric-card" onClick={() => navigate("/parts-catalog")} type="button">
            <div>
              <p className="metric-label metric-label-inline">配件总数</p>
              <strong>{parts.length}</strong>
            </div>
          </button>
        </div>
        <div className="inventory-template-metric-item">
          <button className="inventory-template-metric-card" onClick={() => navigate("/low-stock-alerts")} type="button">
            <div>
              <p className="metric-label metric-label-inline">低库存</p>
              <strong>{lowStockParts.length}</strong>
            </div>
          </button>
        </div>
        <div className="inventory-template-metric-item">
          <button className="inventory-template-metric-card" onClick={() => navigate("/repair-queue")} type="button">
            <div>
              <p className="metric-label metric-label-inline">待处理工单</p>
              <strong>{String(pendingOrders).padStart(2, "0")}</strong>
            </div>
          </button>
        </div>
      </section>

      <section className="inventory-template-actions">
        <button className="inventory-template-action primary" onClick={() => navigate("/inventory/inbound")} type="button">
          <span className="material-symbols-outlined">add_box</span>
          入库登记
        </button>
        <button className="inventory-template-action danger" onClick={() => navigate("/inventory/loss")} type="button">
          <span className="material-symbols-outlined">remove_circle</span>
          配件报损
        </button>
        <button className="inventory-template-action secondary" onClick={() => navigate("/inventory/audit-session")} type="button">
          <span className="material-symbols-outlined">fact_check</span>
          库存盘点
        </button>
      </section>

      <section className="inventory-template-section">
        <div className="inventory-template-section-head">
          <h3>低库存预警</h3>
          <button className="inventory-template-link" onClick={() => navigate("/low-stock-alerts")} type="button">查看全部</button>
        </div>
        <div className="inventory-template-low-stock-list">
          {lowStockVisible.map((part) => (
            <button key={part.id} className="inventory-template-low-stock-card" onClick={() => navigate(`/parts/${part.id}`)} type="button">
              <div className="inventory-template-low-stock-top">
                <div className="inventory-template-part-meta">
                  <div className="inventory-template-part-thumb">
                    <span className="material-symbols-outlined">{inferPartCategory(part.name) === "Batteries" ? "battery_charging_full" : inferPartCategory(part.name) === "Screens" ? "screenshot" : "inventory_2"}</span>
                  </div>
                  <div>
                    <h4>{part.name}</h4>
                    <p>SKU: {part.sku}</p>
                  </div>
                </div>
                <span className={part.stock <= 2 ? "inventory-template-state danger" : "inventory-template-state warning"}>
                  {part.stock <= 2 ? "紧急" : "预警"}
                </span>
              </div>
              <div className="inventory-template-progress-meta">
                <span>剩余 {part.stock} 件</span>
                <span>目标 {part.reorderLevel}</span>
              </div>
              <div className="inventory-template-progress">
                <div style={{ width: `${Math.min(100, (part.stock / Math.max(part.reorderLevel, 1)) * 100)}%` }} />
              </div>
            </button>
          ))}
          {!lowStockVisible.length ? <div className="empty-card">当前没有低库存配件。</div> : null}
        </div>
      </section>

      <section className="inventory-template-section">
        <div className="inventory-template-section-head">
          <h3>分类拆分</h3>
        </div>
        <div className="inventory-template-breakdown-card">
          <div className="inventory-template-breakdown-bar">
            {categoryStats.map((item) => (
              <div key={item.key} style={{ width: `${item.percent}%`, background: item.color }} title={item.label} />
            ))}
          </div>
          <div className="inventory-template-breakdown-grid">
            {categoryStats.map((item) => (
              <button
                key={item.key}
                className="inventory-template-breakdown-item"
                onClick={() => navigate(`/parts-catalog?category=${encodeURIComponent(item.key)}`)}
                type="button"
              >
                <span className="inventory-template-dot" style={{ background: item.color }} />
                <div>
                  <p>{item.label}</p>
                  <span>{item.percent}% · {item.count} 项</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function PartsCatalogPage({ parts }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    setSearch(params.get("search") ?? "");
    setCategory(params.get("category") ?? "All");
  }, [location.search]);

  const lowStockOnly = useMemo(() => new URLSearchParams(location.search).get("lowStock") === "1", [location.search]);

  const categories = useMemo(() => {
    const values = new Set(parts.map((part) => inferPartCategory(part.name)));
    return ["All", ...values];
  }, [parts]);

  const filteredParts = useMemo(() => {
    return parts.filter((part) => {
      const query = search.trim().toLowerCase();
      const inferredCategory = part.category ?? inferPartCategory(part.name);
      const matchesCategory = category === "All" ? true : inferredCategory === category;
      const matchesSearch = !query || part.name.toLowerCase().includes(query) || part.sku.toLowerCase().includes(query);
      const matchesLowStock = lowStockOnly ? part.needsReorder : true;
      return matchesCategory && matchesSearch && matchesLowStock;
    });
  }, [category, lowStockOnly, parts, search]);

  return (
    <div className="inventory-catalog-template-page">
      <section className="inventory-catalog-template-search">
        <div className="repairs-template-search">
          <span className="material-symbols-outlined">search</span>
          <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索 SKU 或配件名称..." type="text" value={search} />
        </div>
      </section>
      <nav className="status-strip inventory-catalog-template-tabs">
        {categories.map((tab) => (
          <button
            key={tab}
            className={tab === category ? "status-chip active" : "status-chip"}
            onClick={() => setCategory(tab)}
            type="button"
          >
            {tab === "All" ? "全部" : formatPartCategory(tab)}
          </button>
        ))}
      </nav>

      {lowStockOnly ? (
        <div className="inventory-catalog-template-filter-tip">
          当前正在查看低库存配件
        </div>
      ) : null}

      <section className="inventory-catalog-template-grid">
        {filteredParts.map((part) => (
          <button key={part.id} className="inventory-catalog-template-card" onClick={() => navigate(`/parts/${part.id}`)} type="button">
            <div className="inventory-catalog-template-media">
              <span className={part.needsReorder ? "catalog-badge danger" : "catalog-badge"}>{part.needsReorder ? "低库存" : "有库存"}</span>
              <span className="material-symbols-outlined inventory-catalog-template-icon">
                {part.name.toLowerCase().includes("battery") ? "battery_charging_full" : part.name.toLowerCase().includes("screen") || part.name.toLowerCase().includes("display") || part.name.toLowerCase().includes("digitizer") || part.name.toLowerCase().includes("oled") ? "screenshot" : "inventory_2"}
              </span>
            </div>
            <div className="inventory-catalog-template-body">
              <h4>{part.name}</h4>
              <p>SKU: {part.sku}</p>
              <div className="inventory-catalog-template-foot">
                <div>
                  <span>当前库存</span>
                  <strong>{part.stock} 件</strong>
                </div>
                <div className="catalog-price">{part.unitPriceFormatted}</div>
              </div>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}

function ScannerPage({ orders, parts }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState({ orders: [], customers: [], parts: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scanMessage, setScanMessage] = useState("");
  const [flashlightOn, setFlashlightOn] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraLoopId, setCameraLoopId] = useState(null);
  const recentScans = [
    { id: `order-${orders[0]?.id ?? 1}`, type: "订单", icon: "receipt_long", title: orders[0]?.orderNo ?? "RO-88294", meta: orders[0]?.title ?? "待确认设备", value: orders[0]?.amountFormatted ?? "-", action: () => navigate(`/orders/${getOrderRouteId(orders[0], "1")}`) },
    { id: `part-${parts[0]?.id ?? 1}`, type: "配件", icon: "inventory_2", title: parts[0]?.name ?? "iPhone 14 Pro Screen", meta: parts[0]?.sku ?? "-", value: parts[0]?.unitPriceFormatted ?? "-", action: () => navigate(`/parts/${parts[0]?.id ?? 1}`) },
    { id: `part-${parts[1]?.id ?? 2}`, type: "设备", icon: "smartphone", title: orders[1]?.deviceName ?? "Samsung S23 Ultra", meta: orders[1]?.orderNo ?? "RO-88295", value: orders[1]?.amountFormatted ?? "-", action: () => navigate(`/orders/${getOrderRouteId(orders[1], "1")}`) },
  ];

  async function handleSearch(rawQuery = query, scope = "all") {
    const nextQuery = rawQuery.trim();
    if (!nextQuery) return;
    try {
      setLoading(true);
      setError("");
      setScanMessage("");
      const result = await fetchJson(`/api/search?scope=${encodeURIComponent(scope)}&query=${encodeURIComponent(nextQuery)}`);
      setResults({
        orders: result.orders ?? [],
        customers: result.customers ?? [],
        parts: result.parts ?? [],
      });
      if (!(result.orders?.length || result.customers?.length || result.parts?.length)) {
        setScanMessage("未找到匹配结果");
      }
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setLoading(false);
    }
  }

  async function stopScannerCamera() {
    if (cameraLoopId) {
      window.clearInterval(cameraLoopId);
      setCameraLoopId(null);
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
  }

  async function startScannerCamera() {
    try {
      setError("");
      setScanMessage("");

      if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        setError("当前浏览器限制 HTTP 局域网直接调相机，请改用 localhost 或 HTTPS。");
        return;
      }

      if (!("BarcodeDetector" in window)) {
        setError("当前浏览器不支持原生扫码，请先用图片导入或手动输入。");
        return;
      }

      await stopScannerCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      setCameraStream(stream);
      window.setTimeout(() => {
        const video = document.getElementById("scanner-live-video");
        if (video) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }
      }, 50);

      const detector = new window.BarcodeDetector({
        formats: ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e"],
      });

      const loopId = window.setInterval(async () => {
        const video = document.getElementById("scanner-live-video");
        if (!video || video.readyState < 2) return;
        try {
          const barcodes = await detector.detect(video);
          const firstCode = barcodes?.[0]?.rawValue?.trim();
          if (!firstCode) return;
          setQuery(firstCode);
          await handleSearch(firstCode, "all");
          setScanMessage(`已识别条码：${firstCode}`);
          await stopScannerCamera();
        } catch {
          // ignore transient detect errors
        }
      }, 900);

      setCameraLoopId(loopId);
      setScanMessage("摄像头已开启，请将条码对准扫描框。");
    } catch (cameraError) {
      setError(cameraError?.message || "无法开启摄像头扫码");
    }
  }

  function handleFlashlightToggle() {
    setFlashlightOn((current) => {
      const next = !current;
      setScanMessage(next ? "补光模式已开启" : "补光模式已关闭");
      return next;
    });
  }

  async function handleImageSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, "").trim();
    setQuery(name);
    setScanMessage(`已载入图片：${file.name}`);
    await handleSearch(name, "all");
    event.target.value = "";
  }

  useEffect(() => () => {
    if (cameraLoopId) window.clearInterval(cameraLoopId);
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  }, [cameraLoopId, cameraStream]);

  return (
    <div className="scanner-page">
      <div className="scanner-toggle">
        <button className="active" onClick={() => navigate("/scanner")} type="button">扫描设备/订单</button>
        <button onClick={() => navigate("/parts-scanner")} type="button">扫描零件</button>
      </div>
      <section className="scanner-viewport-card">
        {cameraStream ? <video autoPlay className="scanner-live-video" id="scanner-live-video" muted playsInline /> : null}
        <div className="scanner-overlay-frame">
          <div className="scanner-laser-line" />
        </div>
        <div className="scanner-floating-actions">
          <button className={cameraStream ? "active" : ""} onClick={() => { if (cameraStream) { stopScannerCamera(); setScanMessage("摄像头扫码已停止"); } else { startScannerCamera(); } }} type="button"><span className="material-symbols-outlined">{cameraStream ? "videocam_off" : "videocam"}</span></button>
          <button className={flashlightOn ? "active" : ""} onClick={handleFlashlightToggle} type="button"><span className="material-symbols-outlined">flashlight_on</span></button>
          <button onClick={() => document.getElementById("scanner-image-upload")?.click()} type="button"><span className="material-symbols-outlined">image</span></button>
        </div>
        <input accept="image/*" hidden id="scanner-image-upload" onChange={handleImageSelect} type="file" />
      </section>
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>手动输入</h4>
          <span className="soft-badge">扫描失败时使用</span>
        </div>
        <div className="scanner-input-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入订单号、序列号或设备编号..." />
          <button className="small-icon-action" onClick={() => handleSearch(query, "all")} type="button"><span className="material-symbols-outlined">arrow_forward</span></button>
        </div>
        {error ? <div className="message-banner error">{error}</div> : null}
        {scanMessage ? <div className="message-banner success">{scanMessage}</div> : null}
        {loading ? <div className="empty-card">查询中...</div> : null}
        {(results.orders.length || results.customers.length || results.parts.length) ? (
          <div className="settings-staff-list">
            {results.orders.map((item) => (
              <button key={`search-order-${item.id}`} className="printer-device-card" onClick={() => navigate(item.link)} type="button">
                <div>
                  <strong>{item.orderNo}</strong>
                  <p>{item.deviceName} · {item.customerName}</p>
                </div>
                <span className="soft-badge">{item.amountFormatted}</span>
              </button>
            ))}
            {results.customers.map((item) => (
              <button key={`search-customer-${item.id}`} className="printer-device-card" onClick={() => navigate(item.link)} type="button">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.phone}</p>
                </div>
                <span className="soft-badge">客户</span>
              </button>
            ))}
            {results.parts.map((item) => (
              <button key={`search-part-${item.id}`} className="printer-device-card" onClick={() => navigate(item.link)} type="button">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.sku}</p>
                </div>
                <span className="soft-badge">库存 {item.stock}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <section className="page-section">
        <div className="section-title-row">
          <h3>最近扫描</h3>
          <button className="link-button" onClick={() => navigate("/parts-scanner")} type="button">切换零件</button>
        </div>
        <div className="scanner-history-grid">
          {recentScans.map((item) => (
            <button key={item.id} className="scan-history-card" onClick={item.action} type="button">
              <div className="scan-history-top">
                <div className="supplier-icon"><span className="material-symbols-outlined">{item.icon}</span></div>
                <span className="micro-label">{item.type}</span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.meta}</p>
              <span>{item.value}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function PartsScannerPage({ parts }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [scanMessage, setScanMessage] = useState("");
  const recentParts = parts.slice(0, 4);

  async function handleSearch() {
    if (!query.trim()) return;
    try {
      setLoading(true);
      setError("");
      setScanMessage("");
      const result = await fetchJson(`/api/search?scope=parts&query=${encodeURIComponent(query.trim())}`);
      setResults(result.parts ?? []);
      if (!(result.parts?.length)) {
        setScanMessage("未找到匹配配件");
      }
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleImageSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, "").trim();
    setQuery(name);
    setScanMessage(`已载入图片：${file.name}`);
    try {
      setLoading(true);
      setError("");
      const result = await fetchJson(`/api/search?scope=parts&query=${encodeURIComponent(name)}`);
      setResults(result.parts ?? []);
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setLoading(false);
      event.target.value = "";
    }
  }

  return (
    <div className="scanner-page">
      <div className="scanner-toggle">
        <button onClick={() => navigate("/scanner")} type="button">扫描设备/订单</button>
        <button className="active" onClick={() => navigate("/parts-scanner")} type="button">扫描零件</button>
      </div>
      <section className="scanner-viewport-card parts">
        <div className="scanner-overlay-frame square">
          <div className="scanner-laser-line" />
        </div>
        <p>请将二维码或条形码置于扫描框内</p>
        <div className="scanner-floating-actions">
          <button onClick={() => document.getElementById("parts-scanner-image-upload")?.click()} type="button"><span className="material-symbols-outlined">image</span></button>
          <button onClick={() => navigate("/parts/select")} type="button"><span className="material-symbols-outlined">playlist_add</span></button>
        </div>
        <input accept="image/*" hidden id="parts-scanner-image-upload" onChange={handleImageSelect} type="file" />
      </section>
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>手动输入零件编号</h4>
        </div>
        <div className="scanner-input-row">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入 SKU 或序列号..." />
          <button className="small-icon-action" onClick={handleSearch} type="button"><span className="material-symbols-outlined">search</span></button>
        </div>
        {error ? <div className="message-banner error">{error}</div> : null}
        {scanMessage ? <div className="message-banner success">{scanMessage}</div> : null}
        {loading ? <div className="empty-card">查询中...</div> : null}
      </section>
      <section className="settings-staff-list">
        {(results.length ? results : recentParts).map((part) => (
          <button key={part.id} className="printer-device-card" onClick={() => navigate(`/parts/${part.id}`)} type="button">
            <div>
              <strong>{part.name}</strong>
              <p>SKU: {part.sku}</p>
            </div>
            <span className="soft-badge">库存 {part.stock}</span>
          </button>
        ))}
      </section>
    </div>
  );
}

function SelectPartsPage({ parts, orders }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [selected, setSelected] = useState({});
  const activeOrder = orders.find((order) => order.status === "pending" || order.status === "in_progress") ?? orders[0];
  const categories = ["All", ...new Set(parts.map((part) => inferPartCategory(part.name)))];

  const filtered = parts.filter((part) => {
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || part.name.toLowerCase().includes(query) || part.sku.toLowerCase().includes(query);
    const matchesCategory = category === "All" || inferPartCategory(part.name) === category;
    return matchesQuery && matchesCategory;
  });

  const totalCount = Object.values(selected).reduce((sum, value) => sum + value, 0);
  const totalPrice = filtered.reduce((sum, part) => sum + ((selected[part.id] ?? 0) * part.unitPrice), 0);

  function updateQty(partId, delta) {
    setSelected((current) => {
      const next = Math.max(0, (current[partId] ?? 0) + delta);
      return { ...current, [partId]: next };
    });
  }

  return (
    <div className="select-parts-page">
      <SearchBar value={search} onChange={setSearch} placeholder="搜索 SKU 或配件名称..." />
      <nav className="status-strip">
        {categories.map((tab) => (
          <button key={tab} className={tab === category ? "status-chip active" : "status-chip"} onClick={() => setCategory(tab)} type="button">{formatPartCategory(tab)}</button>
        ))}
      </nav>
      <section className="catalog-grid catalog-grid-tight">
        {filtered.map((part) => (
          <div key={part.id} className="catalog-card catalog-card-rich">
            <div className="catalog-media">
              <span className={part.needsReorder ? "catalog-badge danger" : "catalog-badge"}>{part.needsReorder ? "低库存" : "有库存"}</span>
              <span className="material-symbols-outlined catalog-icon">{inferPartCategory(part.name) === "Batteries" ? "battery_full" : inferPartCategory(part.name) === "Screens" ? "screenshot" : "memory"}</span>
            </div>
            <h4>{part.name}</h4>
            <p>SKU: {part.sku}</p>
            <div className="select-parts-footer">
              <div>
                <span>价格</span>
                <strong>{part.unitPriceFormatted}</strong>
              </div>
              <div className="quantity-stepper">
                <button onClick={() => updateQty(part.id, -1)} type="button"><span className="material-symbols-outlined">remove</span></button>
                <span>{selected[part.id] ?? 0}</span>
                <button className="primary" onClick={() => updateQty(part.id, 1)} type="button"><span className="material-symbols-outlined">add</span></button>
              </div>
            </div>
          </div>
        ))}
      </section>
      <div className="selection-bottom-bar">
        <div>
          <span className="micro-label">已选零件</span>
          <strong>{totalCount} 项</strong>
        </div>
        <div>
          <span className="micro-label">预计金额</span>
          <strong>{totalPrice.toLocaleString("en-US")} VUV</strong>
        </div>
          <button className="wide-action primary" onClick={() => navigate(`/orders/${getOrderRouteId(activeOrder, "1")}/add-parts`)} type="button">继续添加</button>
      </div>
    </div>
  );
}

function InboundRegistrationPage({ parts, suppliersData, movements, refresh }) {
  const location = useLocation();
  const inventoryContext = useMemo(() => getInventoryContext(location.search), [location.search]);
  const preferredPart = parts.find((item) => String(item.id) === inventoryContext.partId) ?? parts[0];
  const supplier = suppliersData?.suppliers?.[0];
  const latest = movements[0];
  const findPartBySearch = useCallback((value) => {
    const query = String(value ?? "").trim().toLowerCase();
    if (!query) return null;
    return parts.find((item) =>
      String(item.id) === query
      || String(item.sku).toLowerCase() === query
      || String(item.name).trim().toLowerCase() === query
      || buildPartSearchLabel(item).toLowerCase() === query
    ) ?? parts.find((item) =>
      String(item.sku).toLowerCase().includes(query)
      || String(item.name).toLowerCase().includes(query)
    ) ?? null;
  }, [parts]);
  const createEmptyRow = (seedPart = preferredPart) => ({
    partId: String(seedPart?.id ?? parts[0]?.id ?? ""),
    partSearch: seedPart ? buildPartSearchLabel(seedPart) : "",
    supplierName: inventoryContext.supplier || seedPart?.supplier || supplier?.name || "",
    quantity: "1",
    sourceUnitPrice: inventoryContext.unitPrice || String(seedPart?.costPrice ?? seedPart?.unitPrice ?? 0),
  });
  const [rows, setRows] = useState([createEmptyRow(preferredPart)]);
  const [batchForm, setBatchForm] = useState({
    sourceCurrency: "CNY",
    exchangeRate: "17.5",
    shippingFee: "",
    customsFee: "",
    declarationFee: "",
    otherFee: "",
    note: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [scanQuery, setScanQuery] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraLoopId, setCameraLoopId] = useState(null);

  function applyScannedPart(partResult) {
    if (!partResult) return;
    setRows((current) => current.map((row, index) => (
      index === 0
        ? {
            ...row,
            partId: String(partResult.id),
            partSearch: buildPartSearchLabel(partResult),
            supplierName: partResult.supplier || row.supplierName,
            sourceUnitPrice: String(partResult.costPrice ?? partResult.unitPrice ?? row.sourceUnitPrice ?? "0"),
          }
        : row
    )));
    setSuccess(`已识别配件：${partResult.name}`);
  }

  async function handleInboundScan(queryOverride) {
    const nextQuery = String(queryOverride ?? scanQuery).trim();
    if (!nextQuery) {
      setError("请先输入或上传条码内容。");
      return;
    }

    try {
      setScanLoading(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/search?scope=parts&query=${encodeURIComponent(nextQuery)}`);
      const matched = result.parts?.[0];
      if (!matched) {
        setError("未找到匹配配件，请检查 SKU 或配件名称。");
        return;
      }
      setScanQuery(nextQuery);
      applyScannedPart(matched);
    } catch (scanError) {
      setError(scanError.message);
    } finally {
      setScanLoading(false);
    }
  }

  async function handleInboundScanImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const inferredQuery = file.name.replace(/\.[^.]+$/, "").trim();
    setScanQuery(inferredQuery);
    await handleInboundScan(inferredQuery);
    event.target.value = "";
  }

  async function stopInboundCamera() {
    if (cameraLoopId) {
      window.clearInterval(cameraLoopId);
      setCameraLoopId(null);
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
  }

  async function startInboundCameraScan() {
    try {
      setError("");
      setSuccess("");

      if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        setError("当前浏览器限制 HTTP 局域网直接调相机，请改用 localhost 或 HTTPS。");
        return;
      }

      if (!("BarcodeDetector" in window)) {
        setError("当前浏览器不支持原生条码识别，请先用图片导入或手动输入。");
        return;
      }

      await stopInboundCamera();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });

      setCameraStream(stream);
      window.setTimeout(() => {
        const video = document.getElementById("inbound-scan-video");
        if (video) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }
      }, 50);

      const detector = new window.BarcodeDetector({
        formats: ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e"],
      });

      const loopId = window.setInterval(async () => {
        const video = document.getElementById("inbound-scan-video");
        if (!video || video.readyState < 2) return;
        try {
          const barcodes = await detector.detect(video);
          const firstCode = barcodes?.[0]?.rawValue?.trim();
          if (!firstCode) return;
          setScanQuery(firstCode);
          await handleInboundScan(firstCode);
          await stopInboundCamera();
        } catch {
          // ignore transient detection errors
        }
      }, 900);

      setCameraLoopId(loopId);
      setSuccess("摄像头已开启，请将条码对准扫描框。");
    } catch (cameraError) {
      setError(cameraError?.message || "无法开启摄像头扫码");
    }
  }

  useEffect(() => () => {
    if (cameraLoopId) window.clearInterval(cameraLoopId);
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  }, [cameraLoopId, cameraStream]);

  async function handleImportExcel(file) {
    if (!file) return;
    try {
      setError("");
      setSuccess("");
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

      if (!rawRows.length) {
        setError("Excel 里没有可导入的数据。");
        return;
      }

      const importedRows = rawRows.map((rawRow) => {
        const entries = Object.entries(rawRow).reduce((acc, [key, value]) => {
          acc[normalizeImportKey(key)] = value;
          return acc;
        }, {});

        const part =
          parts.find((item) => String(item.id) === String(entries.partid ?? entries.配件id ?? "")) ||
          parts.find((item) => String(item.sku).toLowerCase() === String(entries.sku ?? entries.编码 ?? entries.条码 ?? "").trim().toLowerCase()) ||
          parts.find((item) => String(item.name).trim().toLowerCase() === String(entries.partname ?? entries.配件名称 ?? entries.名称 ?? "").trim().toLowerCase());

        return {
          partId: String(part?.id ?? preferredPart?.id ?? parts[0]?.id ?? ""),
          supplierName: String(entries.supplier ?? entries.供应商 ?? part?.supplier ?? ""),
          quantity: String(entries.quantity ?? entries.数量 ?? "1"),
          sourceUnitPrice: String(entries.sourceunitprice ?? entries.采购单价 ?? entries.单价 ?? entries.unitprice ?? part?.costPrice ?? part?.unitPrice ?? "0"),
          sourceCurrency: String(entries.sourcecurrency ?? entries.采购币种 ?? ""),
          exchangeRate: String(entries.exchangerate ?? entries.汇率 ?? ""),
          shippingFee: String(entries.shippingfee ?? entries.快递费 ?? entries.物流费 ?? ""),
          customsFee: String(entries.customsfee ?? entries.关税 ?? ""),
          declarationFee: String(entries.declarationfee ?? entries.报关费 ?? ""),
          otherFee: String(entries.otherfee ?? entries.其他费用 ?? ""),
          note: String(entries.note ?? entries.备注 ?? ""),
        };
      }).filter((row) => row.partId);

      if (!importedRows.length) {
        setError("没有匹配到任何配件，请确认 Excel 里有 配件ID / SKU / 配件名称。");
        return;
      }

      const firstMetaRow = importedRows.find((row) => row.sourceCurrency || row.exchangeRate || row.shippingFee || row.customsFee || row.declarationFee || row.otherFee || row.note);

      if (firstMetaRow) {
        setBatchForm((current) => ({
          ...current,
          sourceCurrency: firstMetaRow.sourceCurrency || current.sourceCurrency,
          exchangeRate: firstMetaRow.exchangeRate || current.exchangeRate,
          shippingFee: firstMetaRow.shippingFee || current.shippingFee,
          customsFee: firstMetaRow.customsFee || current.customsFee,
          declarationFee: firstMetaRow.declarationFee || current.declarationFee,
          otherFee: firstMetaRow.otherFee || current.otherFee,
          note: firstMetaRow.note || current.note,
        }));
      }

      setRows(importedRows.map((row) => ({
        partId: row.partId,
        partSearch: buildPartSearchLabel(parts.find((item) => String(item.id) === String(row.partId)) ?? preferredPart),
        supplierName: row.supplierName,
        quantity: row.quantity,
        sourceUnitPrice: row.sourceUnitPrice,
      })));
      setSuccess(`已从 Excel 导入 ${importedRows.length} 条进货项目`);
    } catch (importError) {
      setError(`Excel 导入失败: ${importError.message}`);
    }
  }

  useEffect(() => {
    setRows((current) => {
      if (current.length) return current;
      return [createEmptyRow(preferredPart)];
    });
  }, [preferredPart, supplier, inventoryContext.partId, inventoryContext.supplier, inventoryContext.unitPrice]);

  useEffect(() => {
    if (!inventoryContext.partId) return;
    const matched = parts.find((item) => String(item.id) === inventoryContext.partId);
    if (!matched) return;
    setRows((current) => current.map((row, index) => (
      index === 0
        ? {
            ...row,
            partId: String(matched.id),
            partSearch: buildPartSearchLabel(matched),
            supplierName: inventoryContext.supplier || matched.supplier || row.supplierName,
            sourceUnitPrice: inventoryContext.unitPrice || String(matched.costPrice ?? matched.unitPrice ?? row.sourceUnitPrice),
          }
        : row
    )));
  }, [inventoryContext.partId, inventoryContext.supplier, inventoryContext.unitPrice, parts]);

  const normalizedRows = rows.map((row, index) => {
    const selectedPart = parts.find((item) => String(item.id) === String(row.partId)) ?? preferredPart;
    const quantity = Math.max(0, Number(row.quantity) || 0);
    const sourceUnitPrice = Math.max(0, Number(row.sourceUnitPrice) || 0);
    const purchaseValueVuv = Math.round(sourceUnitPrice * quantity * (batchForm.sourceCurrency === "CNY" ? Math.max(0.000001, Number(batchForm.exchangeRate) || 1) : 1));
    return {
      ...row,
      index,
      selectedPart,
      quantity,
      sourceUnitPrice,
      purchaseValueVuv,
    };
  });

  const totalExtraFees = ["shippingFee", "customsFee", "declarationFee", "otherFee"].reduce((sum, key) => sum + Math.max(0, Math.round(Number(batchForm[key]) || 0)), 0);
  const totalPurchaseValueVuv = normalizedRows.reduce((sum, row) => sum + row.purchaseValueVuv, 0);
  const rowPreviews = normalizedRows.map((row, index) => {
    if (!row.quantity) {
      return { ...row, allocatedExtra: 0, landedUnitCost: 0, projectedStock: row.selectedPart?.stock ?? 0 };
    }
    const allocatedExtra = index === normalizedRows.length - 1
      ? Math.max(0, totalExtraFees - normalizedRows.slice(0, index).reduce((sum, current) => sum + Math.round(totalPurchaseValueVuv > 0 ? totalExtraFees * (current.purchaseValueVuv / totalPurchaseValueVuv) : 0), 0))
      : Math.round(totalPurchaseValueVuv > 0 ? totalExtraFees * (row.purchaseValueVuv / totalPurchaseValueVuv) : 0);
    const landedUnitCost = Math.round((row.purchaseValueVuv + allocatedExtra) / Math.max(row.quantity, 1));
    return {
      ...row,
      allocatedExtra,
      landedUnitCost,
      projectedStock: (row.selectedPart?.stock ?? 0) + row.quantity,
    };
  });

  async function handleSubmit() {
    const validItems = normalizedRows
      .filter((row) => row.selectedPart && row.quantity > 0)
      .map((row) => ({
        partId: Number(row.partId),
        quantity: row.quantity,
        supplierName: row.supplierName || row.selectedPart?.supplier || "",
        sourceUnitPrice: row.sourceUnitPrice,
      }));

    if (!validItems.length) {
      setError("请至少添加一条有效入库配件。");
      return;
    }

    try {
      setSaving(true);
      setError("");
      setSuccess("");
      const result = await fetchJson("/api/inventory/inbound-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCurrency: batchForm.sourceCurrency,
          exchangeRate: Number(batchForm.exchangeRate || 1),
          shippingFee: Number(batchForm.shippingFee || 0),
          customsFee: Number(batchForm.customsFee || 0),
          declarationFee: Number(batchForm.declarationFee || 0),
          otherFee: Number(batchForm.otherFee || 0),
          note: batchForm.note,
          items: validItems,
        }),
      });
      setSuccess(`已登记批量入库 ${result.batchNo}，共 ${result.items.length} 项`);
      setRows([createEmptyRow(preferredPart)]);
      setBatchForm((current) => ({ ...current, shippingFee: "", customsFee: "", declarationFee: "", otherFee: "", note: "" }));
      await refresh();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSaving(false);
    }
  }

  function updateRow(index, key, value) {
    setRows((current) => current.map((row, rowIndex) => {
      if (rowIndex !== index) return row;
      if (key !== "partSearch") return { ...row, [key]: value };
      const matched = findPartBySearch(value);
      if (!matched) return { ...row, partSearch: value };
      return {
        ...row,
        partId: String(matched.id),
        partSearch: buildPartSearchLabel(matched),
        supplierName: matched.supplier || row.supplierName,
        sourceUnitPrice: String(matched.costPrice ?? matched.unitPrice ?? row.sourceUnitPrice ?? "0"),
      };
    }));
  }

  function addRow() {
    setRows((current) => [...current, createEmptyRow(parts[0])]);
  }

  function removeRow(index) {
    setRows((current) => current.length === 1 ? current : current.filter((_, rowIndex) => rowIndex !== index));
  }

  function handleDownloadTemplate() {
    const templateRows = [
      {
        配件ID: preferredPart?.id ?? 1,
        SKU: preferredPart?.sku ?? "IP14P-SCR-01",
        配件名称: preferredPart?.name ?? "iPhone 14 Pro OLED Display Assembly",
        供应商: preferredPart?.supplier ?? supplier?.name ?? "Pacific Screen Supply",
        数量: 10,
        采购单价: preferredPart?.costPrice ?? preferredPart?.unitPrice ?? 100,
        采购币种: "CNY",
        汇率: 17.5,
        快递费: 5000,
        关税: 3000,
        报关费: 1500,
        其他费用: 0,
        备注: "首行可填写批次公共费用，其他行可留空",
      },
      {
        配件ID: parts[1]?.id ?? "",
        SKU: parts[1]?.sku ?? "",
        配件名称: parts[1]?.name ?? "",
        供应商: parts[1]?.supplier ?? "",
        数量: 5,
        采购单价: parts[1]?.costPrice ?? parts[1]?.unitPrice ?? "",
        采购币种: "",
        汇率: "",
        快递费: "",
        关税: "",
        报关费: "",
        其他费用: "",
        备注: "",
      },
    ];

    const worksheet = XLSX.utils.json_to_sheet(templateRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "批量进货模板");
    XLSX.writeFile(workbook, "批量进货导入模板.xlsx");
  }

  return (
    <div className="inbound-page">
      <div className="page-title-block">
        <h2>入库登记</h2>
        <p>库存入库登记</p>
      </div>
      <section className="scan-dropzone-card">
        <span className="micro-label">智能扫码入库</span>
        <div className="scan-dropzone">
          {cameraStream ? (
            <video autoPlay className="scan-video-preview" id="inbound-scan-video" muted playsInline />
          ) : (
            <>
              <span className="material-symbols-outlined">qr_code_scanner</span>
              <strong>点击开启摄像头或对准扫码器</strong>
              <p>支持条码、二维码与 DataMatrix</p>
            </>
          )}
        </div>
        <input accept="image/*" hidden id="inbound-scan-image-upload" onChange={handleInboundScanImage} type="file" />
        <div className="action-row">
          <button className="small-action-button" onClick={startInboundCameraScan} type="button">开启条码扫描</button>
          {cameraStream ? <button className="small-action-button" onClick={stopInboundCamera} type="button">关闭摄像头</button> : null}
          <button className="small-action-button" onClick={() => document.getElementById("inbound-scan-image-upload")?.click()} type="button">导入照片识别</button>
        </div>
        <div className="scanner-input-row">
          <input value={scanQuery} onChange={(event) => setScanQuery(event.target.value)} placeholder="输入 SKU、条码或配件名称..." />
          <button className="small-icon-action" disabled={scanLoading} onClick={() => handleInboundScan()} type="button">
            <span className="material-symbols-outlined">{scanLoading ? "hourglass_top" : "search"}</span>
          </button>
        </div>
      </section>
      {error ? <div className="message-banner error">{error}</div> : null}
      {success ? <div className="message-banner success">{success}</div> : null}
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>批量入库配件</h4>
          <div className="action-row">
            <button className="small-action-button" onClick={handleDownloadTemplate} type="button">下载模板</button>
            <button className="small-action-button" onClick={() => document.getElementById("inbound-excel-upload")?.click()} type="button">Excel 导入</button>
            <button className="small-action-button" onClick={addRow} type="button">新增一行</button>
          </div>
        </div>
        <input accept=".xlsx,.xls,.csv" hidden id="inbound-excel-upload" onChange={(event) => { handleImportExcel(event.target.files?.[0]); event.target.value = ""; }} type="file" />
        <div className="inbound-batch-list">
          {rowPreviews.map((row, index) => (
            <div key={`${row.partId}-${index}`} className="inbound-batch-row">
              <div className="sheet-grid compact">
                <Field label="零件选择" full>
                  <>
                    <input list={`inbound-part-options-${index}`} onChange={(event) => updateRow(index, "partSearch", event.target.value)} placeholder="输入 SKU 或配件名称搜索..." value={row.partSearch ?? ""} />
                    <datalist id={`inbound-part-options-${index}`}>
                      {parts.map((item) => <option key={item.id} value={buildPartSearchLabel(item)} />)}
                    </datalist>
                  </>
                </Field>
                <Field label="供应商">
                  <input value={row.supplierName} onChange={(event) => updateRow(index, "supplierName", event.target.value)} />
                </Field>
                <Field label="入库数量">
                  <input min="1" type="number" value={row.quantity ? String(row.quantity) : row.quantity === 0 ? "0" : row.quantity} onChange={(event) => updateRow(index, "quantity", event.target.value)} />
                </Field>
                <Field label={batchForm.sourceCurrency === "CNY" ? "采购单价 (人民币/件)" : "采购单价 (VUV/件)"}>
                  <input min="0" step="0.01" type="number" value={row.sourceUnitPrice ? String(row.sourceUnitPrice) : row.sourceUnitPrice === 0 ? "0" : row.sourceUnitPrice} onChange={(event) => updateRow(index, "sourceUnitPrice", event.target.value)} />
                </Field>
              </div>
              <div className="inbound-row-preview">
                <span>当前库存 {row.selectedPart?.stock ?? 0} 件</span>
                <span>入库后 {row.projectedStock} 件</span>
                <span>分摊费用 {formatCurrency(row.allocatedExtra ?? 0)}</span>
                <strong>预计每件成本 {formatCurrency(row.landedUnitCost ?? 0)}</strong>
              </div>
              <div className="action-row">
                <button className="wide-action secondary" disabled={rows.length === 1} onClick={() => removeRow(index)} type="button">删除本行</button>
              </div>
            </div>
          ))}
        </div>
        <div className="inbound-meta-row">
          <div><span className="micro-label">操作员</span><strong>张三（管理员）</strong></div>
          <div><span className="micro-label">入库时间</span><strong>{latest?.createdAt ?? "今天"}</strong></div>
        </div>
      </section>
      <section className="detail-block highlight-panel">
        <div className="detail-block-head">
          <h4>费用与成本分摊</h4>
        </div>
        <div className="sheet-grid compact">
          <Field label="采购币种">
            <select value={batchForm.sourceCurrency} onChange={(event) => setBatchForm((current) => ({ ...current, sourceCurrency: event.target.value }))}>
              <option value="CNY">人民币 CNY</option>
              <option value="VUV">瓦图 VUV</option>
            </select>
          </Field>
          <Field label="汇率 (1 人民币 = ? VUV)">
            <input min="0.0001" step="0.0001" type="number" value={batchForm.exchangeRate} onChange={(event) => setBatchForm((current) => ({ ...current, exchangeRate: event.target.value }))} />
          </Field>
          <Field label="快递费 (VUV)">
            <input min="0" type="number" value={batchForm.shippingFee} onChange={(event) => setBatchForm((current) => ({ ...current, shippingFee: event.target.value }))} />
          </Field>
          <Field label="关税 (VUV)">
            <input min="0" type="number" value={batchForm.customsFee} onChange={(event) => setBatchForm((current) => ({ ...current, customsFee: event.target.value }))} />
          </Field>
          <Field label="报关费 (VUV)">
            <input min="0" type="number" value={batchForm.declarationFee} onChange={(event) => setBatchForm((current) => ({ ...current, declarationFee: event.target.value }))} />
          </Field>
          <Field label="其他费用 (VUV)">
            <input min="0" type="number" value={batchForm.otherFee} onChange={(event) => setBatchForm((current) => ({ ...current, otherFee: event.target.value }))} />
          </Field>
          <Field label="备注" full>
            <textarea value={batchForm.note} onChange={(event) => setBatchForm((current) => ({ ...current, note: event.target.value }))} />
          </Field>
        </div>
        <div className="procurement-cost-grid">
          <div><span>采购货值</span><strong>{formatCurrency(totalPurchaseValueVuv)}</strong></div>
          <div><span>附加费用合计</span><strong>{formatCurrency(totalExtraFees)}</strong></div>
          <div><span>总落地成本</span><strong>{formatCurrency(totalPurchaseValueVuv + totalExtraFees)}</strong></div>
          <div><span>入库行数</span><strong>{rowPreviews.length} 行</strong></div>
        </div>
      </section>
      <button className="primary-submit" disabled={saving} onClick={handleSubmit} type="button">{saving ? "登记中..." : "确认批量入库并核算成本"}</button>
    </div>
  );
}

function AddPartsPage({ parts }) {
  const navigate = useNavigate();
  const { id } = useParams();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("全部");
  const [selected, setSelected] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [order, setOrder] = useState(null);
  const visibleParts = parts.filter((part) => {
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || part.name.toLowerCase().includes(query) || part.sku.toLowerCase().includes(query);
    const matchesCategory = category === "全部" || inferPartCategory(part.name) === category;
    return matchesQuery && matchesCategory;
  });
  const selectedCount = Object.values(selected).reduce((sum, value) => sum + value, 0);
  const categoryTabs = ["全部", "屏幕", "电池", "小配件"];
  const selectedPartsTotal = Object.entries(selected).reduce((sum, [partId, quantity]) => {
    const part = parts.find((item) => item.id === Number(partId));
    return sum + ((part?.unitPrice ?? 0) * quantity);
  }, 0);
  const estimatedGrandTotal = (order?.amount ?? 0) + selectedPartsTotal;

  useEffect(() => {
    let ignore = false;
    async function loadOrder() {
      try {
        const result = await fetchJson(`/api/orders/${id}`);
        if (!ignore) setOrder(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      }
    }
    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  function updateQty(partId, delta) {
    setSelected((current) => ({ ...current, [partId]: Math.max(0, (current[partId] ?? 0) + delta) }));
  }

  async function handleSubmit() {
    const items = Object.entries(selected)
      .map(([partId, quantity]) => ({ partId: Number(partId), quantity }))
      .filter((item) => item.quantity > 0);

    if (!items.length) {
      setError("请先选择至少一个配件。");
      return;
    }

    try {
      setSaving(true);
      setError("");
      await fetchJson(`/api/orders/${id}/parts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      navigate(`/orders/${id}/parts-usage`);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="repair-flow-page">
      <section className="repair-flow-header">
        <div>
          <h2>添加配件</h2>
          <p>订单 #{order?.orderNo ?? id}</p>
        </div>
      </section>
      {error ? <div className="message-banner error">{error}</div> : null}
      <div className="repairs-template-search">
        <span className="material-symbols-outlined">search</span>
        <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索 SKU 或零件名称..." type="text" value={search} />
      </div>
      <div className="repair-flow-chips">
        {categoryTabs.map((item) => (
          <button key={item} className={category === item ? "repairs-template-filter active" : "repairs-template-filter"} onClick={() => setCategory(item)} type="button">
            {item}
          </button>
        ))}
      </div>
      <section className="repair-flow-summary-card">
        <div>
          <span>已选配件</span>
          <strong>{selectedCount} 项</strong>
        </div>
        <div>
          <span>合计金额</span>
          <strong>{selectedPartsTotal.toLocaleString("en-US")} VUV</strong>
        </div>
      </section>
      <section className="repair-flow-list">
        {visibleParts.slice(0, 8).map((part) => (
          <div key={part.id} className="repair-part-card">
            <div className="repair-part-thumb">
              <span className="material-symbols-outlined">{inferPartCategory(part.name) === "Screens" ? "screenshot" : inferPartCategory(part.name) === "Batteries" ? "battery_charging_full" : "memory"}</span>
            </div>
            <div className="repair-part-body">
              <div className="repair-part-top">
                <strong>{part.name}</strong>
                <span className={part.needsReorder ? "order-list-template-badge warning" : "order-list-template-badge primary"}>{part.needsReorder ? "低库存" : "有库存"}</span>
              </div>
              <p>SKU: {part.sku}</p>
              <div className="repair-part-bottom">
                <span>{part.unitPriceFormatted}</span>
                <div className="quantity-stepper">
                  <button onClick={() => updateQty(part.id, -1)} type="button"><span className="material-symbols-outlined">remove</span></button>
                  <span>{selected[part.id] ?? 0}</span>
                  <button className="primary" onClick={() => updateQty(part.id, 1)} type="button"><span className="material-symbols-outlined">add</span></button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </section>
      <div className="repair-flow-bottom-bar">
        <div>
          <span>预计提交后总价</span>
          <strong>{`${estimatedGrandTotal.toLocaleString("en-US")} VUV`}</strong>
        </div>
        <button className="wide-action primary" disabled={saving} onClick={handleSubmit} type="button">{saving ? "提交中..." : "加入工单"}</button>
      </div>
    </div>
  );
}

function OrderIntakePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadIntake() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/intake`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadIntake();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) return <div className="empty-card">受理单加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到受理单。</div>;

  return (
    <div className="detail-page">
      <section className="quick-order-supplier-card">
        <div className="supplier-categories"><span>受理单</span><span>{data.signedAt}</span></div>
        <h2>{data.intakeCode}</h2>
        <p>{data.customerName} · {data.deviceName}</p>
      </section>
      <section className="detail-block">
        <div className="usage-metric-grid">
          <InfoTile label="工单号" value={data.orderNo} />
          <InfoTile label="IMEI / 序列号" value={data.imeiSerial} />
          <InfoTile label="客户签字" value={data.customerSignature} />
          <InfoTile label="联系电话" value={data.customerPhone} />
        </div>
      </section>
      <section className="detail-block">
        <div className="detail-block-head"><h4>受理照片</h4><span className="inline-link">{data.intakePhotos.length} 张</span></div>
        <div className="gallery-grid">
          <img alt={data.intakePhotos[0]?.stage ?? "intake"} src={data.intakePhotos[0]?.image ?? detailGallery[0]} />
          <div className="gallery-stack">
            {data.intakePhotos.slice(1, 3).map((photo) => (
              <img key={photo.image} alt={photo.stage} src={photo.image} />
            ))}
            <div className="gallery-more">{data.intakePhotos.map((photo) => photo.stage).join(" / ")}</div>
          </div>
        </div>
      </section>
      <section className="detail-block">
        <div className="detail-block-head"><h4>故障描述</h4></div>
        <p>{data.issueSummary}</p>
        <div className="usage-tags">
          <span className="soft-badge">报价: {data.amountFormatted}</span>
          <span className="soft-badge">状态: {statusChinese[data.status]}</span>
        </div>
      </section>
      <div className="action-row">
        <button className="wide-action primary" onClick={() => navigate(`/orders/${id}`)} type="button">进入工单详情</button>
        <button className="wide-action secondary" onClick={() => navigate(`/orders/${id}/photo-archive`)} type="button">查看照片归档</button>
      </div>
    </div>
  );
}

function OrderPartsUsagePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadOrder() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}`);
        if (!ignore) setOrder(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) return <div className="empty-card">配件使用明细加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!order) return <div className="empty-card">未找到工单。</div>;

  const totalQty = order.parts.reduce((sum, part) => sum + part.quantity, 0);

  return (
    <div className="parts-usage-template-page">
      <section className="parts-usage-template-hero">
        <div>
          <p>工单编号</p>
          <h2>#{order.orderNo}</h2>
        </div>
        <span className="parts-usage-template-badge">{statusChinese[order.status]}</span>
      </section>
      <section className="parts-usage-template-metrics">
        <div className="parts-usage-template-metric">
          <span className="material-symbols-outlined">inventory</span>
          <p>消耗部件总数</p>
          <strong>{totalQty} 件</strong>
        </div>
        <div className="parts-usage-template-metric">
          <span className="material-symbols-outlined">payments</span>
          <p>备件总金额</p>
          <strong>{order.partsTotalFormatted ?? order.amountFormatted}</strong>
        </div>
      </section>
      <section className="parts-usage-template-list-head">
        <h3>备件消耗明细</h3>
        <button className="link-button" onClick={() => navigate(`/orders/${id}/deductions/journal`)} type="button">查看库存日志</button>
      </section>
      <section className="parts-usage-template-list">
        {order.parts.map((part) => (
          <button key={part.id} className="parts-usage-template-item" onClick={() => navigate(`/parts/${part.id}`)} type="button">
            <div className="parts-usage-template-thumb">
              <span className="material-symbols-outlined">{inferPartCategory(part.name) === "Screens" ? "screenshot" : inferPartCategory(part.name) === "Batteries" ? "battery_full" : "inventory_2"}</span>
            </div>
            <div className="parts-usage-template-content">
              <div className="parts-usage-template-item-head">
                <h4>{part.name}</h4>
                <strong>{part.subtotalFormatted}</strong>
              </div>
              <p>SKU: {part.sku ?? "IN-ORDER"}</p>
              <div className="parts-usage-template-tags">
                <span>数量: {part.quantity}</span>
                <span>单价: {part.unitPriceFormatted}</span>
              </div>
            </div>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </section>
      <div className="usage-tags">
        <span className="soft-badge">工费: {order.laborTotalFormatted ?? "0 VUV"}</span>
        <span className="soft-badge">订单总价: {order.grandTotalFormatted ?? order.amountFormatted}</span>
      </div>
    </div>
  );
}

function QuickOrderPage({ suppliersData }) {
  const suppliers = suppliersData?.suppliers ?? [];
  const supplier = suppliers[0];
  const quickParts = [
    { id: 1, name: "密封滚珠轴承 6204-2RS", sku: "PP-B-0042", stock: 12, price: "1,450 VUV", tone: "danger" },
    { id: 2, name: "液压控制阀组件", sku: "PP-H-9811", stock: 4, price: "24,800 VUV", tone: "warning" },
    { id: 3, name: "不锈钢螺栓套装 (M12)", sku: "PP-F-2210", stock: 21, price: "5,200 VUV", tone: "primary" },
  ];

  return (
    <div className="quick-order-page">
      <section className="quick-order-supplier-card">
        <h2>{supplier?.name ?? "PrecisionParts Ltd"}</h2>
        <p>{supplier?.tag ?? "活跃合作伙伴"} · 48小时送达</p>
        <div className="supplier-categories">{(supplier?.categories ?? ["屏幕", "电池", "小零件"]).map((item) => <span key={item}>{item}</span>)}</div>
      </section>
      <section className="reports-metrics-grid wide">
        <div className="report-metric-card"><p>低库存预警</p><strong>08</strong><span>项零件</span></div>
        <div className="report-metric-card primary"><p>本月订单总额</p><strong>1.2M VUV</strong><span>采购需求</span></div>
      </section>
      <section className="page-section">
        <div className="section-title-row">
          <h3>畅销零件清单</h3>
          <span>快速加入采购单</span>
        </div>
        {quickParts.map((part) => (
          <div key={part.id} className="quick-order-part-card">
            <div className="add-part-thumb"><span className="material-symbols-outlined">inventory_2</span></div>
            <div className="add-part-content">
              <div className="add-part-head">
                <strong>{part.name}</strong>
                <span>{part.price}</span>
              </div>
              <p>SKU: {part.sku}</p>
              <div className="progress-meta"><span>当前库存</span><span className={part.tone === "danger" ? "text-danger" : part.tone === "warning" ? "text-warning" : "text-primary"}>{part.stock} 件</span></div>
              <div className="progress-bar"><div className={part.tone === "danger" ? "progress-danger" : part.tone === "warning" ? "progress-warning" : ""} style={{ width: `${Math.min(100, part.stock * 4)}%` }} /></div>
            </div>
            <button className="wide-action primary" onClick={() => navigate("/supplier-management")} type="button">快速添加</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function RepairExecutionPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadOrder() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/execution`);
        if (!ignore) setOrder(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) return <div className="empty-card">维修执行页加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!order) return <div className="empty-card">未找到工单。</div>;

  async function saveExecution(nextPhase = order.phase) {
    try {
      setSaving(true);
      setError("");
      const result = await fetchJson(`/api/orders/${id}/execution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: nextPhase,
          elapsedMinutes: order.elapsedMinutes,
          checklist: order.checklist,
        }),
      });
      setOrder((current) => ({
        ...current,
        phase: result.phase,
        phaseLabel: result.phaseLabel,
        status: result.status,
      }));
      const refreshed = await fetchJson(`/api/orders/${id}/execution`);
      setOrder(refreshed);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="execution-template-page">
      <section className="execution-template-header">
        <div className="execution-template-device">
          <div className="execution-template-device-thumb"><span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span></div>
          <div className="execution-template-device-info">
          <div className="supplier-categories"><span>{statusChinese[order.status]}</span><span>#{order.orderNo}</span></div>
          <h2>{order.deviceName}</h2>
          <p>{order.deviceMeta?.color ?? "深空蓝"} · {order.deviceMeta?.storage ?? "256GB"}</p>
        </div>
        </div>
        <div className="execution-template-summary">
          <div><span>阶段</span><strong>{order.phaseLabel}</strong></div>
          <div><span className="micro-label">已耗时</span><strong>{formatMinutesLabel(order.elapsedMinutes)}</strong></div>
        </div>
      </section>
      <div className="execution-template-grid">
        <section className="execution-template-card">
          <div className="execution-template-card-head"><h3>诊断检查清单</h3><button className="link-button" disabled={saving} onClick={() => saveExecution(order.phase)} type="button">保存</button></div>
          <div className="execution-template-checklist">
            {order.checklist.map((item) => (
              <label key={item.id} className="execution-template-check">
                <span>{item.label}</span>
                <input checked={item.checked} onChange={() => setOrder((current) => ({
                  ...current,
                  checklist: current.checklist.map((entry) => (entry.id === item.id ? { ...entry, checked: !entry.checked } : entry)),
                }))} type="checkbox" />
              </label>
            ))}
          </div>
        </section>
        <section className="execution-template-card">
          <div className="execution-template-card-head">
            <h3>维修步骤</h3>
            <div className="order-detail-template-inline-actions">
              <button className="link-button" disabled={saving} onClick={() => saveExecution("diagnosis")} type="button">{formatExecutionPhaseChipLabel("diagnosis")}</button>
              <button className="link-button" disabled={saving} onClick={() => saveExecution("repair")} type="button">{formatExecutionPhaseChipLabel("repair")}</button>
              <button className="link-button" disabled={saving} onClick={() => saveExecution("qa")} type="button">{formatExecutionPhaseChipLabel("qa")}</button>
            </div>
          </div>
          <div className="execution-template-timeline">
            {(order.timeline ?? []).map((item, index) => (
              <div key={`${item.title}-${index}`} className={`execution-template-step ${item.state ?? "future"}`}>
                <div className="execution-template-step-dot">
                  <span className="material-symbols-outlined">{item.state === "done" ? "check" : item.state === "current" ? "adjust" : "flag"}</span>
                </div>
                <div className="execution-template-step-content">
                  <strong>{item.title}</strong>
                  <span>{item.state === "current" ? "进行中" : item.time}</span>
                  <p>{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <section className="execution-template-card">
        <div className="execution-template-card-head">
          <h3>已使用零件</h3>
          <button className="link-button" onClick={() => navigate(`/orders/${id}/add-parts`)} type="button">添加零件</button>
        </div>
        <div className="execution-template-parts">
          {order.parts.map((part) => (
            <div key={part.id} className="execution-template-part">
              <div className="execution-template-part-thumb"><span className="material-symbols-outlined">{inferPartCategory(part.name) === "Screens" ? "screenshot" : inferPartCategory(part.name) === "Batteries" ? "battery_full" : "inventory_2"}</span></div>
              <div className="execution-template-part-main">
                <strong>{part.name}</strong>
                <p>{part.unitPriceFormatted}</p>
              </div>
              <span className="soft-badge">x{part.quantity}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RepairExecutionLivePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadOrder() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/execution`);
        if (!ignore) setOrder(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) return <div className="empty-card">实时执行页加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!order) return <div className="empty-card">未找到工单。</div>;

  const completedPercent = order.checklist.length ? Math.round((order.checklist.filter((item) => item.checked).length / order.checklist.length) * 100) : 0;

  async function advancePhase(nextPhase) {
    try {
      setSaving(true);
      setError("");
      await fetchJson(`/api/orders/${id}/execution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phase: nextPhase,
          elapsedMinutes: order.elapsedMinutes + 15,
          checklist: order.checklist,
        }),
      });
      const refreshed = await fetchJson(`/api/orders/${id}/execution`);
      setOrder(refreshed);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="execution-live-template-page">
      <section className="execution-live-template-hero">
        <div className="execution-live-template-main">
          <div className="supplier-categories"><span>维修中</span><span>#{order.orderNo}</span></div>
          <h2>{order.deviceName}</h2>
          <p>{order.customerName ?? order.title}</p>
        </div>
        <div className="execution-live-template-timer">
          <p>已用时间</p>
          <strong>{String(Math.floor(order.elapsedMinutes / 60)).padStart(2, "0")}:{String(order.elapsedMinutes % 60).padStart(2, "0")}:00</strong>
          <span>阶段: {order.phaseLabel}</span>
        </div>
      </section>
      <div className="execution-live-template-grid">
        <section className="execution-template-card">
          <div className="execution-template-card-head"><h3>诊断清单</h3><span>{completedPercent}% 完成</span></div>
          <div className="execution-template-checklist">
            {order.checklist.map((item) => (
              <label key={item.id} className="execution-template-check">
                <span>{item.label}</span>
                <input checked={item.checked} onChange={() => setOrder((current) => ({
                  ...current,
                  checklist: current.checklist.map((entry) => (entry.id === item.id ? { ...entry, checked: !entry.checked } : entry)),
                }))} type="checkbox" />
              </label>
            ))}
          </div>
          <div className="order-detail-template-inline-actions">
            <button className="wide-action secondary" disabled={saving} onClick={() => advancePhase("repair")} type="button">推进到维修</button>
            <button className="wide-action primary" disabled={saving} onClick={() => advancePhase("qa")} type="button">推进到质检</button>
          </div>
        </section>
        <section className="execution-template-card">
          <div className="execution-template-card-head"><h3>维修进度</h3><button className="link-button" onClick={() => navigate(`/orders/${id}/deductions`)} type="button">查看扣减</button></div>
          <div className="execution-template-timeline">
            {(order.timeline ?? []).map((item, index) => (
              <div key={`${item.title}-${index}`} className={`execution-template-step ${item.state ?? "future"}`}>
                <div className="execution-template-step-dot">
                  <span className="material-symbols-outlined">{item.state === "done" ? "check" : item.state === "current" ? "adjust" : String(index + 1)}</span>
                </div>
                <div className="execution-template-step-content">
                  <strong>{item.title}</strong>
                  <span>{item.state === "current" ? "进行中" : item.time}</span>
                  <p>{item.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="order-detail-template-inline-actions">
        <button className="wide-action secondary" onClick={() => navigate(`/orders/${id}/communication`)} type="button">联系客户</button>
        <button className="wide-action primary" disabled={saving} onClick={() => advancePhase("completed")} type="button">标记完成</button>
      </div>
    </div>
  );
}

function DeductionHistoryPage() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadOrder() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/deductions`);
        if (!ignore) setOrder(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadOrder();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) return <div className="empty-card">扣减历史加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!order) return <div className="empty-card">未找到工单。</div>;

  return (
    <div className="deduction-page">
      <section className="deduction-summary-card">
        <div className="deduction-summary-top">
          <div>
            <span className="micro-label">维修工单</span>
            <h2>#{order.orderNo}</h2>
          </div>
          <span className="soft-badge">{statusChinese[order.status]}</span>
        </div>
        <div className="usage-metric-grid">
          <div className="detail-block"><span className="micro-label">扣减总额</span><strong>{order.totalDeductionFormatted}</strong></div>
          <div className="detail-block"><span className="micro-label">技师</span><strong>{order.technician}</strong></div>
        </div>
      </section>
      <section className="settings-staff-list">
        {order.rows.map((part) => (
          <div key={part.id} className="deduction-timeline-card">
            <div className="add-part-thumb"><span className="material-symbols-outlined">{inferPartCategory(part.partName) === "Screens" ? "screenshot" : inferPartCategory(part.partName) === "Batteries" ? "battery_full" : "memory"}</span></div>
            <div className="add-part-content">
              <div className="add-part-head"><strong>{part.partName}</strong><span className="text-danger">-{part.quantity} 件</span></div>
              <p>SKU: {part.sku ?? "IN-ORDER"} · {order.technician}</p>
              <div className="progress-meta"><span>{part.createdLabel}</span><span>{part.subtotalFormatted}</span></div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function DeductionJournalPage({ movements }) {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadJournal() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/deductions/journal`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadJournal();
    return () => {
      ignore = true;
    };
  }, [id]);

  if (loading) return <div className="empty-card">扣减台账加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到扣减台账。</div>;

  const rows = data.rows;
  return (
    <div className="deduction-page">
      <section className="reports-metrics-grid">
        <div className="report-metric-card"><p>扣减总次数</p><strong>{data.totalDeductions}</strong><span>当前工单</span></div>
        <div className="report-metric-card"><p>扣减总金额 (VUV)</p><strong>{data.totalValueFormatted}</strong><span>库存出库</span></div>
        <div className="report-metric-card"><p>活跃工单</p><strong>{data.activeOrders}</strong><span>待完工处理</span></div>
      </section>
      <div className="section-title-row">
        <h3>库存台账</h3>
        <button className="wide-action primary" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出 CSV</button>
      </div>
      <section className="settings-staff-list">
        {rows.map((movement) => (
          <div key={movement.id} className="journal-row-card">
            <div className="add-part-thumb"><span className="material-symbols-outlined">inventory_2</span></div>
            <div className="add-part-content">
              <div className="add-part-head"><strong>{movement.partName}</strong><span className="text-danger">-{movement.quantity} 件</span></div>
              <p>{movement.note || "客户维修出库"} · {movement.createdAt}</p>
            </div>
            <div className="audit-log-side">
              <strong>{movement.reference ?? "RO-REF"}</strong>
              <span>{movement.partName}</span>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function InventoryAdjustmentPage({ parts, movements, refresh }) {
  const location = useLocation();
  const inventoryContext = useMemo(() => getInventoryContext(location.search), [location.search]);
  const isLossMode = location.pathname === "/inventory/loss";
  const [partId, setPartId] = useState(inventoryContext.partId || String(parts[0]?.id ?? ""));
  const [adjustmentType, setAdjustmentType] = useState("scrap");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState(isLossMode ? "填写报损原因..." : "说明库存调整原因...");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const part = parts.find((item) => String(item.id) === partId) ?? parts[0];
  const lossRecords = useMemo(
    () => (movements ?? [])
      .filter((movement) => String(movement.note ?? "").startsWith("Loss ·"))
      .slice(0, 20)
      .map((movement) => {
        const matchedPart = parts.find((item) => item.id === movement.partId);
        const totalAmount = (matchedPart?.costPrice ?? matchedPart?.unitPrice ?? 0) * movement.quantity;
        return {
          ...movement,
          totalAmountFormatted: formatMoney(totalAmount),
        };
      }),
    [movements, parts],
  );

  useEffect(() => {
    if (isLossMode) {
      setAdjustmentType("scrap");
      setNote((current) => current || "填写报损原因...");
    }
  }, [isLossMode]);

  useEffect(() => {
    if (inventoryContext.partId) {
      setPartId(inventoryContext.partId);
      return;
    }
    if (!partId && parts[0]?.id) {
      setPartId(String(parts[0].id));
    }
  }, [inventoryContext.partId, partId, parts]);

  async function handleSubmit() {
    if (!part) return;
    try {
      setWorking(true);
      setError("");
      setSuccess("");
      const result = await fetchJson("/api/inventory/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            partId: Number(part.id),
            adjustmentType: isLossMode ? "scrap" : adjustmentType,
            quantity: Number(quantity),
            unit: "件",
            note,
            operator: "Jean-Pierre Kalot",
            source: isLossMode ? "loss" : "manual",
          }),
        });
        setSuccess(isLossMode ? `已完成报损，当前库存 ${result.part.stock} 件` : `已完成调整，当前库存 ${result.part.stock} 件`);
        await refresh();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="adjustment-page">
      {error ? <div className="message-banner error">{error}</div> : null}
      {success ? <div className="message-banner success">{success}</div> : null}
      <section className="detail-block">
        <div className="detail-block-head"><h4>{isLossMode ? "选择报损配件" : "选择配件"}</h4><span className="soft-badge">必选</span></div>
        <SearchBar value="" onChange={() => {}} placeholder="搜索 SKU 或配件名称..." />
        <div className="printer-device-card">
          <div>
            <strong>{part?.name ?? "通用前刹车片套装"}</strong>
            <p>SKU: {part?.sku ?? "BP-VILA-204"} · 库存: {part?.stock ?? 24} 件</p>
          </div>
          <span className="material-symbols-outlined text-success">check_circle</span>
        </div>
        <Field label="库存项目" full>
          <select value={partId} onChange={(event) => setPartId(event.target.value)}>
            {parts.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </Field>
      </section>
      <section className="detail-block">
        <div className="sheet-form compact">
        {!isLossMode ? (
          <Field label="调整类型" full>
            <div className="chip-row static">
              {["scrap", "internal", "testing"].map((item) => (
                  <button
                    key={item}
                    className={adjustmentType === item ? "active" : ""}
                    onClick={() => setAdjustmentType(item)}
                    type="button"
                  >
                    {item === "scrap" ? "报废" : item === "internal" ? "内部使用" : "测试损耗"}
                  </button>
                ))}
            </div>
          </Field>
        ) : (
          <Field label="报损类型" full>
            <div className="chip-row static">
              <button className="active" type="button">报损出库</button>
            </div>
          </Field>
        )}
          <Field label="数量"><input value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" /></Field>
          <Field label="单位"><input defaultValue="件" readOnly /></Field>
          <Field label={isLossMode ? "报损原因 / 备注" : "原因 / 备注"} full><textarea value={note} onChange={(event) => setNote(event.target.value)} /></Field>
        </div>
      </section>
      <section className="detail-block highlight-panel">
        <div className="detail-block-head"><h4>授权人员</h4></div>
        <div className="printer-device-card"><div><strong>Jean-Pierre Kalot</strong><p>库存主管</p></div><span className="material-symbols-outlined">unfold_more</span></div>
      </section>
      <section className="detail-block highlight-panel">
        <div className="detail-block-head"><h4>{isLossMode ? "报损金额" : "调整金额"}</h4><strong>{part?.unitPriceFormatted ?? "1,450 VUV"}</strong></div>
        <p>单价: {part?.unitPriceFormatted ?? "1,450 VUV"} · 数量: {quantity || 0}</p>
      </section>
      {isLossMode ? (
        <section className="detail-block">
          <div className="detail-block-head"><h4>最近报损记录</h4><strong>{lossRecords.length} 条</strong></div>
          <div className="page-section">
            {lossRecords.length ? lossRecords.map((record) => (
              <div key={record.id} className="movement-card loss-record-card">
                <div>
                  <strong>{record.partName}</strong>
                  <p>{record.createdAt} · 库存报损</p>
                  <p>数量: {record.quantity} 件</p>
                  <p>原因: {String(record.note ?? "").replace(/^Loss · [^·]+ ·\s*/, "") || "未填写"}</p>
                </div>
                <div className="finance-list-right">
                  <span className="movement-tag out">报损</span>
                  <strong>{record.totalAmountFormatted ?? record.partValueFormatted ?? "-"}</strong>
                </div>
              </div>
            )) : <div className="empty-card">还没有报损记录。</div>}
          </div>
        </section>
      ) : null}
      <button className="primary-submit" onClick={handleSubmit} type="button" disabled={working || !part}>
        {working ? "提交中..." : isLossMode ? "确认报损" : "确认调整"}
      </button>
    </div>
  );
}

function InventoryLossPage(props) {
  return <InventoryAdjustmentPage {...props} />;
}

function PartsRequisitionPage({ parts, refresh }) {
  const location = useLocation();
  const inventoryContext = useMemo(() => getInventoryContext(location.search), [location.search]);
  const [partId, setPartId] = useState(inventoryContext.partId || String(parts[0]?.id ?? ""));
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("repair");
  const [note, setNote] = useState("补充填写领用说明...");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const part = parts.find((item) => String(item.id) === partId) ?? parts[0];

  useEffect(() => {
    if (inventoryContext.partId) {
      setPartId(inventoryContext.partId);
      return;
    }
    if (!partId && parts[0]?.id) {
      setPartId(String(parts[0].id));
    }
  }, [inventoryContext.partId, partId, parts]);

  async function handleSubmit() {
    if (!part) return;
    try {
      setWorking(true);
      setError("");
      setSuccess("");
      const result = await fetchJson("/api/inventory/adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partId: Number(part.id),
          adjustmentType: reason,
          quantity: Number(quantity),
          unit: "件",
          note,
          operator: "Robert Kalmet",
          source: "requisition",
        }),
      });
      setSuccess(`已生成领用记录，当前库存 ${result.part.stock} 件`);
      await refresh();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="adjustment-page">
      {error ? <div className="message-banner error">{error}</div> : null}
      {success ? <div className="message-banner success">{success}</div> : null}
      <div className="page-title-block">
        <div className="supplier-categories"><span>领用单</span><span>工单参考: RO-2023-8892</span></div>
        <h2>配件领用</h2>
      </div>
      <section className="reports-main-grid mobileish">
        <section className="detail-block">
          <div className="detail-block-head"><h4>搜索库存</h4></div>
          <SearchBar value="" onChange={() => {}} placeholder="搜索例如 iPhone 14 屏幕..." />
          <div className="printer-device-card">
            <div><strong>{part?.name ?? "iPhone 14 Pro OLED Display Assembly"}</strong><p>SKU: {part?.sku ?? "DISP-IP14P-BLK"}</p></div>
            <span className="soft-badge">{part?.stock ?? 14} 件</span>
          </div>
          <div className="sheet-form compact">
            <Field label="配件" full>
              <select value={partId} onChange={(event) => setPartId(event.target.value)}>
                {parts.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </Field>
            <Field label="领用数量"><input value={quantity} onChange={(event) => setQuantity(event.target.value)} type="number" /></Field>
            <Field label="领用原因"><select value={reason} onChange={(event) => setReason(event.target.value)}><option value="repair">客户维修</option><option value="internal">内部使用</option><option value="scrap">报废 / 损坏</option></select></Field>
            <Field label="授权人员" full><input defaultValue="Robert Kalmet (Workshop Manager)" readOnly /></Field>
            <Field label="备注（可选）" full><textarea value={note} onChange={(event) => setNote(event.target.value)} /></Field>
          </div>
          <button className="primary-submit" onClick={handleSubmit} type="button" disabled={working || !part}>
            {working ? "提交中..." : "确认领用"}
          </button>
        </section>
        <aside className="detail-block">
          <div className="detail-block-head"><h4>费用汇总</h4></div>
          <div className="usage-metric-grid">
            <div className="detail-block"><span className="micro-label">领用总额</span><strong>{part ? `${Number(quantity || 0) * (part.unitPrice ?? 0)} VUV` : "42,500 VUV"}</strong></div>
            <div className="detail-block"><span className="micro-label">库位</span><strong>Warehouse 1A</strong></div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function InventoryAuditSessionPage({ parts, refresh }) {
  const navigate = useNavigate();
  const location = useLocation();
  const inventoryContext = useMemo(() => getInventoryContext(location.search), [location.search]);
  const auditParts = useMemo(() => {
    if (!inventoryContext.partId) return parts.slice(0, 3);
    const selected = parts.find((part) => String(part.id) === inventoryContext.partId);
    if (!selected) return parts.slice(0, 3);
    return [selected, ...parts.filter((part) => String(part.id) !== inventoryContext.partId)].slice(0, 3);
  }, [inventoryContext.partId, parts]);
  const [actuals, setActuals] = useState(() => Object.fromEntries(auditParts.map((part, index) => [part.id, String(index === 1 ? Math.max(0, part.stock - 1) : part.stock)])));
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [category, setCategory] = useState("全部");

  const visibleAuditParts = useMemo(() => {
    if (category === "全部") return auditParts;
    return auditParts.filter((part) => inferPartCategory(part.name) === category);
  }, [auditParts, category]);

  useEffect(() => {
    setActuals((current) => {
      if (Object.keys(current).length) return current;
      return Object.fromEntries(auditParts.map((part, index) => [part.id, String(index === 1 ? Math.max(0, part.stock - 1) : part.stock)]));
    });
  }, [auditParts]);

  async function handleSubmit() {
    try {
      setWorking(true);
      setError("");
      setSuccess("");
      const items = auditParts.map((part) => ({
        partId: part.id,
        actualStock: Number(actuals[part.id] ?? part.stock),
      }));
      const result = await fetchJson("/api/inventory/audit-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operator: "Aiden",
          items,
        }),
      });
      setSuccess(`已保存盘点 ${result.sessionNo}，差异 ${result.discrepancies.length} 项`);
      await refresh();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="audit-session-page">
      {error ? <div className="message-banner error">{error}</div> : null}
      {success ? <div className="message-banner success">{success}</div> : null}
      <section className="quick-order-supplier-card">
        <div className="supplier-categories"><span>盘点进行中</span><span>2024-05-20</span></div>
        <h2>盘点单 #AD-20240520</h2>
        <p>技师: Aiden</p>
      </section>
      <nav className="status-strip">
        {["全部", "屏幕", "电池", "小配件"].map((item) => (
          <button key={item} className={category === item ? "status-chip active" : "status-chip"} onClick={() => setCategory(item)} type="button">{item}</button>
        ))}
      </nav>
        <section className="settings-staff-list">
          {visibleAuditParts.map((part, index) => (
            <div key={part.id} className={`audit-stock-card ${index === 1 ? "discrepancy" : ""}`}>
              <div className="add-part-head">
                <div className="audit-stock-main">
                  <span className="micro-label">{inferPartCategory(part.name)}</span>
                  <strong>{part.name}</strong>
                  <p>B 区 42 号位</p>
                </div>
                <div className="audit-log-side">
                  <span>系统库存 {part.stock} 件</span>
                </div>
              </div>
            <div className="scanner-input-row">
              <input value={actuals[part.id] ?? ""} onChange={(event) => setActuals((current) => ({ ...current, [part.id]: event.target.value }))} placeholder="输入实际盘点数量" type="number" />
              <button className="small-icon-action" onClick={() => navigate("/parts-scanner")} type="button"><span className="material-symbols-outlined">qr_code_scanner</span></button>
            </div>
            {Number(actuals[part.id] ?? part.stock) !== part.stock ? <p className="text-danger">发现差异（{Number(actuals[part.id] ?? part.stock) - part.stock}）</p> : null}
          </div>
        ))}
      </section>
      <button className="primary-submit" onClick={handleSubmit} type="button" disabled={working}>
        {working ? "保存中..." : "保存盘点会话"}
      </button>
    </div>
  );
}

function CustomerCenterPage({ customers, orders }) {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [search, setSearch] = useState("");

  const filteredCustomers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return customers.filter((customer) => {
      return !query
        || customer.name.toLowerCase().includes(query)
        || customer.phone.toLowerCase().includes(query)
        || customer.email.toLowerCase().includes(query);
    });
  }, [customers, search]);

  const metrics = useMemo(() => {
    const todayKey = getTodayInputDate();
    const totalCustomers = customers.length;
    const activeCustomers = customers.filter((customer) => customer.orderCount > 0).length;
    const todayAppointments = orders.filter((order) => order.scheduledDate === todayKey).length;
    const completedOrders = orders.filter((order) => order.status === "completed" || order.status === "picked_up").length;
    const satisfaction = orders.length ? Math.round((completedOrders / orders.length) * 100) : 0;
    return { totalCustomers, activeCustomers, todayAppointments, satisfaction };
  }, [customers, orders]);

  if (!isMobile) {
    return (
      <div className="customer-center-desktop-page">
        <section className="customer-center-desktop-hero">
          <div>
            <span className="micro-label">客户关系</span>
            <h2>客户中心</h2>
            <p>查看客户活跃度、预约表现和维修关系，按联系方式快速检索。</p>
          </div>
          <div className="desktop-topbar-actions">
            <button className="wide-action secondary" onClick={() => navigate("/more-options")} type="button">更多操作</button>
            <button className="wide-action" onClick={() => navigate("/repairs-hub")} type="button">新增客户</button>
          </div>
        </section>

        <section className="customer-center-desktop-metrics">
          <div className="customer-center-template-metric">
            <p>总客户数</p>
            <strong>{metrics.totalCustomers}</strong>
          </div>
          <div className="customer-center-template-metric">
            <p>活跃客户</p>
            <strong>{metrics.activeCustomers}</strong>
          </div>
          <div className="customer-center-template-metric warning">
            <p>今日预约</p>
            <strong>{metrics.todayAppointments}</strong>
          </div>
          <div className="customer-center-template-metric success">
            <p>满意度</p>
            <strong>{metrics.satisfaction}%</strong>
          </div>
        </section>

        <div className="customer-center-desktop-grid">
          <section className="customer-center-desktop-panel">
            <div className="customer-center-template-search">
              <span className="material-symbols-outlined">search</span>
              <input onChange={(event) => setSearch(event.target.value)} placeholder="快速搜索客户名称或联系电话..." type="text" value={search} />
            </div>

            <div className="customer-center-desktop-list">
              {filteredCustomers.map((customer) => (
                <button key={customer.id} className="customer-center-desktop-row" onClick={() => navigate(`/customers/${customer.id}`)} type="button">
                  <div className="customer-center-template-card-left">
                    <CustomerAvatar customer={customer} className="customer-center-template-icon" />
                    <div>
                      <h3>{customer.name}</h3>
                      <div className="customer-center-template-meta">
                        <span><span className="material-symbols-outlined inline-icon">call</span>{customer.phone}</span>
                        <span className="dot" />
                        <span>{customer.address || customer.email}</span>
                      </div>
                    </div>
                  </div>
                  <div className="customer-center-desktop-right">
                    <div className="customer-pill">维修次数: {customer.orderCount}</div>
                    <strong>{formatCustomerTierLabel(customer.tier)}</strong>
                    <span className="material-symbols-outlined customer-chevron">chevron_right</span>
                  </div>
                </button>
              ))}
              {!filteredCustomers.length ? <div className="empty-card">没有匹配到客户。</div> : null}
            </div>
          </section>

          <aside className="customer-center-desktop-side">
            <div className="template-card">
              <h3>今日重点</h3>
              <div className="stacked-list">
                <div className="summary-pill">活跃客户 {metrics.activeCustomers}</div>
                <div className="summary-pill">预约客户 {metrics.todayAppointments}</div>
                <div className="summary-pill">满意度 {metrics.satisfaction}%</div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="customer-center-template-page">
      <section className="customer-center-template-header">
        <div>
          <h2>客户中心</h2>
          <p>管理您的所有客户及其维修历史记录</p>
        </div>
        <button className="icon-button subtle" onClick={() => navigate("/more-options")} type="button">
          <span className="material-symbols-outlined">more_vert</span>
        </button>
      </section>

      <div className="customer-center-template-search">
        <span className="material-symbols-outlined">search</span>
        <input onChange={(event) => setSearch(event.target.value)} placeholder="快速搜索客户名称或联系电话..." type="text" value={search} />
      </div>

      <section className="customer-center-template-metrics">
        <div className="customer-center-template-metric">
          <p>总客户数</p>
          <strong>{metrics.totalCustomers}</strong>
        </div>
        <div className="customer-center-template-metric">
          <p>活跃客户</p>
          <strong>{metrics.activeCustomers}</strong>
        </div>
        <div className="customer-center-template-metric warning">
          <p>今日预约</p>
          <strong>{metrics.todayAppointments}</strong>
        </div>
        <div className="customer-center-template-metric success">
          <p>满意度</p>
          <strong>{metrics.satisfaction}%</strong>
        </div>
      </section>

      <section className="customer-center-template-list">
        {filteredCustomers.map((customer) => (
          <button key={customer.id} className="customer-center-template-card" onClick={() => navigate(`/customers/${customer.id}`)} type="button">
            <div className="customer-center-template-card-left">
              <CustomerAvatar customer={customer} className="customer-center-template-icon" />
              <div>
                <h3>{customer.name}</h3>
                <div className="customer-center-template-meta">
                  <span><span className="material-symbols-outlined inline-icon">call</span>{customer.phone}</span>
                  <span className="dot" />
                  <span>{customer.address || customer.email}</span>
                </div>
              </div>
            </div>
            <div className="customer-center-template-card-right">
              <div className="customer-pill">维修次数: {customer.orderCount}</div>
              <span className="material-symbols-outlined customer-chevron">chevron_right</span>
            </div>
          </button>
        ))}
        {!filteredCustomers.length ? <div className="empty-card">没有匹配到客户。</div> : null}
      </section>

      <button className="customer-center-template-fab" onClick={() => navigate("/repairs-hub")} type="button">
        <span className="material-symbols-outlined">person_add</span>
      </button>
    </div>
  );
}

function NotificationsPage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [data, setData] = useState({ rows: [], unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadNotifications = useCallback(async (nextFilter = filter) => {
    const result = await fetchJson(`/api/notifications?filter=${nextFilter}`);
    setData(result);
  }, [filter]);

  useEffect(() => {
    let ignore = false;
    async function boot() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/notifications?filter=${filter}`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    boot();
    return () => { ignore = true; };
  }, [filter]);

  async function handleReadAll() {
    try {
      setError("");
      await fetchJson("/api/notifications/read-all", { method: "POST" });
      await loadNotifications(filter);
    } catch (readError) {
      setError(readError.message);
    }
  }

  async function handleOpen(item) {
    try {
      await fetchJson(`/api/notifications/${item.id}/read`, { method: "POST" });
      await loadNotifications(filter);
      if (item.link) navigate(item.link);
    } catch (readError) {
      setError(readError.message);
    }
  }

  const rows = data.rows ?? [];

  return (
    <div className="notifications-page">
      <div className="section-title-row">
        <div>
          <h3>通知中心</h3>
          <span>您有 {data.unreadCount ?? 0} 条未读提醒</span>
        </div>
        <button className="wide-action secondary" onClick={handleReadAll} type="button">全部忽略</button>
      </div>
      <nav className="history-filter-tabs">
        <button className={filter === "all" ? "status-chip active" : "status-chip"} onClick={() => setFilter("all")} type="button">全部</button>
        <button className={filter === "order" ? "status-chip active" : "status-chip"} onClick={() => setFilter("order")} type="button">订单提醒</button>
        <button className={filter === "inventory" ? "status-chip active" : "status-chip"} onClick={() => setFilter("inventory")} type="button">库存预警</button>
        <button className={filter === "system" ? "status-chip active" : "status-chip"} onClick={() => setFilter("system")} type="button">系统通知</button>
      </nav>
      {error ? <div className="message-banner error">{error}</div> : null}
      {loading ? <div className="empty-card">通知加载中...</div> : null}
      <section className="page-section">
        {rows.map((item) => (
          <button key={item.id} className={`notification-card ${item.tone}`} onClick={() => handleOpen(item)} type="button">
            <div className={`notification-icon ${item.tone}`}>
              <span className="material-symbols-outlined">{item.category === "inventory" ? "inventory_2" : item.category === "order" ? "assignment" : item.category === "system" ? "settings_suggest" : "payments"}</span>
            </div>
            <div className="notification-body">
              <div className="notification-head">
                <h4>{item.title}</h4>
                <span>{item.time}</span>
              </div>
              <p>{item.body}</p>
              <em>{item.isRead ? `${item.tag} · 已读` : item.tag}</em>
            </div>
          </button>
        ))}
        {!rows.length && !loading ? <div className="empty-card">当前分类下暂无通知。</div> : null}
      </section>
    </div>
  );
}

function MoreOptionsPage({ orders }) {
  const navigate = useNavigate();
  const latestOrder = orders?.[0] ?? null;
  const latestOrderId = latestOrder?.id ?? 1;

  function handleClose() {
    const referrer = document.referrer || "";
    const hasAppReferrer = referrer.startsWith(window.location.origin) && !referrer.includes("/more-options");
    if (window.history.length > 1 && hasAppReferrer) {
      navigate(-1);
      return;
    }
    navigate("/repairs-hub");
  }

  return (
    <div className="more-options-page">
      <button aria-label="关闭更多操作" className="sheet-scrim" onClick={handleClose} type="button" />
      <div className="options-sheet">
        <div className="options-header">
          <div className="supplier-icon"><span className="material-symbols-outlined">settings_suggest</span></div>
          <div>
            <h3>更多操作</h3>
            <p>常用入口与系统快捷操作</p>
          </div>
          <button aria-label="关闭" className="icon-button subtle" onClick={handleClose} type="button">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="options-list">
          <button onClick={() => navigate("/notifications")} type="button"><span className="material-symbols-outlined">notifications</span><span>通知中心</span></button>
          <button onClick={() => navigate("/scanner")} type="button"><span className="material-symbols-outlined">qr_code_scanner</span><span>扫码工具</span></button>
          <button onClick={() => navigate(`/orders/${latestOrderId}`)} type="button"><span className="material-symbols-outlined">assignment</span><span>最近工单</span></button>
          <button onClick={() => navigate("/profile")} type="button"><span className="material-symbols-outlined">person</span><span>个人中心</span></button>
          <button className="danger" onClick={() => navigate("/settings")} type="button"><span className="material-symbols-outlined">settings</span><span>系统设置</span></button>
        </div>
        <button className="options-cancel" onClick={handleClose} type="button">取消</button>
      </div>
    </div>
  );
}

function ProfilePage({ staffPerformance }) {
  const navigate = useNavigate();
  const top = staffPerformance?.topPerformer ?? staffPerformance?.rows?.[0];
  return (
    <div className="profile-page">
      <section className="profile-hero-card">
        <div className="profile-avatar">A</div>
        <h2>{top?.staffName ?? "Aiden"}</h2>
        <p>员工编号: VPR-088</p>
        <span className="soft-badge">高级技师</span>
      </section>
      <section className="profile-stats-grid">
        <div className="detail-block">
          <p>已完成订单</p>
          <strong>{String(top?.completedOrders ?? 0)}</strong>
          <span>今日绩效</span>
        </div>
        <div className="detail-block">
          <p>日营收</p>
          <strong>{top?.totalRevenueFormatted ?? "-"}</strong>
          <span>实时数据</span>
        </div>
        <div className="detail-block">
          <p>评分</p>
          <strong>{String(top?.rating ?? "-")}</strong>
          <span>客户满意度</span>
        </div>
      </section>
      <section className="detail-block">
        <div className="options-list profile-menu">
          <button onClick={() => navigate("/technician-performance")} type="button"><span className="material-symbols-outlined">history</span><span>我的维修记录</span></button>
          <button onClick={() => navigate("/settings/business-hours")} type="button"><span className="material-symbols-outlined">calendar_month</span><span>我的排班</span></button>
          <button onClick={() => navigate("/technician-performance")} type="button"><span className="material-symbols-outlined">verified</span><span>资质与荣誉</span></button>
          <button onClick={() => navigate("/financial-reports")} type="button"><span className="material-symbols-outlined">account_balance_wallet</span><span>收入与结算</span></button>
          <button onClick={() => navigate("/settings/staff-permissions")} type="button"><span className="material-symbols-outlined">security</span><span>账户安全</span></button>
        </div>
      </section>
      <button className="logout-button" onClick={() => navigate("/repairs-hub")} type="button">退出当前账号</button>
      <p className="version-note">维拉港维修后台 v2.4.0</p>
    </div>
  );
}

function AppSettingsPage({ customers }) {
  const navigate = useNavigate();
  return (
    <div className="settings-template-page">
      <section className="settings-template-hero">
        <div>
          <span className="micro-label">系统设置</span>
          <h2>维拉港维修中心</h2>
          <p>门店、员工、硬件与系统偏好统一管理</p>
        </div>
        <button className="icon-button" onClick={() => navigate("/settings/store")} type="button">
          <span className="material-symbols-outlined">tune</span>
        </button>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>店铺信息</h4>
        </div>
        <div className="settings-template-store-card">
          <div className="supplier-icon"><span className="material-symbols-outlined">storefront</span></div>
          <div>
            <strong>维拉港维修中心</strong>
            <p>维拉港 · 埃法特岛 · 瓦努阿图</p>
          </div>
          <button className="small-action-button" onClick={() => navigate("/settings/store")} type="button">编辑</button>
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>硬件连接</h4>
        </div>
        <div className="settings-template-hardware-card">
          <div>
            <strong>蓝牙打印机</strong>
            <p>已配对: POS-58-Thermal</p>
          </div>
          <button className="wide-action primary" onClick={() => navigate("/settings/printer")} type="button">扫描连接</button>
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>员工管理</h4>
          <button className="link-button" onClick={() => navigate("/settings/staff-permissions")} type="button">权限设置</button>
        </div>
        <div className="settings-template-staff-list">
          {customers.slice(0, 3).map((customer, index) => (
            <button key={customer.id} className="settings-template-staff-row" onClick={() => navigate("/settings/staff-permissions")} type="button">
              <div className="avatar-circle">{customer.name.slice(0, 1)}</div>
              <div>
                <strong>{customer.name}</strong>
                <p>{index === 0 ? "店长 / 系统管理员" : index === 1 ? "高级维修技师" : "前台客服"}</p>
              </div>
              <span className="soft-badge">{index === 0 ? "主管" : index === 1 ? "技师" : "收银"}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>系统设置</h4>
        </div>
        <div className="settings-template-menu">
          <button onClick={() => navigate("/settings/business-hours")} type="button"><span className="material-symbols-outlined">schedule</span><span>营业时间</span></button>
          <button onClick={() => navigate("/settings/language")} type="button"><span className="material-symbols-outlined">language</span><span>语言与地区</span></button>
          <button onClick={() => navigate("/settings/print")} type="button"><span className="material-symbols-outlined">print</span><span>打印与票据</span></button>
          <button onClick={() => navigate("/settings/order-options")} type="button"><span className="material-symbols-outlined">smartphone</span><span>建单默认选项</span></button>
          <button onClick={() => navigate("/settings/reorder")} type="button"><span className="material-symbols-outlined">inventory</span><span>补货阈值</span></button>
        </div>
      </section>
    </div>
  );
}

function EditStorePage() {
  const [form, setForm] = useState({
    storeName: "",
    storeCode: "",
    phone: "",
    email: "",
    address: "",
    companyName: "",
    companyAddress: "",
    companyPhone: "",
    bankAccounts: "",
    quoteTaxInclusive: true,
    quoteTaxRate: 15,
    tinNumber: "",
    coverImage: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadStoreSettings() {
      try {
        setLoading(true);
        const result = await fetchJson("/api/settings/store");
        if (!ignore) setForm(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadStoreSettings();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setError("");
      setMessage("");
      const result = await fetchJson("/api/settings/store", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm(result);
      setMessage("门店信息已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty-card">门店设置加载中...</div>;

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}
      <section className="settings-template-store-hero">
        <div className="supplier-icon"><span className="material-symbols-outlined">storefront</span></div>
        <div>
          <strong>{form.storeName}</strong>
          <p>门店编号 {form.storeCode}</p>
        </div>
        <div className="store-cover-card">
          <img alt="storefront" src={form.coverImage} />
          <span className="soft-badge">实时展示</span>
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>基础资料</h4>
        </div>
        <div className="sheet-form compact">
          <Field label="门店名称" full><input value={form.storeName} onChange={(event) => setForm((current) => ({ ...current, storeName: event.target.value }))} /></Field>
          <Field label="门店编号"><input value={form.storeCode} onChange={(event) => setForm((current) => ({ ...current, storeCode: event.target.value }))} /></Field>
          <Field label="联系电话"><input value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} /></Field>
          <Field label="联系邮箱" full><input value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} /></Field>
          <Field label="公司名称" full><input value={form.companyName} onChange={(event) => setForm((current) => ({ ...current, companyName: event.target.value }))} /></Field>
          <Field label="公司电话"><input value={form.companyPhone} onChange={(event) => setForm((current) => ({ ...current, companyPhone: event.target.value }))} /></Field>
          <Field label="银行账号信息" full><textarea value={form.bankAccounts} onChange={(event) => setForm((current) => ({ ...current, bankAccounts: event.target.value }))} /></Field>
          <Field label="报价默认含税">
            <label className="toggle-field">
              <input
                checked={Boolean(form.quoteTaxInclusive)}
                onChange={(event) => setForm((current) => ({ ...current, quoteTaxInclusive: event.target.checked }))}
                type="checkbox"
              />
              <span>{form.quoteTaxInclusive ? "默认含税报价" : "默认不含税报价"}</span>
            </label>
          </Field>
          <Field label="报价税率(%)">
            <input
              min="0"
              step="0.1"
              type="number"
              value={form.quoteTaxRate ?? 15}
              onChange={(event) => setForm((current) => ({ ...current, quoteTaxRate: Number(event.target.value || 0) }))}
            />
          </Field>
          <Field label="TIN 税号"><input value={form.tinNumber} onChange={(event) => setForm((current) => ({ ...current, tinNumber: event.target.value }))} /></Field>
          <Field label="公司地址" full><textarea value={form.companyAddress} onChange={(event) => setForm((current) => ({ ...current, companyAddress: event.target.value }))} /></Field>
          <Field label="封面图" full><input value={form.coverImage} onChange={(event) => setForm((current) => ({ ...current, coverImage: event.target.value }))} /></Field>
          <Field label="门店地址" full><textarea value={form.address} onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))} /></Field>
          <button className="primary-submit" disabled={saving} onClick={handleSave} type="button">{saving ? "保存中..." : "保存门店信息"}</button>
        </div>
      </section>
    </div>
  );
}

function BusinessHoursSettingsPage() {
  const [rows, setRows] = useState([]);
  const [holidayRule, setHolidayRule] = useState({ holidayEnabled: true, holidayHours: "", holidayNote: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadBusinessHours() {
      try {
        setLoading(true);
        const result = await fetchJson("/api/settings/business-hours");
        if (!ignore) {
          setRows(result.rows ?? []);
          setHolidayRule(result.holidayRule ?? { holidayEnabled: true, holidayHours: "", holidayNote: "" });
        }
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadBusinessHours();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setError("");
      setMessage("");
      const result = await fetchJson("/api/settings/business-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, ...holidayRule }),
      });
      setRows(result.rows ?? []);
      setHolidayRule(result.holidayRule ?? holidayRule);
      setMessage("营业时间已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty-card">营业时间加载中...</div>;

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>营业时间</h4>
          <span className="soft-badge">实时保存</span>
        </div>
        <div className="sheet-form compact">
          {rows.map((row, index) => (
            <div key={row.id ?? index} className="settings-inline-card wide">
              <Field label="日期"><input value={row.dayLabel} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, dayLabel: event.target.value } : item))} /></Field>
              <Field label="时间"><input value={row.hoursValue} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, hoursValue: event.target.value } : item))} /></Field>
              <Field label="备注"><input value={row.note} onChange={(event) => setRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, note: event.target.value } : item))} /></Field>
            </div>
          ))}
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>节假日规则</h4>
        </div>
        <div className="sheet-form compact">
          <label className="settings-inline-card">
            <input checked={holidayRule.holidayEnabled} onChange={(event) => setHolidayRule((current) => ({ ...current, holidayEnabled: event.target.checked }))} type="checkbox" />
            <div>
              <strong>启用节假日自动缩短营业</strong>
              <p>保存后立即影响建单页和提醒文案</p>
            </div>
          </label>
          <Field label="节假日营业时间"><input value={holidayRule.holidayHours} onChange={(event) => setHolidayRule((current) => ({ ...current, holidayHours: event.target.value }))} /></Field>
          <Field label="说明文案" full><textarea value={holidayRule.holidayNote} onChange={(event) => setHolidayRule((current) => ({ ...current, holidayNote: event.target.value }))} /></Field>
          <button className="primary-submit" disabled={saving} onClick={handleSave} type="button">{saving ? "保存中..." : "保存营业时间"}</button>
        </div>
      </section>
    </div>
  );
}

function OrderOptionsSettingsPage({ orderFormOptions, refresh }) {
  const [options, setOptions] = useState(orderFormOptions);
  const [brandName, setBrandName] = useState("");
  const [modelBrandId, setModelBrandId] = useState(String(orderFormOptions.brands?.[0]?.id ?? ""));
  const [modelName, setModelName] = useState("");
  const [technicianName, setTechnicianName] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [savingKey, setSavingKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!modelBrandId && options.brands?.length) {
      setModelBrandId(String(options.brands[0].id));
    }
  }, [modelBrandId, options.brands]);

  useEffect(() => {
    let ignore = false;
    async function loadAdminOptions() {
      try {
        const result = await fetchJson("/api/order-form-options/admin");
        if (!ignore) setOptions(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      }
    }
    loadAdminOptions();
    return () => {
      ignore = true;
    };
  }, [orderFormOptions]);

  async function refreshAdminOptions() {
    const [activeResult, adminResult] = await Promise.all([
      refresh(),
      fetchJson("/api/order-form-options/admin"),
    ]);
    setOptions(adminResult);
    return activeResult;
  }

  async function submitOption(type) {
    try {
      setSavingKey(type);
      setError("");
      setMessage("");

      if (type === "brand") {
        await fetchJson("/api/order-form-options/brands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: brandName, market: "Vanuatu" }),
        });
        setBrandName("");
        setMessage("品牌已添加");
      }

      if (type === "model") {
        await fetchJson("/api/order-form-options/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId: Number(modelBrandId), name: modelName }),
        });
        setModelName("");
        setMessage("型号已添加");
      }

      if (type === "technician") {
        await fetchJson("/api/order-form-options/technicians", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: technicianName }),
        });
        setTechnicianName("");
        setMessage("技师已添加");
      }

      if (type === "issue") {
        await fetchJson("/api/order-form-options/issues", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: issueTitle }),
        });
        setIssueTitle("");
        setMessage("默认问题已添加");
      }

        await refreshAdminOptions();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSavingKey("");
    }
  }

  async function updateOption(collection, item, changes) {
    try {
      setSavingKey(`${collection}-${item.id}`);
      setError("");
      setMessage("");
      await fetchJson(`/api/order-form-options/${collection}/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      setMessage("选项已更新");
      await refreshAdminOptions();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSavingKey("");
    }
  }

  async function deleteOption(collection, item) {
    try {
      setSavingKey(`delete-${collection}-${item.id}`);
      setError("");
      setMessage("");
      await fetchJson(`/api/order-form-options/${collection}/${item.id}`, {
        method: "DELETE",
      });
      setMessage("选项已删除");
      await refreshAdminOptions();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSavingKey("");
    }
  }

  const groupedModels = options.brands.map((brand) => ({
    ...brand,
    models: options.models.filter((model) => model.brandId === brand.id),
  }));

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}

      <section className="settings-hero-card">
        <div>
          <span className="micro-label">建单配置</span>
          <h2>建单默认选项</h2>
          <p>直接维护瓦努阿图在售品牌、型号、技师和默认维修问题</p>
        </div>
        <span className="soft-badge">实时写入后台</span>
      </section>

      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>新增品牌</h4>
          <span className="soft-badge">瓦努阿图</span>
        </div>
        <div className="sheet-form compact">
          <Field label="品牌名称" full><input placeholder="例如 Honor" value={brandName} onChange={(event) => setBrandName(event.target.value)} /></Field>
          <button className="primary-submit" disabled={!brandName.trim() || savingKey === "brand"} onClick={() => submitOption("brand")} type="button">
            {savingKey === "brand" ? "保存中..." : "添加品牌"}
          </button>
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>新增型号</h4>
          <span>{options.models.length} 个型号</span>
        </div>
        <div className="sheet-form compact">
          <Field label="所属品牌">
            <select value={modelBrandId} onChange={(event) => setModelBrandId(event.target.value)}>
              <option value="">选择品牌</option>
              {options.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
          </Field>
          <Field label="型号名称">
            <input placeholder="例如 Magic 6" value={modelName} onChange={(event) => setModelName(event.target.value)} />
          </Field>
          <button className="primary-submit" disabled={!modelBrandId || !modelName.trim() || savingKey === "model"} onClick={() => submitOption("model")} type="button">
            {savingKey === "model" ? "保存中..." : "添加型号"}
          </button>
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>技师选项</h4>
          <span>{options.technicians.length} 位</span>
        </div>
        <div className="sheet-form compact">
          <Field label="技师姓名" full><input placeholder="例如 Peter" value={technicianName} onChange={(event) => setTechnicianName(event.target.value)} /></Field>
          <button className="primary-submit" disabled={!technicianName.trim() || savingKey === "technician"} onClick={() => submitOption("technician")} type="button">
            {savingKey === "technician" ? "保存中..." : "添加技师"}
          </button>
          <div className="usage-tags">
            {options.technicians.filter((technician) => technician.isActive).map((technician) => <span key={technician.id} className="soft-badge">{technician.name}</span>)}
          </div>
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>默认维修问题</h4>
          <span>{options.issueTemplates.length} 条</span>
        </div>
        <div className="sheet-form compact">
          <Field label="问题标题" full><input placeholder="例如 无法开机 / 反复重启" value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} /></Field>
          <button className="primary-submit" disabled={!issueTitle.trim() || savingKey === "issue"} onClick={() => submitOption("issue")} type="button">
            {savingKey === "issue" ? "保存中..." : "添加问题"}
          </button>
        </div>
        <div className="options-list order-options-list">
          {options.issueTemplates.map((item) => (
            <div key={item.id} className="settings-inline-card">
              <span className="material-symbols-outlined">build_circle</span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.isActive ? "建单时可直接选择" : "已停用，可恢复"}</p>
              </div>
              <div className="detail-actions-inline">
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("issues", item, { direction: "up" })} type="button">上移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("issues", item, { isActive: !item.isActive })} type="button">{item.isActive ? "停用" : "恢复"}</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => deleteOption("issues", item)} type="button">删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>品牌与型号总览</h4>
          <span>{options.brands.length} 个品牌</span>
        </div>
        <div className="settings-overview-list">
          {groupedModels.map((brand) => (
            <div key={brand.id} className="settings-inline-card wide">
              <div>
                <strong>{brand.name}</strong>
                <p>{brand.market} {brand.isActive ? "" : "· 已停用"}</p>
              </div>
              <div className="detail-actions-inline">
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("brands", brand, { direction: "up" })} type="button">上移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("brands", brand, { isActive: !brand.isActive })} type="button">{brand.isActive ? "停用" : "恢复"}</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("brands", brand, { direction: "down" })} type="button">下移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => deleteOption("brands", brand)} type="button">删除</button>
              </div>
              <div className="usage-tags">
                {brand.models.map((model) => (
                  <span key={model.id} className="soft-badge">
                    {model.name}
                    <button className="inline-chip-button" disabled={!!savingKey} onClick={() => updateOption("models", model, { isActive: !model.isActive })} type="button">{model.isActive ? "停用" : "恢复"}</button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>型号管理</h4>
          <span>{options.models.length} 个型号</span>
        </div>
        <div className="settings-overview-list">
          {options.models.map((model) => (
            <div key={model.id} className="settings-inline-card wide">
              <div>
                <strong>{model.name}</strong>
                <p>{options.brands.find((brand) => brand.id === model.brandId)?.name ?? "未分类品牌"} {model.isActive ? "" : "· 已停用"}</p>
              </div>
              <div className="detail-actions-inline">
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("models", model, { direction: "up" })} type="button">上移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("models", model, { isActive: !model.isActive })} type="button">{model.isActive ? "停用" : "恢复"}</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("models", model, { direction: "down" })} type="button">下移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => deleteOption("models", model)} type="button">删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>技师排序与状态</h4>
        </div>
        <div className="settings-overview-list">
          {options.technicians.map((technician) => (
            <div key={technician.id} className="settings-inline-card wide">
              <div>
                <strong>{technician.name}</strong>
                <p>{technician.isActive ? "建单直接选择" : "已停用，可恢复"}</p>
              </div>
              <div className="detail-actions-inline">
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("technicians", technician, { direction: "up" })} type="button">上移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("technicians", technician, { isActive: !technician.isActive })} type="button">{technician.isActive ? "停用" : "恢复"}</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => updateOption("technicians", technician, { direction: "down" })} type="button">下移</button>
                <button className="small-action-button" disabled={!!savingKey} onClick={() => deleteOption("technicians", technician)} type="button">删除</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SystemSettingsOverviewPage({ customers }) {
  const navigate = useNavigate();
  const storeCards = [
    { icon: "storefront", title: "门店信息", note: "维拉港中心店 (Vila Central)", path: "/settings/store" },
    { icon: "schedule", title: "营业时间", note: "周一至周六 08:00 - 17:30", path: "/settings/business-hours" },
    { icon: "smartphone", title: "建单默认选项", note: "品牌 / 型号 / 技师 / 默认问题", path: "/settings/order-options" },
  ];
  const staffCards = [
    { icon: "badge", title: "员工帐号管理", note: `${customers.length} 人`, path: "/settings/staff-permissions" },
    { icon: "admin_panel_settings", title: "权限等级配置", note: "角色与可见范围", path: "/settings/staff-permissions" },
  ];
  const featureCards = [
    { icon: "print", title: "打印机设置", note: "纸张 / 品牌 / 热敏单", path: "/settings/print", tone: "orange" },
    { icon: "sell", title: "扫描枪设置", note: "自动识别码", path: "/settings/printer-2", tone: "teal" },
  ];

  return (
    <div className="system-settings-overview">
      <section className="system-settings-header">
        <div className="section-title-row slim">
          <h3>系统设置</h3>
          <span className="soft-badge">?</span>
        </div>
      </section>

      <section className="page-section">
        <p className="micro-label">门店管理</p>
        {storeCards.map((card) => (
          <button key={card.title} className="settings-overview-card" onClick={() => navigate(card.path)} type="button">
            <div className="settings-overview-icon"><span className="material-symbols-outlined">{card.icon}</span></div>
            <div>
              <strong>{card.title}</strong>
              <p>{card.note}</p>
            </div>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </section>

      <section className="page-section">
        <p className="micro-label">员工与权限</p>
        {staffCards.map((card) => (
          <button key={card.title} className="settings-overview-card" onClick={() => navigate(card.path)} type="button">
            <div className="settings-overview-icon"><span className="material-symbols-outlined">{card.icon}</span></div>
            <div>
              <strong>{card.title}</strong>
              <p>{card.note}</p>
            </div>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </section>

      <section className="page-section">
        <p className="micro-label">硬件配置</p>
        <div className="settings-feature-grid">
          {featureCards.map((card) => (
            <button key={card.title} className="settings-feature-card" onClick={() => navigate(card.path)} type="button">
              <div className={`settings-overview-icon tone-${card.tone}`}>
                <span className="material-symbols-outlined">{card.icon}</span>
              </div>
              <strong>{card.title}</strong>
              <p>{card.note}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="page-section">
        <p className="micro-label">通用偏好</p>
        <button className="settings-overview-card split" onClick={() => navigate("/settings/language")} type="button">
          <div>
            <strong>系统语言</strong>
            <p>简体中文</p>
          </div>
          <span className="soft-badge">当前</span>
        </button>
        <button className="settings-overview-card split" onClick={() => navigate("/settings/print")} type="button">
          <div>
            <strong>货币显示</strong>
            <p>VUV (瓦图)</p>
          </div>
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </section>

      <section className="page-section">
        <p className="micro-label">安全与维护</p>
        <button className="settings-overview-card split" onClick={() => navigate("/audit-logs")} type="button">
          <div>
            <strong>修改登录密码</strong>
            <p>建议每 90 天更新一次</p>
          </div>
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
        <button className="settings-overview-card split" onClick={() => navigate("/inventory")} type="button">
          <div>
            <strong>在线仓位管理</strong>
            <p>库存、货位、盘点入口</p>
          </div>
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </section>

      <section className="settings-app-card">
        <div className="settings-app-icon"><span className="material-symbols-outlined">verified</span></div>
        <strong>Vila Repair Pro</strong>
        <p>版本 v2.4.0 Stable</p>
      </section>

      <section className="page-section">
        <button className="settings-overview-card split" onClick={() => window.open("https://example.com/terms", "_blank", "noopener")} type="button">
          <div>
            <strong>服务条款</strong>
          </div>
          <span className="material-symbols-outlined">open_in_new</span>
        </button>
        <button className="settings-overview-card split" onClick={() => window.open("https://example.com/privacy", "_blank", "noopener")} type="button">
          <div>
            <strong>隐私政策</strong>
          </div>
          <span className="material-symbols-outlined">open_in_new</span>
        </button>
      </section>

      <button className="settings-logout-button" onClick={() => navigate("/repairs-hub")} type="button">
        <span className="material-symbols-outlined">logout</span>
        <span>退出登录</span>
      </button>
    </div>
  );
}

function LanguageSettingsPage() {
  const [form, setForm] = useState({ primaryLanguage: "zh-CN", externalLanguage: "en", localLanguage: "bi" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function boot() {
      try {
        setLoading(true);
        const result = await fetchJson("/api/settings/language");
        if (!ignore) setForm(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    boot();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setError("");
      setMessage("");
      const result = await fetchJson("/api/settings/language", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm(result);
      setMessage("语言设置已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty-card">语言设置加载中...</div>;

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>语言与地区</h4>
        </div>
        <div className="sheet-form compact">
          <Field label="门店主语言">
            <select value={form.primaryLanguage} onChange={(event) => setForm((current) => ({ ...current, primaryLanguage: event.target.value }))}>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
              <option value="bi">Bislama</option>
            </select>
          </Field>
          <Field label="外部分享语言">
            <select value={form.externalLanguage} onChange={(event) => setForm((current) => ({ ...current, externalLanguage: event.target.value }))}>
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
              <option value="bi">Bislama</option>
            </select>
          </Field>
          <Field label="本地接待语言">
            <select value={form.localLanguage} onChange={(event) => setForm((current) => ({ ...current, localLanguage: event.target.value }))}>
              <option value="bi">Bislama</option>
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </Field>
          <button className="primary-submit" disabled={saving} onClick={handleSave} type="button">{saving ? "保存中..." : "保存语言设置"}</button>
        </div>
      </section>
    </div>
  );
}

function PrintSettingsPage() {
  const [form, setForm] = useState({ paperSize: "58mm", qrEnabled: true, defaultReceiptEnabled: true, footerBrandEnabled: true });
  const [mailForm, setMailForm] = useState({
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "",
    smtpPassword: "",
    smtpFromName: "Vila Port Repair Team",
    smtpFromEmail: "",
    popHost: "",
    popPort: 110,
    popUser: "",
    popPassword: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [mailSaving, setMailSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function boot() {
      try {
        setLoading(true);
        const [printResult, mailResult] = await Promise.all([
          fetchJson("/api/settings/print"),
          fetchJson("/api/settings/mail-server"),
        ]);
        if (!ignore) {
          setForm(printResult);
          setMailForm(mailResult);
        }
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    boot();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setError("");
      setMessage("");
      const result = await fetchJson("/api/settings/print", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setForm(result);
      setMessage("打印设置已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMail() {
    try {
      setMailSaving(true);
      setError("");
      setMessage("");
      const result = await fetchJson("/api/settings/mail-server", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mailForm),
      });
      setMailForm(result);
      setMessage("邮件服务器设置已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setMailSaving(false);
    }
  }

  if (loading) return <div className="empty-card">打印设置加载中...</div>;

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>票据样式</h4>
        </div>
        <div className="print-preview-card">
          <div className="receipt-brand">
            <h2>Vila Port Cyan</h2>
            <p>热敏小票预览</p>
          </div>
          <div className="receipt-divider" />
          <div className="receipt-line-item">
            <span>维修工单</span>
            <strong>RO-88294</strong>
          </div>
          <div className="receipt-line-item">
            <span>纸张规格</span>
            <strong>{form.paperSize}</strong>
          </div>
          <div className="receipt-line-item">
            <span>页尾二维码</span>
            <strong>{form.qrEnabled ? "开启" : "关闭"}</strong>
          </div>
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>打印偏好</h4>
        </div>
        <div className="sheet-form compact">
          <Field label="纸张规格">
            <select value={form.paperSize} onChange={(event) => setForm((current) => ({ ...current, paperSize: event.target.value }))}>
              <option value="58mm">58mm</option>
              <option value="80mm">80mm</option>
            </select>
          </Field>
          <label className="settings-inline-card"><input checked={form.qrEnabled} onChange={(event) => setForm((current) => ({ ...current, qrEnabled: event.target.checked }))} type="checkbox" /><span>客户自助取件码</span></label>
          <label className="settings-inline-card"><input checked={form.defaultReceiptEnabled} onChange={(event) => setForm((current) => ({ ...current, defaultReceiptEnabled: event.target.checked }))} type="checkbox" /><span>默认打印结算单</span></label>
          <label className="settings-inline-card"><input checked={form.footerBrandEnabled} onChange={(event) => setForm((current) => ({ ...current, footerBrandEnabled: event.target.checked }))} type="checkbox" /><span>页脚品牌信息</span></label>
          <button className="primary-submit" disabled={saving} onClick={handleSave} type="button">{saving ? "保存中..." : "保存打印设置"}</button>
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>邮件服务器</h4>
        </div>
        <div className="sheet-form compact">
          <Field label="SMTP 主机"><input value={mailForm.smtpHost} onChange={(event) => setMailForm((current) => ({ ...current, smtpHost: event.target.value }))} /></Field>
          <Field label="SMTP 端口"><input type="number" value={mailForm.smtpPort} onChange={(event) => setMailForm((current) => ({ ...current, smtpPort: Number(event.target.value || 0) }))} /></Field>
          <label className="settings-inline-card"><input checked={mailForm.smtpSecure} onChange={(event) => setMailForm((current) => ({ ...current, smtpSecure: event.target.checked }))} type="checkbox" /><span>SMTP SSL/TLS</span></label>
          <Field label="SMTP 用户"><input value={mailForm.smtpUser} onChange={(event) => setMailForm((current) => ({ ...current, smtpUser: event.target.value }))} /></Field>
          <Field label="SMTP 密码"><input type="password" value={mailForm.smtpPassword} onChange={(event) => setMailForm((current) => ({ ...current, smtpPassword: event.target.value }))} /></Field>
          <Field label="发件人名称"><input value={mailForm.smtpFromName} onChange={(event) => setMailForm((current) => ({ ...current, smtpFromName: event.target.value }))} /></Field>
          <Field label="发件邮箱"><input type="email" value={mailForm.smtpFromEmail} onChange={(event) => setMailForm((current) => ({ ...current, smtpFromEmail: event.target.value }))} /></Field>
          <Field label="POP 主机"><input value={mailForm.popHost} onChange={(event) => setMailForm((current) => ({ ...current, popHost: event.target.value }))} /></Field>
          <Field label="POP 端口"><input type="number" value={mailForm.popPort} onChange={(event) => setMailForm((current) => ({ ...current, popPort: Number(event.target.value || 0) }))} /></Field>
          <Field label="POP 用户"><input value={mailForm.popUser} onChange={(event) => setMailForm((current) => ({ ...current, popUser: event.target.value }))} /></Field>
          <Field label="POP 密码"><input type="password" value={mailForm.popPassword} onChange={(event) => setMailForm((current) => ({ ...current, popPassword: event.target.value }))} /></Field>
          <button className="primary-submit" disabled={mailSaving} onClick={handleSaveMail} type="button">{mailSaving ? "保存中..." : "保存邮件服务器"}</button>
        </div>
      </section>
    </div>
  );
}

function PrinterSettingsPage() {
  const navigate = useNavigate();
  const devices = [
    { name: "POS-58-Thermal", status: "已连接", detail: "蓝牙 | 最后使用 2 分钟前" },
    { name: "Sunmi V2 Pro", status: "可配对", detail: "Wi-Fi | 前台收银台" },
    { name: "Brother QL-820NWB", status: "离线", detail: "标签打印 | 仓库区域" },
  ];

  return (
    <div className="settings-page">
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>打印设备</h4>
          <button className="wide-action primary" onClick={() => navigate("/settings/printer-2")} type="button">重新扫描</button>
        </div>
        <div className="settings-staff-list">
          {devices.map((device) => (
            <div key={device.name} className="printer-device-card">
              <div>
                <strong>{device.name}</strong>
                <p>{device.detail}</p>
              </div>
              <span className={`soft-badge ${device.status === "已连接" ? "" : "secondary"}`}>{device.status}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PrinterPairingPage() {
  const navigate = useNavigate();
  const devices = [
    { name: "Sunmi V2 Pro", code: "P-204", location: "前台收银区", strength: "strong", detail: "蓝牙 5.0 · 58mm Thermal Printer", status: "推荐连接" },
    { name: "POS-58 Mobile", code: "P-118", location: "移动维修台", strength: "medium", detail: "Wi-Fi Direct · Battery 82%", status: "可配对" },
    { name: "Brother QL-820NWB", code: "P-091", location: "库存标签区", strength: "weak", detail: "Network Printer · Label Mode", status: "信号较弱" },
  ];

  return (
    <div className="settings-page printer-pairing-page">
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>可配对设备</h4>
          <span className="soft-badge">3 Devices</span>
        </div>
        <div className="settings-staff-list">
          {devices.map((device, index) => (
            <div key={device.code} className="pairing-device-card">
              <div className="pairing-device-top">
                <div>
                  <strong>{device.name}</strong>
                  <p>{device.code} · {device.location}</p>
                </div>
                <span className={`soft-badge ${index === 0 ? "" : "secondary"}`}>{device.status}</span>
              </div>
              <div className="pairing-device-meta">
                <div>
                  <span>连接模式</span>
                  <strong>{device.detail}</strong>
                </div>
                <div>
                  <span>信号质量</span>
                  <strong>{device.strength === "strong" ? "Excellent" : device.strength === "medium" ? "Good" : "Weak"}</strong>
                </div>
              </div>
              <div className="pairing-device-actions">
                <button className="wide-action secondary" onClick={() => navigate("/settings/print")} type="button">测试打印</button>
                <button className="wide-action primary" onClick={() => navigate("/settings/printer")} type="button">{index === 0 ? "立即配对" : "连接设备"}</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function StaffPermissionsPage() {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState({
    name: "",
    role: "门店成员",
    scope: "前台",
    canEditOrders: true,
    canAdjustInventory: false,
    canViewFinance: false,
    isActive: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadRows() {
    const result = await fetchJson("/api/settings/staff-permissions");
    setRows(result);
  }

  useEffect(() => {
    let ignore = false;
    async function boot() {
      try {
        setLoading(true);
        const result = await fetchJson("/api/settings/staff-permissions");
        if (!ignore) setRows(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    boot();
    return () => {
      ignore = true;
    };
  }, []);

  async function handleCreate() {
    try {
      setSaving("create");
      setError("");
      setMessage("");
      await fetchJson("/api/settings/staff-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      setDraft({
        name: "",
        role: "门店成员",
        scope: "前台",
        canEditOrders: true,
        canAdjustInventory: false,
        canViewFinance: false,
        isActive: true,
      });
      await loadRows();
      setMessage("员工权限已添加");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving("");
    }
  }

  async function handleRowSave(row) {
    try {
      setSaving(String(row.id));
      setError("");
      setMessage("");
      await fetchJson(`/api/settings/staff-permissions/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      await loadRows();
      setMessage("员工权限已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving("");
    }
  }

  async function handleDeleteRow(row) {
    try {
      setSaving(`delete-${row.id}`);
      setError("");
      setMessage("");
      await fetchJson(`/api/settings/staff-permissions/${row.id}`, {
        method: "DELETE",
      });
      await loadRows();
      setMessage("员工权限已删除");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving("");
    }
  }

  if (loading) return <div className="empty-card">员工权限加载中...</div>;

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>新增员工权限</h4>
          <span className="soft-badge">{rows.length} 人</span>
        </div>
        <div className="sheet-form compact">
          <Field label="姓名"><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></Field>
          <Field label="角色"><input value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))} /></Field>
          <Field label="范围"><input value={draft.scope} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))} /></Field>
          <label className="settings-inline-card"><input checked={draft.canEditOrders} onChange={(event) => setDraft((current) => ({ ...current, canEditOrders: event.target.checked }))} type="checkbox" /><span>允许工单编辑</span></label>
          <label className="settings-inline-card"><input checked={draft.canAdjustInventory} onChange={(event) => setDraft((current) => ({ ...current, canAdjustInventory: event.target.checked }))} type="checkbox" /><span>允许库存调整</span></label>
          <label className="settings-inline-card"><input checked={draft.canViewFinance} onChange={(event) => setDraft((current) => ({ ...current, canViewFinance: event.target.checked }))} type="checkbox" /><span>允许查看财务</span></label>
          <button className="primary-submit" disabled={saving === "create" || !draft.name.trim()} onClick={handleCreate} type="button">{saving === "create" ? "保存中..." : "添加员工权限"}</button>
        </div>
      </section>
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>员工权限</h4>
        </div>
        <div className="settings-staff-list">
          {rows.map((row) => (
            <div key={row.id} className="permission-card">
              <div className="permission-row">
                <div className="avatar-circle">{row.name.slice(0, 1)}</div>
                <div>
                  <strong>{row.name}</strong>
                  <p>{row.role}</p>
                </div>
                <span className="soft-badge">{row.scope}</span>
              </div>
              <div className="sheet-form compact">
                <Field label="姓名"><input value={row.name} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, name: event.target.value } : item))} /></Field>
                <Field label="角色"><input value={row.role} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, role: event.target.value } : item))} /></Field>
                <Field label="范围"><input value={row.scope} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, scope: event.target.value } : item))} /></Field>
                <label className="settings-inline-card"><input checked={row.canEditOrders} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, canEditOrders: event.target.checked } : item))} type="checkbox" /><span>工单编辑</span></label>
                <label className="settings-inline-card"><input checked={row.canAdjustInventory} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, canAdjustInventory: event.target.checked } : item))} type="checkbox" /><span>库存调整</span></label>
                <label className="settings-inline-card"><input checked={row.canViewFinance} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, canViewFinance: event.target.checked } : item))} type="checkbox" /><span>财务报表</span></label>
                <label className="settings-inline-card"><input checked={row.isActive} onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, isActive: event.target.checked } : item))} type="checkbox" /><span>启用帐号</span></label>
              </div>
              <div className="detail-actions-inline">
                <button className="primary-submit" disabled={saving === String(row.id)} onClick={() => handleRowSave(row)} type="button">{saving === String(row.id) ? "保存中..." : "保存权限"}</button>
                <button className="small-action-button" disabled={saving === `delete-${row.id}`} onClick={() => handleDeleteRow(row)} type="button">{saving === `delete-${row.id}` ? "删除中..." : "删除员工"}</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReorderSettingsPage({ parts, refresh }) {
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setRows(parts.map((part) => ({
      id: part.id,
      name: part.name,
      stock: part.stock,
      reorderLevel: part.reorderLevel ?? 0,
      supplier: part.supplier ?? "",
    })));
  }, [parts]);

  async function handleSave() {
    try {
      setSaving(true);
      setError("");
      setMessage("");
      await fetchJson("/api/settings/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: rows.map((row) => ({ id: row.id, reorderLevel: Number(row.reorderLevel) })),
        }),
      });
      await refresh();
      setMessage("补货阈值已保存");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-template-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      {error ? <div className="message-banner error">{error}</div> : null}
      <section className="settings-template-section">
        <div className="settings-template-head">
          <h4>补货提醒阈值</h4>
        </div>
        <div className="settings-staff-list">
          {rows.slice(0, 8).map((part) => (
            <div key={part.id} className="reorder-card">
              <div>
                <strong>{part.name}</strong>
                <p>{part.supplier || "配件"} · 当前库存 {part.stock}</p>
              </div>
              <input min="0" type="number" value={part.reorderLevel} onChange={(event) => setRows((current) => current.map((item) => item.id === part.id ? { ...item, reorderLevel: event.target.value } : item))} />
            </div>
          ))}
        </div>
        <button className="primary-submit" disabled={saving} onClick={handleSave} type="button">{saving ? "保存中..." : "保存补货阈值"}</button>
      </section>
    </div>
  );
}

function SupplierManagementPage({ suppliersData }) {
  const navigate = useNavigate();
  const metrics = suppliersData?.metrics;
  const suppliers = suppliersData?.suppliers ?? [];
  const history = suppliersData?.history ?? [];

  return (
    <div className="supplier-template-page">
      <section className="supplier-template-metrics">
        <div className="supplier-template-metric primary"><p>供应商总数</p><strong>{String(metrics?.totalSuppliers ?? 0)}</strong><span>+2 本月</span></div>
        <div className="supplier-template-metric warning"><p>待入库订单</p><strong>{String(metrics?.pendingOrders ?? 0)}</strong><span>需关注</span></div>
        <div className="supplier-template-metric blue"><p>本月采购额</p><strong>{metrics?.procurementValueFormatted ?? "-"}</strong><span>采购总额</span></div>
        <div className="supplier-template-metric success"><p>交付准时率</p><strong>{metrics?.onTimeRate ?? "-"}</strong><span>当前履约</span></div>
      </section>

      <div className="supplier-template-grid">
        <section className="supplier-template-directory">
          <div className="supplier-template-head">
            <h3>主要供应商</h3>
            <button className="link-button" onClick={() => navigate("/quick-order")} type="button">新增供应商</button>
          </div>
          <div className="supplier-template-list">
            {suppliers.map((supplier) => (
              <button key={supplier.id} className="supplier-template-card" onClick={() => navigate(`/supplier-management/${supplier.id}`)} type="button">
                <div className="supplier-template-card-top">
                  <div className="supplier-template-card-main">
                    <div className="supplier-template-card-icon"><span className="material-symbols-outlined">precision_manufacturing</span></div>
                    <div>
                      <h4>{supplier.name}</h4>
                      <div className="supplier-template-contact-row">
                        <span><span className="material-symbols-outlined inline-icon">person</span>{supplier.manager}</span>
                        <span><span className="material-symbols-outlined inline-icon">call</span>{supplier.phone}</span>
                      </div>
                    </div>
                  </div>
                  <span className="supplier-tag">{supplier.tag}</span>
                </div>
                <div className="supplier-template-card-bottom">
                  <div className="supplier-categories">
                    {supplier.categories.map((category) => <span key={category}>{category}</span>)}
                  </div>
                  <span className="material-symbols-outlined customer-chevron">chevron_right</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="supplier-template-history">
          <div className="supplier-template-head">
            <h3>历史订单</h3>
            <button className="link-button" onClick={() => navigate("/inventory/adjustment/requisition")} type="button">查看全部</button>
          </div>
          <div className="supplier-template-history-card">
            {history.map((item) => (
              <button key={item.id} className="supplier-template-history-item" onClick={() => navigate(`/procurements/${item.id}`)} type="button">
                <div>
                  <div className="supplier-history-top">
                    <span className={item.status === "已交付" ? "status-success" : "status-warning"}>{item.status}</span>
                    <span>{item.date}</span>
                  </div>
                  <h4>{item.id}</h4>
                  <p>供应商: {item.supplierName}</p>
                </div>
                <div className="finance-list-right">
                  <strong>{item.amountFormatted}</strong>
                  <span className="inline-link">详情</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function SupplierDetailsPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [supplier, setSupplier] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadSupplier() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/suppliers/${id}`);
        if (!ignore) setSupplier(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    loadSupplier();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">供应商详情加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!supplier) return <div className="empty-card">未找到供应商。</div>;

  return (
    <div className="supplier-detail-template-page">
      <section className="supplier-detail-template-hero">
        <div className="supplier-detail-template-main">
          <div className="supplier-badges">
            <span className="supplier-tag">{supplier.tag}</span>
            <span className="soft-badge">合作 {supplier.yearsOfCooperation} 年</span>
          </div>
          <h2>{supplier.name}</h2>
          <p>{supplier.companyEnglishName}</p>
          <div className="supplier-rating">
            <span className="material-symbols-outlined fill">star</span>
            <span className="material-symbols-outlined fill">star</span>
            <span className="material-symbols-outlined fill">star</span>
            <span className="material-symbols-outlined fill">star</span>
            <span className="material-symbols-outlined fill">star</span>
            <strong>{supplier.rating.toFixed(1)} 评分</strong>
          </div>
          <div className="supplier-detail-template-actions">
            <button className="wide-action primary" onClick={() => navigate("/inventory/inbound")} type="button">快速入库</button>
            <button className="wide-action secondary" onClick={() => navigate(`/procurements/${supplier.recentOrders[0]?.id ?? "PO-20260001"}`)} type="button">最近订单</button>
          </div>
        </div>
        <div className="supplier-detail-template-side">
          <span className="material-symbols-outlined">factory</span>
          <p>制造中心</p>
          <strong>{supplier.city}</strong>
        </div>
      </section>

      <section className="supplier-detail-template-contact-grid">
        <InfoTile label="联系人" value={supplier.manager} />
        <InfoTile label="联系电话" value={supplier.phone} />
        <InfoTile label="电子邮箱" value={supplier.email} />
        <InfoTile label="地址" value={supplier.address} />
      </section>

      <div className="supplier-detail-template-layout">
        <section className="detail-block">
          <div className="detail-block-head">
            <h4>主要供应产品</h4>
            <span className="inline-link">共 {supplier.products.length} 项</span>
          </div>
          <div className="supplier-detail-template-products">
            {supplier.products.map((product) => (
              <button key={product.id} className="supplier-detail-template-product-card" onClick={() => navigate(`/parts/${product.id}`)} type="button">
                <div className="supplier-detail-template-product-image">
                  <span className="material-symbols-outlined">{resolvePartIcon(product.name)}</span>
                </div>
                <div>
                  <strong>{product.name}</strong>
                  <p>SKU: {product.sku}</p>
                </div>
                <div className="supplier-detail-template-product-footer">
                  <span>{product.unitPriceFormatted}</span>
                  <em className={product.needsReorder ? "status-warning" : "status-success"}>{product.stockStatus}</em>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="detail-block">
          <div className="detail-block-head">
            <h4>最近采购订单</h4>
          </div>
          <div className="supplier-detail-template-orders">
            {supplier.recentOrders.map((item) => (
              <button key={item.id} className="supplier-detail-template-order-row" onClick={() => navigate(`/procurements/${item.id}`)} type="button">
                <div>
                  <strong>{item.id}</strong>
                  <p>{item.date}</p>
                </div>
                <div className="finance-list-right">
                  <span className={item.status === "已交付" ? "status-success" : "status-warning"}>{item.status}</span>
                  <strong>{item.amountFormatted}</strong>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      <section className="detail-block supplier-detail-template-note">
        <div className="detail-block-head">
          <h4>内部评估</h4>
        </div>
        <p>{supplier.notes}</p>
      </section>
    </div>
  );
}

function ProcurementDetailsPage() {
  const { id } = useParams();
  const [procurement, setProcurement] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [working, setWorking] = useState(false);
  const [costingSaving, setCostingSaving] = useState(false);
  const [costingForm, setCostingForm] = useState({
    sourceCurrency: "CNY",
    sourceUnitPrice: "",
    exchangeRate: "",
    shippingFee: "",
    customsFee: "",
    otherFee: "",
  });

  const loadProcurement = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const result = await fetchJson(`/api/procurements/${id}`);
      setProcurement(result);
      setCostingForm({
        sourceCurrency: result.costing?.sourceCurrency ?? "CNY",
        sourceUnitPrice: String(result.costing?.sourceUnitPrice ?? ""),
        exchangeRate: String(result.costing?.exchangeRate ?? ""),
        shippingFee: String(result.costing?.shippingFee ?? 0),
        customsFee: String(result.costing?.customsFee ?? 0),
        otherFee: String(result.costing?.otherFee ?? 0),
      });
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadProcurement();
  }, [loadProcurement]);

  async function handleReceive() {
    try {
      setWorking(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/procurements/${id}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      setSuccess(result.alreadyReceived ? "该采购单已入库" : `已完成入库，当前库存 ${result.part.stock} 件`);
      await loadProcurement();
    } catch (receiveError) {
      setError(receiveError.message);
    } finally {
      setWorking(false);
    }
  }

  async function handleSaveCosting() {
    try {
      setCostingSaving(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/procurements/${id}/costing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCurrency: costingForm.sourceCurrency,
          sourceUnitPrice: Number(costingForm.sourceUnitPrice || 0),
          exchangeRate: Number(costingForm.exchangeRate || 1),
          shippingFee: Number(costingForm.shippingFee || 0),
          customsFee: Number(costingForm.customsFee || 0),
          otherFee: Number(costingForm.otherFee || 0),
        }),
      });
      setProcurement(result);
      setSuccess(`成本核算已更新，每件成本 ${result.costing?.landedUnitCostFormatted ?? "-"}`);
    } catch (costingError) {
      setError(costingError.message);
    } finally {
      setCostingSaving(false);
    }
  }

  if (loading) return <div className="empty-card">采购单详情加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!procurement) return <div className="empty-card">未找到采购单。</div>;

  return (
    <div className="procurement-template-page">
      {success ? <div className="message-banner success">{success}</div> : null}
      <section className="procurement-template-hero">
        <div className="procurement-template-main">
          <div className="procurement-template-head">
            <div>
              <p>采购单状态</p>
              <span className={procurement.status === "已交付" ? "status-success" : "status-warning"}>{procurement.statusLabel}</span>
            </div>
            <div className="procurement-id-wrap">
              <p>订单编号</p>
              <strong>{procurement.id}</strong>
            </div>
          </div>
          <div className="procurement-template-meta-grid">
            <div><span>供应商</span><strong>{procurement.supplier?.name ?? "-"}</strong></div>
            <div><span>下单日期</span><strong>{procurement.orderDate}</strong></div>
            <div><span>操作人</span><strong>{procurement.operator}</strong></div>
            <div><span>币种</span><strong>{procurement.currency}</strong></div>
          </div>
        </div>
        <div className="procurement-template-amount">
          <span className="material-symbols-outlined">account_balance_wallet</span>
          <p>总金额</p>
          <strong>{procurement.amountFormatted}</strong>
          <small>{procurement.paymentMethod}</small>
          {procurement.status !== "已交付" ? (
            <button className="wide-action" onClick={handleReceive} type="button" disabled={working}>
              {working ? "Receiving..." : "确认入库"}
            </button>
          ) : null}
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>采购清单</h4>
          <span className="inline-link">{procurement.items.length} 项</span>
        </div>
        <div className="procurement-template-items">
          {procurement.items.map((item) => (
            <div key={item.id} className="procurement-template-item-row">
              <div className="procurement-template-item-image">
                <span className="material-symbols-outlined">{resolvePartIcon(item.name)}</span>
              </div>
              <div className="procurement-template-item-main">
                <strong>{item.name}</strong>
                <p>{item.unitPriceFormatted} / 件</p>
              </div>
              <div className="finance-list-right">
                <span>x{item.quantity}</span>
                <strong>{item.totalAmountFormatted}</strong>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>配件成本核算</h4>
          <strong>{procurement.costing?.landedUnitCostFormatted ?? "-"}/件</strong>
        </div>
        <div className="sheet-grid">
          <Field label="采购币种">
            <select value={costingForm.sourceCurrency} onChange={(event) => setCostingForm((current) => ({ ...current, sourceCurrency: event.target.value }))}>
              <option value="CNY">人民币 CNY</option>
              <option value="VUV">瓦图 VUV</option>
            </select>
          </Field>
          <Field label={costingForm.sourceCurrency === "CNY" ? "采购单价 (人民币/件)" : "采购单价 (VUV/件)"}>
            <input min="0" step="0.01" type="number" value={costingForm.sourceUnitPrice} onChange={(event) => setCostingForm((current) => ({ ...current, sourceUnitPrice: event.target.value }))} />
          </Field>
          <Field label="汇率 (1 人民币 = ? VUV)">
            <input min="0.0001" step="0.0001" type="number" value={costingForm.exchangeRate} onChange={(event) => setCostingForm((current) => ({ ...current, exchangeRate: event.target.value }))} />
          </Field>
          <Field label="物流费用 (VUV)">
            <input min="0" type="number" value={costingForm.shippingFee} onChange={(event) => setCostingForm((current) => ({ ...current, shippingFee: event.target.value }))} />
          </Field>
          <Field label="海关费用 (VUV)">
            <input min="0" type="number" value={costingForm.customsFee} onChange={(event) => setCostingForm((current) => ({ ...current, customsFee: event.target.value }))} />
          </Field>
          <Field label="其他费用 (VUV)">
            <input min="0" type="number" value={costingForm.otherFee} onChange={(event) => setCostingForm((current) => ({ ...current, otherFee: event.target.value }))} />
          </Field>
        </div>
        <div className="procurement-cost-grid">
          <div><span>采购货值</span><strong>{procurement.costing?.sourceCurrency === "CNY" ? procurement.costing?.purchaseAmountCnyFormatted : procurement.costing?.purchaseAmountVuvFormatted}</strong></div>
          <div><span>折合瓦图</span><strong>{procurement.costing?.purchaseAmountVuvFormatted}</strong></div>
          <div><span>附加费用合计</span><strong>{procurement.costing?.extraFeesFormatted}</strong></div>
          <div><span>总落地成本</span><strong>{procurement.costing?.totalLandedCostFormatted}</strong></div>
        </div>
        <div className="action-row">
          <button className="wide-action primary" disabled={costingSaving} onClick={handleSaveCosting} type="button">{costingSaving ? "保存中..." : "保存成本核算"}</button>
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>物流与入库信息</h4>
        </div>
        <div className="procurement-template-logistics-grid">
          <InfoTile label="承运商" value={procurement.delivery.courier} />
          <InfoTile label="物流单号" value={procurement.delivery.trackingNumber} />
          <InfoTile label="到达时间" value={procurement.delivery.deliveryTime} />
        </div>
        <div className="procurement-template-timeline">
          <div className="timeline-step active">
            <span className="material-symbols-outlined">inventory_2</span>
            <div>
              <strong>{procurement.status === "已交付" ? "已入库" : "运输途中"}</strong>
              <p>{procurement.delivery.location}</p>
            </div>
          </div>
          <div className="timeline-step">
            <span className="material-symbols-outlined">local_shipping</span>
            <div>
              <strong>物流签收</strong>
              <p>{procurement.delivery.trackingNumber}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PartDetailsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const { id } = useParams();
  const [part, setPart] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [movementSaving, setMovementSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ reorderLevel: "", unitPrice: "", supplier: "" });
  const [movementForm, setMovementForm] = useState({ movementType: "in", quantity: "1", note: "" });

  const loadPart = useCallback(async (showLoader = true) => {
    try {
      if (showLoader) setLoading(true);
      setError("");
      const result = await fetchJson(`/api/parts/${id}`);
      setPart(result);
      setSettingsForm({
        reorderLevel: String(result.reorderLevel ?? ""),
        unitPrice: String(result.unitPrice ?? ""),
        supplier: result.supplier ?? "",
      });
      return result;
    } catch (partError) {
      setError(partError.message);
      return null;
    } finally {
      if (showLoader) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadPart();
  }, [loadPart]);

  async function handleSaveSettings() {
    try {
      setSaving(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/parts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reorderLevel: Number(settingsForm.reorderLevel || 0),
          unitPrice: Number(settingsForm.unitPrice || 0),
          supplier: settingsForm.supplier,
        }),
      });
      setPart((current) => ({ ...(current ?? {}), ...result }));
      setSuccess("配件资料已更新");
      await loadPart(false);
    } catch (settingsError) {
      setError(settingsError.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReorder() {
    try {
      setReordering(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/parts/${id}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: Math.max(Number(settingsForm.reorderLevel || part?.reorderLevel || 1) * 2, 1) }),
      });
      setSuccess(`已创建采购单 ${result.procurementNo}`);
      await loadPart(false);
    } catch (reorderError) {
      setError(reorderError.message);
    } finally {
      setReordering(false);
    }
  }

  async function handleQuickMovement() {
    try {
      setMovementSaving(true);
      setError("");
      setSuccess("");
      await fetchJson("/api/parts/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partId: Number(id),
          movementType: movementForm.movementType,
          quantity: Number(movementForm.quantity || 0),
          note: movementForm.note || (movementForm.movementType === "in" ? "产品详情页快速入库" : "产品详情页快速出库"),
        }),
      });
      setMovementForm((current) => ({ ...current, quantity: "1", note: "" }));
      setSuccess(movementForm.movementType === "in" ? "已完成快速入库" : "已完成快速出库");
      await loadPart(false);
    } catch (movementError) {
      setError(movementError.message);
    } finally {
      setMovementSaving(false);
    }
  }

  if (loading) return <div className="empty-card">配件详情加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!part) return <div className="empty-card">未找到配件。</div>;
  const partQuery = createPartQuery(part);

  if (!isMobile) {
    return (
      <div className="part-detail-desktop-page">
        {success ? <div className="message-banner success">{success}</div> : null}
        <section className="part-detail-desktop-hero">
          <div className="part-image">
            <span className="material-symbols-outlined">{part.name.toLowerCase().includes("battery") ? "battery_charging_full" : part.name.toLowerCase().includes("screen") || part.name.toLowerCase().includes("display") || part.name.toLowerCase().includes("digitizer") || part.name.toLowerCase().includes("oled") ? "screenshot" : "inventory_2"}</span>
          </div>
          <div className="part-detail-desktop-copy">
            <span className="micro-label">Desktop Part Detail</span>
            <h2>{part.name}</h2>
            <p>SKU: {part.sku} · 供应商: {part.supplier}</p>
          </div>
          <div className="part-detail-desktop-actions">
            <button className="wide-action primary" onClick={() => navigate(`/inventory/inbound${partQuery}`)} type="button">入库登记</button>
            <button className="wide-action secondary" disabled={reordering} onClick={handleReorder} type="button">{reordering ? "创建中..." : "快速补货"}</button>
          </div>
        </section>

        <section className="part-detail-desktop-grid">
          <section className="detail-block">
            <div className="part-stat-grid">
              <div><span>当前库存</span><strong>{part.stock} 件</strong></div>
              <div><span>单价</span><strong>{part.unitPriceFormatted}</strong></div>
              <div><span>成本价</span><strong>{part.costPriceFormatted}</strong></div>
              <div><span>安全阈值</span><strong>{part.reorderLevel} 件</strong></div>
              <div><span>库存状态</span><strong>{part.stockStatus}</strong></div>
              <div><span>库位</span><strong>{part.location}</strong></div>
            </div>
            <div className="sheet-grid">
              <Field label="补货阈值"><input min="0" type="number" value={settingsForm.reorderLevel} onChange={(event) => setSettingsForm((current) => ({ ...current, reorderLevel: event.target.value }))} /></Field>
              <Field label="单价 (VUV)"><input min="0" type="number" value={settingsForm.unitPrice} onChange={(event) => setSettingsForm((current) => ({ ...current, unitPrice: event.target.value }))} /></Field>
              <Field label="供应商" full><input value={settingsForm.supplier} onChange={(event) => setSettingsForm((current) => ({ ...current, supplier: event.target.value }))} /></Field>
            </div>
            <div className="action-row">
              <button className="wide-action secondary" onClick={() => navigate(`/inventory/adjustment${partQuery}`)} type="button">手动调整</button>
              <button className="wide-action primary" disabled={saving} onClick={handleSaveSettings} type="button">{saving ? "保存中..." : "保存库存设置"}</button>
            </div>
          </section>

          <aside className="detail-block">
            <div className="detail-block-head">
              <h4>快速出入库</h4>
            </div>
            <div className="sheet-grid">
              <Field label="操作类型" full>
                <select value={movementForm.movementType} onChange={(event) => setMovementForm((current) => ({ ...current, movementType: event.target.value }))}>
                  <option value="in">入库</option>
                  <option value="out">出库</option>
                </select>
              </Field>
              <Field label="数量"><input min="1" type="number" value={movementForm.quantity} onChange={(event) => setMovementForm((current) => ({ ...current, quantity: event.target.value }))} /></Field>
              <Field label="备注" full><textarea value={movementForm.note} onChange={(event) => setMovementForm((current) => ({ ...current, note: event.target.value }))} /></Field>
            </div>
            <button className="wide-action primary" disabled={movementSaving} onClick={handleQuickMovement} type="button">{movementSaving ? "提交中..." : "确认库存变动"}</button>
          </aside>
        </section>
      </div>
    );
  }

  return (
    <div className="part-detail-page">
      {success ? <div className="message-banner success">{success}</div> : null}
      <section className="part-hero">
        <div className="part-image">
          <span className="material-symbols-outlined">{part.name.toLowerCase().includes("battery") ? "battery_charging_full" : part.name.toLowerCase().includes("screen") || part.name.toLowerCase().includes("display") || part.name.toLowerCase().includes("digitizer") || part.name.toLowerCase().includes("oled") ? "screenshot" : "inventory_2"}</span>
        </div>
        <div className="part-hero-main">
          <span className="customer-pill">产品详情</span>
          <h2>{part.name}</h2>
          <p>SKU: {part.sku} | 供应商: {part.supplier}</p>
          <div className="part-stat-grid">
            <div><span>当前库存</span><strong>{part.stock} 件</strong></div>
            <div><span>单价</span><strong>{part.unitPriceFormatted}</strong></div>
            <div><span>成本价</span><strong>{part.costPriceFormatted}</strong></div>
            <div><span>安全阈值</span><strong>{part.reorderLevel} 件</strong></div>
            <div><span>库存状态</span><strong>{part.stockStatus}</strong></div>
            <div><span>库位</span><strong>{part.location}</strong></div>
            <div><span>周转系数</span><strong>{part.stockTurnover}</strong></div>
          </div>
          <div className="part-hero-actions">
            <button className="wide-action primary" onClick={() => navigate(`/inventory/inbound${partQuery}`)} type="button">入库登记</button>
            <button className="wide-action secondary" onClick={() => navigate(`/inventory/adjustment${partQuery}`)} type="button">手动调整</button>
            <button className="wide-action secondary" onClick={() => navigate(`/inventory/loss${partQuery}`)} type="button">配件报损</button>
            <button className="wide-action secondary" onClick={() => navigate(`/supplier-management/${part.supplierId}`)} type="button">查看供应商</button>
            <button className="wide-action secondary" disabled={reordering} onClick={handleReorder} type="button">{reordering ? "创建中..." : "快速补货"}</button>
          </div>
        </div>
      </section>

      <div className="part-detail-layout">
        <section className="detail-block">
          <div className="detail-block-head">
            <h4>库存设置</h4>
            <strong>{part.stockStatus}</strong>
          </div>
          <div className="sheet-grid">
            <Field label="补货阈值">
              <input min="0" type="number" value={settingsForm.reorderLevel} onChange={(event) => setSettingsForm((current) => ({ ...current, reorderLevel: event.target.value }))} />
            </Field>
            <Field label="单价 (VUV)">
              <input min="0" type="number" value={settingsForm.unitPrice} onChange={(event) => setSettingsForm((current) => ({ ...current, unitPrice: event.target.value }))} />
            </Field>
            <Field label="供应商" full>
              <input value={settingsForm.supplier} onChange={(event) => setSettingsForm((current) => ({ ...current, supplier: event.target.value }))} />
            </Field>
          </div>
          <div className="action-row">
            <button className="wide-action secondary" onClick={() => navigate(`/inventory/audit-session${partQuery}`)} type="button">盘点当前配件</button>
            <button className="wide-action primary" disabled={saving} onClick={handleSaveSettings} type="button">{saving ? "保存中..." : "保存库存设置"}</button>
          </div>
        </section>

        <section className="detail-block">
          <div className="detail-block-head">
            <h4>快速出入库</h4>
            <strong>{movementForm.movementType === "in" ? "入库" : "出库"}</strong>
          </div>
          <div className="sheet-grid">
            <Field label="操作类型" full>
              <select value={movementForm.movementType} onChange={(event) => setMovementForm((current) => ({ ...current, movementType: event.target.value }))}>
                <option value="in">入库</option>
                <option value="out">出库</option>
              </select>
            </Field>
            <Field label="数量">
              <input min="1" type="number" value={movementForm.quantity} onChange={(event) => setMovementForm((current) => ({ ...current, quantity: event.target.value }))} />
            </Field>
            <Field label="备注" full>
              <textarea value={movementForm.note} onChange={(event) => setMovementForm((current) => ({ ...current, note: event.target.value }))} placeholder="例如：门店调拨 / 紧急领用 / 到货入库" />
            </Field>
          </div>
          <div className="action-row">
            <button className="wide-action secondary" onClick={() => navigate(`/inventory/adjustment/requisition${partQuery}`)} type="button">去做领用登记</button>
            <button className="wide-action primary" disabled={movementSaving} onClick={handleQuickMovement} type="button">{movementSaving ? "提交中..." : "确认库存变动"}</button>
          </div>
        </section>

        <section className="detail-block">
          <div className="detail-block-head">
            <h4>最近入库记录</h4>
          </div>
          <div className="page-section">
            {part.movementHistory.map((movement) => (
              <div key={movement.id} className="movement-card">
                <div>
                  <strong>{movement.movementType === "in" ? "入库" : "出库"}</strong>
                  <p>{movement.createdAt}</p>
                </div>
                <span className={movement.movementType === "out" ? "movement-tag out" : "movement-tag in"}>
                  {movement.movementType === "out" ? "-" : "+"}{movement.quantity}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="detail-block">
          <div className="detail-block-head">
            <h4>最近采购单</h4>
          </div>
          <div className="page-section">
            {(part.recentProcurements ?? []).length ? part.recentProcurements.map((procurement) => (
              <button key={procurement.procurementNo} className="movement-card customer-record-button" onClick={() => navigate(`/procurements/${procurement.procurementNo}`)} type="button">
                <div>
                  <strong>{procurement.procurementNo}</strong>
                  <p>{procurement.createdAt} · {procurement.supplier}</p>
                </div>
                <span className="movement-tag in">{procurement.status}</span>
              </button>
            )) : <div className="empty-card">还没有采购记录。</div>}
          </div>
        </section>

        <section className="detail-block">
          <div className="detail-block-head">
            <h4>进货成本记录</h4>
          </div>
          <div className="page-section">
            {(part.inboundBatchHistory ?? []).length ? part.inboundBatchHistory.map((batch) => (
              <div key={`${batch.batchNo}-${batch.createdAt}`} className="movement-card inbound-cost-record">
                <div>
                  <strong>{batch.batchNo}</strong>
                  <p>{batch.createdLabel} · {batch.supplierName || part.supplier}</p>
                  <p>
                    数量 {batch.quantity} 件 · 采购价 {batch.sourceUnitPriceFormatted}
                    {batch.sourceCurrency === "CNY" ? ` · 汇率 ${batch.exchangeRate}` : ""}
                  </p>
                  <p>快递 {batch.shippingFeeFormatted} · 关税 {batch.customsFeeFormatted} · 报关费 {batch.declarationFeeFormatted}</p>
                </div>
                <div className="finance-list-right">
                  <span className="movement-tag in">已入库</span>
                  <strong>{batch.landedUnitCostFormatted}/件</strong>
                </div>
              </div>
            )) : <div className="empty-card">还没有进货成本记录。</div>}
          </div>
        </section>

        <section className="detail-block">
          <div className="detail-block-head">
            <h4>关联维修工单</h4>
          </div>
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>工单编号</th>
                  <th>日期</th>
                  <th>数量</th>
                  <th>消耗金额</th>
                </tr>
              </thead>
              <tbody>
                {part.orderUsage.map((row) => (
                  <tr key={row.orderNo} onClick={() => navigate(`/orders/${row.id}`)} style={{ cursor: "pointer" }}>
                    <td>{row.orderNo}<div className="table-sub">{row.deviceName}</div></td>
                    <td>{row.scheduledDate}</td>
                    <td>{row.quantity}</td>
                    <td>{row.totalAmountFormatted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function CustomerDetailsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const { id } = useParams();
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadCustomer() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/customers/${id}`);
        if (!ignore) setCustomer(result);
      } catch (customerError) {
        if (!ignore) setError(customerError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadCustomer();
    return () => { ignore = true; };
  }, [id]);

  async function handleShareCard() {
    if (!customer) return;
    const cardText = `${customer.name}\n${customer.phone}\n${customer.email ?? ""}\n${customer.address ?? ""}`.trim();

    try {
      setError("");
      setActionMessage("");

      if (navigator.share) {
        await navigator.share({
          title: `${customer.name} 联系方式`,
          text: cardText,
        });
        setActionMessage("名片已打开分享面板");
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(cardText);
        setActionMessage("名片信息已复制");
        return;
      }

      const textarea = document.createElement("textarea");
      textarea.value = cardText;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);

      if (!copied) {
        throw new Error("当前浏览器不支持复制");
      }

      setActionMessage("名片信息已复制");
    } catch (shareError) {
      if (shareError?.name === "AbortError") return;
      setError(shareError.message || "分享名片失败");
    }
  }

  if (loading) return <div className="empty-card">客户详情加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!customer) return <div className="empty-card">未找到客户。</div>;

  const whatsappLink = buildWhatsAppLink(customer.phone);

  if (!isMobile) {
    return (
      <div className="customer-detail-desktop-page">
        {actionMessage ? <div className="message-banner success">{actionMessage}</div> : null}
        <section className="customer-detail-desktop-hero">
          <div className="customer-detail-template-profile">
            <div className="customer-avatar-wrap">
              <CustomerAvatar customer={customer} className="customer-avatar-large" />
            </div>
            <div className="customer-detail-main">
              <div>
                <span className="micro-label">Desktop Customer Detail</span>
                <h2>{customer.name}</h2>
                <p>{formatCustomerTierLabel(customer.tier)}客户 · 注册于 {customer.registeredSince}</p>
              </div>
              <div className="customer-detail-template-contact">
                <div><span className="material-symbols-outlined inline-icon">phone</span>{customer.phone}</div>
                <div><span className="material-symbols-outlined inline-icon">mail</span>{customer.email}</div>
                <div><span className="material-symbols-outlined inline-icon">location_on</span>{customer.address}</div>
              </div>
            </div>
          </div>
          <div className="customer-detail-template-stats">
            <div className="customer-detail-template-stats-top">
              <span>总消费额</span>
              <strong>{customer.customerRank}</strong>
            </div>
            <div>
              <div className="customer-detail-template-total">{customer.lifetimeValueFormatted}</div>
              <p>共 {customer.orderCount} 次维修记录</p>
            </div>
          </div>
        </section>

        <section className="customer-detail-desktop-grid">
          <section className="detail-block">
            <div className="detail-block-head">
              <h4>快捷联系</h4>
            </div>
            <div className="customer-detail-template-quick-grid">
              <button onClick={() => { window.location.href = `tel:${customer.phone}`; }} type="button"><span className="material-symbols-outlined">call</span><span>语音通话</span></button>
              <button onClick={() => { window.location.href = `sms:${customer.phone}`; }} type="button"><span className="material-symbols-outlined">sms</span><span>发送短信</span></button>
              {whatsappLink ? <button onClick={() => { window.open(whatsappLink, "_blank", "noopener,noreferrer"); }} type="button"><span className="material-symbols-outlined">forum</span><span>WhatsApp</span></button> : null}
              <button onClick={() => { window.location.href = `mailto:${customer.email}`; }} type="button"><span className="material-symbols-outlined">mail</span><span>电子邮件</span></button>
              <button onClick={handleShareCard} type="button"><span className="material-symbols-outlined">share</span><span>分享名片</span></button>
            </div>
          </section>

          <section className="detail-block">
            <div className="detail-block-head">
              <h4>历史维修记录</h4>
              <button className="link-button" onClick={() => navigate(`/customers/${customer.id}/history`)} type="button">查看全部</button>
            </div>
            <div className="page-section">
              {customer.records.map((record) => (
                <button key={record.id} className="customer-detail-template-record-card" onClick={() => navigate(`/orders/${getOrderRouteId(record)}`)} type="button">
                  <div className="customer-detail-template-record-left">
                    <div className="customer-detail-template-record-icon">
                      <span className="material-symbols-outlined">{resolveDeviceIcon(record.deviceName)}</span>
                    </div>
                    <div>
                      <div className="customer-detail-template-record-top">
                        <h4>{record.orderNo}</h4>
                        <span className={`status-badge ${record.status}`}>{record.statusMeta.label}</span>
                      </div>
                      <p>{record.scheduledDate} · {record.serviceTag ?? record.title}</p>
                    </div>
                  </div>
                  <div className="customer-detail-template-record-right">
                    <strong>{record.amountFormatted}</strong>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </section>
      </div>
    );
  }

  return (
    <div className="customer-detail-template-page">
      {actionMessage ? <div className="message-banner success">{actionMessage}</div> : null}
      <section className="customer-detail-template-hero">
        <div className="customer-detail-template-profile">
          <div className="customer-avatar-wrap">
            <CustomerAvatar customer={customer} className="customer-avatar-large" />
            <div className="customer-verified-badge">
              <span className="material-symbols-outlined">verified</span>
            </div>
          </div>
          <div className="customer-detail-main">
            <div>
              <h2>{customer.name}</h2>
              <p>{formatCustomerTierLabel(customer.tier)}客户 · 注册于 {customer.registeredSince}</p>
            </div>
            <div className="customer-detail-template-contact">
              <div><span className="material-symbols-outlined inline-icon">phone</span>{customer.phone}</div>
              <div><span className="material-symbols-outlined inline-icon">mail</span>{customer.email}</div>
              <div><span className="material-symbols-outlined inline-icon">location_on</span>{customer.address}</div>
            </div>
          </div>
        </div>

        <div className="customer-detail-template-stats">
          <div className="customer-detail-template-stats-top">
            <span>总消费额</span>
            <strong>{customer.customerRank}</strong>
          </div>
          <div>
            <div className="customer-detail-template-total">{customer.lifetimeValueFormatted}</div>
            <p>共 {customer.orderCount} 次维修记录</p>
          </div>
          <div className="customer-detail-template-actions">
            <button type="button" onClick={() => navigate("/repairs-hub")}>
              <span className="material-symbols-outlined">add</span>
              <span>新建维修</span>
            </button>
            <button type="button" className="secondary-action" onClick={() => navigate(`/customers/${customer.id}/history`)}>
              <span className="material-symbols-outlined">chat</span>
            </button>
          </div>
          <div className="customer-detail-template-vip">
            <span className="material-symbols-outlined">workspace_premium</span>
            <span>前 5% 高价值客户</span>
          </div>
        </div>
      </section>

      <section className="customer-detail-template-quick-grid">
        <button onClick={() => { window.location.href = `tel:${customer.phone}`; }} type="button"><span className="material-symbols-outlined">call</span><span>语音通话</span></button>
        <button onClick={() => { window.location.href = `sms:${customer.phone}`; }} type="button"><span className="material-symbols-outlined">sms</span><span>发送短信</span></button>
        {whatsappLink ? (
          <button onClick={() => { window.open(whatsappLink, "_blank", "noopener,noreferrer"); }} type="button"><span className="material-symbols-outlined">forum</span><span>WhatsApp</span></button>
        ) : null}
        <button onClick={() => { window.location.href = `mailto:${customer.email}`; }} type="button"><span className="material-symbols-outlined">mail</span><span>电子邮件</span></button>
        <button onClick={handleShareCard} type="button"><span className="material-symbols-outlined">share</span><span>分享名片</span></button>
      </section>

      <section className="customer-detail-template-records">
        <div className="customer-detail-template-records-head">
          <h3>历史维修记录</h3>
          <button className="link-button" onClick={() => navigate(`/customers/${customer.id}/history`)} type="button">查看全部</button>
        </div>
        {customer.records.map((record) => (
          <button key={record.id} className="customer-detail-template-record-card" onClick={() => navigate(`/orders/${getOrderRouteId(record)}`)} type="button">
            <div className="customer-detail-template-record-left">
              <div className="customer-detail-template-record-icon">
                <span className="material-symbols-outlined">{resolveDeviceIcon(record.deviceName)}</span>
              </div>
              <div>
                <div className="customer-detail-template-record-top">
                  <h4>{record.orderNo}</h4>
                  <span className={`status-badge ${record.status}`}>{record.statusMeta.label}</span>
                </div>
                <p>{record.scheduledDate} · {record.serviceTag ?? record.title}</p>
              </div>
            </div>
            <div className="customer-detail-template-record-right">
              <strong>{record.amountFormatted}</strong>
              <span className="material-symbols-outlined customer-chevron">chevron_right</span>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}

function MyRepairHistoryPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [followupNote, setFollowupNote] = useState("");
  const [savingFollowup, setSavingFollowup] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadHistory() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/customers/${id}/history`);
        if (!ignore) setHistory(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadHistory();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">维修历史加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!history) return <div className="empty-card">未找到维修历史。</div>;

  const records = history.records.filter((record) => {
    if (filter === "all") return true;
    if (filter === "completed") return record.status === "completed" || record.status === "picked_up";
    return record.status === "in_progress" || record.status === "pending";
  });

  async function handleAddFollowup() {
    const trimmed = followupNote.trim();
    if (!trimmed) {
      setError("请输入回访记录。");
      return;
    }

    try {
      setSavingFollowup(true);
      setError("");
      const created = await fetchJson(`/api/customers/${id}/followups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: trimmed,
          channel: "phone",
          orderId: history.records[0]?.id ?? null,
        }),
      });
      setHistory((current) => ({
        ...current,
        followups: [created, ...(current.followups ?? [])],
      }));
      setFollowupNote("");
    } catch (followupError) {
      setError(followupError.message);
    } finally {
      setSavingFollowup(false);
    }
  }

  return (
    <div className="customer-history-template-page">
      <section className="customer-history-template-head">
        <div className="customer-history-template-search">
          <span className="material-symbols-outlined">search</span>
          <input placeholder="搜索订单号、客户姓名或设备..." readOnly value={history.name} />
        </div>
        <div className="customer-history-template-stats">
          <div className="customer-history-template-stat-primary">
            <p>本月维修总额</p>
            <strong>{history.totalSpendFormatted}</strong>
            <span className="material-symbols-outlined">payments</span>
          </div>
          <div className="customer-history-template-stat-card">
            <p>已完成任务</p>
            <strong>{history.completedOrders}</strong>
          </div>
        </div>
      </section>

      <nav className="customer-history-template-tabs">
        <button className={filter === "all" ? "status-chip active" : "status-chip"} onClick={() => setFilter("all")} type="button">全部</button>
        <button className={filter === "completed" ? "status-chip active" : "status-chip"} onClick={() => setFilter("completed")} type="button">已完成</button>
        <button className={filter === "active" ? "status-chip active" : "status-chip"} onClick={() => setFilter("active")} type="button">进行中</button>
      </nav>

      <section className="customer-history-template-list">
        {records.map((record) => (
          <button key={record.id} className={`customer-history-template-card ${record.status}`} onClick={() => navigate(`/orders/${getOrderRouteId(record)}`)} type="button">
            <div className="customer-history-template-card-top">
              <div>
                <span className="customer-history-template-id">{record.orderNo}</span>
                <h3>{record.deviceName}</h3>
              </div>
              <span className={`status-badge ${record.status}`}>{record.statusMeta.label}</span>
            </div>
            <div className="customer-history-template-meta">
              <div>
                <span className="material-symbols-outlined">build</span>
                <span>{record.serviceTag ?? record.title}</span>
              </div>
              <div>
                <span className="material-symbols-outlined">calendar_today</span>
                <span>{record.scheduledDate}</span>
              </div>
            </div>
            <div className="customer-history-template-foot">
              <div className="customer-history-template-customer">
                <div className="avatar-circle small">{history.name.slice(0, 1)}</div>
                <span>{history.name}</span>
              </div>
              <strong>{record.amountFormatted}</strong>
            </div>
          </button>
        ))}
      </section>

      <section className="customer-history-template-insight">
        <div className="customer-history-template-insight-copy">
          <div className="customer-history-template-insight-tag">
            <span className="material-symbols-outlined">trending_up</span>
            <span>回访洞察</span>
          </div>
          <h4>客户回访记录</h4>
          <p>统一记录售后沟通、满意度反馈和下一次保养提醒。</p>
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>客户回访记录</h4>
          <span>{history.followups?.length ?? 0} 条</span>
        </div>
        <div className="reply-compose-box">
          <textarea onChange={(event) => setFollowupNote(event.target.value)} placeholder="记录一次回访结果..." value={followupNote} />
          <button className="wide-action primary" disabled={savingFollowup} onClick={handleAddFollowup} type="button">{savingFollowup ? "提交中..." : "新增回访"}</button>
        </div>
        <div className="settings-staff-list">
          {(history.followups ?? []).map((item) => (
            <div key={item.id} className="journal-row-card">
              <div className="add-part-thumb"><span className="material-symbols-outlined">{item.channel === "sms" ? "sms" : item.channel === "email" ? "mail" : "call"}</span></div>
              <div className="add-part-content">
                <div className="add-part-head"><strong>{item.orderNo ?? "客户档案"}</strong><span>{item.createdLabel}</span></div>
                <p>{item.note}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <button className="customer-history-template-fab" onClick={() => navigate("/repairs-hub")} type="button">
        <span className="material-symbols-outlined">add</span>
      </button>
    </div>
  );
}

function OrderCommunicationPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadCommunication() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/communication`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadCommunication();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">沟通记录加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到沟通记录。</div>;

  async function handleSend(body = draft) {
    const trimmed = body.trim();

    if (!trimmed) {
      setError("请输入沟通内容。");
      return;
    }

    try {
      setSending(true);
      setError("");
      const created = await fetchJson(`/api/orders/${id}/communication`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: trimmed,
          sender: isInternal ? "internal" : "staff",
        }),
      });

      setData((current) => ({
        ...current,
        messages: [...current.messages, created],
      }));
      setDraft("");
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="communication-template-page">
      <header className="communication-template-header">
        <button className="icon-button" onClick={() => navigate(-1)} type="button"><span className="material-symbols-outlined">arrow_back</span></button>
        <div>
          <strong>{data.orderNo}</strong>
          <span>{data.amountFormatted} 总计</span>
        </div>
        <div className="avatar-circle small">T</div>
      </header>
      <div className="communication-template-feed">
        <div className="day-pill">今天</div>
        {data.messages.map((message) => (
          <div key={message.id} className={`chat-row ${message.sender}`}>
            <div className={`chat-avatar ${message.sender}`}>
              <span className="material-symbols-outlined">{message.sender === "staff" ? "handyman" : message.sender === "internal" ? "lock" : "person"}</span>
            </div>
            <div className="chat-bubble-wrap">
              <div className={`chat-bubble ${message.sender} ${message.type === "note" ? "note" : ""}`}>
                <p>{message.body}</p>
                {message.type === "photos" ? <div className="chat-photo-grid">{message.photos.map((photo, index) => <img key={photo} alt={`chat-${index}`} src={photo} />)}</div> : null}
                {message.type === "voice" ? <div className="voice-bar"><span className="material-symbols-outlined">mic</span><div className="voice-wave" /><strong>{message.duration}</strong></div> : null}
              </div>
              <span className="chat-time">{message.time}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="communication-template-footer">
        <div className="chip-row">
          {data.suggestedReplies.map((chip) => (
            <button key={chip} onClick={() => setDraft(chip)} type="button">{chip}</button>
          ))}
        </div>
        <div className="composer-row">
          <div className="composer-tools">
            <button onClick={() => navigate(`/orders/${id}/photo-upload`)} type="button"><span className="material-symbols-outlined">add_photo_alternate</span></button>
            <button onClick={() => setDraft((current) => `${current}${current ? "\n" : ""}[语音备注] `)} type="button"><span className="material-symbols-outlined">mic</span></button>
          </div>
          <div className="composer-input">
            <textarea onChange={(event) => setDraft(event.target.value)} placeholder={isInternal ? "输入内部备注..." : "输入沟通内容或备注..."} value={draft} />
            <button onClick={() => setIsInternal((current) => !current)} type="button"><span className="material-symbols-outlined">{isInternal ? "lock" : "lock_open"}</span></button>
          </div>
          <button className="composer-send" disabled={sending} onClick={() => handleSend()} type="button"><span className="material-symbols-outlined">send</span></button>
        </div>
      </div>
    </div>
  );
}

function RepairCompletionPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadCompletion() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/completion`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadCompletion();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">完工确认加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到完工记录。</div>;

  function toggleCheck(itemId) {
    setData((current) => ({
      ...current,
      checklist: current.checklist.map((item) => (item.id === itemId ? { ...item, checked: !item.checked } : item)),
    }));
  }

  async function handleConfirm() {
    try {
      setSaving(true);
      setError("");
      await fetchJson(`/api/orders/${id}/completion/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warranty: data.warranty,
          checklist: data.checklist,
          finalNotes: data.finalNotes,
        }),
      });
      navigate("/receipts");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="repair-flow-page">
      <section className="completion-template-summary">
        <div className="completion-template-head">
          <div className="device-icon-box"><span className="material-symbols-outlined">{resolveDeviceIcon(data.deviceName)}</span></div>
          <div>
            <h2>{data.deviceName}</h2>
            <p>#{data.orderNo}</p>
          </div>
        </div>
        <div className="completion-template-cost">
          <span>总费用</span>
          <strong>{data.amountFormatted}</strong>
        </div>
        <div className="completion-warranty">
          <span className="material-symbols-outlined">verified</span>
          <span>{formatWarrantyLabel(data.warranty)}</span>
        </div>
      </section>
      <section className="detail-block">
        <h4>质检清单</h4>
        <div className="completion-checklist">
          {data.checklist.map((item) => (
            <label key={item.id} className="completion-check-item">
              <span>{item.label}</span>
              <input checked={item.checked} onChange={() => toggleCheck(item.id)} type="checkbox" />
            </label>
          ))}
        </div>
      </section>
      <section className="detail-block">
        <h4>技师备注</h4>
        <textarea className="reply-compose-box" onChange={(event) => setData((current) => ({ ...current, finalNotes: event.target.value }))} rows={4} value={data.finalNotes} />
      </section>
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>照片核验</h4>
          <button className="link-button" onClick={() => navigate(`/orders/${id}/photo-upload`)} type="button">继续添加</button>
        </div>
        <div className="completion-photo-grid">
          {data.photos.map((photo) => <img key={photo} alt="completion" src={photo} />)}
          <div className="completion-photo-add"><span className="material-symbols-outlined">add_circle</span></div>
        </div>
      </section>
      <button className="completion-confirm-button" disabled={saving} onClick={handleConfirm} type="button">
        <span>确认并关闭工单</span>
        <span className="material-symbols-outlined">task_alt</span>
      </button>
    </div>
  );
}

function ReceiptPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadReceipt() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/receipt`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReceipt();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">结算单加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到结算单。</div>;

  async function handlePrint() {
    try {
      setWorking(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/orders/${id}/receipt/print`, { method: "POST" });
      setSuccess("小票已进入打印预览");
      setData((current) => ({ ...current, printed: true, printedAt: result.printedAt ?? current?.printedAt ?? null }));
      window.setTimeout(() => window.print(), 120);
    } catch (printError) {
      setError(printError.message);
    } finally {
      setWorking(false);
    }
  }

  async function handlePickup() {
    try {
      setWorking(true);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/orders/${id}/pickup`, { method: "POST" });
      setSuccess(result.message);
      setData((current) => ({ ...current, pickedUp: true }));
    } catch (pickupError) {
      setError(pickupError.message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="receipt-page">
      {success ? <div className="message-banner success">{success}</div> : null}
      <div className="receipt-toolbar">
        <button className="wide-action primary" disabled={working} onClick={handlePrint} type="button">{data.printed ? "重新打印" : "立即打印"}</button>
      </div>
      <div className="receipt-card">
        <div className="receipt-brand">
          <div className="device-icon-box"><span className="material-symbols-outlined">handyman</span></div>
          <h2>VILA PORT 维修中心</h2>
          <p>精修工坊</p>
        </div>
        <div className="receipt-divider" />
        <div className="receipt-meta">
          <div><span>订单号</span><strong>{data.orderNo}</strong></div>
          <div><span>日期</span><strong>{data.date}</strong></div>
          <div><span>客户</span><strong>{data.customerName} ({data.customerPhoneMasked})</strong></div>
        </div>
        <div className="receipt-divider" />
        <div className="receipt-items">
          {data.items.map((item) => (
            <div key={item.name} className="receipt-line-item">
              <div>
                <strong>{item.name}</strong>
                <p>{item.detail}</p>
                <p className="receipt-line-price">{item.amountFormatted}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="receipt-divider" />
        <div className="receipt-totals">
          <div><span>备件费合计</span><strong>{data.partsTotalFormatted}</strong></div>
          <div><span>工费合计</span><strong>{data.laborTotalFormatted}</strong></div>
          <div className="receipt-grand-total"><span>合计金额</span><strong>{data.totalFormatted}</strong></div>
        </div>
        <div className="payment-pill">
          <span className="material-symbols-outlined">payments</span>
          <span>{data.paymentMethod}</span>
        </div>
        <div className="receipt-action-grid">
          <button className="wide-action secondary" onClick={() => navigate(`/orders/${id}/share-report`)} type="button">分享报告</button>
          <button className="wide-action secondary" onClick={() => navigate(`/orders/${id}/send-email`)} type="button">发送邮件</button>
          <button className="wide-action primary" disabled={working || data.pickedUp} onClick={handlePickup} type="button">{data.pickedUp ? "已取机" : "确认取机"}</button>
        </div>
      </div>
    </div>
  );
}

function CompactReceiptSettlementPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedPayment, setSelectedPayment] = useState("现金支付");

  useEffect(() => {
    let ignore = false;
    async function loadReceipt() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id ?? 1}/receipt`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReceipt();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">收银结算页加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到结算数据。</div>;

  const paymentOptions = [
    { label: "现金支付", sub: "现金", icon: "payments", tone: "orange" },
    { label: "银行转账", sub: "银行转账", icon: "account_balance", tone: "blue" },
    { label: "支票支付", sub: "支票", icon: "receipt_long", tone: "purple" },
  ];

  return (
    <div className="compact-settlement-page">
      <div className="detail-topbar compact">
        <button className="icon-button" onClick={() => navigate(-1)} type="button"><span className="material-symbols-outlined">arrow_back_ios_new</span></button>
        <h2>收银结算与打印</h2>
        <span />
      </div>
      <section className="detail-block">
        <p className="micro-label">设备详情</p>
        <div className="compact-settlement-device">
          <div>
            <strong>iPhone 13 Pro</strong>
            <p>序列号: DX3G9L0K8P</p>
            <span className="soft-badge">待支付维修</span>
          </div>
          <img alt="device" src="https://lh3.googleusercontent.com/aida-public/AB6AXuDE_nc43-r-q0wsiq1ZNkorVapOS6wLdNyJEbWAFoAUnZWic7gS5umBvDFxRPHJUp1qI_wHiRou62-kuk_5-nO6w_AX78EFGRS9n_8rLsfx3IGwvuD1HTd8hp8xL3DE6Oeu6jITsfDmGWdh3Vtj75G0hfKZQiBUsY3EZNoy76egO4bybm0ddhpD98ZAZsk9qxGibYjkbeDm0WZZVVX-v6-TEmwSQQ-CeC-Bxkso8ikLwzssGwfjXCZMU81g7W9yzHJ9ZscxoAkK6NJO" />
        </div>
      </section>
      <section className="detail-block">
        <div className="section-title-row slim">
          <h3>费用明细</h3>
          <span>订单号: #{data.orderNo}</span>
        </div>
        {data.items.map((item) => (
          <div key={item.name} className="receipt-line-item settlement">
            <div>
              <strong>{item.name}</strong>
              <p>{item.detail}</p>
            </div>
            <span>{item.amountFormatted}</span>
          </div>
        ))}
        <div className="receipt-divider" />
        <div className="compact-settlement-total">
          <span>应付总额</span>
          <strong>{data.totalFormatted}</strong>
        </div>
      </section>
      <section className="page-section">
        <p className="micro-label">支付方式</p>
        {paymentOptions.map((option) => (
          <button key={option.label} className={`settlement-payment-card ${selectedPayment === option.label ? "active" : ""}`} onClick={() => setSelectedPayment(option.label)} type="button">
            <div className={`settings-overview-icon tone-${option.tone}`}>
              <span className="material-symbols-outlined">{option.icon}</span>
            </div>
            <div>
              <strong>{option.label}</strong>
              <p>{option.sub}</p>
            </div>
            <span className={`payment-radio ${selectedPayment === option.label ? "active" : ""}`} />
          </button>
        ))}
      </section>
      <button className="compact-settlement-submit" onClick={() => window.open(`/api/orders/${id ?? 1}/report.pdf`, "_blank")} type="button">
        <span className="material-symbols-outlined">print</span>
        <span>确认支付并打印</span>
      </button>
      <p className="compact-settlement-note">完成后将自动打印取机单</p>
    </div>
  );
}

function ReceiptCenterPage() {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("全部");

  useEffect(() => {
    let ignore = false;
    async function loadReceipts() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson("/api/receipts");
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReceipts();
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="empty-card">收据中心加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  const visibleItems = data.filter((item) => {
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || item.orderNo.toLowerCase().includes(query) || item.customerName.toLowerCase().includes(query) || item.code.toLowerCase().includes(query);
    const matchesFilter = filter === "全部" || item.type === filter;
    return matchesQuery && matchesFilter;
  });

  return (
    <div className="receipt-center-page">
      <div className="receipt-center-toolbar">
        <button className="wide-action secondary" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出 CSV</button>
      </div>
      <div className="search-panel">
        <span className="material-symbols-outlined search-icon">search</span>
        <input onChange={(event) => setSearch(event.target.value)} placeholder="搜索单号或客户名" value={search} />
      </div>
      <nav className="history-filter-tabs">
        {["全部", "维修工单", "收银收据", "调拨单"].map((item) => (
          <button key={item} className={filter === item ? "status-chip active" : "status-chip"} onClick={() => setFilter(item)} type="button">{item}</button>
        ))}
      </nav>
      <section className="page-section">
        {visibleItems.map((item) => (
          <div key={item.code} className="receipt-center-card">
            <div className="receipt-center-top">
              <div className={`receipt-type-icon ${item.typeTone}`}>
                <span className="material-symbols-outlined">{item.type === "维修工单" ? "build" : item.type === "收银收据" ? "payments" : "sync_alt"}</span>
              </div>
              <div>
                <div className="receipt-center-code">{item.code}</div>
                <p>{item.scheduledDate}</p>
              </div>
              <span className={item.pickedUp ? "status-success" : item.printed ? "status-success" : "status-warning"}>{item.pickedUp ? "已取机" : item.printed ? "已打印" : "待打印"}</span>
            </div>
            <div className="receipt-center-bottom">
              <div>
                <span>{item.metaLabel}</span>
                <strong>{item.metaValue}</strong>
              </div>
              <div className="receipt-center-actions">
                <button onClick={() => navigate(`/orders/${getOrderRouteId(item, "1")}/share-report`)} type="button"><span className="material-symbols-outlined">share</span></button>
                <button className="small-action-button" onClick={() => navigate(`/orders/${getOrderRouteId(item, "1")}/receipt`)} type="button">重新打印</button>
                <button className="small-action-button" onClick={() => navigate(`/orders/${getOrderRouteId(item, "1")}/share-report`)} type="button">PDF</button>
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function ReceiptCenterCompactPage() {
  const navigate = useNavigate();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadReceipts() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson("/api/receipts");
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReceipts();
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="empty-card">紧凑收据中心加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  return (
    <div className="receipt-center-page compact">
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>收据中心</h4>
          <button className="wide-action secondary" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出</button>
        </div>
        <div className="settings-staff-list">
          {data.map((item) => (
            <div key={item.code} className="receipt-center-card compact">
              <div className="receipt-center-top">
                <div className={`receipt-type-icon ${item.typeTone}`}>
                  <span className="material-symbols-outlined">{item.type === "维修工单" ? "receipt_long" : item.type === "收银收据" ? "payments" : "inventory_2"}</span>
                </div>
                <div>
                  <div className="receipt-center-code">{item.code}</div>
                  <p>{item.type} · {item.scheduledDate}</p>
                </div>
                <span className={item.printed ? "status-success" : "status-warning"}>{item.printed ? "已打印" : "待处理"}</span>
              </div>
              <div className="receipt-center-bottom">
                <div>
                  <span>{item.metaLabel}</span>
                  <strong>{item.metaValue}</strong>
                </div>
                <button className="receipt-center-button" onClick={() => navigate(`/orders/${getOrderRouteId(item, "1")}/receipt`)} type="button">打开</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PhotoUploadPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadPhotos() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/photo-upload`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadPhotos();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">上传页加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到照片数据。</div>;

  function addMockPhoto() {
    setData((current) => {
      const nextPhotos = [`https://picsum.photos/seed/repair-${id}-${current.photos.length + 1}/800/600`, ...current.photos].slice(0, current.maxCount);
      return {
        ...current,
        photos: nextPhotos,
        selectedCount: nextPhotos.length,
      };
    });
  }

  async function handleUploadConfirm() {
    try {
      setSaving(true);
      setError("");
      await fetchJson(`/api/orders/${id}/photo-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photos: data.photos.map((photo, index) => ({
            imageUrl: photo,
            stage: "维修后",
            note: index === 0 ? "维修完成后拍照留档。" : "补充上传的维修记录照片。",
          })),
        }),
      });
      navigate(`/orders/${id}/photo-archive`);
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="photo-upload-page">
      <section className="upload-info-banner">
        <span className="material-symbols-outlined">info</span>
        <div>
          <strong>上传维修照片</strong>
          <p>请上传 3-5 张清晰的维修前后对比照片</p>
        </div>
      </section>
      <section className="upload-action-grid">
        <button onClick={addMockPhoto} type="button"><span className="material-symbols-outlined">photo_camera</span><span>拍照</span></button>
        <button onClick={addMockPhoto} type="button"><span className="material-symbols-outlined">collections</span><span>从相册选择</span></button>
      </section>
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>已选照片 ({data.selectedCount}/{data.maxCount})</h4>
          <span className="inline-link">维修上下文已启用</span>
        </div>
        <div className="upload-photo-grid">
          {data.photos.map((photo) => (
            <div key={photo} className="upload-photo-card">
              <img alt="upload" src={photo} />
              <button className="upload-delete" onClick={() => setData((current) => {
                const nextPhotos = current.photos.filter((item) => item !== photo);
                return { ...current, photos: nextPhotos, selectedCount: nextPhotos.length };
              })} type="button"><span className="material-symbols-outlined">close</span></button>
              <button className="upload-edit" onClick={() => navigate(`/orders/${id}/photo-archive`)} type="button"><span className="material-symbols-outlined">edit_note</span><span>编辑</span></button>
            </div>
          ))}
          <button className="upload-add-card" onClick={addMockPhoto} type="button"><span className="material-symbols-outlined">add_a_photo</span><span>继续添加</span></button>
        </div>
      </section>
      <div className="upload-bottom-bar">
        <button onClick={() => navigate(-1)} type="button"><span className="material-symbols-outlined">close</span><span>取消</span></button>
        <button className="active" disabled={saving} onClick={handleUploadConfirm} type="button"><span className="material-symbols-outlined">check_circle</span><span>{saving ? "上传中..." : "确认上传"}</span></button>
      </div>
    </div>
  );
}

function RepairPhotoArchivePage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadArchive() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/photo-archive`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadArchive();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">照片归档加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到照片归档。</div>;

  return (
    <div className="archive-template-page">
      <section className="archive-template-header">
        <div>
          <span className="soft-badge">当前工单</span>
          <h2>{data.deviceName}</h2>
          <p>客户: {data.customerName ?? "-"}</p>
        </div>
        <button className="wide-action primary" onClick={() => navigate(`/orders/${id}/photo-upload`)} type="button">添加照片</button>
      </section>
      {data.sections.map((section, index) => (
        <section key={section.title} className="archive-template-section">
          <div className={`archive-template-title ${index === 0 ? "danger" : index === 1 ? "warning" : "success"}`}>
            <span className="material-symbols-outlined">{index === 0 ? "history" : index === 1 ? "construction" : "verified"}</span>
            <h3>{section.title}</h3>
          </div>
          <div className="archive-template-grid">
            {section.photos.map((photo) => (
              <div key={photo.image} className="archive-template-card">
                <img alt={section.title} src={photo.image} />
                <div className="archive-template-note">
                  <p className="micro-label">Technician Note</p>
                  <strong>{photo.note}</strong>
                  <span>{photo.time}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function RepairPhotoArchiveCompactPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadArchive() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/photo-archive`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadArchive();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">紧凑照片归档加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到照片归档。</div>;

      return (
    <div className="archive-page compact">
      <section className="archive-summary-card">
        <div className="archive-summary-top">
          <div>
            <span>归档总览</span>
            <h2>#{data.orderNo}</h2>
          </div>
          <span className="status-success">{data.statusLabel}</span>
        </div>
        <div className="archive-summary-meta">
          <div><span>分组数</span><strong>{data.sections.length}</strong></div>
          <div><span>设备</span><strong>{data.deviceName}</strong></div>
        </div>
      </section>
      <section className="page-section">
        {data.sections.flatMap((section) => section.photos.slice(0, 1).map((photo) => (
          <div key={`${section.title}-${photo.image}`} className="archive-photo-card compact">
            <img alt={section.title} src={photo.image} />
            <div className="archive-photo-note">
              <div>
                <p className="micro-label">{section.title}</p>
                <strong>{photo.note}</strong>
                <span>{photo.time}</span>
              </div>
              <button className="small-action-button" onClick={() => navigate(`/orders/${id}/photo-archive`)} type="button">查看全部</button>
            </div>
          </div>
        )))}
      </section>
    </div>
  );
}

function PdfReportPreviewPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadShare() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/share-report`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadShare();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">PDF 预览加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到报告内容。</div>;

  return (
    <div className="pdf-variant-page">
      <section className="pdf-preview-card">
        <div className="pdf-preview-header">
          <span>PDF 预览</span>
          <strong>模板方案 1</strong>
        </div>
        <div className="pdf-preview-body">
          <div className="pdf-preview-brand">
            <div>
              <h2>{data.fileName}</h2>
              <p>{data.customerName}</p>
            </div>
            <div className="pdf-preview-ref">
              <span>工单编号</span>
              <strong>{data.orderNo}</strong>
            </div>
          </div>
          <div className="receipt-divider" />
          <div className="pdf-preview-lines">
            {data.previewItems.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.amountFormatted}</strong>
              </div>
            ))}
          </div>
          <div className="pdf-preview-total">
            <span>应付总额</span>
            <strong>{data.totalFormatted}</strong>
          </div>
        </div>
      </section>
      <div className="selection-bottom-bar">
        <button className="wide-action secondary" onClick={() => window.open(`/api/orders/${id}/report.pdf`, "_blank")} type="button">下载 PDF</button>
        <button className="wide-action primary" onClick={() => navigate(`/orders/${id}/pdf-report-2`)} type="button">继续发送</button>
      </div>
    </div>
  );
}

function PdfReportDeliveryPage() {
  const navigate = useNavigate();
  const { id } = useParams();

  return (
    <div className="pdf-variant-page delivery">
      <section className="detail-block">
        <div className="detail-block-head">
          <h4>交付方式</h4>
          <span className="soft-badge">PDF 方案 2</span>
        </div>
        <div className="profile-menu">
          <button onClick={() => navigate(`/orders/${id}/send-email`)} type="button">
            <span className="material-symbols-outlined">mail</span>
            <span>发送到邮箱</span>
          </button>
          <button onClick={() => navigate(`/orders/${id}/whatsapp-share`)} type="button">
            <span className="material-symbols-outlined">forum</span>
            <span>发送到 WhatsApp</span>
          </button>
          <button onClick={() => navigate(`/orders/${id}/share-report`)} type="button">
            <span className="material-symbols-outlined">ios_share</span>
            <span>打开分享面板</span>
          </button>
        </div>
      </section>
      <section className="detail-block">
        <div className="pdf-file-card">
          <div>
            <span>输出文件</span>
            <strong>维修报告-{id}.pdf</strong>
          </div>
          <div className="pdf-file-meta">
            <div><span>状态</span><strong>可立即交付</strong></div>
            <div><span>格式</span><strong>PDF / A4</strong></div>
          </div>
        </div>
      </section>
      <div className="selection-bottom-bar">
        <button className="wide-action secondary" onClick={() => navigate(`/orders/${id}/pdf-report-1`)} type="button">返回预览</button>
        <button className="wide-action primary" onClick={() => window.open(`/api/orders/${id}/report.pdf`, "_blank")} type="button">立即导出</button>
      </div>
    </div>
  );
}

function ShareReportPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadShare() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/share-report`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadShare();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">报告预览加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到报告。</div>;

  return (
    <div className="share-report-page">
      <section className="pdf-preview-card">
        <div className="pdf-preview-header">
          <span>文档预览</span>
          <strong>第 1 页 / 共 1 页</strong>
        </div>
        <div className="pdf-preview-body">
          <div className="pdf-preview-brand">
            <div className="supplier-icon"><span className="material-symbols-outlined">cell_tower</span></div>
            <div>
              <h2>维拉港维修中心</h2>
              <p>维拉港 · 瓦努阿图</p>
            </div>
            <div className="pdf-preview-ref">
              <span>维修报告</span>
              <strong>编号: {data.orderNo}</strong>
            </div>
          </div>
          <div className="receipt-divider" />
          <div className="pdf-preview-section">
            <span>客户信息</span>
            <strong>{data.customerName}</strong>
          </div>
          <div className="pdf-preview-lines">
            {data.previewItems.map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.amountFormatted}</strong>
              </div>
            ))}
          </div>
          <div className="pdf-preview-total">
            <span>应付总额</span>
            <strong>{data.totalFormatted}</strong>
          </div>
        </div>
      </section>

      <section className="detail-block">
        <div className="detail-block-head">
          <h4>文件信息</h4>
        </div>
        <div className="pdf-file-card">
          <div>
            <span>文件名</span>
            <strong>{data.fileName}</strong>
          </div>
          <div className="pdf-file-meta">
            <div><span>大小</span><strong>{data.fileSize}</strong></div>
            <div><span>创建时间</span><strong>{data.createdDate}</strong></div>
          </div>
        </div>
      </section>

      <section className="share-actions">
        <button className="whatsapp-button" onClick={() => navigate(`/orders/${id}/whatsapp-share`)} type="button">通过 WhatsApp 分享</button>
        <button className="wide-action primary" onClick={() => navigate(`/orders/${id}/send-email`)} type="button">邮件发送</button>
        <button className="wide-action secondary" onClick={() => window.open(`/api/orders/${id}/report.pdf`, "_blank")} type="button">下载 PDF</button>
      </section>
    </div>
  );
}

function WhatsAppSharePage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadShare() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/share-report`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadShare();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">WhatsApp 分享加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到分享内容。</div>;

  const shareText = [
    `维修报告 ${data.orderNo}`,
    `客户: ${data.customerName}`,
    `备件费用: ${data.partsTotalFormatted ?? "-"}`,
    `工费: ${data.laborTotalFormatted ?? "-"}`,
    `总金额: ${data.totalFormatted}`,
    `PDF: ${window.location.origin}/api/orders/${id}/report.pdf`,
  ].join("\n");

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  async function handleNativeShare() {
    try {
      setMessage("");
      if (navigator.share) {
        await navigator.share({
          title: `维修报告 ${data.orderNo}`,
          text: shareText,
          url: `${window.location.origin}/api/orders/${id}/report.pdf`,
        });
        setMessage("已打开系统分享面板。");
        return;
      }

      await navigator.clipboard.writeText(shareText);
      setMessage("分享内容已复制，可直接粘贴到 WhatsApp。");
    } catch (shareError) {
      setMessage(shareError?.message || "分享失败，请稍后重试。");
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareText);
      setMessage("内容已复制，可直接粘贴到 WhatsApp。");
    } catch (copyError) {
      setMessage(copyError?.message || "复制失败，请稍后重试。");
    }
  }

  return (
    <div className="share-report-page">
      {message ? <div className="message-banner success">{message}</div> : null}
      <section className="pdf-preview-card">
        <div className="pdf-preview-header">
          <span>WhatsApp 分享</span>
          <strong>{data.orderNo}</strong>
        </div>
        <div className="pdf-preview-body">
          <div className="pdf-preview-brand">
            <div className="supplier-icon"><span className="material-symbols-outlined">forum</span></div>
            <div>
              <h2>分享给客户</h2>
              <p>{data.customerName}</p>
            </div>
          </div>
          <div className="receipt-divider" />
          <div className="pdf-preview-lines">
            <div><span>备件费用</span><strong>{data.partsTotalFormatted ?? "-"}</strong></div>
            <div><span>工费</span><strong>{data.laborTotalFormatted ?? "-"}</strong></div>
            <div><span>总金额</span><strong>{data.totalFormatted}</strong></div>
          </div>
          <div className="detail-block" style={{ marginTop: 16 }}>
            <div className="detail-block-head">
              <h4>消息预览</h4>
            </div>
            <pre className="share-message-preview">{shareText}</pre>
          </div>
        </div>
      </section>

      <section className="share-actions">
        <button className="whatsapp-button" onClick={() => window.open(whatsappUrl, "_blank", "noopener,noreferrer")} type="button">打开 WhatsApp</button>
        <button className="wide-action primary" onClick={handleNativeShare} type="button">系统分享</button>
        <button className="wide-action secondary" onClick={handleCopy} type="button">复制内容</button>
        <button className="wide-action secondary" onClick={() => navigate(`/orders/${id}/share-report`)} type="button">返回预览</button>
      </section>
    </div>
  );
}

function SendEmailReportPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sendState, setSendState] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadEmail() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/orders/${id}/email-report`);
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadEmail();
    return () => { ignore = true; };
  }, [id]);

  if (loading) return <div className="empty-card">邮件发送页加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;
  if (!data) return <div className="empty-card">未找到邮件内容。</div>;

  async function handleSend() {
    try {
      setError("");
      setSendState("");
      const result = await fetchJson(`/api/orders/${id}/email-report/send`, { method: "POST" });
      setSendState(result.message);
    } catch (sendError) {
      setError(sendError.message);
    }
  }

  return (
    <div className="email-report-page">
      {sendState ? <div className="message-banner success">{sendState}</div> : null}
      <div className="email-form">
        <label className="email-field">
          <span>收件人</span>
          <input readOnly type="email" value={data.recipient} />
        </label>
        <label className="email-field">
          <span>主题</span>
          <input readOnly type="text" value={data.subject} />
        </label>
        <label className="email-field">
          <span>正文</span>
          <textarea readOnly rows="12" value={data.message} />
        </label>
        <div className="email-attachment-card">
          <div className="supplier-icon"><span className="material-symbols-outlined">description</span></div>
          <div>
            <strong>{data.attachmentName}</strong>
            <p>{data.attachmentSize} · 80mm 小票 PDF</p>
          </div>
        </div>
        <div className="detail-block">
          <div className="detail-block-head">
            <h4>邮件服务器状态</h4>
          </div>
          <span className={data.mailServerConfigured ? "status-success" : "status-warning"}>
            {data.mailServerConfigured ? "SMTP 已配置，可直接发送" : "未配置 SMTP，请先去打印设置填写邮件服务器"}
          </span>
        </div>
      </div>
      <div className="email-bottom-bar">
        <button className="wide-action primary" disabled={!data.mailServerConfigured} onClick={handleSend} type="button">发送邮件</button>
        <button className="composer-send" onClick={() => window.open(`/api/orders/${id}/report.pdf`, "_blank")} type="button"><span className="material-symbols-outlined">attach_file</span></button>
      </div>
    </div>
  );
}

function LowStockAlertsPage({ dashboard, refresh }) {
  const navigate = useNavigate();
  const lowStockParts = dashboard?.lowStockParts ?? [];
  const criticalCount = lowStockParts.filter((part) => part.stock <= 2).length;
  const lowCount = lowStockParts.filter((part) => part.stock > 2).length;
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [workingId, setWorkingId] = useState(null);

  async function handleReorder(part) {
    try {
      setWorkingId(part.id);
      setError("");
      setSuccess("");
      const result = await fetchJson(`/api/parts/${part.id}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: Math.max(part.reorderLevel * 2, 1) }),
      });
      setSuccess(`已创建采购单 ${result.procurementNo}`);
      await refresh();
    } catch (reorderError) {
      setError(reorderError.message);
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <div className="inventory-alert-template-page">
      {error ? <div className="message-banner error">{error}</div> : null}
      {success ? <div className="message-banner success">{success}</div> : null}
      <section className="inventory-alert-template-summary">
        <div className="alert-summary-card">
          <span>紧急预警</span>
          <div><strong className="text-danger">{String(criticalCount).padStart(2, "0")}</strong><small>需立即处理</small></div>
        </div>
        <div className="alert-summary-card">
          <span>低库存</span>
          <div><strong className="text-warning">{String(lowCount).padStart(2, "0")}</strong><small>建议补货</small></div>
        </div>
      </section>

      <section className="inventory-alert-template-list">
        {lowStockParts.map((part) => {
          const critical = part.stock <= 2;
          const percent = Math.min(100, Math.round((part.stock / Math.max(part.reorderLevel, 1)) * 100));
          return (
            <div key={part.id} className="stock-alert-card inventory-alert-template-card">
              <div className={critical ? "stock-alert-bar critical" : "stock-alert-bar low"} />
              <div className="stock-alert-body">
                <div className="stock-alert-head">
                  <div>
                    <h3>{part.name}</h3>
                    <p>SKU: {part.sku}</p>
                  </div>
                  <span className={critical ? "critical-badge" : "warning-badge"}>{critical ? "紧急" : "低库存"}</span>
                </div>
                <div className="progress-meta">
                  <span>库存: {part.stock} 件</span>
                  <span>目标: {part.reorderLevel}</span>
                </div>
                <div className="progress-bar"><div className={critical ? "progress-danger" : "progress-warning"} style={{ width: `${percent}%` }} /></div>
                <div className="inventory-alert-template-actions">
                  <button className="wide-action secondary" onClick={() => navigate(`/parts/${part.id}`)} type="button">查看详情</button>
                  <button className="wide-action primary" disabled={workingId === part.id} onClick={() => handleReorder(part)} type="button">{workingId === part.id ? "创建中..." : "创建采购单"}</button>
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function TechnicianPerformancePage({ staffPerformance }) {
  const rows = staffPerformance?.rows ?? [];
  const top = staffPerformance?.topPerformer;

  return (
    <>
      <section className="tech-kpi-grid">
        <MetricTile label="总订单数" value={rows.reduce((sum, row) => sum + row.completedOrders, 0)} icon="inventory_2" tone="primary" />
        <MetricTile label="平均耗时" value={formatMinutesLabel(Math.round(rows.reduce((sum, row) => sum + row.avgRepairMinutes, 0) / Math.max(rows.length, 1)))} icon="schedule" tone="warning" />
        <MetricTile label="总营收" value={top?.totalRevenueFormatted ?? "-"} icon="payments" tone="primary" />
        <MetricTile label="满意度" value={top ? `${top.rating}` : "-"} icon="star" tone="warning" />
      </section>

      <section className="page-section">
        <div className="section-title-row">
          <h3>技师绩效排行</h3>
        </div>
        {rows.map((row) => (
          <div key={row.staffId} className={`tech-card ${row.rank === 1 ? "top-rank" : ""}`}>
            <div className="tech-rank">{row.rank}</div>
            <div className="tech-avatar">{row.staffName.slice(0, 1)}</div>
            <div className="tech-main">
              <h4>{row.staffName}</h4>
              <p>{row.rank === 1 ? "高级认证专家" : "维修技师"}</p>
            </div>
            <div className="tech-stats">
              <div><span>完工单</span><strong>{row.completedOrders}</strong></div>
              <div><span>平均耗时</span><strong>{formatMinutesLabel(row.avgRepairMinutes)}</strong></div>
              <div><span>营收</span><strong>{row.totalRevenueFormatted}</strong></div>
            </div>
            <span className="material-symbols-outlined tech-chevron">chevron_right</span>
          </div>
        ))}
      </section>
    </>
  );
}

function CreateQuotePage({ customers, parts, orderFormOptions }) {
  const navigate = useNavigate();
  const [customerOptions, setCustomerOptions] = useState(customers);
  const [draft, setDraft] = useState(() => createQuoteDraft(customers, parts, orderFormOptions));
  const [storeSettings, setStoreSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", email: "", address: "" });

  useEffect(() => {
    setCustomerOptions(customers);
  }, [customers]);

  useEffect(() => {
    let active = true;
    fetchJson("/api/settings/store")
      .then((result) => {
        if (!active) return;
        setStoreSettings(result);
        setDraft((current) => ({
          ...current,
          taxInclusive: result?.quoteTaxInclusive !== false,
        }));
      })
      .catch(() => {
        // keep local default when settings cannot be loaded
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setDraft((current) => {
      if (current.customerId || !customerOptions.length) return current;
      return {
        ...createQuoteDraft(customerOptions, parts, orderFormOptions),
        taxInclusive: storeSettings?.quoteTaxInclusive !== false,
      };
    });
  }, [customerOptions, parts, orderFormOptions, storeSettings]);

  const selectedCustomer = customerOptions.find((item) => String(item.id) === String(draft.customerId));
  const availableModels = useMemo(
    () => orderFormOptions.models.filter((model) => String(model.brandId) === String(draft.brandId)),
    [draft.brandId, orderFormOptions.models],
  );
  const selectedBrand = useMemo(
    () => orderFormOptions.brands.find((brand) => String(brand.id) === String(draft.brandId)) ?? null,
    [draft.brandId, orderFormOptions.brands],
  );
  const selectedModel = useMemo(
    () => orderFormOptions.models.find((model) => String(model.id) === String(draft.modelId)) ?? null,
    [draft.modelId, orderFormOptions.models],
  );
  const subtotal = draft.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const totalItems = draft.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

  function updateItem(index, patch) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    }));
  }

  function addItem() {
    const candidate = parts.find((part) => !draft.items.some((item) => String(item.partId) === String(part.id)));
    setDraft((current) => ({
      ...current,
      items: [
        ...current.items,
        candidate
          ? {
            itemType: "part",
            partId: String(candidate.id),
            name: candidate.name,
            description: "报价配件",
            quantity: 1,
            unitPrice: Number(candidate.unitPrice ?? 0),
          }
          : {
            itemType: "labor",
            partId: "",
            name: "人工服务",
            description: "维修工费",
            quantity: 1,
            unitPrice: 0,
          },
      ],
    }));
  }

  function removeItem(index) {
    setDraft((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function handleCreateCustomer() {
    try {
      setCreatingCustomer(true);
      setError("");
      const created = await fetchJson("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newCustomer),
      });
      setCustomerOptions((current) => [created, ...current]);
      setDraft((current) => ({
        ...current,
        customerId: String(created.id),
        customerName: created.name,
        customerPhone: created.phone ?? "",
        customerEmail: created.email ?? "",
      }));
      setNewCustomer({ name: "", phone: "", email: "", address: "" });
    } catch (createError) {
      setError(createError.message);
    } finally {
      setCreatingCustomer(false);
    }
  }

  function updateBrand(brandId) {
    const firstModel = orderFormOptions.models.find((model) => String(model.brandId) === String(brandId));
    const brand = orderFormOptions.brands.find((item) => String(item.id) === String(brandId));
    setDraft((current) => ({
      ...current,
      brandId,
      modelId: String(firstModel?.id ?? ""),
      deviceName: [brand?.name, firstModel?.name].filter(Boolean).join(" "),
    }));
  }

  function updateModel(modelId) {
    const model = orderFormOptions.models.find((item) => String(item.id) === String(modelId));
    setDraft((current) => ({
      ...current,
      modelId,
      deviceName: [selectedBrand?.name, model?.name].filter(Boolean).join(" "),
    }));
  }

  function updateIssueTemplate(issueTemplateId) {
    const template = orderFormOptions.issueTemplates.find((item) => String(item.id) === String(issueTemplateId));
    setDraft((current) => ({
      ...current,
      issueTemplateId,
      serviceType: template?.title ?? "",
    }));
  }

  async function handleSubmit() {
    try {
      setSaving(true);
      setError("");
      const payload = {
        ...draft,
        customerId: draft.customerId ? Number(draft.customerId) : null,
        customerName: selectedCustomer?.name ?? draft.customerName,
        customerPhone: selectedCustomer?.phone ?? draft.customerPhone,
        customerEmail: selectedCustomer?.email ?? draft.customerEmail,
        taxInclusive: draft.taxInclusive !== false,
        items: draft.items.map((item) => ({
          itemType: item.itemType,
          partId: item.partId ? Number(item.partId) : null,
          name: item.name,
          description: item.description,
          quantity: Number(item.quantity || 0),
          unitPrice: Number(item.unitPrice || 0),
        })),
      };
      const created = await fetchJson("/api/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      navigate(`/quotes/${created.quoteNo}`);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="quote-template-page">
      <section className="quote-template-section">
        <div className="quote-template-head">
          <button className="icon-button" onClick={() => navigate(-1)} type="button"><span className="material-symbols-outlined">arrow_back</span></button>
          <div>
            <h2>新建报价单</h2>
            <p>按模板结构录入客户、设备、报价项目。</p>
          </div>
        </div>
        <div className="quote-template-hero-grid">
          <article className="quote-template-hero-card accent">
            <span>当前报价</span>
            <strong>{formatCurrency(subtotal)}</strong>
            <p>{totalItems} 项报价内容</p>
          </article>
          <article className="quote-template-hero-card">
            <span>报价客户</span>
            <strong>{selectedCustomer?.name ?? draft.customerName ?? "待选择客户"}</strong>
            <p>{selectedCustomer?.phone ?? draft.customerPhone ?? "可直接带入联系方式"}</p>
          </article>
          <article className="quote-template-hero-card">
            <span>设备信息</span>
            <strong>{draft.deviceName || "待选择品牌型号"}</strong>
            <p>{draft.serviceType || "待选择维修问题"}</p>
          </article>
        </div>
      </section>
      <section className="quote-template-section">
        <h3>客户信息</h3>
        <div className="quick-create-card">
          <div className="quote-template-title-row compact">
            <h3>快速新增客户</h3>
            <span className="soft-badge">创建后自动选中</span>
          </div>
          <div className="quote-form-grid compact">
            <label>
              <span>客户姓名</span>
              <input value={newCustomer.name} onChange={(event) => setNewCustomer((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              <span>联系电话</span>
              <input value={newCustomer.phone} onChange={(event) => setNewCustomer((current) => ({ ...current, phone: event.target.value }))} />
            </label>
            <label>
              <span>邮箱</span>
              <input type="email" value={newCustomer.email} onChange={(event) => setNewCustomer((current) => ({ ...current, email: event.target.value }))} />
            </label>
          </div>
          <label className="quote-template-section-label">
            <span>地址</span>
            <input value={newCustomer.address} onChange={(event) => setNewCustomer((current) => ({ ...current, address: event.target.value }))} />
          </label>
          <button className="wide-action secondary" disabled={creatingCustomer} onClick={handleCreateCustomer} type="button">{creatingCustomer ? "创建中..." : "新增客户并选中"}</button>
        </div>
        <div className="quote-form-grid">
          <label>
            <span>选择客户</span>
            <select
              value={draft.customerId}
              onChange={(event) => {
                const customer = customerOptions.find((item) => String(item.id) === event.target.value);
                setDraft((current) => ({
                  ...current,
                  customerId: event.target.value,
                  customerName: customer?.name ?? current.customerName,
                  customerPhone: customer?.phone ?? current.customerPhone,
                  customerEmail: customer?.email ?? current.customerEmail,
                }));
              }}
            >
              <option value="">选择客户</option>
              {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
          </label>
          <label>
            <span>手机品牌</span>
            <select value={draft.brandId} onChange={(event) => updateBrand(event.target.value)}>
              <option value="">选择品牌</option>
              {orderFormOptions.brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
            </select>
          </label>
          <label>
            <span>手机型号</span>
            <select value={draft.modelId} onChange={(event) => updateModel(event.target.value)}>
              <option value="">选择型号</option>
              {availableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <label>
            <span>服务类型</span>
            <select value={draft.issueTemplateId} onChange={(event) => updateIssueTemplate(event.target.value)}>
              <option value="">选择维修问题</option>
              {orderFormOptions.issueTemplates.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <label>
            <span>有效期至</span>
            <input type="date" value={draft.validUntil} onChange={(event) => setDraft((current) => ({ ...current, validUntil: event.target.value }))} />
          </label>
        </div>
      </section>
      <section className="quote-template-section">
        <div className="quote-template-title-row">
          <h3>报价项目</h3>
          <button className="small-action-button" onClick={addItem} type="button">添加项目</button>
        </div>
        <div className="quote-item-list">
          {draft.items.map((item, index) => (
            <div key={`${item.name}-${index}`} className="quote-item-card">
              <div className="quote-item-top">
                <div>
                  <strong>{item.name || "未命名项目"}</strong>
                  <p>{item.itemType === "labor" ? "人工项目" : "配件项目"}</p>
                </div>
                <button className="icon-button destructive" onClick={() => removeItem(index)} type="button"><span className="material-symbols-outlined">delete</span></button>
              </div>
              <div className="quote-form-grid compact">
                <label>
                  <span>配件</span>
                  <select
                    value={item.partId}
                    onChange={(event) => {
                      const part = parts.find((candidate) => String(candidate.id) === event.target.value);
                      updateItem(index, {
                        itemType: "part",
                        partId: event.target.value,
                        name: part?.name ?? item.name,
                        description: "报价配件",
                        unitPrice: Number(part?.unitPrice ?? item.unitPrice ?? 0),
                      });
                    }}
                  >
                    <option value="">手动项目</option>
                    {parts.map((part) => <option key={part.id} value={part.id}>{part.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>项目名称</span>
                  <input value={item.name} onChange={(event) => updateItem(index, { name: event.target.value })} />
                </label>
                <label>
                  <span>说明</span>
                  <input value={item.description} onChange={(event) => updateItem(index, { description: event.target.value })} />
                </label>
                <label>
                  <span>数量</span>
                  <input type="number" min="1" value={item.quantity} onChange={(event) => updateItem(index, { quantity: Number(event.target.value || 0) })} />
                </label>
                <label>
                  <span>单价</span>
                  <input type="number" min="0" value={item.unitPrice} onChange={(event) => updateItem(index, { unitPrice: Number(event.target.value || 0) })} />
                </label>
                <div className="quote-item-total">
                  <span>小计</span>
                  <strong>{formatCurrency(Number(item.quantity || 0) * Number(item.unitPrice || 0))}</strong>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="quote-template-summary">
        <div>
          <span>{draft.taxInclusive ? "报价合计（含税）" : "报价合计（不含税）"}</span>
          <strong>{formatCurrency(subtotal)}</strong>
        </div>
        <button className="wide-action primary" disabled={saving} onClick={handleSubmit} type="button">{saving ? "保存中..." : "生成报价单"}</button>
      </section>
      {error ? <p className="inline-error">{error}</p> : null}
    </div>
  );
}

function QuotePreviewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [storeSettings, setStoreSettings] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchJson(`/api/quotes/${id}`),
      fetchJson("/api/settings/store"),
    ])
      .then(([quoteResult, storeResult]) => {
        if (active) {
          setData(quoteResult);
          setStoreSettings(storeResult);
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (!data && !error) return <LoadingState label="正在加载报价单..." />;
  if (error) return <EmptyState title="报价单加载失败" message={error} />;

  const companyName = storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心";
  const companyAddress = storeSettings?.companyAddress || storeSettings?.address || "维拉港 · 瓦努阿图";
  const companyPhone = storeSettings?.companyPhone || storeSettings?.phone || "待补充公司电话";
  const companyEmail = storeSettings?.email || "待补充邮箱";
  const companyLogo = storeSettings?.coverImage || "";
  const bankAccounts = String(storeSettings?.bankAccounts || "").trim();
  const taxInclusive = data?.taxInclusive !== false;
  const taxRate = Number(data?.taxRate ?? storeSettings?.quoteTaxRate ?? 15);
  const companyInitials = companyName
    .replace(/\s+/g, "")
    .slice(0, 2)
    .toUpperCase();

  function handleConvertToPos() {
    navigate("/pos/checkout", {
      state: {
        customerId: data.customerId ? String(data.customerId) : "",
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        sourceQuoteNo: data.quoteNo,
        note: data.notes ? `报价转单：${data.notes}` : `由报价单 ${data.quoteNo} 转收银`,
        cart: data.items.map((item) => ({
          partId: item.partId,
          category: item.itemType === "labor" ? "Service" : "",
          name: item.name,
          description: item.description,
          quantity: Number(item.quantity ?? 0),
          unitPrice: Number(item.unitPrice ?? 0),
        })),
      },
    });
  }

  const quoteActions = (
    <>
      <button className="wide-action primary" onClick={handleConvertToPos} type="button">转到 POS 收银</button>
      <button className="wide-action secondary" onClick={() => window.print()} type="button">打印报价</button>
      <button className="wide-action secondary" onClick={() => navigate("/documents")} type="button">文档中心</button>
    </>
  );

  return (
    <div className="document-template-page">
      <section className="document-sheet-page">
        <div className="document-sheet-topbar">
          <button className="icon-button" onClick={() => navigate(-1)} type="button"><span className="material-symbols-outlined">arrow_back</span></button>
          <div className="document-sheet-topbar-actions">
            {quoteActions}
          </div>
        </div>

        <section className="document-sheet-card quote-sheet-card">
          <div className="document-sheet-header quote-sheet-header">
            <div className="document-sheet-code">
              <span>报价编号</span>
              <strong>{data.quoteNo}</strong>
              <p>有效期至 {formatDateLabel(data.validUntil)}</p>
            </div>
            <div className="document-sheet-brand document-sheet-brand-extended quote-sheet-brand-right">
              {companyLogo ? (
                <div className="document-brand-logo">
                  <img alt="公司 Logo" src={companyLogo} />
                </div>
              ) : (
                <div className="document-brand-fallback">
                  <strong>{companyInitials}</strong>
                </div>
              )}
              <div className="document-brand-copy">
                <span className="micro-label">报价单</span>
                <p className="document-brand-name">{companyName}</p>
                <p className="document-sheet-subline">{companyAddress}</p>
                <p className="document-sheet-subline">{companyPhone}</p>
                <p className="document-sheet-subline">{companyEmail}</p>
              </div>
            </div>
          </div>

          <div className="document-sheet-meta-grid quote-meta-grid">
            <div className="document-sheet-meta-card">
              <span>客户信息</span>
              <strong>{data.customerName || "门店客户"}</strong>
              <p>{data.customerPhone || "待补充联系电话"}</p>
            </div>
            <div className="document-sheet-meta-card">
              <span>设备与服务</span>
              <strong>{data.deviceName || "未填写设备"}</strong>
              <p>{data.serviceType || "维修报价"}</p>
            </div>
          </div>

          <div className="document-sheet-table">
            <div className="document-sheet-table-head">
              <span>项目</span>
              <span>数量</span>
              <span>单价</span>
              <span>金额</span>
            </div>
            {data.items.map((item) => (
              <div key={item.id} className="document-sheet-table-row">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description || "报价项目"}</p>
                </div>
                <span>{item.quantity}</span>
                <span>{item.unitPriceFormatted}</span>
                <strong>{item.totalPriceFormatted}</strong>
              </div>
            ))}
          </div>

          <div className="document-sheet-footer-grid">
            <div className="document-footer-left">
              <div className="document-sheet-note">
                <span>报价备注</span>
                <p>{data.notes?.trim() || "本报价仅供维修前确认，最终费用以实际检测结果和客户确认内容为准。"}</p>
              </div>
              <div className="document-bank-inline footer">
                <span>银行账号信息</span>
                <p>{bankAccounts || "请在门店设置中填写银行名称、账号、账户名等信息。"}</p>
              </div>
            </div>
            <div className="document-total-box">
              <div><span>小计</span><strong>{data.subtotalFormatted}</strong></div>
              <div><span>{taxInclusive ? `税额（已含 ${taxRate}%）` : `税额（${taxRate}%）`}</span><strong>{data.vatAmountFormatted}</strong></div>
              <div className="grand"><span>{taxInclusive ? "报价总额（含税）" : "报价总额（不含税）"}</span><strong>{data.totalAmountFormatted}</strong></div>
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}

function PosRegisterPage({ parts, customers }) {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [customerOptions, setCustomerOptions] = useState(customers);
  const [storeSettings, setStoreSettings] = useState(null);
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState([]);
  const [customerId, setCustomerId] = useState(String(customers[0]?.id ?? ""));
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", email: "", address: "" });

  useEffect(() => {
    setCustomerOptions(customers);
  }, [customers]);

  useEffect(() => {
    let active = true;
    fetchJson("/api/settings/store")
      .then((result) => {
        if (active) setStoreSettings(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const visibleParts = parts.filter((part) => {
    const matchesCategory = category === "All" || part.category === category;
    const query = search.trim().toLowerCase();
    const matchesQuery = !query || part.name.toLowerCase().includes(query) || String(part.sku ?? "").toLowerCase().includes(query);
    return matchesCategory && matchesQuery;
  });

  const cartTotal = cart.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const cartCount = cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const lowStockCount = visibleParts.filter((part) => part.needsReorder).length;

  function addToCart(part) {
    setCart((current) => {
      const existing = current.find((item) => String(item.partId) === String(part.id));
      if (existing) {
        return current.map((item) => String(item.partId) === String(part.id) ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [
        ...current,
        {
          partId: part.id,
          category: part.category,
          name: part.name,
          description: part.subtitle ?? "POS 收银商品",
          quantity: 1,
          unitPrice: Number(part.unitPrice ?? 0),
        },
      ];
    });
  }

  function updateCartQuantity(partId, delta) {
    setCart((current) => current
      .map((item) => String(item.partId) === String(partId)
        ? { ...item, quantity: Math.max(0, Number(item.quantity ?? 0) + delta) }
        : item)
      .filter((item) => Number(item.quantity ?? 0) > 0));
  }

  function removeFromCart(partId) {
    setCart((current) => current.filter((item) => String(item.partId) !== String(partId)));
  }

  if (!isMobile) {
    return (
      <div className="pos-desktop-page">
        <section className="pos-desktop-header">
          <div>
            <span className="micro-label">Desktop POS</span>
            <h2>POS 收银工作台</h2>
            <p>{storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心"} · {storeSettings?.companyPhone || storeSettings?.phone || "待补充联系电话"}</p>
          </div>
          <div className="pos-desktop-header-actions">
            <button className="wide-action secondary" onClick={() => navigate("/pos/checkout", { state: { cart, customerId } })} type="button">去结账</button>
          </div>
        </section>

        <section className="pos-desktop-overview">
          <article className="pos-overview-card accent">
            <span>购物车合计</span>
            <strong>{formatCurrency(cartTotal)}</strong>
            <p>{cartCount} 件商品待结账</p>
          </article>
          <article className="pos-overview-card">
            <span>可售商品</span>
            <strong>{visibleParts.length}</strong>
            <p>{lowStockCount} 件低库存提醒</p>
          </article>
          <article className="pos-overview-card">
            <span>默认客户</span>
            <strong>{customerOptions.find((item) => String(item.id) === String(customerId))?.name ?? "门店散客"}</strong>
            <p>结账时可切换客户</p>
          </article>
        </section>

        <section className="pos-desktop-grid">
          <div className="pos-desktop-catalog">
            <section className="quote-template-section">
              <div className="quote-form-grid compact">
                <label>
                  <span>收银客户</span>
                  <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                    <option value="">门店散客</option>
                    {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                  </select>
                </label>
              </div>
              <section className="pos-template-search">
                <div className="search-shell"><span className="material-symbols-outlined">search</span><input placeholder="搜索配件 / SKU" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
              </section>
              <section className="pos-template-tabs">
                {["All", "Screens", "Batteries", "Small Parts", "Others"].map((item) => (
                  <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)} type="button">{formatPartCategory(item)}</button>
                ))}
              </section>
              <section className="pos-template-grid desktop">
                {visibleParts.map((part) => (
                  <article key={part.id} className="pos-product-card">
                    <div className="pos-product-media">
                      <span className={`soft-badge ${part.needsReorder ? "soft-badge-warn" : ""}`}>{part.needsReorder ? "低库存" : "有库存"}</span>
                    </div>
                    <div className="pos-product-copy">
                      <strong>{part.name}</strong>
                      <p>{part.subtitle ?? formatPartCategory(part.category)}</p>
                    </div>
                    <div className="pos-product-footer">
                      <strong>{part.unitPriceFormatted}</strong>
                      <button onClick={() => addToCart(part)} type="button"><span className="material-symbols-outlined">add</span></button>
                    </div>
                  </article>
                ))}
              </section>
            </section>
          </div>

          <aside className="pos-desktop-cart quote-template-summary checkout-summary-panel">
            <div className="checkout-summary-head">
              <h3>购物车</h3>
              <p>{cartCount} 件商品</p>
            </div>
            {cart.length ? (
              <div className="document-line-items">
                {cart.map((item) => (
                  <div key={`${item.partId}-${item.name}`} className="document-line-row pos-cart-line">
                    <div>
                      <strong>{item.name}</strong>
                      <p>{item.description || formatPartCategory(item.category)}</p>
                    </div>
                    <div className="pos-qty-stepper">
                      <button onClick={() => updateCartQuantity(item.partId, -1)} type="button">-</button>
                      <span>{item.quantity}</span>
                      <button onClick={() => updateCartQuantity(item.partId, 1)} type="button">+</button>
                    </div>
                    <span>{formatCurrency(item.unitPrice)}</span>
                    <div className="pos-cart-line-total">
                      <strong>{formatCurrency(item.quantity * item.unitPrice)}</strong>
                      <button className="link-button danger" onClick={() => removeFromCart(item.partId)} type="button">移除</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-card">请选择商品后再结账</div>
            )}
            <div className="document-total-box">
              <div><span>应付合计</span><strong>{formatCurrency(cartTotal)}</strong></div>
            </div>
          </aside>
        </section>
      </div>
    );
  }

  return (
    <div className="pos-template-page">
      <section className="pos-template-head">
        <div>
          <h2>POS 收银台</h2>
          <p>{storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心"} · {storeSettings?.companyPhone || storeSettings?.phone || "待补充联系电话"}</p>
        </div>
        <button className="wide-action secondary" onClick={() => navigate("/pos/checkout", { state: { cart, customerId } })} type="button">去结账</button>
      </section>
      <section className="pos-template-overview">
        <article className="pos-overview-card accent">
          <span>购物车合计</span>
          <strong>{formatCurrency(cartTotal)}</strong>
          <p>{cartCount} 件商品待结账</p>
        </article>
        <article className="pos-overview-card">
          <span>可售商品</span>
          <strong>{visibleParts.length}</strong>
          <p>{lowStockCount} 件低库存提醒</p>
        </article>
        <article className="pos-overview-card">
          <span>默认客户</span>
          <strong>{customerOptions.find((item) => String(item.id) === String(customerId))?.name ?? "门店散客"}</strong>
          <p>结账时可切换客户</p>
        </article>
      </section>
      <section className="quote-template-section">
        <div className="quote-form-grid compact">
          <label>
            <span>收银客户</span>
            <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
              <option value="">门店散客</option>
              {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </select>
          </label>
        </div>
        <div className="quick-create-inline">
          <input placeholder="客户姓名" value={newCustomer.name} onChange={(event) => setNewCustomer((current) => ({ ...current, name: event.target.value }))} />
          <input placeholder="联系电话" value={newCustomer.phone} onChange={(event) => setNewCustomer((current) => ({ ...current, phone: event.target.value }))} />
          <button
            className="wide-action secondary"
            disabled={creatingCustomer}
            onClick={async () => {
              try {
                setCreatingCustomer(true);
                const created = await fetchJson("/api/customers", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(newCustomer),
                });
                setCustomerOptions((current) => [created, ...current]);
                setCustomerId(String(created.id));
                setNewCustomer({ name: "", phone: "", email: "", address: "" });
              } catch (createError) {
                alert(createError.message);
              } finally {
                setCreatingCustomer(false);
              }
            }}
            type="button"
          >
            {creatingCustomer ? "创建中..." : "新增客户"}
          </button>
        </div>
      </section>
      <section className="pos-template-search">
        <div className="search-shell"><span className="material-symbols-outlined">search</span><input placeholder="搜索配件 / SKU" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      </section>
      <section className="pos-template-tabs">
        {["All", "Screens", "Batteries", "Small Parts", "Others"].map((item) => (
          <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)} type="button">{formatPartCategory(item)}</button>
        ))}
      </section>
      <section className="pos-template-grid">
        {visibleParts.map((part) => (
          <article key={part.id} className="pos-product-card">
            <div className="pos-product-media">
              <span className={`soft-badge ${part.needsReorder ? "soft-badge-warn" : ""}`}>{part.needsReorder ? "低库存" : "有库存"}</span>
            </div>
            <div className="pos-product-copy">
              <strong>{part.name}</strong>
              <p>{part.subtitle ?? formatPartCategory(part.category)}</p>
            </div>
            <div className="pos-product-footer">
              <strong>{part.unitPriceFormatted}</strong>
              <button onClick={() => addToCart(part)} type="button"><span className="material-symbols-outlined">add</span></button>
            </div>
          </article>
        ))}
      </section>
      {cart.length ? (
        <section className="pos-cart-list">
          <div className="quote-template-title-row compact">
            <h3>已选商品</h3>
            <span className="soft-badge">{cartCount} 件</span>
          </div>
          <div className="document-line-items">
            {cart.map((item) => (
              <div key={`${item.partId}-${item.name}`} className="document-line-row pos-cart-line">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description || formatPartCategory(item.category)}</p>
                </div>
                <div className="pos-qty-stepper">
                  <button onClick={() => updateCartQuantity(item.partId, -1)} type="button">-</button>
                  <span>{item.quantity}</span>
                  <button onClick={() => updateCartQuantity(item.partId, 1)} type="button">+</button>
                </div>
                <span>{formatCurrency(item.unitPrice)}</span>
                <div className="pos-cart-line-total">
                  <strong>{formatCurrency(item.quantity * item.unitPrice)}</strong>
                  <button className="link-button danger" onClick={() => removeFromCart(item.partId)} type="button">移除</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="pos-cart-bar">
        <div>
          <span>应付合计</span>
          <strong>{formatCurrency(cartTotal)}</strong>
          <p>{cartCount ? `已选 ${cartCount} 件商品` : "请选择商品后再结账"}</p>
        </div>
        <button className="wide-action primary" onClick={() => navigate("/pos/checkout", { state: { cart, customerId } })} type="button">结账</button>
      </section>
    </div>
  );
}

function PosCheckoutPage({ customers }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobileViewport();
  const incomingCart = location.state?.cart ?? [];
  const incomingCustomerId = String(location.state?.customerId ?? customers[0]?.id ?? "");
  const [customerOptions, setCustomerOptions] = useState(customers);
  const [storeSettings, setStoreSettings] = useState(null);
  const [draft, setDraft] = useState(() => ({
    ...createPosDraft(customers),
    customerId: incomingCustomerId,
    customerName: location.state?.customerName ?? customers[0]?.name ?? "",
    customerPhone: location.state?.customerPhone ?? customers[0]?.phone ?? "",
    sourceQuoteNo: location.state?.sourceQuoteNo ?? "",
    note: location.state?.note ?? "",
    items: incomingCart,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomer, setNewCustomer] = useState({ name: "", phone: "", email: "", address: "" });
  const selectedCustomer = customerOptions.find((item) => String(item.id) === String(draft.customerId));
  const subtotal = draft.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);

  useEffect(() => {
    setCustomerOptions(customers);
  }, [customers]);

  useEffect(() => {
    let active = true;
    fetchJson("/api/settings/store")
      .then((result) => {
        if (active) setStoreSettings(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  function updateDraftItem(index, patch) {
    setDraft((current) => ({
      ...current,
      items: current.items
        .map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item))
        .filter((item) => Number(item.quantity ?? 0) > 0),
    }));
  }

  function removeDraftItem(index) {
    setDraft((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  async function handleCheckout() {
    try {
      setSaving(true);
      setError("");
      const created = await fetchJson("/api/pos/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: draft.customerId ? Number(draft.customerId) : null,
          customerName: selectedCustomer?.name ?? draft.customerName,
          customerPhone: selectedCustomer?.phone ?? draft.customerPhone,
          paymentMethod: draft.paymentMethod,
          note: draft.note,
          sourceQuoteNo: draft.sourceQuoteNo,
          items: draft.items,
        }),
      });
      navigate(`/pos/sales/${created.saleNo}/receipt`);
    } catch (checkoutError) {
      setError(checkoutError.message);
    } finally {
      setSaving(false);
    }
  }

  if (!isMobile) {
    return (
      <div className="pos-checkout-desktop-page">
        <section className="pos-checkout-desktop-header">
          <div>
            <span className="micro-label">Desktop Checkout</span>
            <h2>POS 收银结账</h2>
            <p>{draft.sourceQuoteNo ? `来源报价 ${draft.sourceQuoteNo}` : "门店直接收银"} · {storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心"}</p>
          </div>
          <div className="pos-checkout-desktop-header-actions">
            <button className="wide-action secondary" onClick={() => navigate("/pos/register")} type="button">返回收银台</button>
            <button className="wide-action primary" disabled={saving || !draft.items.length} onClick={handleCheckout} type="button">{saving ? "收银中..." : "完成收银"}</button>
          </div>
        </section>

        <section className="pos-checkout-desktop-grid">
          <section className="quote-template-section">
            <div className="quote-form-grid">
              <label>
                <span>客户</span>
                <select value={draft.customerId} onChange={(event) => setDraft((current) => ({ ...current, customerId: event.target.value }))}>
                  <option value="">门店散客</option>
                  {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                </select>
              </label>
              <label>
                <span>支付方式</span>
                <select value={draft.paymentMethod} onChange={(event) => setDraft((current) => ({ ...current, paymentMethod: event.target.value }))}>
                  <option value="Cash">现金</option>
                  <option value="Bank Transfer">银行转账</option>
                  <option value="Check">支票</option>
                </select>
              </label>
            </div>
            {draft.sourceQuoteNo ? (
              <div className="checkout-source-badge">
                <span className="soft-badge">报价转单</span>
                <strong>{draft.sourceQuoteNo}</strong>
              </div>
            ) : null}
            <label className="quote-template-section-label">
              <span>备注</span>
              <textarea value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} />
            </label>
            <div className="quote-template-title-row compact">
              <h3>桌面购物清单</h3>
              <span className="soft-badge">{draft.items.length} 项</span>
            </div>
            <div className="document-line-items">
              {draft.items.map((item, index) => (
                <div key={`${item.name}-${index}`} className="document-line-row">
                  <div>
                    <strong>{item.name}</strong>
                    <p>{item.description || formatPartCategory(item.category)}</p>
                  </div>
                  <div className="pos-qty-stepper">
                    <button onClick={() => updateDraftItem(index, { quantity: Math.max(0, Number(item.quantity || 0) - 1) })} type="button">-</button>
                    <span>{item.quantity}</span>
                    <button onClick={() => updateDraftItem(index, { quantity: Number(item.quantity || 0) + 1 })} type="button">+</button>
                  </div>
                  <span>{formatCurrency(item.unitPrice)}</span>
                  <div className="pos-cart-line-total">
                    <strong>{formatCurrency(item.quantity * item.unitPrice)}</strong>
                    <button className="link-button danger" onClick={() => removeDraftItem(index)} type="button">移除</button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <aside className="quote-template-summary checkout-summary-panel desktop">
            <div className="checkout-summary-head">
              <h3>收银摘要</h3>
              <p>{selectedCustomer?.name ?? "门店散客"}</p>
            </div>
            <div className="document-total-box">
              <div><span>商品小计</span><strong>{formatCurrency(subtotal)}</strong></div>
              <div><span>税额</span><strong>{formatCurrency(0)}</strong></div>
              <div className="grand"><span>应付总额</span><strong>{formatCurrency(subtotal)}</strong></div>
            </div>
            <div className="checkout-summary-notes">
              <div className="info-mini">
                <span>支付方式</span>
                <strong>{formatChannelLabel(draft.paymentMethod)}</strong>
              </div>
              <div className="info-mini">
                <span>客户电话</span>
                <strong>{selectedCustomer?.phone ?? draft.customerPhone ?? "现场收银"}</strong>
              </div>
            </div>
            {error ? <p className="inline-error">{error}</p> : null}
          </aside>
        </section>
      </div>
    );
  }

  return (
    <div className="document-template-page">
      <section className="document-template-toolbar">
        <button className="icon-button" onClick={() => navigate("/pos/register")} type="button"><span className="material-symbols-outlined">arrow_back</span></button>
        <div className="document-template-toolbar-copy">
          <h2>POS 收银结账</h2>
          <p>{draft.sourceQuoteNo ? `来源报价 ${draft.sourceQuoteNo}` : "门店直接收银"} · {storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心"}</p>
        </div>
      </section>
      <div className="checkout-template-grid">
        <section className="quote-template-section">
          <div className="quote-form-grid">
            <label>
              <span>客户</span>
              <select value={draft.customerId} onChange={(event) => setDraft((current) => ({ ...current, customerId: event.target.value }))}>
                <option value="">门店散客</option>
                {customerOptions.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
              </select>
            </label>
            <label>
              <span>支付方式</span>
              <select value={draft.paymentMethod} onChange={(event) => setDraft((current) => ({ ...current, paymentMethod: event.target.value }))}>
                <option value="Cash">现金</option>
                <option value="Bank Transfer">银行转账</option>
                <option value="Check">支票</option>
              </select>
            </label>
          </div>
          <div className="quick-create-inline">
            <input placeholder="客户姓名" value={newCustomer.name} onChange={(event) => setNewCustomer((current) => ({ ...current, name: event.target.value }))} />
            <input placeholder="联系电话" value={newCustomer.phone} onChange={(event) => setNewCustomer((current) => ({ ...current, phone: event.target.value }))} />
            <button
              className="wide-action secondary"
              disabled={creatingCustomer}
              onClick={async () => {
                try {
                  setCreatingCustomer(true);
                  setError("");
                  const created = await fetchJson("/api/customers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(newCustomer),
                  });
                  setCustomerOptions((current) => [created, ...current]);
                  setDraft((current) => ({
                    ...current,
                    customerId: String(created.id),
                    customerName: created.name,
                    customerPhone: created.phone ?? "",
                  }));
                  setNewCustomer({ name: "", phone: "", email: "", address: "" });
                } catch (createError) {
                  setError(createError.message);
                } finally {
                  setCreatingCustomer(false);
                }
              }}
              type="button"
            >
              {creatingCustomer ? "创建中..." : "新增客户"}
            </button>
          </div>
          {draft.sourceQuoteNo ? (
            <div className="checkout-source-badge">
              <span className="soft-badge">报价转单</span>
              <strong>{draft.sourceQuoteNo}</strong>
            </div>
          ) : null}
          <label className="quote-template-section-label">
            <span>备注</span>
            <textarea value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} />
          </label>
          <div className="quote-template-title-row compact">
            <h3>购物清单</h3>
            <span className="soft-badge">{draft.items.length} 项</span>
          </div>
          <div className="document-line-items">
            {draft.items.map((item, index) => (
              <div key={`${item.name}-${index}`} className="document-line-row">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description || formatPartCategory(item.category)}</p>
                </div>
                <div className="pos-qty-stepper">
                  <button onClick={() => updateDraftItem(index, { quantity: Math.max(0, Number(item.quantity || 0) - 1) })} type="button">-</button>
                  <span>{item.quantity}</span>
                  <button onClick={() => updateDraftItem(index, { quantity: Number(item.quantity || 0) + 1 })} type="button">+</button>
                </div>
                <span>{formatCurrency(item.unitPrice)}</span>
                <div className="pos-cart-line-total">
                  <strong>{formatCurrency(item.quantity * item.unitPrice)}</strong>
                  <button className="link-button danger" onClick={() => removeDraftItem(index)} type="button">移除</button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="quote-template-summary checkout-summary-panel">
          <div className="checkout-summary-head">
            <h3>收银摘要</h3>
            <p>{selectedCustomer?.name ?? "门店散客"}</p>
          </div>
          <div className="document-total-box">
            <div><span>商品小计</span><strong>{formatCurrency(subtotal)}</strong></div>
            <div><span>税额</span><strong>{formatCurrency(0)}</strong></div>
            <div className="grand"><span>应付总额</span><strong>{formatCurrency(subtotal)}</strong></div>
          </div>
          <div className="checkout-summary-notes">
            <div className="info-mini">
              <span>支付方式</span>
              <strong>{formatChannelLabel(draft.paymentMethod)}</strong>
            </div>
            <div className="info-mini">
              <span>客户电话</span>
              <strong>{selectedCustomer?.phone ?? draft.customerPhone ?? "现场收银"}</strong>
            </div>
          </div>
          <button className="wide-action primary" disabled={saving || !draft.items.length} onClick={handleCheckout} type="button">{saving ? "收银中..." : "完成收银"}</button>
          {error ? <p className="inline-error">{error}</p> : null}
        </section>
      </div>
    </div>
  );
}

function PosReceipt80mmPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [storeSettings, setStoreSettings] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchJson(`/api/pos/sales/${id}`),
      fetchJson("/api/settings/store"),
    ])
      .then(([saleResult, storeResult]) => {
        if (active) {
          setData(saleResult);
          setStoreSettings(storeResult);
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (!data && !error) return <LoadingState label="正在加载 POS 小票..." />;
  if (error) return <EmptyState title="POS 小票加载失败" message={error} />;

  return (
    <div className="receipt-page pos-80mm">
      <div className="receipt-toolbar">
        <button className="wide-action secondary" onClick={() => navigate(`/invoices/${data.saleNo}`)} type="button">查看发票</button>
        <button className="wide-action primary" onClick={() => window.print()} type="button">打印 80mm 小票</button>
      </div>
      <div className="receipt-card pos-thermal-card">
        <div className="receipt-brand thermal-brand">
          <div className="document-brand-mark thermal">
            <span className="material-symbols-outlined">build</span>
          </div>
          <strong>{storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心"}</strong>
          <p>{storeSettings?.companyAddress || storeSettings?.address || "维拉港 · 瓦努阿图"}</p>
        </div>
        <div className="receipt-divider" />
        <div className="receipt-meta">
          <div><span>收银单号</span><strong>{data.saleNo}</strong></div>
          <div><span>客户</span><strong>{data.customerName || "门店散客"}</strong></div>
          <div><span>支付方式</span><strong>{formatChannelLabel(data.paymentMethod)}</strong></div>
          <div><span>收银状态</span><strong>已完成</strong></div>
          <div><span>联系电话</span><strong>{storeSettings?.companyPhone || storeSettings?.phone || "-"}</strong></div>
        </div>
        <div className="receipt-divider" />
        <div className="receipt-items">
          {data.items.map((item) => (
            <div key={item.id} className="receipt-line-item">
              <div>
                <strong>{item.name}</strong>
                <p>{item.quantity} x {item.unitPriceFormatted}</p>
                <p className="receipt-line-price">{item.totalPriceFormatted}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="receipt-divider" />
        <div className="receipt-totals">
          <div><span>小计</span><strong>{data.subtotalFormatted}</strong></div>
          <div><span>税额</span><strong>{data.vatAmountFormatted}</strong></div>
          <div className="receipt-grand-total"><span>合计金额</span><strong>{data.totalAmountFormatted}</strong></div>
        </div>
        <div className="thermal-footer-note">
          <span className="soft-badge">POS 已收款</span>
          <p>请妥善保管此票据，作为售后和发票关联凭证。</p>
        </div>
      </div>
    </div>
  );
}

function OfficialInvoicePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [storeSettings, setStoreSettings] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchJson(`/api/invoices/${id}`),
      fetchJson("/api/settings/store"),
    ])
      .then(([invoiceResult, storeResult]) => {
        if (active) {
          setData(invoiceResult);
          setStoreSettings(storeResult);
        }
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (!data && !error) return <LoadingState label="正在加载正式发票..." />;
  if (error) return <EmptyState title="发票加载失败" message={error} />;

  const companyName = storeSettings?.companyName || storeSettings?.storeName || "维拉港维修中心";
  const companyAddress = storeSettings?.companyAddress || storeSettings?.address || "维拉港 · 瓦努阿图";
  const companyPhone = storeSettings?.companyPhone || storeSettings?.phone || "待补充公司电话";
  const companyEmail = storeSettings?.email || "待补充邮箱";
  const companyLogo = storeSettings?.coverImage || "";
  const companyInitials = companyName
    .replace(/\s+/g, "")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="document-template-page">
      <section className="document-sheet-page">
        <div className="document-sheet-topbar">
          <button className="icon-button" onClick={() => navigate("/documents")} type="button"><span className="material-symbols-outlined">arrow_back</span></button>
          <div className="document-sheet-topbar-actions">
            <button className="wide-action secondary" onClick={() => navigate(`/pos/sales/${data.saleNo}/receipt`)} type="button">查看小票</button>
            <button className="wide-action primary" onClick={() => window.print()} type="button">打印发票</button>
          </div>
        </div>

        <section className="document-sheet-card invoice invoice-sheet-card">
          <div className="document-sheet-header">
            <div className="document-sheet-brand document-sheet-brand-extended">
              {companyLogo ? (
                <div className="document-brand-logo invoice">
                  <img alt="公司 Logo" src={companyLogo} />
                </div>
              ) : (
                <div className="document-brand-fallback invoice">
                  <strong>{companyInitials}</strong>
                </div>
              )}
              <div className="document-brand-copy">
                <span className="micro-label">正式发票</span>
                <p className="document-brand-name">{companyName}</p>
                <p className="document-sheet-subline">{companyAddress}</p>
                <p className="document-sheet-subline">{companyPhone}</p>
                <p className="document-sheet-subline">{companyEmail}</p>
                <p className="document-sheet-subline">TIN 税号：{storeSettings?.tinNumber || "-"}</p>
              </div>
            </div>
            <div className="document-sheet-code">
              <span>发票编号</span>
              <strong>{data.invoiceNo}</strong>
              <p>开票日期 {formatDateLabel(data.issueDate)}</p>
            </div>
          </div>

          <div className="document-sheet-meta-card invoice-summary-card">
            <div className="invoice-summary-grid">
              <div>
                <span>客户付款信息</span>
                <strong>{formatChannelLabel(data.paymentMethod)}</strong>
                <p>收银单号 {data.saleNo}</p>
              </div>
              <div>
                <span>发票总额</span>
                <strong>{data.totalAmountFormatted}</strong>
                <p>状态 {data.statusLabel || "已支付"}</p>
              </div>
            </div>
          </div>

          <div className="document-sheet-table">
            <div className="document-sheet-table-head">
              <span>项目</span>
              <span>数量</span>
              <span>单价</span>
              <span>金额</span>
            </div>
            {data.items.map((item) => (
              <div key={item.id} className="document-sheet-table-row">
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.description || formatPartCategory(item.category)}</p>
                </div>
                <span>{item.quantity}</span>
                <span>{item.unitPriceFormatted}</span>
                <strong>{item.totalPriceFormatted}</strong>
              </div>
            ))}
          </div>

          <div className="document-sheet-footer-grid">
            <div className="document-sheet-note">
              <span>票据说明</span>
              <p>本发票为门店收银完成后的正式付款凭证，可与 80mm 小票一并用于对账、售后和客户留存。</p>
            </div>
            <div className="document-total-box invoice">
              <div><span>小计</span><strong>{data.subtotalFormatted}</strong></div>
              <div><span>税额</span><strong>{data.vatAmountFormatted}</strong></div>
              <div className="grand"><span>发票总额</span><strong>{data.totalAmountFormatted}</strong></div>
            </div>
          </div>
        </section>
      </section>
    </div>
  );
}

function DocumentManagementPage() {
  const navigate = useNavigate();
  const [data, setData] = useState({ summary: null, rows: [] });
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams();
    if (type !== "all") query.set("type", type);
    if (search.trim()) query.set("search", search.trim());
    fetchJson(`/api/documents?${query.toString()}`)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message);
      });
    return () => {
      active = false;
    };
  }, [search, type]);

  return (
    <div className="document-management-page">
      <section className="document-summary-grid">
        <article className="document-summary-card">
          <span>待处理总额</span>
          <strong>{data.summary?.totalPendingFormatted ?? "-"}</strong>
        </article>
        <article className="document-summary-card">
          <span>已支付发票</span>
          <strong>{data.summary?.invoicesPaid ?? 0}</strong>
        </article>
        <article className="document-summary-card warn">
          <span>逾期待处理</span>
          <strong>{data.summary?.overdue ?? 0}</strong>
        </article>
      </section>
      <section className="document-template-toolbar">
        <div className="document-template-toolbar-copy">
          <h2>文档中心</h2>
          <p>报价单与发票总览</p>
        </div>
        <div className="search-shell document-search-shell"><span className="material-symbols-outlined">search</span><input placeholder="按编号或客户搜索..." value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <div className="pos-template-tabs document-tabs">
          <button className={type === "all" ? "active" : ""} onClick={() => setType("all")} type="button">全部</button>
          <button className={type === "quote" ? "active" : ""} onClick={() => setType("quote")} type="button">报价单</button>
          <button className={type === "invoice" ? "active" : ""} onClick={() => setType("invoice")} type="button">发票</button>
        </div>
      </section>
      <section className="document-activity-list">
        {data.rows.map((row) => (
          <button key={`${row.type}-${row.code}`} className="document-activity-card" onClick={() => navigate(row.route)} type="button">
            <div className={`document-activity-icon ${row.type}`}>
              <span className="material-symbols-outlined">{row.type === "quote" ? "request_quote" : "receipt_long"}</span>
            </div>
            <div className="document-activity-copy">
              <div className="document-activity-head">
                <div>
                  <strong>{row.code}</strong>
                  <p>{row.customerName}</p>
                </div>
                <div className="document-activity-badges">
                  <span className={`soft-badge ${row.status === "paid" ? "" : row.status === "overdue" ? "soft-badge-warn" : ""}`}>{row.typeLabel}</span>
                  <span className={`soft-badge subtle ${row.status === "paid" ? "" : row.status === "overdue" ? "soft-badge-warn" : ""}`}>{row.statusLabel || "处理中"}</span>
                </div>
              </div>
              <div className="document-activity-meta">
                <span>{formatDateLabel(row.createdAt)}</span>
                <strong>{row.amountFormatted}</strong>
              </div>
              <div className="document-activity-foot">
                <span>{row.type === "quote" ? "查看报价详情" : "查看发票详情"}</span>
                <span className="material-symbols-outlined">north_east</span>
              </div>
            </div>
            <span className="material-symbols-outlined">chevron_right</span>
          </button>
        ))}
      </section>
      {error ? <p className="inline-error">{error}</p> : null}
    </div>
  );
}

function FinancialReportsPage() {
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const [financeReport, setFinanceReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [type, setType] = useState("all");

  useEffect(() => {
    let ignore = false;
    async function loadReport() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/finance/report?type=${type}`);
        if (!ignore) setFinanceReport(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReport();
    return () => { ignore = true; };
  }, [type]);

  if (loading) return <div className="empty-card">财务报表加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  const summary = financeReport?.summary;
  const channels = financeReport?.channels ?? [];
  const rows = financeReport?.rows ?? [];

  if (!isMobile) {
    return (
      <div className="finance-desktop-page">
        <section className="finance-desktop-hero">
          <div className="finance-template-hero-main">
            <p>本月总收入 (VUV)</p>
            <h2>{summary?.totalRevenueFormatted ?? "-"}</h2>
            <div className="finance-growth">
              <span className="material-symbols-outlined">trending_up</span>
              <span>{summary?.growthRate ?? "-"}</span>
            </div>
          </div>
          <div className="finance-desktop-actions">
            <button className={type === "all" ? "status-chip active" : "status-chip"} onClick={() => setType("all")} type="button">全部</button>
            <button className={type === "income" ? "status-chip active" : "status-chip"} onClick={() => setType("income")} type="button">收入</button>
            <button className={type === "expense" ? "status-chip active" : "status-chip"} onClick={() => setType("expense")} type="button">支出</button>
          </div>
        </section>

        <section className="finance-desktop-summary">
          <div className="finance-template-mini-card">
            <p>今日收入</p>
            <strong>{summary?.todayRevenueFormatted ?? "-"}</strong>
            <div className="finance-mini-state success"><span className="material-symbols-outlined">check_circle</span><span>{summary?.transactionCount ?? 0} 笔交易</span></div>
          </div>
          <div className="finance-template-mini-card">
            <p>待结余额</p>
            <strong>{summary?.pendingBalanceFormatted ?? "-"}</strong>
            <div className="finance-mini-state warning"><span className="material-symbols-outlined">schedule</span><span>{summary?.completedOrders ?? 0} 单已完结</span></div>
          </div>
          <div className="metric-tile">
            <div>
              <p>收入渠道</p>
              <strong>{channels.length}</strong>
            </div>
          </div>
          <div className="metric-tile success">
            <div>
              <p>近期流水</p>
              <strong>{rows.length}</strong>
            </div>
          </div>
        </section>

        <div className="finance-desktop-grid">
          <section className="finance-template-chart-card">
            <div className="finance-template-head">
              <h3>收入趋势分析</h3>
              <button className="link-button" onClick={() => navigate("/financial-reports/drill-down")} type="button">下钻明细</button>
            </div>
            <div className="finance-template-bars">
              {rows.slice(0, 7).map((row, index) => {
                const absAmount = Math.abs(row.amount);
                const max = Math.max(...rows.slice(0, 7).map((item) => Math.abs(item.amount)), 1);
                const height = Math.max(30, Math.round((absAmount / max) * 100));
                return (
                  <div key={row.id} className="finance-template-bar-col">
                    <div className={`finance-template-bar ${index === 2 ? "active" : ""}`} style={{ height: `${height}%` }} />
                    <span>{row.subtitle.split("·")[0].trim().slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <aside className="finance-desktop-side">
            <section className="finance-template-channel-section">
              <div className="finance-template-head">
                <h3>收支来源分布</h3>
                <button className="link-button" onClick={() => navigate("/revenue-breakdown")} type="button">更多图表</button>
              </div>
              <div className="finance-template-channel-grid">
                {channels.map((channel) => (
                  <div key={channel.channel} className="finance-template-channel-card">
                    <div className={`finance-template-channel-icon ${channel.tone ?? "primary"}`}>
                      <span className="material-symbols-outlined">{channel.icon ?? "payments"}</span>
                    </div>
                    <div>
                      <p>{channel.label ?? formatChannelLabel(channel.channel)}</p>
                      <strong>{channel.amountFormatted}</strong>
                      <span>占比 {channel.percent}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>

        <section className="finance-template-list-card">
          <div className="finance-template-head">
            <h3>近期流水明细</h3>
            <div className="detail-actions-inline">
              <button className="link-button" onClick={() => navigate("/financial-reports/daily")} type="button">日结报表</button>
              <button className="link-button" onClick={() => navigate("/financial-reports/monthly")} type="button">月结报表</button>
              <button className="link-button" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出流水</button>
            </div>
          </div>
          <div className="finance-template-list">
            {rows.map((row) => (
              <button
                key={row.id}
                className="finance-template-list-item finance-list-button"
                onClick={() => openFinanceRowDetail(navigate, row)}
                type="button"
              >
                <div className={`finance-template-list-icon ${row.amount >= 0 ? "positive" : "negative"}`}>
                  <span className="material-symbols-outlined">{row.amount >= 0 ? "payments" : "shopping_cart"}</span>
                </div>
                <div className="finance-template-list-main">
                  <strong>{row.title}</strong>
                  <p>{row.subtitle}</p>
                </div>
                <div className="finance-list-right">
                  <strong className={row.amount >= 0 ? "positive" : "negative"}>{row.amountFormatted}</strong>
                  <span className={row.statusTone === "success" ? "status-success" : "status-warning"}>{row.statusLabel}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="finance-template-page">
      <section className="finance-template-hero">
        <div className="finance-template-hero-main">
          <p>本月总收入 (VUV)</p>
          <h2>{summary?.totalRevenueFormatted ?? "-"}</h2>
          <div className="finance-growth">
            <span className="material-symbols-outlined">trending_up</span>
            <span>{summary?.growthRate ?? "-"}</span>
          </div>
        </div>
        <div className="finance-template-mini-grid">
          <div className="finance-template-mini-card">
            <p>今日收入</p>
            <strong>{summary?.todayRevenueFormatted ?? "-"}</strong>
            <div className="finance-mini-state success"><span className="material-symbols-outlined">check_circle</span><span>{summary?.transactionCount ?? 0} 笔交易</span></div>
          </div>
          <div className="finance-template-mini-card">
            <p>待结余额</p>
            <strong>{summary?.pendingBalanceFormatted ?? "-"}</strong>
            <div className="finance-mini-state warning"><span className="material-symbols-outlined">schedule</span><span>{summary?.completedOrders ?? 0} 单已完结</span></div>
          </div>
        </div>
      </section>

      <section className="finance-template-chart-card">
        <div className="finance-template-head">
          <h3>收入趋势分析</h3>
          <div className="detail-actions-inline">
            <button className={type === "all" ? "status-chip active" : "status-chip"} onClick={() => setType("all")} type="button">全部</button>
            <button className={type === "income" ? "status-chip active" : "status-chip"} onClick={() => setType("income")} type="button">收入</button>
            <button className={type === "expense" ? "status-chip active" : "status-chip"} onClick={() => setType("expense")} type="button">支出</button>
          </div>
        </div>
        <div className="finance-template-bars">
          {rows.slice(0, 7).map((row, index) => {
            const absAmount = Math.abs(row.amount);
            const max = Math.max(...rows.slice(0, 7).map((item) => Math.abs(item.amount)), 1);
            const height = Math.max(30, Math.round((absAmount / max) * 100));
            return (
              <div key={row.id} className="finance-template-bar-col">
                <div className={`finance-template-bar ${index === 2 ? "active" : ""}`} style={{ height: `${height}%` }} />
                <span>{row.subtitle.split("·")[0].trim().slice(5)}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="finance-template-channel-section">
        <div className="finance-template-head">
          <h3>收支来源分布</h3>
          <button className="link-button" onClick={() => navigate("/revenue-breakdown")} type="button">更多图表</button>
        </div>
        <div className="finance-template-channel-grid">
          {channels.map((channel) => (
            <div key={channel.channel} className="finance-template-channel-card">
              <div className={`finance-template-channel-icon ${channel.tone ?? "primary"}`}>
                <span className="material-symbols-outlined">{channel.icon ?? "payments"}</span>
              </div>
              <div>
                <p>{channel.label ?? formatChannelLabel(channel.channel)}</p>
                <strong>{channel.amountFormatted}</strong>
                <span>占比 {channel.percent}%</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="finance-template-list-card">
        <div className="finance-template-head">
          <h3>近期流水明细</h3>
          <div className="detail-actions-inline">
            <button className="link-button" onClick={() => navigate("/financial-reports/daily")} type="button">日结报表</button>
            <button className="link-button" onClick={() => navigate("/financial-reports/monthly")} type="button">月结报表</button>
            <button className="link-button" onClick={() => navigate("/financial-reports/drill-down")} type="button">下钻明细</button>
            <button className="link-button" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出流水</button>
          </div>
        </div>
        <div className="finance-template-list">
          {rows.map((row) => (
            <button
              key={row.id}
              className="finance-template-list-item finance-list-button"
              onClick={() => openFinanceRowDetail(navigate, row)}
              type="button"
            >
              <div className={`finance-template-list-icon ${row.amount >= 0 ? "positive" : "negative"}`}>
                <span className="material-symbols-outlined">{row.amount >= 0 ? "payments" : "shopping_cart"}</span>
              </div>
              <div className="finance-template-list-main">
                <strong>{row.title}</strong>
                <p>{row.subtitle}</p>
              </div>
              <div className="finance-list-right">
                <strong className={row.amount >= 0 ? "positive" : "negative"}>{row.amountFormatted}</strong>
                <span className={row.statusTone === "success" ? "status-success" : "status-warning"}>{row.statusLabel}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function FinanceDrillDownPage({ financeReport }) {
  const navigate = useNavigate();
  const summary = financeReport?.summary;
  const rows = financeReport?.rows ?? [];
  const paidRows = rows.filter((row) => row.amount >= 0);
  const average = paidRows.length ? Math.round(paidRows.reduce((sum, row) => sum + row.amount, 0) / paidRows.length) : 0;

  return (
    <div className="finance-drill-template-page">
      <section className="finance-drill-template-summary">
        <div className="finance-drill-template-main">
          <span className="micro-label">本月收入汇总</span>
          <h2>{summary?.totalRevenueFormatted ?? "-"}</h2>
          <div className="finance-growth"><span className="material-symbols-outlined">trending_up</span><span>{summary?.growthRate ?? "-"}</span></div>
        </div>
        <div className="finance-drill-template-mini">
          <div className="metric-tile"><div><p>交易笔数</p><strong>{paidRows.length}</strong></div></div>
          <div className="metric-tile"><div><p>平均客单价</p><strong>{average.toLocaleString("en-US")} VUV</strong></div></div>
        </div>
      </section>
      <div className="finance-template-head">
        <div>
          <h3>流水穿透视图</h3>
          <span>查看最近收入与支出流水</span>
        </div>
        <button className="wide-action secondary" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出</button>
      </div>
      <section className="finance-template-list-card">
        <div className="finance-template-list">
          {paidRows.map((row) => (
            <button key={row.id} className="finance-template-list-item finance-list-button" onClick={() => openFinanceRowDetail(navigate, row)} type="button">
              <div className="finance-template-list-icon positive">
                <span className="material-symbols-outlined">{row.amount >= 0 ? "payments" : "shopping_cart"}</span>
              </div>
              <div className="finance-template-list-main finance-list-grow">
                <strong>{row.title}</strong>
                <p>{row.subtitle}</p>
              </div>
              <div className="finance-list-right">
                <strong className="positive">{row.amountFormatted}</strong>
                <span className={row.statusTone === "success" ? "status-success" : "status-warning"}>{row.statusLabel}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function openFinanceRowDetail(navigate, row) {
  if (row.orderNo) {
    navigate(`/orders/${row.orderNo}`);
    return;
  }

  if (row.procurementNo) {
    navigate(`/procurements/${row.procurementNo}`);
    return;
  }

  if (row.channel === "loss_expense") {
    navigate("/inventory/loss");
    return;
  }

  navigate("/refund-management");
}

function ClosingReportPage({ scope = "daily" }) {
  const navigate = useNavigate();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadReport() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson(`/api/finance/closing-report?scope=${scope}`);
        if (!ignore) setReport(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReport();
    return () => { ignore = true; };
  }, [scope]);

  if (loading) return <div className="empty-card">{scope === "monthly" ? "月结报表加载中..." : "日结报表加载中..."}</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  const summary = report?.summary ?? {};
  const rows = report?.rows ?? [];
  const breakdown = report?.breakdown ?? [];
  const periods = report?.periods ?? [];

  return (
    <div className="finance-template-page">
      <section className="finance-template-hero">
        <div className="finance-template-hero-main">
          <p>{scope === "monthly" ? "本月结算周期" : "今日结算周期"}</p>
          <h2>{report?.title ?? (scope === "monthly" ? "月结报表" : "日结报表")}</h2>
          <div className="finance-growth">
            <span className="material-symbols-outlined">calendar_month</span>
            <span>{scope === "monthly" ? (report?.month ?? "-") : (report?.date ?? "-")}</span>
          </div>
        </div>
        <div className="finance-template-mini-grid">
          <div className="finance-template-mini-card">
            <p>收入合计</p>
            <strong>{summary.incomeTotalFormatted ?? "-"}</strong>
            <div className="finance-mini-state success"><span className="material-symbols-outlined">payments</span><span>{summary.orderCount ?? 0} 单收入</span></div>
          </div>
          <div className="finance-template-mini-card">
            <p>支出合计</p>
            <strong>{summary.expenseTotalFormatted ?? "-"}</strong>
            <div className="finance-mini-state warning"><span className="material-symbols-outlined">receipt_long</span><span>{(summary.procurementCount ?? 0) + (summary.refundCount ?? 0) + (summary.lossCount ?? 0)} 笔支出</span></div>
          </div>
        </div>
      </section>

      <section className="finance-overview-template-metrics">
        <div className="report-metric-card primary"><p>净额</p><strong>{summary.netTotalFormatted ?? "-"}</strong><span>{scope === "monthly" ? "本月结余" : "今日结余"}</span></div>
        <div className="report-metric-card"><p>采购笔数</p><strong>{summary.procurementCount ?? 0}</strong><span>成本入账</span></div>
        <div className="report-metric-card tertiary"><p>退款/报损</p><strong>{(summary.refundCount ?? 0) + (summary.lossCount ?? 0)}</strong><span>异常支出</span></div>
      </section>

      <section className="finance-template-chart-card">
        <div className="finance-template-head">
          <h3>{scope === "monthly" ? "每日结算汇总" : "结算来源分布"}</h3>
          <button className="link-button" onClick={() => navigate("/financial-reports")} type="button">返回财务首页</button>
        </div>
        <div className="finance-template-list">
          {(scope === "monthly" ? periods : breakdown).map((item) => (
            <div key={item.date ?? item.channel} className="finance-template-list-item">
              <div className="finance-template-list-icon positive">
                <span className="material-symbols-outlined">{scope === "monthly" ? "calendar_today" : "pie_chart"}</span>
              </div>
              <div className="finance-template-list-main">
                <strong>{scope === "monthly" ? item.date : item.label}</strong>
                <p>{scope === "monthly" ? `${item.count} 笔流水` : `${item.count} 笔 · ${item.channel}`}</p>
              </div>
              <div className="finance-list-right">
                <strong className={(scope === "monthly" ? item.net : item.amount) >= 0 ? "positive" : "negative"}>{scope === "monthly" ? item.netFormatted : item.amountFormatted}</strong>
                <span className={(scope === "monthly" ? item.net : item.amount) >= 0 ? "status-success" : "status-warning"}>{scope === "monthly" ? "净额" : "汇总"}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="finance-template-list-card">
        <div className="finance-template-head">
          <h3>{scope === "monthly" ? "本月流水明细" : "今日流水明细"}</h3>
        </div>
        <div className="finance-template-list">
          {rows.map((row) => (
            <button key={row.id} className="finance-template-list-item finance-list-button" onClick={() => openFinanceRowDetail(navigate, row)} type="button">
              <div className={`finance-template-list-icon ${row.amount >= 0 ? "positive" : "negative"}`}>
                <span className="material-symbols-outlined">{row.amount >= 0 ? "payments" : "shopping_cart"}</span>
              </div>
              <div className="finance-template-list-main">
                <strong>{row.title}</strong>
                <p>{row.subtitle}</p>
              </div>
              <div className="finance-list-right">
                <strong className={row.amount >= 0 ? "positive" : "negative"}>{row.amountFormatted}</strong>
                <span className={row.statusTone === "success" ? "status-success" : "status-warning"}>{row.statusLabel}</span>
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function RefundManagementPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [refundReason, setRefundReason] = useState("维修后再次故障");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMethod, setRefundMethod] = useState("original");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadRefunds() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson("/api/refunds");
        if (!ignore) {
          setData(result);
          const firstId = result.rows[0]?.orderId ?? null;
          setSelectedId(firstId);
          setRefundAmount(result.rows[0]?.amount ?? "");
        }
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadRefunds();
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="empty-card">退款数据加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  const refundableOrders = data?.rows ?? [];
  const selected = refundableOrders.find((item) => item.orderId === selectedId) ?? refundableOrders[0];

  async function handleCreateRefund() {
    if (!selected) return;

    try {
      setSaving(true);
      setError("");
      const created = await fetchJson("/api/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: selected.orderId,
          amount: Number(refundAmount || selected.amount),
          reason: refundReason,
          method: refundMethod,
        }),
      });
      setData((current) => ({
        ...current,
        rows: [created, ...current.rows],
      }));
    } catch (refundError) {
      setError(refundError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="refund-page">
      <section className="refund-hero-card">
        <div>
          <span className="micro-label">退款中心</span>
          <h2>售后退款管理</h2>
          <p>统一处理已付款订单退款、原支付路径和审核说明</p>
        </div>
        <div className="refund-hero-metrics">
          <div><span>已完成订单</span><strong>{data?.metrics?.completedOrders ?? refundableOrders.length}</strong></div>
          <div><span>退款总额</span><strong>{data?.metrics?.totalRefundsFormatted ?? "-"}</strong></div>
        </div>
      </section>
      <div className="refund-layout">
        <section className="refund-order-list">
          <div className="section-title-row">
            <h3>已完成订单</h3>
            <span>最近 30 天</span>
          </div>
          <div className="settings-staff-list">
            {refundableOrders.map((order) => (
              <div key={order.id} className="refund-order-card">
                <div className="refund-order-head">
                  <div>
                    <strong>{order.title}</strong>
                    <p>工单: #{order.orderNo} · {order.createdLabel ?? order.scheduledDate}</p>
                  </div>
                  <span className={order.status === "approved" ? "soft-badge" : "warning-badge"}>{order.status === "approved" ? "已批准" : "待处理"}</span>
                </div>
                <div className="refund-order-foot">
                  <div>
                    <span className="micro-label">金额</span>
                    <strong>{order.amountFormatted}</strong>
                  </div>
                  <div className="detail-actions-inline">
                    <button className="wide-action secondary" onClick={() => {
                      setSelectedId(order.orderId);
                      setRefundAmount(order.amount);
                    }} type="button">发起退款</button>
                    <button className="small-action-button" onClick={() => navigate(`/orders/${order.orderId}`)} type="button">查看工单</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="refund-form-card">
          <div className="refund-form-head">
            <h3>退款申请表</h3>
            <p>请核对订单信息并选择退款路径</p>
          </div>
          <div className="refund-info-grid">
            <InfoTile label="订单编号" value={`#${selected?.orderNo ?? "-"}`} />
            <InfoTile label="原支付方式" value={selected?.method === "store_credit" ? "门店余额" : "现金"} />
          </div>
          <div className="sheet-form compact">
            <Field label="退款原因" full>
              <select onChange={(event) => setRefundReason(event.target.value)} value={refundReason}>
                <option value="维修后再次故障">维修后再次故障</option>
                <option value="零件不符">零件不符</option>
                <option value="客户取消">客户取消</option>
                <option value="服务延时">服务延时</option>
              </select>
            </Field>
            <Field label="退款金额 (VUV)" full><input onChange={(event) => setRefundAmount(event.target.value)} type="number" value={refundAmount} /></Field>
            <Field label="说明" full><textarea onChange={(event) => setRefundReason(event.target.value)} value={refundReason} /></Field>
          </div>
          <div className="refund-path-list">
            <label className={refundMethod === "original" ? "refund-path-option active" : "refund-path-option"}><input checked={refundMethod === "original"} name="refund-path" onChange={() => setRefundMethod("original")} type="radio" /><div><strong>现金退款</strong><p>柜台即时处理</p></div><span className="material-symbols-outlined">payments</span></label>
            <label className={refundMethod === "bank" ? "refund-path-option active" : "refund-path-option"}><input checked={refundMethod === "bank"} name="refund-path" onChange={() => setRefundMethod("bank")} type="radio" /><div><strong>银行转账</strong><p>1-2 个工作日</p></div><span className="material-symbols-outlined">account_balance</span></label>
            <label className={refundMethod === "store_credit" ? "refund-path-option active" : "refund-path-option"}><input checked={refundMethod === "store_credit"} name="refund-path" onChange={() => setRefundMethod("store_credit")} type="radio" /><div><strong>门店余额</strong><p>下次维修使用</p></div><span className="material-symbols-outlined">credit_card</span></label>
          </div>
          <button className="primary-submit" disabled={saving || !selected} onClick={handleCreateRefund} type="button">{saving ? "提交中..." : "提交退款申请"}</button>
        </section>
      </div>
    </div>
  );
}

function AuditLogsPage() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const auditTypeLabel = {
    Refund: "退款",
    Modification: "修改",
    "System Update": "系统更新",
    Inventory: "库存",
  };

  useEffect(() => {
    let ignore = false;
    async function loadLogs() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson("/api/audit/logs");
        if (!ignore) setLogs(result.rows);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadLogs();
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="empty-card">审计日志加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  return (
    <div className="audit-page">
      <div className="audit-header">
        <div>
          <span className="micro-label">系统完整性</span>
          <h2>审计日志</h2>
          <p>实时查看员工操作记录和系统改动情况。</p>
        </div>
        <div className="audit-header-actions">
          <button className="wide-action secondary" onClick={() => window.open("/api/receipts/export.csv", "_blank")} type="button">导出记录</button>
          <button className="wide-action primary" onClick={() => navigate("/audit-resolution")} type="button">核查完整性</button>
        </div>
      </div>
      <section className="audit-filter-grid">
        <div className="audit-filter-card"><span className="micro-label">时间范围</span><strong>最近 7 天</strong></div>
        <div className="audit-filter-card"><span className="micro-label">员工范围</span><strong>全部人员</strong></div>
        <div className="audit-filter-card"><span className="micro-label">动作类型</span><strong>全部操作</strong></div>
        <div className="audit-filter-card primary"><span className="micro-label">活跃日志</span><strong>{logs.length * 321}</strong></div>
      </section>
      <section className="settings-staff-list">
        {logs.map((log) => (
          <button key={log.id} className={`audit-log-card ${log.tone}`} onClick={() => navigate("/audit-history")} type="button">
            <div className={`audit-log-icon ${log.tone}`}><span className="material-symbols-outlined">{log.type === "Refund" ? "payments" : log.type === "Modification" ? "edit_square" : log.type === "System Update" ? "settings_account_box" : "inventory_2"}</span></div>
            <div className="audit-log-body">
              <div className="audit-log-top">
                <span>{log.actor}</span>
                <em>{auditTypeLabel[log.type] ?? log.type}</em>
              </div>
              <p>{log.message}</p>
            </div>
            <div className="audit-log-side">
              <span>{log.meta}</span>
              <span className="material-symbols-outlined">chevron_right</span>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}

function AuditHistoryPage({ parts, movements }) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("全部盘点");
  const audits = parts.slice(0, 4).map((part, index) => ({
    id: `AD-2024052${index}`,
    discrepancies: index === 0 ? 7 : index === 1 ? 0 : index === 2 ? 3 : 1,
    status: index === 0 ? "发现差异" : index === 1 ? "已清账" : index === 2 ? "处理中" : "待复核",
    date: movements[index]?.createdAt ?? `2026-03-2${index}`,
    auditor: ["Jean-Paul V.", "Marie T.", "管理员", "Lina K."][index],
    value: `${(part.unitPrice * Math.max(part.stock, 1)).toLocaleString("en-US")} VUV`,
    checked: `${Math.max(part.stock, 1)} 件`,
  }));
  const visibleAudits = audits.filter((audit) => {
    if (filter === "全部盘点") return true;
    if (filter === "已完成") return audit.status === "已清账";
    if (filter === "进行中") return audit.status !== "已清账";
    return true;
  });

  return (
    <div className="audit-page">
      <SearchBar value="" onChange={() => {}} placeholder="搜索盘点单号或技师..." />
      <nav className="status-strip">
        {["全部盘点", "已完成", "进行中"].map((item) => (
          <button key={item} className={filter === item ? "status-chip active" : "status-chip"} onClick={() => setFilter(item)} type="button">{item}</button>
        ))}
      </nav>
      <section className="audit-metric-grid">
        <MetricTile label="盘点总数" value={128} icon="inventory_2" tone="primary" />
        <MetricTile label="待处理" value={4} icon="schedule" tone="warning" />
        <MetricTile label="高差异率" value="12%" icon="warning" tone="danger" />
        <MetricTile label="准确率" value="94.2%" icon="verified" tone="primary" />
      </section>
      <section className="settings-staff-list">
        {visibleAudits.map((audit) => (
          <button key={audit.id} className="audit-history-card" onClick={() => navigate("/audit-resolution")} type="button">
            <div className="audit-log-icon primary"><span className="material-symbols-outlined">{audit.status === "已清账" ? "assignment_turned_in" : audit.status === "处理中" ? "history_edu" : "inventory_2"}</span></div>
            <div className="audit-log-body">
              <div className="audit-log-top">
                <span>{audit.id}</span>
                <em>{audit.status}</em>
              </div>
              <p>{audit.date} · {audit.auditor}</p>
            </div>
            <div className="audit-log-side">
              <strong>{audit.checked}</strong>
              <span>{audit.value}</span>
            </div>
          </button>
        ))}
      </section>
    </div>
  );
}

function AuditResolutionPage({ parts }) {
  const navigate = useNavigate();
  const part = parts[0];
  return (
    <div className="audit-resolution-page">
      <div className="message-banner error">检测到库存差异，请确认并处理。</div>
      <section className="audit-resolution-card">
        <div className="audit-resolution-top">
          <div className="add-part-thumb"><span className="material-symbols-outlined">inventory_2</span></div>
          <div>
            <h3>{part?.name ?? "iPhone 14 屏幕组件"}</h3>
            <p>SKU: {part?.sku ?? "-"}</p>
          </div>
        </div>
        <div className="audit-resolution-metrics">
          <div><span className="micro-label">系统库存</span><strong>{part?.stock ?? 2}</strong></div>
          <div><span className="micro-label">实盘数量</span><strong className="text-danger">0</strong></div>
          <div><span className="micro-label">库存价值损失</span><strong>{((part?.unitPrice ?? 15000) * Math.max(part?.stock ?? 1, 1)).toLocaleString("en-US")} VUV</strong></div>
        </div>
      </section>
      <section className="settings-staff-list">
        <label className="resolution-option active"><input defaultChecked name="reason" type="radio" /><div><strong>物品损坏</strong><p>零件在存储或移动过程中受损</p></div></label>
        <label className="resolution-option"><input name="reason" type="radio" /><div><strong>物品丢失</strong><p>无法在指定库位找到实物</p></div></label>
        <label className="resolution-option"><input name="reason" type="radio" /><div><strong>行政错误</strong><p>入库或出库单据录入错误</p></div></label>
      </section>
      <section className="detail-block">
        <div className="detail-block-head"><h4>备注说明</h4></div>
        <textarea className="resolution-note" defaultValue="请录入差异详细说明..." />
      </section>
      <button className="primary-submit" onClick={() => navigate("/inventory/adjustment")} type="button">调整库存</button>
    </div>
  );
}

function ReviewsSummaryPage() {
  const navigate = useNavigate();
  const [sortMode, setSortMode] = useState("最新");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ignore = false;
    async function loadReviews() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson("/api/reviews");
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReviews();
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="empty-card">评价数据加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  const reviewCount = data?.summary?.totalReviews ?? 0;
  const featured = [...(data?.rows ?? [])].sort((left, right) => {
    if (sortMode === "评分") return Number(right.rating) - Number(left.rating);
    return String(right.createdLabel).localeCompare(String(left.createdLabel));
  });

  return (
    <div className="reviews-page">
      <section className="reviews-summary-grid">
        <div className="reviews-score-card">
          <div className="reviews-score-value">{data?.summary?.averageRating ?? "0.0"}</div>
          <div className="reviews-stars">{[1, 2, 3, 4].map((star) => <span key={star} className="material-symbols-outlined filled">star</span>)}<span className="material-symbols-outlined filled">star_half</span></div>
          <p>基于 {reviewCount} 条真实评价</p>
        </div>
        <div className="reviews-bars-card">
          {(data?.summary?.distribution ?? []).map((item) => (
            <div key={item.rating} className="rating-bar-row">
              <span>{item.rating}</span>
              <div className="rating-bar"><div style={{ width: `${item.percent}%` }} /></div>
              <em>{item.percent}%</em>
            </div>
          ))}
        </div>
        <div className="reviews-highlight-card">
          <h3>满意度高达 {reviewCount ? Math.max(90, Math.round((data.summary.repliedCount / reviewCount) * 100)) : 0}%</h3>
          <p>技师团队保持高质量交付和快速响应。</p>
          <button className="wide-action secondary" onClick={() => navigate("/reports/advanced")} type="button">查看详情报告</button>
        </div>
      </section>
      <div className="section-title-row">
        <h3>客户评价列表</h3>
        <div className="detail-actions-inline">
          <button className="wide-action secondary" onClick={() => navigate("/reviews/manage")} type="button">筛选</button>
          <button className="wide-action secondary" onClick={() => setSortMode((current) => current === "最新" ? "评分" : "最新")} type="button">{sortMode}</button>
        </div>
      </div>
      <section className="settings-staff-list">
        {featured.map((item) => (
          <article key={item.id} className="review-card">
            <div className="review-card-top">
              <div className="review-user">
                <div className="avatar-circle">{item.customerName.slice(0, 1)}</div>
                <div>
                  <strong>{item.customerName}</strong>
                  <div className="review-meta"><span>工单 #{item.orderNo}</span><span>{item.createdLabel}</span></div>
                </div>
              </div>
              <span className={item.status === "已回复" ? "soft-badge" : "warning-badge"}>{item.status}</span>
            </div>
            <div className="reviews-stars inline">{Array.from({ length: item.rating }).map((_, i) => <span key={i} className="material-symbols-outlined filled">star</span>)}</div>
            <p>{item.review}</p>
            {item.reply ? <div className="review-reply-box"><div className="review-reply-head"><span className="material-symbols-outlined">support_agent</span><span>技术主管回复</span></div><p>{item.reply}</p></div> : null}
          </article>
        ))}
      </section>
    </div>
  );
}

function ReviewsManagePage() {
  const [filter, setFilter] = useState("全部评价");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState({});
  const [savingId, setSavingId] = useState(null);

  useEffect(() => {
    let ignore = false;
    async function loadReviews() {
      try {
        setLoading(true);
        setError("");
        const result = await fetchJson("/api/reviews");
        if (!ignore) setData(result);
      } catch (loadError) {
        if (!ignore) setError(loadError.message);
      } finally {
        if (!ignore) setLoading(false);
      }
    }
    loadReviews();
    return () => { ignore = true; };
  }, []);

  if (loading) return <div className="empty-card">评价管理加载中...</div>;
  if (error) return <div className="message-banner error">{error}</div>;

  const items = data?.rows ?? [];
  const visibleItems = items.filter((item) => {
    if (filter === "全部评价") return true;
    if (filter === "待回复") return item.status === "待回复";
    if (filter === "差评预警") return Number(item.rating) <= 3;
    return true;
  });

  async function handleReply(item) {
    const reply = (drafts[item.id] ?? item.reply ?? "").trim();
    if (!reply) {
      setError("请输入回复内容。");
      return;
    }

    try {
      setSavingId(item.id);
      setError("");
      const updated = await fetchJson(`/api/reviews/${item.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply }),
      });
      setData((current) => ({
        ...current,
        rows: current.rows.map((row) => (row.id === updated.id ? updated : row)),
      }));
    } catch (replyError) {
      setError(replyError.message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="reviews-page">
      <section className="reviews-summary-grid alt">
        <div className="reviews-score-card">
          <span className="micro-label">总体满意度</span>
          <div className="reviews-score-value small">{data?.summary?.averageRating ?? "0.0"} / 5.0</div>
          <p>基于 {data?.summary?.totalReviews ?? 0} 条真实评价。</p>
        </div>
        <div className="reviews-highlight-card">
          <h3>已回复 {data?.summary?.repliedCount ?? 0} 条</h3>
          <p>平均响应时间: 4.2 小时</p>
          <button className="wide-action secondary" onClick={() => {
            const pending = items.find((item) => item.status === "待回复");
            if (pending) {
              setFilter("待回复");
              setDrafts((current) => ({ ...current, [pending.id]: current[pending.id] ?? "您好，感谢您的反馈，我们已经安排专员跟进处理。" }));
            }
          }} type="button">查看建议回复</button>
        </div>
      </section>
      <div className="section-title-row">
        <h3>最近评价</h3>
        <nav className="status-strip compact">
          {["全部评价", "待回复", "差评预警"].map((item) => (
            <button key={item} className={filter === item ? "status-chip active" : "status-chip"} onClick={() => setFilter(item)} type="button">{item}</button>
          ))}
        </nav>
      </div>
      <section className="settings-staff-list">
        {visibleItems.map((item) => (
          <article key={item.id} className="review-card">
            <div className="review-card-top">
              <div className="review-user">
                <div className="avatar-circle">{item.customerName.slice(0, 1)}</div>
                <div>
                  <strong>{item.customerName}</strong>
                  <div className="review-meta"><span>工单 #{item.orderNo}</span><span>{item.createdLabel}</span></div>
                  <div className="reviews-stars inline">{Array.from({ length: item.rating }).map((_, i) => <span key={i} className="material-symbols-outlined filled">star</span>)}</div>
                </div>
              </div>
              <span className={item.status === "待回复" ? "warning-badge" : "soft-badge"}>{item.status}</span>
            </div>
            <p>"{item.review}"</p>
            <div className="reply-compose-box">
              <textarea onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} placeholder={`输入给 ${item.customerName} 的回复内容...`} value={drafts[item.id] ?? item.reply ?? ""} />
              <button className="wide-action primary" disabled={savingId === item.id} onClick={() => handleReply(item)} type="button">{item.reply ? "更新回复" : "发送回复"}</button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function ReportsOverviewPage({ financeReport, staffPerformance }) {
  const navigate = useNavigate();
  const summary = financeReport?.summary;
  const top = staffPerformance?.topPerformer;
  const categorySplit = financeReport?.categorySplit ?? [];
  const totalOrdersCompleted = staffPerformance?.rows?.reduce((sum, row) => sum + row.completedOrders, 0) ?? 0;
  const averageCompletedByTech = staffPerformance?.rows?.length ? (totalOrdersCompleted / staffPerformance.rows.length).toFixed(1) : "0.0";
  return (
    <div className="finance-overview-template-page">
      <section className="finance-overview-template-hero">
        <div>
          <span className="micro-label">经营数据总览</span>
          <h2>经营分析总览</h2>
          <p>收入、完工效率和服务结构的关键洞察</p>
        </div>
        <button className="wide-action secondary" onClick={() => navigate("/reports/advanced")} type="button">高级视图</button>
      </section>
      <section className="finance-overview-template-metrics">
        <div className="report-metric-card primary"><p>总营收</p><strong>{summary?.totalRevenueFormatted ?? "-"}</strong><span>+12.5%</span></div>
        <div className="report-metric-card"><p>完工工单</p><strong>{totalOrdersCompleted}</strong><span>{summary?.transactionCount ?? 0} 笔总交易</span></div>
        <div className="report-metric-card tertiary"><p>平均客单价</p><strong>{summary?.averageTicketFormatted ?? "-"}</strong><span>真实工单均价</span></div>
      </section>
      <section className="finance-overview-template-grid">
        <div className="finance-template-chart-card">
          <div className="finance-template-head"><h3>收入增长</h3><button className="link-button" onClick={() => navigate("/revenue-analysis")} type="button">分析</button></div>
          <div className="finance-template-bars">{financeReport.rows.slice(0, 7).map((row, index) => <div key={row.id} className="finance-template-bar-col"><div className={`finance-template-bar ${index === 3 ? "active" : ""}`} style={{ height: `${Math.max(30, Math.abs(row.amount) / 2500)}%` }} /><span>{row.subtitle.split("·")[0].trim().slice(5)}</span></div>)}</div>
        </div>
        <div className="finance-overview-template-split">
          <h3>分类占比</h3>
          <div className="finance-overview-template-donut" />
          <div className="finance-overview-template-legend">
            {categorySplit.slice(0, 3).map((item, index) => (
              <div key={item.name}>
                <span className={`dot ${index === 0 ? "primary" : index === 1 ? "tertiary" : "blue"}`} /> {item.name} <strong>{item.percent}%</strong>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="finance-overview-template-mini-grid">
        <div className="detail-block"><div className="detail-block-head"><h4>完工效率</h4><span className="material-symbols-outlined text-primary">timer</span></div><p>当前人均完工 {averageCompletedByTech} 单，已完成工单 {totalOrdersCompleted} 单。</p></div>
        <div className="detail-block"><div className="detail-block-head"><h4>本月之星</h4><span className="material-symbols-outlined text-primary">military_tech</span></div><p>{top?.staffName ?? "-"} 本月已完成 {top?.completedOrders ?? 0} 单维修，表现领先。</p></div>
        <div className="detail-block"><div className="detail-block-head"><h4>更多报表</h4><span className="material-symbols-outlined text-primary">insights</span></div><div className="profile-menu"><button onClick={() => navigate("/reports/advanced")} type="button"><span className="material-symbols-outlined">analytics</span><span>高级视图</span></button><button onClick={() => navigate("/reviews")} type="button"><span className="material-symbols-outlined">reviews</span><span>客户评价</span></button></div></div>
      </section>
    </div>
  );
}

function ReportsAdvancedPage({ financeReport }) {
  const navigate = useNavigate();
  const rows = financeReport?.rows ?? [];
  const positiveRows = rows.filter((row) => row.amount >= 0);
  const monthlyBars = rows.slice(0, 6).map((row, index) => {
    const max = Math.max(...rows.slice(0, 6).map((item) => Math.abs(item.amount)), 1);
    return {
      label: row.subtitle.split("·")[0].trim().slice(5) || `M${index + 1}`,
      height: `${Math.max(30, Math.round((Math.abs(row.amount) / max) * 100))}%`,
    };
  });
  const avgCompletedValue = positiveRows.length ? Math.round(positiveRows.reduce((sum, row) => sum + row.amount, 0) / positiveRows.length) : 0;
  return (
    <div className="finance-advanced-template-page">
      <section className="finance-overview-template-metrics wide">
        <div className="report-metric-card primary"><p>累计营收</p><strong>{(rows.reduce((sum, row) => sum + Math.max(row.amount, 0), 0)).toLocaleString("en-US")} VUV</strong><span>{financeReport?.summary?.transactionCount ?? 0} 笔交易</span></div>
        <div className="report-metric-card"><p>完工效率</p><strong>{avgCompletedValue.toLocaleString("en-US")} VUV</strong><span>平均完工客单价</span></div>
      </section>
      <section className="finance-overview-template-grid alt">
        <div className="finance-template-chart-card">
          <div className="finance-template-head"><h3>收入趋势</h3><button className="link-button" onClick={() => navigate("/revenue-breakdown")} type="button">收入拆解</button></div>
          <div className="finance-template-bars monthly">{monthlyBars.map((item, index) => <div key={item.label} className="finance-template-bar-col"><div className={`finance-template-bar ${index === 3 ? "active" : ""}`} style={{ height: item.height }} /><span>{item.label}</span></div>)}</div>
        </div>
        <div className="finance-overview-template-split">
          <h3>收支来源</h3>
          <div className="finance-overview-template-payment-list">
            {financeReport.channels.map((channel) => <div key={channel.channel}><span>{channel.label ?? formatChannelLabel(channel.channel)}</span><strong>{channel.percent}%</strong></div>)}
          </div>
        </div>
      </section>
    </div>
  );
}

function RevenueAnalysisPage({ financeReport }) {
  const rows = financeReport?.rows ?? [];
  const channels = financeReport?.channels ?? [];
  const topServices = financeReport?.topServices ?? [];
  return (
    <div className="revenue-analysis-template-page">
      <section className="revenue-analysis-template-summary">
        <p>本月总收入</p>
        <strong>{financeReport?.summary?.totalRevenueFormatted ?? "-"}</strong>
        <span>对比上月增加 {financeReport?.summary?.growthRate ?? "-"}</span>
      </section>
      <section className="finance-template-chart-card">
        <div className="finance-template-head"><h3>每日营收趋势</h3></div>
        <div className="finance-template-bars">{rows.slice(0, 7).map((row, index) => <div key={row.id} className="finance-template-bar-col"><div className={`finance-template-bar ${index === 5 ? "active" : ""}`} style={{ height: `${Math.max(30, Math.abs(row.amount) / 2500)}%` }} /><span>{row.subtitle.split("·")[0].trim().slice(5)}</span></div>)}</div>
      </section>
      <section className="revenue-analysis-template-grid">
        <div className="revenue-analysis-template-card">
          <h4>收支来源</h4>
          <div className="finance-overview-template-payment-list">{channels.map((channel) => <div key={channel.channel}><span>{channel.label ?? formatChannelLabel(channel.channel)}</span><strong>{channel.percent}%</strong></div>)}</div>
        </div>
        <div className="revenue-analysis-template-image">
          <div className="revenue-analysis-template-image-copy">
            <p>工作效率</p>
            <strong>稳步增长</strong>
          </div>
        </div>
      </section>
      <section className="revenue-analysis-template-card">
        <div className="finance-template-head"><h4>热门维修服务</h4></div>
        <div className="revenue-analysis-template-service-list">
          {topServices.map((item) => (
            <div key={item.name} className="revenue-analysis-template-service">
              <div className="revenue-analysis-template-service-icon">
                <span className="material-symbols-outlined">{item.name.includes("屏") ? "smartphone" : item.name.includes("电池") ? "battery_charging_full" : "construction"}</span>
              </div>
              <div>
                <strong>{item.name}</strong>
                <p>{item.count ?? 0} 次服务</p>
              </div>
              <span>{item.amountFormatted}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RevenueBreakdownPage({ financeReport }) {
  const [range, setRange] = useState("7天");
  const channels = financeReport?.channels ?? [];
  const rows = financeReport?.rows ?? [];
  const totalRevenue = financeReport?.summary?.totalRevenue ?? 0;
  const targetRevenue = Math.max(totalRevenue, 190000);
  const targetPercent = targetRevenue ? Math.round((totalRevenue / targetRevenue) * 100) : 0;
  const trendRows = rows.slice(0, range === "30天" ? 10 : 7);
  const max = Math.max(...trendRows.map((item) => Math.abs(item.amount)), 1);
  return (
    <div className="revenue-breakdown-template-page">
      <section className="finance-overview-template-metrics wide">
        <div className="report-metric-card primary"><p>本月总收入</p><strong>{financeReport?.summary?.totalRevenueFormatted ?? "-"}</strong><span>+12.4% 对比上月同期</span></div>
        <div className="report-metric-card"><p>月度目标进度</p><strong>{targetPercent}%</strong><span>目标: {targetRevenue.toLocaleString("en-US")} VUV</span></div>
      </section>
      <section className="finance-template-chart-card">
        <div className="finance-template-head"><h3>每日趋势</h3><nav className="status-strip compact"><button className={range === "7天" ? "status-chip active" : "status-chip"} onClick={() => setRange("7天")} type="button">7天</button><button className={range === "30天" ? "status-chip active" : "status-chip"} onClick={() => setRange("30天")} type="button">30天</button></nav></div>
        <div className="finance-template-bars">
          {trendRows.map((row, index) => (
            <div key={row.id} className="finance-template-bar-col">
              <div className={`finance-template-bar ${index === 3 ? "active" : ""}`} style={{ height: `${Math.max(28, Math.round((Math.abs(row.amount) / max) * 100))}%` }} />
              <span>{row.subtitle.split("·")[0].trim().slice(5)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="revenue-breakdown-template-grid">
        <div className="revenue-analysis-template-card">
          <h4>来源占比</h4>
          <div className="finance-overview-template-payment-list">{channels.map((channel) => <div key={channel.channel}><span>{channel.label ?? formatChannelLabel(channel.channel)}</span><strong>{channel.amountFormatted}</strong></div>)}</div>
        </div>
        <div className="revenue-analysis-template-card">
          <h4>最近流水</h4>
          <div className="finance-overview-template-payment-list">{rows.slice(0, 4).map((row) => <div key={row.id}><span>{row.title}</span><strong>{row.amountFormatted}</strong></div>)}</div>
        </div>
      </section>
    </div>
  );
}

function SearchBar({ value, onChange, placeholder }) {
  return (
    <section className="search-panel">
      <span className="material-symbols-outlined search-icon">search</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </section>
  );
}

function StatusTabs({ selectedStatus, setSelectedStatus, onSearch }) {
  return (
    <nav className="status-strip">
      {statusTabs.map((tab) => (
        <button
          key={tab.value}
          className={tab.value === selectedStatus ? "status-chip active" : "status-chip"}
          onClick={() => {
            setSelectedStatus(tab.value);
            onSearch(tab.value);
          }}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function MetricTile({ label, value, icon, tone }) {
  return (
    <div className="metric-tile">
      <div className={`metric-icon ${tone}`}>
        <span className="material-symbols-outlined">{icon}</span>
      </div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function QueueCard({ order, onOpen, onAction, working }) {
  const progress = order.progress ?? queueProgress(order);
  const tone = order.priority === "urgent" ? "urgent" : order.status === "completed" || order.status === "picked_up" ? "completed" : "active";
  const elapsed = order.elapsedLabel ?? (order.status === "pending" ? "已等待 1小时12分" : order.status === "completed" ? "已完成" : "已进行 45 分钟");
  const badge = order.priorityLabel ?? (order.status === "pending" ? "加急" : order.status === "completed" ? "完成" : "正常");
  const footerText = order.footerText ?? (order.status === "pending" ? `已分配: ${order.technician}` : order.status === "completed" ? `完结技师: ${order.technician}` : `在店时长: ${elapsed}`);
  const isBusy = String(working ?? "").startsWith(`${order.id}:`);
  return (
    <div className={`queue-card ${tone}`}>
      <div className="queue-top">
        <div className="device-wrap">
          <div className={`queue-icon ${tone}`}>
            <span className="material-symbols-outlined">{resolveDeviceIcon(order.deviceName)}</span>
          </div>
          <div>
            <h3>{order.deviceName}</h3>
            <p>#{order.orderNo} · <span className="queue-emphasis">{elapsed}</span></p>
          </div>
        </div>
        <div className="queue-side">
          <span className={`mini-state ${tone}`}>{badge}</span>
          <p>{order.amountFormatted}</p>
        </div>
      </div>
      <div className="queue-progress-wrap">
        <div className="progress-meta">
          <span>{statusChinese[order.status]}</span>
          <span>{progress}%</span>
        </div>
        <div className="progress-bar queue">
          <div className={tone} style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="queue-foot">
        <p>{footerText}</p>
        <button className="queue-detail-button" onClick={onOpen} type="button">详情</button>
      </div>
      <div className="action-row">
        {order.status === "pending" ? (
          <>
            <button className="wide-action secondary" disabled={isBusy} onClick={() => onAction(order.id, "accept")} type="button">
              {working === `${order.id}:accept` ? "处理中..." : "接单"}
            </button>
            <button className="wide-action primary" disabled={isBusy} onClick={() => onAction(order.id, "start")} type="button">
              {working === `${order.id}:start` ? "处理中..." : "开始维修"}
            </button>
          </>
        ) : null}
        {order.status === "in_progress" ? (
          <button className="wide-action primary" disabled={isBusy} onClick={() => onAction(order.id, "complete")} type="button">
            {working === `${order.id}:complete` ? "处理中..." : "标记完成"}
          </button>
        ) : null}
        {(order.status === "completed" || order.status === "picked_up") ? (
          <button className="wide-action secondary" onClick={onOpen} type="button">查看工单</button>
        ) : null}
      </div>
    </div>
  );
}

function BottomNav() {
  return (
    <nav className="bottom-nav">
      {primaryNavItems.map((item) => (
        <NavLink key={item.to} className={({ isActive }) => (isActive ? "nav-item active" : "nav-item")} to={item.to}>
          <span className="material-symbols-outlined">{item.icon}</span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function Drawer({ title, onClose, children }) {
  return (
    <div className="drawer-backdrop" onClick={onClose} role="presentation">
      <div className="drawer-sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="icon-button" onClick={onClose} type="button">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, full = false, children }) {
  return (
    <label className={full ? "sheet-field full" : "sheet-field"}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function InfoMini({ label, value }) {
  return (
    <div className="info-mini">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoTile({ label, value }) {
  return (
    <div className="info-tile">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function LoadingState({ label = "正在加载..." }) {
  return (
    <div className="empty-shell loading-shell">
      <div className="empty-shell-card">
        <span className="material-symbols-outlined">progress_activity</span>
        <h3>{label}</h3>
      </div>
    </div>
  );
}

function EmptyState({ title = "暂无数据", message = "当前没有可显示的内容。" }) {
  return (
    <div className="empty-shell">
      <div className="empty-shell-card">
        <span className="material-symbols-outlined">inbox</span>
        <h3>{title}</h3>
        <p>{message}</p>
      </div>
    </div>
  );
}

function resolvePartIcon(partName) {
  const normalized = partName.toLowerCase();
  if (normalized.includes("battery")) return "battery_charging_full";
  if (normalized.includes("screen") || normalized.includes("display") || normalized.includes("oled")) return "smartphone";
  if (normalized.includes("port") || normalized.includes("flex")) return "charging_station";
  return "inventory_2";
}

function resolveDeviceIcon(deviceName) {
  const normalized = deviceName.toLowerCase();
  const matched = Object.entries(iconByDevice).find(([keyword]) => normalized.includes(keyword));
  return matched?.[1] ?? "devices";
}

function queueProgress(order) {
  if (order.status === "completed" || order.status === "picked_up") return 100;
  if (order.status === "pending") return 15;
  return 65;
}

export default App;
