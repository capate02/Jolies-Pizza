/* Live customer tracking for the San Roque–Pambujan service area. */
const API_BASE_URL = ["3000", "5500"].includes(window.location.port)
    ? "http://localhost:5000"
    : "";
const SERVICE_AREA = Object.freeze({ south: 12.43, north: 12.68, west: 124.77, east: 125.02 });
const SERVICE_CENTER = { lat: 12.55, lng: 124.89 };
const TRACKING_REFRESH_MS = 5000;
const GPS_STALE_AFTER_MS = 60_000;

const toast = document.getElementById("toast");
const ordersList = document.getElementById("ordersList");
const viewMoreButton = document.getElementById("viewMoreOrders");
const mapElement = document.getElementById("deliveryMap");
const mapMessage = document.getElementById("mapMessage");
let customer = null;
let orders = [];
let selectedOrder = null;
let expandedOrders = false;
let mapsApi = null;
let trackingMap = null;
let mapGeocoder = null;
let destinationMarker = null;
let riderMarker = null;
let routeLine = null;
let directionsRenderer = null;
let lastRouteRequestAt = 0;
let trackingTimer = null;
let pageRequestInProgress = false;

function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function readCustomer() {
    for (const storage of [window.localStorage, window.sessionStorage]) {
        try {
            const value = JSON.parse(storage.getItem("loggedInUser") || "null");
            if (value?.sessionToken && String(value.role).toLowerCase() === "customer") {
                return value;
            }
        } catch (error) {
            console.warn("Could not read customer login data.", error);
        }
    }
    return null;
}

function money(value) {
    return `₱${Number(value || 0).toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? "Date unavailable"
        : date.toLocaleString("en-PH", {
            year: "numeric", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit"
        });
}

function safePhone(value) {
    return String(value || "").replace(/[^\d+]/g, "");
}

function statusClass(value) {
    return String(value || "pending").toLowerCase().replaceAll(" ", "-");
}

function renderOrders() {
    ordersList.replaceChildren();
    if (!orders.length) {
        const notice = document.createElement("p");
        notice.className = "orders-empty";
        notice.textContent = customer
            ? "No orders were found for this account."
            : "Log in with the account used at checkout to view your orders.";
        ordersList.appendChild(notice);
        viewMoreButton.hidden = true;
        return;
    }

    const visibleOrders = expandedOrders ? orders : orders.slice(0, 5);
    for (const order of visibleOrders) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `recent-order${selectedOrder?.orderNumber === order.orderNumber ? " active" : ""}`;
        button.dataset.order = order.orderNumber;

        const left = document.createElement("span");
        left.className = "order-left";
        const number = document.createElement("strong");
        number.textContent = `#${order.orderNumber}`;
        const date = document.createElement("span");
        date.textContent = formatDate(order.createdAt);
        left.append(number, date);

        const right = document.createElement("span");
        right.className = "order-right";
        const status = document.createElement("span");
        status.className = `status ${statusClass(order.status)}`;
        status.textContent = order.status;
        const total = document.createElement("strong");
        total.textContent = money(order.total);
        right.append(status, total);

        const arrow = document.createElement("i");
        arrow.className = "fa-solid fa-chevron-right";
        button.append(left, right, arrow);
        button.addEventListener("click", () => selectOrder(order));
        ordersList.appendChild(button);
    }

    viewMoreButton.hidden = orders.length <= 5;
    viewMoreButton.classList.toggle("expanded", expandedOrders);
    viewMoreButton.querySelector("span").textContent = expandedOrders
        ? "Show Fewer Orders"
        : "View More Orders";
}

