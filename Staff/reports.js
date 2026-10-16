(() => {
  const $ = id => document.getElementById(id);
  const money = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  function token() {
    for (const storage of [localStorage, sessionStorage]) try {
      const user = JSON.parse(storage.getItem("loggedInUser") || "null");
      if (user?.sessionToken && ["staff", "admin"].includes(String(user.role).toLowerCase())) return user.sessionToken;
    } catch { /* Try the other browser store. */ }
    return "";
  }
  let activePeriod = "week";
  let report = null;

  async function load(period = activePeriod) {
    activePeriod = period;
    try {
      const sessionToken = token();
      if (!sessionToken) throw new Error("Sign in with a staff account to view reports.");
      const api = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
      const response = await fetch(`${api}/api/staff/reports?period=${encodeURIComponent(period)}`, { headers: { Authorization: `Bearer ${sessionToken}` }, credentials: "same-origin", cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Unable to load reports.");
      report = data;
      render();
    } catch (error) {
      document.querySelectorAll(".stat-value").forEach(node => node.textContent = "—");
      $("topItemsBody").innerHTML = `<tr><td colspan="3">${escapeHTML(error.message)}</td></tr>`;
      $("dailySummaryBody").innerHTML = `<tr><td colspan="4">Report data could not be loaded. Check the backend and database.</td></tr>`;
      $("paymentMethodBody").innerHTML = `<tr><td colspan="3">No payment data available.</td></tr>`;
    }
  }

  function currentPeriodLabel() {
    if (activePeriod === "today") return new Date().toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    const days = activePeriod === "month" ? 30 : 7;
    const start = new Date(); start.setDate(start.getDate() - days + 1);
    return `${start.toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${new Date().toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`;
  }

  function render() {
    const { current, previous } = report;
    const label = currentPeriodLabel();
    $("rangeSelect").value = activePeriod;
    $("rangeSelect").options[0].textContent = "Last 7 days";
    $("rangeSelect").options[1].textContent = "Today";
    $("rangeSelect").options[2].textContent = "Last 30 days";
    $("summaryRange").textContent = label;
    $("salesTotal").textContent = money(current.sales);
    $("ordersTotal").textContent = current.orders;
    $("averageTotal").textContent = money(current.orders ? current.sales / current.orders : 0);
    $("completedTotal").textContent = current.completed;
    $("cancelledTotal").textContent = current.cancelled;
    const comparisons = [["salesChange", current.sales, previous.sales], ["ordersChange", current.orders, previous.orders], ["averageChange", current.orders ? current.sales / current.orders : 0, previous.orders ? previous.sales / previous.orders : 0], ["completedChange", current.completed, previous.completed], ["cancelledChange", current.cancelled, previous.cancelled]];
    comparisons.forEach(([id, value, prior]) => {
      const delta = prior ? (value - prior) / prior * 100 : (value ? 100 : 0);
      const node = $(id); node.classList.toggle("negative", delta < 0); node.classList.toggle("positive", delta >= 0);
      node.textContent = `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta).toFixed(1)}% vs previous period`;
    });
    const statuses = report.statusBreakdown;
    const statusColors = { Completed: "#22a969", Preparing: "#ff8b19", "Out for Delivery": "#2584f4", Cancelled: "#8b36d9", Pending: "#e31b23", Confirmed: "#16a5a1" };
    const totalStatuses = statuses.reduce((sum, item) => sum + item.count, 0);
    let deg = 0;
    const segments = statuses.filter(item => item.count > 0).map(item => { const start = deg; deg += item.count / (totalStatuses || 1) * 360; return `${statusColors[item.status] || "#8993a4"} ${start}deg ${deg}deg`; });
    $("statusDonut").style.background = segments.length ? `conic-gradient(${segments.join(",")})` : "#e7eaf0";
    $("donutTotal").textContent = current.orders;
    $("statusLegend").innerHTML = statuses.map(item => `<div class="status-legend-row"><span><i style="--status-color:${statusColors[item.status] || "#8993a4"}"></i>${escapeHTML(item.status)}</span><strong>${item.count} <small>(${totalStatuses ? (item.count / totalStatuses * 100).toFixed(1) : "0.0"}%)</small></strong></div>`).join("") || "<span>No orders in this period.</span>";
    const rate = current.orders ? current.completed / current.orders * 100 : 0;
    $("completionRate").textContent = `${rate.toFixed(1)}%`;
    $("completionRate").insertAdjacentHTML("beforeend", " <small>of orders completed</small>");
    $("topItemsBody").innerHTML = report.topItems.map((item, i) => `<tr><td><span class="top-item-name"><i class="item-image item-${i % 5}"><i class="fa-solid fa-pizza-slice"></i></i>${escapeHTML(item.name)}</span></td><td>${item.quantity}</td><td>${money(item.revenue)}</td></tr>`).join("") || "<tr><td colspan=\"3\">No menu items sold in this period.</td></tr>";
    const days = report.daily;
    $("dailySummaryBody").innerHTML = days.map(row => `<tr><td>${new Date(`${String(row.date).slice(0, 10)}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</td><td>${row.orders}</td><td>${money(row.sales)}</td><td>${row.completed}</td></tr>`).join("") || "<tr><td colspan=\"4\">No orders in this period.</td></tr>";
    $("dailyOrderTotal").textContent = current.orders; $("dailySalesTotal").textContent = money(current.sales); $("dailyCompletedTotal").textContent = current.completed;
    const paidTotal = report.paymentMethods.reduce((sum, method) => sum + method.amount, 0);
    $("paymentMethodBody").innerHTML = report.paymentMethods.map(method => `<tr><td>${escapeHTML(method.method)}</td><td>${money(method.amount)}</td><td>${paidTotal ? (method.amount / paidTotal * 100).toFixed(1) : "0.0"}%</td></tr>`).join("") || "<tr><td colspan=\"3\">No paid transactions in this period.</td></tr>";
    document.querySelector(".payment-method-table tfoot th:nth-child(2)").textContent = money(paidTotal);
    document.querySelector(".payment-method-table tfoot th:nth-child(3)").textContent = `${paidTotal ? "100.0" : "0.0"}%`;
    const values = days.map(row => row.sales);
    drawLineChart($("salesChart"), values);
    drawBarChart($("timeChart"), report.hourly);
  }
  function updateHeaderClock() {
    const now = new Date();
    $("currentDate").textContent = now.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    $("currentTime").textContent = `${now.toLocaleDateString("en-PH", { weekday: "long" })} · ${now.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}`;
  }

  function drawLineChart(canvas, values) {
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio);
    const pad = { top: 12, right: 10, bottom: 24, left: 38 }, width = rect.width, height = rect.height;
    const max = Math.max(1, ...values); const chartW = width - pad.left - pad.right, chartH = height - pad.top - pad.bottom;
    ctx.font = "9px Inter, sans-serif"; ctx.textAlign = "right";
    for (let n = 0; n <= 4; n++) { const y = pad.top + chartH * n / 4; ctx.strokeStyle = "#edf0f3"; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); ctx.fillStyle = "#687181"; ctx.fillText(money(max * (4 - n) / 4), pad.left - 4, y + 3); }
    if (!values.length) return;
    ctx.beginPath(); values.forEach((value, i) => { const x = pad.left + (values.length === 1 ? chartW / 2 : chartW * i / (values.length - 1)); const y = pad.top + chartH * (1 - value / max); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = "#e31b23"; ctx.lineWidth = 2; ctx.stroke();
    ctx.textAlign = "center"; ctx.fillStyle = "#687181";
    values.forEach((_, i) => { const row = report.daily[i]; const x = pad.left + (values.length === 1 ? chartW / 2 : chartW * i / (values.length - 1)); ctx.fillText(row ? new Date(`${String(row.date).slice(0,10)}T12:00:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) : "", x, height - 7); });
  }

  function drawBarChart(canvas, rows) {
    const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1; canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
    const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio);
    const width = rect.width, height = rect.height, pad = { top: 15, right: 8, bottom: 28, left: 28 };
    const slots = [[0,5],[6,8],[9,11],[12,14],[15,17],[18,20],[21,23]];
    const values = slots.map(([from,to]) => rows.filter(r => r.hour >= from && r.hour <= to).reduce((sum,r) => sum + r.orders, 0));
    const max = Math.max(1, ...values), chartW = width - pad.left - pad.right, chartH = height - pad.top - pad.bottom, slotW = chartW / 7;
    ctx.strokeStyle = "#edf0f3"; ctx.font = "8px Inter, sans-serif";
    for (let n=0;n<=4;n++){const y=pad.top+chartH*n/4;ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke();ctx.fillStyle="#687181";ctx.textAlign="right";ctx.fillText(String(Math.round(max*(4-n)/4)),pad.left-4,y+3);}
    values.forEach((value,i)=>{const bw=Math.min(20,slotW*.55), bh=chartH*value/max,x=pad.left+i*slotW+(slotW-bw)/2,y=pad.top+chartH-bh;ctx.fillStyle="#e31b23";ctx.fillRect(x,y,bw,bh);ctx.fillStyle="#687181";ctx.textAlign="center";ctx.fillText(`${slots[i][0]}–${slots[i][1]+1}`,x+bw/2,height-8);});
  }

  $("rangeSelect").addEventListener("change", event => load(event.target.value));
  $("menuToggle").addEventListener("click", event => {
    const open = $("sidebar").classList.toggle("open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
  });
  ["topItemsPeriod", "timePeriod", "paymentPeriod"].forEach(id => $(id).addEventListener("change", event => {
    const value = event.target.value.toLowerCase();
    if (value.includes("today")) load("today"); else if (value.includes("month")) load("month"); else load("week");
  }));
  $("exportReport").addEventListener("click", () => {
    if (!report) return;
    const rows = [["Date", "Total Orders", "Total Sales", "Completed Orders"], ...report.daily.map(row => [String(row.date).slice(0,10), row.orders, row.sales, row.completed]), ["Total", report.current.orders, report.current.sales, report.current.completed]];
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `jolies-pizza-report-${activePeriod}.csv`; link.click(); URL.revokeObjectURL(link.href);
  });
  $("submitReportToAdmin")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    const message = $("reportSubmitMessage");
    const sessionToken = token();
    if (!sessionToken) { message.textContent = "Sign in again to submit a report."; return; }
    button.disabled = true;
    message.textContent = "Sending report…";
    try {
      const api = ["3000", "5500"].includes(location.port) ? "http://localhost:5000" : "";
      const response = await fetch(`${api}/api/staff/reports/submissions`, {
        method: "POST", headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ period: activePeriod, note: $("adminReportNote").value }), cache: "no-store"
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "Could not send the report.");
      message.textContent = "Report sent to the admin.";
      $("adminReportNote").value = "";
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  load();
  updateHeaderClock(); setInterval(updateHeaderClock, 60000);
  window.addEventListener("resize", () => { if (report) render(); });
})();
