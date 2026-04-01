export function diffMinutesFromNow(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

export function formatElapsedMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `已等待 ${minutes} 分钟`;
  return `已等待 ${hours}小时${String(minutes).padStart(2, "0")}分`;
}

export function queueProgressByStatus(status) {
  if (status === "pending") return 22;
  if (status === "in_progress") return 64;
  if (status === "completed") return 100;
  if (status === "picked_up") return 100;
  return 0;
}

export function queuePriorityForOrder(order, elapsedMinutes) {
  if (order.status === "completed" || order.status === "picked_up") return "done";
  if (order.status === "pending" && elapsedMinutes >= 60) return "urgent";
  if (order.status === "in_progress" && elapsedMinutes >= 45) return "high";
  return "normal";
}

export function looksBrokenText(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return true;
  if (/[锟絔�]/.test(normalized)) return true;
  if (/\s\?\s/.test(normalized)) return true;
  if (/\?{2,}/.test(normalized)) return true;
  if (/^[?\s._\-\\/|]+$/.test(normalized)) return true;
  if (!/[\p{L}\p{N}]/u.test(normalized)) return true;
  return false;
}

export function sanitizeIssueSummary(order) {
  const rawIssue = String(order?.issueSummary ?? order?.issue_summary ?? "").trim();
  if (!looksBrokenText(rawIssue)) return rawIssue;

  const rawNotes = String(order?.notes ?? "").trim();
  if (!looksBrokenText(rawNotes)) return rawNotes;

  return "待检测故障";
}

export function sanitizeOrderTitle(order) {
  const rawTitle = String(order?.title ?? "").trim();
  const issueSummary = sanitizeIssueSummary(order);
  const deviceName = String(order?.deviceName ?? order?.device_name ?? "").trim();
  const titleLooksBroken = looksBrokenText(rawTitle);

  if (!titleLooksBroken) return rawTitle;

  return [deviceName, issueSummary].filter(Boolean).join(" · ") || deviceName || issueSummary || "维修订单";
}