function renderSteps(order) {
    const steps = document.getElementById("trackingSteps");
    steps.replaceChildren();
    const definitions = [
        ["Order Placed", "fa-clipboard-check"],
        ["Preparing", "fa-pizza-slice"],
        ["On The Way", "fa-motorcycle"],
        ["Delivered", "fa-circle-check"]
    ];
    const stage = order.status === "Cancelled" ? -1
        : order.status === "Completed" ? 3
            : order.status === "Out for Delivery" ? 2
                : order.status === "Preparing" || order.status === "Confirmed" ? 1
                    : 0;

    definitions.forEach(([label, icon], index) => {
        const step = document.createElement("div");
        step.className = `track-step${stage >= index ? " completed" : ""}${stage === index ? " active" : ""}`;
        const circle = document.createElement("div");
        circle.className = "step-circle";
        const stepIcon = document.createElement("i");
        stepIcon.className = `fa-solid ${icon}`;
        circle.appendChild(stepIcon);
        const name = document.createElement("strong");
        name.textContent = label;
        const time = document.createElement("span");
        time.textContent = index === 0 ? formatDate(order.createdAt)
            : stage >= index ? `Order ${order.status.toLowerCase()}`
                : index === 2 ? "Waiting for rider" : "Not delivered yet";
        const marker = document.createElement("small");
        marker.textContent = stage > index ? "✓" : String(index + 1);
        step.append(circle, name, time, marker);
        steps.appendChild(step);
    });
}

function renderSelectedOrder() {
    if (!selectedOrder) return;
    document.getElementById("currentOrderTitle").textContent = `Order #${selectedOrder.orderNumber}`;
    document.getElementById("currentOrderDate").textContent = formatDate(selectedOrder.createdAt);
    const status = document.getElementById("currentOrderStatus");
    status.className = `preparing-status ${statusClass(selectedOrder.status)}`;
    status.innerHTML = `<span></span>${selectedOrder.status}`;
    renderSteps(selectedOrder);

    const itemList = document.getElementById("trackItems");
    itemList.replaceChildren();
    selectedOrder.items.forEach(item => {
        const row = document.createElement("div");
        row.className = "item-row";
        const itemName = document.createElement("span");
        itemName.textContent = `${item.quantity} × ${item.name}${item.size ? ` (${item.size})` : ""}`;
        const itemTotal = document.createElement("strong");
        itemTotal.textContent = money(item.lineTotal);
        row.append(itemName, itemTotal);
        itemList.appendChild(row);
    });
    document.getElementById("summarySubtotal").textContent = money(selectedOrder.subtotal);
    document.getElementById("summaryDeliveryFee").textContent = money(selectedOrder.deliveryFee);
    document.getElementById("summaryTotal").textContent = money(selectedOrder.total);
    document.getElementById("summaryPayment").textContent = selectedOrder.paymentMethod || "—";

    const gpsUpdatedAt = new Date(selectedOrder.location?.updatedAt).getTime();
    const gpsIsFresh = Number.isFinite(gpsUpdatedAt) &&
        Date.now() - gpsUpdatedAt <= GPS_STALE_AFTER_MS;
    document.getElementById("riderName").textContent = selectedOrder.rider || "Rider not assigned";
    document.getElementById("riderPhone").textContent = "Contact staff for order questions";
    document.getElementById("riderGpsState").textContent = gpsIsFresh
        ? "✦ Live"
        : selectedOrder.location
            ? "◷ Delayed"
        : "◌ Waiting";
    document.getElementById("riderVehicle").textContent = [
        selectedOrder.vehicleDescription,
        selectedOrder.licensePlate
    ].filter(Boolean).join(" · ") || (selectedOrder.location
        ? `GPS accuracy ±${Math.round(selectedOrder.location.accuracy || 0)} m`
        : "Live location is shared from rider’s phone");

    const message = selectedOrder.status === "Cancelled"
        ? "This order was cancelled. Live tracking has stopped."
        : selectedOrder.status === "Completed"
            ? "This order has been delivered."
            : selectedOrder.location
                ? gpsIsFresh
                    ? "Your rider is on the way. The map updates as the rider’s phone shares GPS."
                    : "Showing the rider’s last known location. The latest phone GPS update is delayed."
                : selectedOrder.status === "Out for Delivery"
                    ? "Your order is out for delivery. Waiting for the rider’s phone to share GPS."
                    : "Your order is being prepared. Live rider tracking will begin after dispatch.";
    document.getElementById("liveUpdateMessage").textContent = message;
    renderOrders();
}

