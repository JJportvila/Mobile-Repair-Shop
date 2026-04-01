import { looksBrokenText, sanitizeIssueSummary } from "./order-display.js";

const completionChecklistLabels = {
  display: "显示与触控",
  battery: "充电与电池稳定性",
  signal: "信号与 Wi‑Fi 连接",
  camera: "摄像头与音频功能",
  cleaning: "外观清洁与封装检查",
  screen: "屏幕显示与触控",
  touch: "触控灵敏度",
  speaker: "扬声器与听筒",
  network: "网络与通话",
};

const executionChecklistLabels = {
  display: "显示屏检查",
  face_id: "面容识别",
  truetone: "原彩显示",
  battery: "电池健康",
  seal: "密封完整性",
};

function normalizeChecklistItem(item, fallbackLabelMap, checkedFallback = false) {
  const id = String(item?.id ?? "").trim();
  if (!id) return null;
  const fallbackLabel = fallbackLabelMap[id] ?? id;
  const label = looksBrokenText(item?.label) ? fallbackLabel : String(item.label).trim();
  return {
    id,
    label,
    checked: Boolean(item?.checked ?? item?.done ?? checkedFallback),
  };
}

export function normalizeCompletionChecklist(checklist = [], order = {}) {
  const source = Array.isArray(checklist) && checklist.length ? checklist : getDefaultCompletionChecklist(order);
  return source
    .map((item) => normalizeChecklistItem(item, completionChecklistLabels, true))
    .filter(Boolean);
}

export function normalizeExecutionChecklist(checklist = []) {
  const source = Array.isArray(checklist) && checklist.length ? checklist : getDefaultExecutionChecklist();
  return source
    .map((item) => normalizeChecklistItem(item, executionChecklistLabels, false))
    .filter(Boolean);
}

export function getDefaultCommunicationMessages(order) {
  const issue = sanitizeIssueSummary(order);
  return [
    {
      id: `${order.id}-seed-1`,
      sender: "customer",
      type: "text",
      time: `${order.scheduledDate} 09:15`,
      body: `你好，我的 ${order.deviceName} 今天早上开始出现 ${issue.slice(0, 18)}，今天可以处理吗？`,
    },
    {
      id: `${order.id}-seed-2`,
      sender: "staff",
      type: "text",
      time: `${order.scheduledDate} 09:22`,
      body: `可以的，我们已经安排 ${order.technician} 进行检测，初步判断还需要进一步拆机确认。`,
    },
    {
      id: `${order.id}-seed-3`,
      sender: "internal",
      type: "note",
      time: `${order.scheduledDate} 09:40`,
      body: `${order.notes || "请优先核对库存并准备报价。"} 请同步核对库存和客户报价。`,
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
      body: "已发送语音说明。",
      duration: "0:12",
    },
  ];
}

export function getDefaultCompletionChecklist(order) {
  return normalizeCompletionChecklist([
    { id: "display", label: "显示与触控", checked: true },
    { id: "battery", label: "充电与电池稳定性", checked: true },
    { id: "signal", label: "信号与 Wi‑Fi 连接", checked: true },
    { id: "camera", label: "摄像头与音频功能", checked: true },
    { id: "cleaning", label: "外观清洁与封装检查", checked: order.status !== "pending" },
  ], order);
}

export function getDefaultExecutionChecklist() {
  return normalizeExecutionChecklist([
    { id: "display", label: "显示屏检查", checked: true },
    { id: "face_id", label: "面容识别", checked: true },
    { id: "truetone", label: "原彩显示", checked: false },
    { id: "battery", label: "电池健康", checked: false },
    { id: "seal", label: "密封完整性", checked: false },
  ]);
}

export function getExecutionPhaseLabel(phase) {
  return phase === "diagnosis"
    ? "检测中"
    : phase === "repair"
      ? "维修中"
      : phase === "qa"
        ? "质检中"
        : phase === "completed"
          ? "已完成"
          : "维修中";
}

export function getDefaultUploadPhotos() {
  return [
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDn7g_GFjZ1XweOpPCpvDcL7OLpLH6WsZ-8mhDBzUOmGEolCjYDGvd3ub5Tpr5lpDbRCv0HVJIDXqIrX-dUWvSaPtZpbZ0bj2Us7xTt0aTvV7kUFH_qfqZLGop7NW9w7fS_KRvpWNJKxvIVBBRSANXR-TCxXYMTGUjXkWZsG4v3PfUuPPIBDF97psNQW_i6CZ1X4_TG4S0I1NruKd4uva6vsWPFhItnfwhROyu9GBpzhSUF_ohcioTmq1BWWLZxqEo2wHwbIISkaEpJ",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDIkq-dqnseQ9ugvWshqUxAYW5jzRjMlOdvdc5Skxvto6Zxcj9DB_ZP_88FiDWWHEnSiooJYZ5lI1ml4_lpR8aoSacGDq8AxVxPYcTV636UkO_rVr6lCb6LLJPUCx64khUVmAP01mlGviDGNrRU9WEUbJTlPKmyNZwgJT0WIdHs8S5gyYngxV_tgd_Ii5cquLtUeTjVoZHlqfJ_hbfIvsdcuOl2NOhfxwE2jwDiY0ytaiEq2yEPLk9gJz2wD76vRxbI2y_fwk5x2kAa",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuCrtiB6C-cjwQTXJ015mN9mylPtTUHdB_PH1SR44Ezrj9ylMW5AfWKSmfZ8-tZotHzNYZNfrAOXruEez6GFo_h5oVFA9Rl82zpq51nvAVXogvvbNGskC7NABZ6rm5zu9AmYyGrD3PpekNzLFbEGviUyK1eeyLvrFja5JzJ1OrwRkFHZp_nvGQZZSVkMDiwYvXaqqQS80BX3qn0CxQLfjWltJ2IJANpGBURyvfUePMKvN8musvjo8beikLXxJpj5G6LkikQJXsnlX_0D",
  ];
}

export function allocateBatchExtraFees(items, totalExtraFees) {
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

export function getOrderTimeline(order, phase = "repair") {
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
      time: `${order.scheduledDate} 10:05`,
      description: `由 ${order.technician} 进行故障确认与备件评估`,
      state: states[1],
    },
    {
      title: "维修处理",
      time: `${order.scheduledDate} 11:20`,
      description: sanitizeIssueSummary(order),
      state: states[2],
    },
    {
      title: "完工交付",
      time: `${order.scheduledDate} 15:30`,
      description: isPickedUp ? "客户已完成取机" : "等待客户确认与取机",
      state: states[3],
    },
  ];
}