function isInsideServiceArea(point) {
    return point.lat() >= SERVICE_AREA.south && point.lat() <= SERVICE_AREA.north &&
        point.lng() >= SERVICE_AREA.west && point.lng() <= SERVICE_AREA.east;
}

async function ensureMap() {
    if (trackingMap) return;
    mapMessage.textContent = "Loading live map…";
    try {
        mapsApi = await window.loadGoogleMaps(API_BASE_URL);
        const bounds = new mapsApi.LatLngBounds(
            { lat: SERVICE_AREA.south, lng: SERVICE_AREA.west },
            { lat: SERVICE_AREA.north, lng: SERVICE_AREA.east }
        );
        trackingMap = new mapsApi.Map(mapElement, {
            center: SERVICE_CENTER,
            zoom: 13,
            restriction: { latLngBounds: bounds, strictBounds: true },
            streetViewControl: false,
            mapTypeControl: false,
            fullscreenControl: true,
            clickableIcons: false
        });
        mapGeocoder = new mapsApi.Geocoder();
        routeLine = new mapsApi.Polyline({
            map: trackingMap,
            strokeColor: "#1687ff",
            strokeOpacity: 0.8,
            strokeWeight: 5
        });
        directionsRenderer = new mapsApi.DirectionsRenderer({
            map: trackingMap,
            suppressMarkers: true,
            preserveViewport: true,
            polylineOptions: { strokeColor: "#1687ff", strokeWeight: 5, strokeOpacity: 0.8 }
        });
        mapMessage.hidden = true;
    } catch (error) {
        mapMessage.hidden = false;
        mapMessage.textContent = error.message || "Live map is unavailable.";
        throw error;
    }
}

async function setDestination(order) {
    if (!trackingMap || destinationMarker?.orderNumber === order.orderNumber) return;
    destinationMarker?.setMap(null);
    destinationMarker = null;
    if (!order.deliveryAddress) {
        mapMessage.hidden = false;
        mapMessage.textContent = "This order has no delivery address to map.";
        return;
    }
    try {
        const result = await mapGeocoder.geocode({
            address: `${order.deliveryAddress}, San Roque, Northern Samar, Philippines`,
            bounds: new mapsApi.LatLngBounds(
                { lat: SERVICE_AREA.south, lng: SERVICE_AREA.west },
                { lat: SERVICE_AREA.north, lng: SERVICE_AREA.east }
            )
        });
        const location = result.results?.[0]?.geometry?.location;
        if (!location || !isInsideServiceArea(location)) {
            mapMessage.hidden = false;
            mapMessage.textContent = "The delivery address is outside the San Roque–Pambujan tracking area.";
            trackingMap.setCenter(SERVICE_CENTER);
            return;
        }
        destinationMarker = new mapsApi.Marker({
            map: trackingMap,
            position: location,
            title: "Customer delivery address",
            label: { text: "D", color: "#fff", fontWeight: "700" }
        });
        destinationMarker.orderNumber = order.orderNumber;
        trackingMap.setCenter(location);
        trackingMap.setZoom(14);
        mapMessage.hidden = false;
        mapMessage.textContent = "Waiting for the rider’s live GPS location.";
    } catch (error) {
        mapMessage.hidden = false;
        mapMessage.textContent = "Could not locate the delivery address on the map.";
    }
}

function updateDistance(position) {
    if (!destinationMarker) return;
    const destination = destinationMarker.getPosition();
    const radians = value => value * Math.PI / 180;
    const latitudeDelta = radians(destination.lat() - position.lat());
    const longitudeDelta = radians(destination.lng() - position.lng());
    const a = Math.sin(latitudeDelta / 2) ** 2 +
        Math.cos(radians(position.lat())) * Math.cos(radians(destination.lat())) *
        Math.sin(longitudeDelta / 2) ** 2;
    const meters = 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const label = meters >= 1000
        ? `${(meters / 1000).toFixed(1)} km`
        : `${Math.round(meters)} m`;
    document.getElementById("distanceBadge").innerHTML = `${label}<br><span>straight-line distance</span>`;
}

function updateRiderLocation(location) {
    if (!location || !trackingMap) return;
    const position = { lat: Number(location.latitude), lng: Number(location.longitude) };
    if (!Number.isFinite(position.lat) || !Number.isFinite(position.lng) ||
        position.lat < SERVICE_AREA.south || position.lat > SERVICE_AREA.north ||
        position.lng < SERVICE_AREA.west || position.lng > SERVICE_AREA.east) {
        mapMessage.hidden = false;
        mapMessage.textContent = "The rider location is outside the San Roque–Pambujan tracking area.";
        return;
    }
    mapMessage.hidden = true;
    if (!riderMarker) {
        riderMarker = new mapsApi.Marker({
            map: trackingMap,
            position,
            title: "Rider live location",
            icon: {
                path: mapsApi.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: "#1687ff",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 3
            }
        });
    } else {
        riderMarker.setPosition(position);
    }
    routeLine.setPath(destinationMarker
        ? [position, destinationMarker.getPosition()]
        : [position]);
    routeLine.setMap(trackingMap);
    directionsRenderer.set("directions", null);
    trackingMap.panTo(position);
    updateDistance(new mapsApi.LatLng(position.lat, position.lng));
    const updated = new Date(location.updatedAt);
    document.getElementById("locationUpdated").textContent =
        `GPS updated ${Number.isNaN(updated.getTime()) ? "just now" : updated.toLocaleTimeString("en-PH")}`;
    if (destinationMarker && Date.now() - lastRouteRequestAt > 20_000) {
        void requestRoadRoute(position, destinationMarker.getPosition());
    }
}

async function requestRoadRoute(origin, destination) {
    if (!mapsApi?.DirectionsService || !directionsRenderer) return;
    lastRouteRequestAt = Date.now();
    try {
        const result = await new Promise((resolve, reject) => {
            new mapsApi.DirectionsService().route({
                origin,
                destination,
                travelMode: mapsApi.TravelMode.DRIVING
            }, (response, status) => {
                if (status === "OK" && response?.routes?.length) resolve(response);
                else reject(new Error(status || "No driving route found."));
            });
        });
        routeLine.setMap(null);
        directionsRenderer.setDirections(result);
    } catch (error) {
        routeLine.setMap(trackingMap);
        console.info("Road directions are unavailable; showing the live GPS position and direct distance.", error);
    }
}

async function refreshSelectedTracking() {
    if (!selectedOrder || !customer?.sessionToken) return;
    try {
        const response = await fetch(
            `${API_BASE_URL}/api/orders/${encodeURIComponent(selectedOrder.orderNumber)}/tracking`,
            {
                headers: { Authorization: `Bearer ${customer.sessionToken}` },
                cache: "no-store"
            }
        );
        const result = await response.json();
        if (!response.ok || !result.success || !result.tracking) {
            throw new Error(result.message || "Could not refresh order tracking.");
        }
        if (selectedOrder.orderNumber !== result.tracking.orderNumber) return;
        Object.assign(selectedOrder, result.tracking);
        selectedOrder.status = result.tracking.orderStatus;
        renderSelectedOrder();
        await ensureMap();
        await setDestination(selectedOrder);
        if (selectedOrder.location && selectedOrder.status === "Out for Delivery") {
            updateRiderLocation(selectedOrder.location);
        } else {
            riderMarker?.setMap(null);
            riderMarker = null;
            routeLine?.setPath([]);
            directionsRenderer?.set("directions", null);
            lastRouteRequestAt = 0;
            document.getElementById("locationUpdated").textContent = "No live location yet";
            document.getElementById("distanceBadge").innerHTML = "Waiting<br><span>for rider GPS</span>";
            mapMessage.hidden = false;
            mapMessage.textContent = selectedOrder.status === "Out for Delivery"
                ? "Your order is out for delivery. Waiting for GPS from the rider’s phone."
                : "Live rider GPS appears here after the order is dispatched.";
        }
    } catch (error) {
        console.warn("Could not refresh order tracking:", error);
        if (error.message.includes("customer account") || error.message.includes("Log in")) {
            showToast(error.message);
        }
    }
}

async function selectOrder(order) {
    selectedOrder = order;
    const pageUrl = new URL(window.location.href);
    pageUrl.searchParams.set("order", order.orderNumber);
    window.history.replaceState({}, "", pageUrl);
    lastRouteRequestAt = 0;
    destinationMarker?.setMap(null);
    destinationMarker = null;
    riderMarker?.setMap(null);
    riderMarker = null;
    routeLine?.setPath([]);
    directionsRenderer?.set("directions", null);
    renderSelectedOrder();
    try {
        await ensureMap();
        await setDestination(order);
        await refreshSelectedTracking();
    } catch (error) {
        console.warn("Map initialization failed:", error);
    }
}

async function loadOrders() {
    if (pageRequestInProgress) return;
    pageRequestInProgress = true;
    customer = readCustomer();
    if (!customer) {
        orders = [];
        selectedOrder = null;
        renderOrders();
        mapMessage.hidden = false;
        mapMessage.textContent = "Log in with the customer account used at checkout to track your orders.";
        pageRequestInProgress = false;
        return;
    }
    try {
        const response = await fetch(`${API_BASE_URL}/api/orders`, {
            headers: { Authorization: `Bearer ${customer.sessionToken}` },
            cache: "no-store"
        });
        const result = await response.json();
        if (!response.ok || !result.success || !Array.isArray(result.orders)) {
            throw new Error(result.message || "Could not load your orders.");
        }
        orders = result.orders;
        const queryOrder = new URLSearchParams(window.location.search).get("order");
        const nextSelected = orders.find(order => order.orderNumber === queryOrder) ||
            orders.find(order => order.orderNumber === selectedOrder?.orderNumber) ||
            orders.find(order => order.status === "Out for Delivery") || orders[0];
        if (nextSelected) {
            const changed = selectedOrder?.orderNumber !== nextSelected.orderNumber;
            if (changed) await selectOrder(nextSelected);
            else {
                Object.assign(selectedOrder, nextSelected);
                renderSelectedOrder();
                await refreshSelectedTracking();
            }
        } else {
            selectedOrder = null;
            renderOrders();
            document.getElementById("currentOrderTitle").textContent = "No order selected";
            document.getElementById("currentOrderDate").textContent = "Your recent orders will appear here.";
            document.getElementById("liveUpdateMessage").textContent = "Place an order to start tracking.";
            mapMessage.hidden = false;
            mapMessage.textContent = "No orders are available to track.";
        }
    } catch (error) {
        console.error("Could not load customer tracking orders:", error);
        showToast(error.message || "Could not load your orders.");
        mapMessage.hidden = false;
        mapMessage.textContent = error.message || "Could not load your orders.";
    } finally {
        pageRequestInProgress = false;
    }
}

ordersList.addEventListener("click", event => {
    const button = event.target.closest("button[data-order]");
    const order = orders.find(item => item.orderNumber === button?.dataset.order);
    if (order) void selectOrder(order);
});

viewMoreButton.addEventListener("click", () => {
    expandedOrders = !expandedOrders;
    renderOrders();
});

document.getElementById("supportButton").addEventListener("click", () => {
    window.location.href = "contact.html";
});
document.getElementById("viewDetails").addEventListener("click", () => {
    document.querySelector(".items-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
document.querySelector(".cart-header")?.addEventListener("click", () => {
    window.location.href = "menus.html";
});
document.getElementById("liveUpdateToggle").addEventListener("click", event => {
    const panel = document.getElementById("liveUpdate");
    const closed = panel.classList.toggle("closed");
    event.currentTarget.setAttribute("aria-label", closed ? "Open live update" : "Close live update");
});
document.getElementById("zoomIn").addEventListener("click", () => {
    if (trackingMap) trackingMap.setZoom(Math.min(19, trackingMap.getZoom() + 1));
});
document.getElementById("zoomOut").addEventListener("click", () => {
    if (trackingMap) trackingMap.setZoom(Math.max(10, trackingMap.getZoom() - 1));
});

void loadOrders();
trackingTimer = window.setInterval(() => {
    if (!document.hidden) void loadOrders();
}, TRACKING_REFRESH_MS);
window.addEventListener("pagehide", () => window.clearInterval(trackingTimer));
