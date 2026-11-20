const STORAGE_KEY = "data-ocean-observations-v1";
const NOTIFICATIONS_STORAGE_KEY = "data-ocean-notifications-v1";
const zones = [
  "Plage Akewni",
  "Pointe Denis",
  "Parc national de Pongara",
  "Cap Lopez",
  "Port-Gentil",
  "Gamba",
  "Mayumba"
];
const materials = ["Plastique", "Métal", "Verre", "Autre"];
const materialColors = { Plastique: "#3687c5", Métal: "#50b3a5", Verre: "#f1b953", Autre: "#d7e2ec" };
const typeColors = {
  "Déchets collectés": "#3687c5",
  Biodiversité: "#50a18c",
  "Qualité de l’eau": "#419ac1",
  "Érosion côtière": "#df9d3c",
  Pollution: "#db6b60"
};
const pinPositions = {
  "Plage Akewni": [48.6, 36.5],
  "Pointe Denis": [46.2, 41.2],
  "Parc national de Pongara": [50.8, 44],
  "Cap Lopez": [42.7, 51.2],
  "Port-Gentil": [43.4, 52.7],
  Gamba: [52.9, 77.7],
  Mayumba: [58, 86.6]
};

const daysAgo = (days, hour) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(days === 0 ? Math.min(hour, date.getHours()) : hour, 0, 0, 0);
  if (date > new Date()) date.setTime(Date.now() - 60_000);
  return date.toISOString();
};

const demoObservations = [
  { id: "demo-1", zone: "Plage Akewni", type: "Déchets collectés", value: 18, unit: "kg", material: "Plastique", contributor: "Équipe terrain", date: daysAgo(0, 8), note: "", demo: true },
  { id: "demo-2", zone: "Pointe Denis", type: "Biodiversité", value: 6, unit: "espèces", contributor: "Observateur côtier", date: daysAgo(0, 7), note: "", demo: true },
  { id: "demo-3", zone: "Port-Gentil", type: "Qualité de l’eau", value: 28, unit: "°C", contributor: "Équipe terrain", date: daysAgo(1, 16), note: "", demo: true },
  { id: "demo-4", zone: "Cap Lopez", type: "Déchets collectés", value: 12, unit: "kg", material: "Métal", contributor: "Collectif local", date: daysAgo(1, 10), note: "", demo: true },
  { id: "demo-5", zone: "Parc national de Pongara", type: "Biodiversité", value: 9, unit: "espèces", contributor: "Observateur côtier", date: daysAgo(2, 9), note: "", demo: true },
  { id: "demo-6", zone: "Gamba", type: "Érosion côtière", value: 3, unit: "niveau 1–5", contributor: "Collectif local", date: daysAgo(2, 14), note: "Recul visible du trait de côte.", demo: true },
  { id: "demo-7", zone: "Mayumba", type: "Déchets collectés", value: 8, unit: "kg", material: "Verre", contributor: "Équipe terrain", date: daysAgo(3, 11), note: "", demo: true },
  { id: "demo-8", zone: "Pointe Denis", type: "Qualité de l’eau", value: 27.5, unit: "°C", contributor: "Observateur côtier", date: daysAgo(3, 8), note: "", demo: true },
  { id: "demo-9", zone: "Plage Akewni", type: "Déchets collectés", value: 7, unit: "kg", material: "Autre", contributor: "Collectif local", date: daysAgo(4, 15), note: "", demo: true },
  { id: "demo-10", zone: "Port-Gentil", type: "Pollution", value: 2, unit: "niveau 1–5", contributor: "Observateur côtier", date: daysAgo(5, 13), note: "Signalement à confirmer sur le terrain.", demo: true }
];

function loadLegacyObservations() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error("Le format des observations enregistrées est invalide.");
    return parsed;
  } catch (error) {
    console.error("Impossible de lire les anciennes observations du navigateur.", error);
    throw error;
  }
}

async function requestApi(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Erreur HTTP ${response.status}`);
  return body;
}

async function migrateLegacyObservations() {
  const legacyObservations = loadLegacyObservations();
  for (const observation of legacyObservations) {
    await requestApi("/api/observations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(observation)
    });
  }
  if (legacyObservations.length) localStorage.removeItem(STORAGE_KEY);
}

function setConnectionStatus(message, isError = false) {
  connectionStatus.dataset.state = isError ? "error" : "connected";
  connectionStatus.querySelector("p").textContent = message;
  connectionStatus.setAttribute("role", isError ? "alert" : "status");
}

async function initializeDatabase() {
  try {
    await migrateLegacyObservations();
  } catch (error) {
    console.error("La migration des observations locales a échoué.", error);
    migrationIssue = error.message;
  }

  try {
    await refreshDatabaseObservations();
  } catch (error) {
    console.error("Impossible de se connecter à la base SQLite.", error);
    setConnectionStatus(`Connexion à la base SQLite impossible : ${error.message}. Lancez le serveur avec « npm start ».`, true);
  }
}

async function refreshDatabaseObservations() {
  const savedObservations = await requestApi("/api/observations");
  if (hasLoadedApiObservations) {
    const currentById = new Map(savedObservations.map((item) => [item.id, item]));
    for (const item of savedObservations) {
      const previous = knownObservations.get(item.id);
      if (!previous) {
        addNotification("new", item, []);
        continue;
      }
      const changedFields = ["zone", "type", "value", "unit", "material", "contributor", "date", "note"]
        .filter((field) => previous[field] !== item[field]);
      if (changedFields.length) addNotification("updated", item, changedFields);
    }
    for (const [id, previous] of knownObservations) {
      if (!currentById.has(id)) addNotification("deleted", previous, []);
    }
    knownObservations = currentById;
  } else {
    knownObservations = new Map(savedObservations.map((item) => [item.id, item]));
    hasLoadedApiObservations = true;
  }
  observations = [...savedObservations, ...demoObservations];
  render();
  setConnectionStatus(
    migrationIssue
      ? `Base SQLite connectée, mais l’import des anciennes observations a échoué : ${migrationIssue}`
      : "Base SQLite connectée. Les observations sont partagées sur ce serveur.",
    Boolean(migrationIssue)
  );
}

let observations = [...demoObservations];
const zoneFilter = document.getElementById("zone-filter");
const periodFilter = document.getElementById("period-filter");
const typeFilter = document.getElementById("type-filter");
const tableBody = document.getElementById("observations-table");
const dialog = document.getElementById("observation-dialog");
const observationForm = document.getElementById("observation-form");
const typeSelect = document.getElementById("form-type");
const unitSelect = document.getElementById("form-unit");
const materialSelect = document.getElementById("form-material");
const materialLabel = document.getElementById("material-label");
const connectionStatus = document.getElementById("connection-status");
let migrationIssue = "";
let currentUser = null;
let knownObservations = new Map();
let hasLoadedApiObservations = false;
let notificationStorageKey = NOTIFICATIONS_STORAGE_KEY;
let notificationRecords = [];
let toastTimeout;

function loadNotifications() {
  try {
    const stored = JSON.parse(localStorage.getItem(notificationStorageKey) || "[]");
    return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string") : [];
  } catch (error) {
    console.error("Impossible de lire les notifications enregistrées.", error);
    return [];
  }
}

function saveNotifications() {
  try {
    localStorage.setItem(notificationStorageKey, JSON.stringify(notificationRecords.slice(0, 30)));
  } catch (error) {
    console.error("Impossible d’enregistrer les notifications.", error);
  }
}

function addNotification(kind, observation, changedFields) {
  const fieldNames = {
    zone: "zone", type: "type", value: "mesure", unit: "unité",
    material: "matière", contributor: "contributeur", date: "date", note: "commentaire"
  };
  const notification = {
    id: `${observation.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    observationId: observation.id,
    kind,
    zone: observation.zone,
    type: observation.type,
    value: observation.value,
    unit: observation.unit,
    contributor: observation.contributor,
    changedFields: changedFields.map((field) => fieldNames[field]),
    createdAt: new Date().toISOString(),
    read: false
  };
  notificationRecords.unshift(notification);
  notificationRecords = notificationRecords.slice(0, 30);
  saveNotifications();
  renderNotifications();
  showNotificationToast(notification);
  if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
    const title = kind === "new" ? "Nouvelle observation" : kind === "deleted" ? "Observation supprimée" : "Observation modifiée";
    new Notification(title, {
      body: `${observation.zone} · ${observation.type}`
    });
  }
}

function renderNotifications() {
  const unreadCount = notificationRecords.filter((item) => !item.read).length;
  const count = document.getElementById("notification-count");
  count.textContent = unreadCount > 9 ? "9+" : unreadCount;
  count.hidden = unreadCount === 0;
  document.getElementById("notification-empty").hidden = notificationRecords.length > 0;
  document.getElementById("notification-list").innerHTML = notificationRecords.map((item) => {
    const title = item.kind === "new" ? "Nouvelle observation" : item.kind === "deleted" ? "Observation supprimée" : "Observation modifiée";
    const detail = item.kind === "new"
      ? `${item.type} · ${formatNumber(item.value)} ${item.unit} · ${item.contributor || "Contributeur"}`
      : item.kind === "deleted" ? "Cette observation a été supprimée."
        : `Champs modifiés : ${item.changedFields.join(", ")}`;
    return `<li class="notification-item${item.read ? "" : " unread"}"><button type="button" data-notification-id="${escapeHtml(item.id)}"><strong>${title} · ${escapeHtml(item.zone)}</strong><span>${escapeHtml(detail)}</span><time>${formatDate(item.createdAt)}</time></button></li>`;
  }).join("");
  const browserButton = document.getElementById("enable-browser-notifications");
  if (!("Notification" in window)) {
    browserButton.hidden = true;
  } else if (Notification.permission === "granted") {
    browserButton.textContent = "Alertes du navigateur activées";
    browserButton.disabled = true;
  } else if (Notification.permission === "denied") {
    browserButton.textContent = "Alertes bloquées dans les paramètres du navigateur";
    browserButton.disabled = true;
  }
}

function showNotificationToast(notification) {
  const toast = document.getElementById("notification-toast");
  toast.textContent = notification.kind === "new"
    ? `Nouvelle observation à ${notification.zone} : ${notification.type}.`
    : notification.kind === "deleted" ? `Une observation de ${notification.zone} a été supprimée.`
      : `Une observation de ${notification.zone} a été modifiée.`;
  toast.hidden = false;
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => { toast.hidden = true; }, 5000);
}

function selectedObservations() {
  const zone = zoneFilter.value;
  const type = typeFilter.value;
  const period = Number(periodFilter.value);
  const earliestDate = period ? Date.now() - period * 24 * 60 * 60 * 1000 : null;
  return observations.filter((item) =>
    (zone === "all" || item.zone === zone) &&
    (type === "all" || item.type === type) &&
    (earliestDate === null || new Date(item.date).getTime() >= earliestDate)
  );
}

function formatNumber(value) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function renderMetrics(items) {
  const waste = items.filter((item) => item.type === "Déchets collectés");
  const species = items.filter((item) => item.type === "Biodiversité");
  const temperatures = items.filter((item) => item.type === "Qualité de l’eau");
  const risks = new Set(items.filter((item) =>
    (item.type === "Pollution" && item.value >= 2) ||
    (item.type === "Érosion côtière" && item.value >= 3)
  ).map((item) => item.zone));
  const totalWaste = waste.reduce((total, item) => total + item.value, 0);
  const totalSpecies = species.reduce((total, item) => total + item.value, 0);
  const averageTemp = temperatures.length
    ? temperatures.reduce((total, item) => total + item.value, 0) / temperatures.length
    : null;

  document.getElementById("waste-total").textContent = formatNumber(totalWaste);
  document.getElementById("waste-observations").textContent = `${waste.length} observation${waste.length === 1 ? "" : "s"}`;
  document.getElementById("species-total").textContent = formatNumber(totalSpecies);
  document.getElementById("species-zones").textContent = `sur ${new Set(species.map((item) => item.zone)).size} zones`;
  document.getElementById("water-temp").textContent = averageTemp === null ? "—" : formatNumber(averageTemp);
  document.getElementById("temp-observations").textContent = temperatures.length
    ? `${temperatures.length} mesure${temperatures.length === 1 ? "" : "s"} partagée${temperatures.length === 1 ? "" : "s"}`
    : "Aucune mesure";
  document.getElementById("risk-total").textContent = risks.size;
  document.getElementById("zone-count").textContent = `${new Set(items.map((item) => item.zone)).size} zones`;
  renderWasteChart(waste, totalWaste);
  renderZoneChart(waste);
  renderMap(items, risks);
}

function renderWasteChart(waste, total) {
  const totals = Object.fromEntries(materials.map((material) => [material, 0]));
  waste.forEach((item) => {
    const material = materials.includes(item.material) ? item.material : "Autre";
    totals[material] += item.value;
  });
  let cursor = 0;
  const slices = materials.map((material) => {
    const start = cursor;
    cursor += total ? totals[material] / total * 100 : 0;
    return `${materialColors[material]} ${start}% ${cursor}%`;
  });
  document.getElementById("waste-donut").style.background = total
    ? `conic-gradient(${slices.join(", ")})`
    : "conic-gradient(#e6edf3 0% 100%)";
  document.getElementById("donut-total").textContent = formatNumber(total);
  document.getElementById("waste-legend").innerHTML = materials.map((material) =>
    `<div class="legend-item"><i class="legend-color" style="background:${materialColors[material]}"></i><span>${material}</span><strong>${formatNumber(totals[material])} kg</strong></div>`
  ).join("");
}

function renderZoneChart(waste) {
  const totals = zones.map((zone) => ({
    zone,
    value: waste.filter((item) => item.zone === zone).reduce((sum, item) => sum + item.value, 0)
  }));
  const max = Math.max(...totals.map((item) => item.value), 1);
  document.getElementById("zone-chart").innerHTML = totals.map(({ zone, value }) =>
    `<div class="bar-item" title="${zone} : ${formatNumber(value)} kg"><div class="bar-track"><div class="bar-fill" style="height:${Math.max(value / max * 100, value ? 5 : 0)}%"></div></div><span>${zone.replace("Parc national de ", "").replace("Plage ", "")}</span></div>`
  ).join("");
}

function renderMap(items, risks) {
  const activeZones = new Set(items.map((item) => item.zone));
  document.getElementById("map-points").innerHTML = zones.map((zone) => {
    const [x, y] = pinPositions[zone];
    const active = activeZones.has(zone);
    return `<button class="map-pin${risks.has(zone) ? " alert" : ""}" style="left:${x}%;top:${y}%" title="${zone}${risks.has(zone) ? " — à surveiller" : ""}" aria-label="Filtrer par ${zone}" data-zone="${zone}"${active ? "" : " disabled"}></button>`;
  }).join("");
  document.querySelectorAll(".map-pin").forEach((pin) => {
    pin.addEventListener("click", () => {
      zoneFilter.value = pin.dataset.zone;
      render();
      document.getElementById("tableau").scrollIntoView({ behavior: "smooth" });
    });
  });
}

function renderTable(items) {
  const sorted = [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
  tableBody.innerHTML = sorted.slice(0, 20).map((item) => {
    const isRisk = (item.type === "Pollution" && item.value >= 2) || (item.type === "Érosion côtière" && item.value >= 3);
    const measure = `${formatNumber(item.value)} ${item.unit}${item.material ? ` · ${item.material}` : ""}`;
    return `<tr>
      <td class="zone-cell">${escapeHtml(item.zone)}</td>
      <td><span class="type-label"><i class="type-bullet" style="background:${typeColors[item.type] || "#8291a0"}"></i>${escapeHtml(item.type)}</span></td>
      <td>${escapeHtml(measure)}</td>
      <td>${escapeHtml(item.contributor || "Contributeur")}${item.demo ? ' <span title="Donnée fictive de démonstration">· démo</span>' : ""}</td>
      <td>${formatDate(item.date)}</td>
      <td><span class="status${isRisk ? " alert" : ""}">${isRisk ? "À vérifier" : "Partagée"}</span></td>
    </tr>`;
  }).join("");
  document.getElementById("empty-state").hidden = sorted.length > 0;
  document.getElementById("table-summary").textContent = `${sorted.length} observation${sorted.length === 1 ? "" : "s"}${items.length > sorted.length ? " récentes affichées" : ""}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function render() {
  const items = selectedObservations();
  renderMetrics(items);
  renderTable(items);
}

function updateClock() {
  document.getElementById("current-time").textContent = `Mise à jour ${new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`;
}

function renderAccount() {
  const displayName = currentUser.email.split("@")[0];
  document.getElementById("account-name").textContent = displayName;
  document.getElementById("account-avatar").textContent = displayName.slice(0, 1).toUpperCase();
  document.getElementById("account-role").textContent = currentUser.role === "admin" ? "Admin" : "Utilisateur";
}

async function initializeSession() {
  try {
    const session = await requestApi("/api/auth/me");
    if (!session.user) {
      window.location.replace("/connexion");
      return;
    }
    currentUser = session.user;
    notificationStorageKey = `${NOTIFICATIONS_STORAGE_KEY}-${currentUser.id}`;
    notificationRecords = loadNotifications();
    renderNotifications();
    renderAccount();
  } catch {
    window.location.replace("/connexion");
    return;
  }
  await initializeDatabase();
  window.setInterval(async () => {
    try {
      await refreshDatabaseObservations();
    } catch (error) {
      console.error("Impossible d’actualiser les observations depuis SQLite.", error);
      setConnectionStatus(`Actualisation impossible : ${error.message}`, true);
    }
  }, 15_000);
}

function updateFormFields() {
  const type = typeSelect.value;
  const unitByType = {
    "Déchets collectés": "kg",
    Biodiversité: "espèces",
    "Qualité de l’eau": "°C",
    "Érosion côtière": "niveau 1–5",
    Pollution: "niveau 1–5"
  };
  unitSelect.value = unitByType[type];
  const isWaste = type === "Déchets collectés";
  materialSelect.disabled = !isWaste;
  materialLabel.hidden = !isWaste;
  materialSelect.hidden = !isWaste;
}

function downloadCsv() {
  const rows = selectedObservations().map((item) => [
    item.zone, item.type, item.value, item.unit, item.material || "", item.contributor || "", item.date, item.note || ""
  ]);
  const headings = ["Zone", "Type", "Valeur", "Unité", "Matière", "Contributeur", "Date ISO", "Commentaire"];
  const csv = [headings, ...rows].map((row) =>
    row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(";")
  ).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "observations-littoral-gabonais.csv";
  link.click();
  URL.revokeObjectURL(url);
}

zoneFilter.addEventListener("change", render);
periodFilter.addEventListener("change", render);
typeFilter.addEventListener("change", render);
document.getElementById("notification-button").addEventListener("click", (event) => {
  const panel = document.getElementById("notification-panel");
  const isOpen = panel.hidden;
  panel.hidden = !isOpen;
  event.currentTarget.setAttribute("aria-expanded", String(isOpen));
});
document.getElementById("notification-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-notification-id]");
  if (!button) return;
  const notification = notificationRecords.find((item) => item.id === button.dataset.notificationId);
  if (!notification) return;
  notification.read = true;
  saveNotifications();
  renderNotifications();
  if (notification.kind !== "deleted") {
    zoneFilter.value = notification.zone;
    periodFilter.value = "all";
    typeFilter.value = "all";
    render();
    document.getElementById("tableau").scrollIntoView({ behavior: "smooth" });
  }
  document.getElementById("notification-panel").hidden = true;
  document.getElementById("notification-button").setAttribute("aria-expanded", "false");
});
document.getElementById("mark-notifications-read").addEventListener("click", () => {
  notificationRecords.forEach((item) => { item.read = true; });
  saveNotifications();
  renderNotifications();
});
document.getElementById("enable-browser-notifications").addEventListener("click", async () => {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  await Notification.requestPermission();
  renderNotifications();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".notification-area")) {
    document.getElementById("notification-panel").hidden = true;
    document.getElementById("notification-button").setAttribute("aria-expanded", "false");
  }
});
document.getElementById("download-button").addEventListener("click", downloadCsv);
document.getElementById("logout-button").addEventListener("click", async () => {
  try {
    await requestApi("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.replace("/connexion");
  }
});
document.getElementById("open-form").addEventListener("click", () => {
  document.getElementById("form-error").hidden = true;
  dialog.showModal();
});
document.getElementById("close-form").addEventListener("click", () => dialog.close());
document.getElementById("cancel-form").addEventListener("click", () => dialog.close());
typeSelect.addEventListener("change", updateFormFields);
observationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.getElementById("form-error");
  const submitButton = observationForm.querySelector('button[type="submit"]');
  const value = Number(document.getElementById("form-value").value);
  if (!Number.isFinite(value) || value < 0) {
    error.textContent = "Saisissez une valeur numérique positive.";
    error.hidden = false;
    return;
  }
  if ((typeSelect.value === "Pollution" || typeSelect.value === "Érosion côtière") && value > 5) {
    error.textContent = "Pour ce type d’observation, la valeur doit être comprise entre 0 et 5.";
    error.hidden = false;
    return;
  }
  const observation = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    zone: document.getElementById("form-zone").value,
    type: typeSelect.value,
    value,
    unit: unitSelect.value,
    material: typeSelect.value === "Déchets collectés" ? materialSelect.value : "",
    contributor: currentUser ? currentUser.email.split("@")[0].slice(0, 80) : "Contributeur citoyen",
    date: new Date().toISOString(),
    note: document.getElementById("form-note").value.trim(),
    demo: false
  };
  submitButton.disabled = true;
  try {
    await requestApi("/api/observations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(observation)
    });
  } catch (saveError) {
    console.error("Impossible d’enregistrer l’observation dans SQLite.", saveError);
    error.textContent = `L’enregistrement dans la base a échoué : ${saveError.message}`;
    error.hidden = false;
    submitButton.disabled = false;
    return;
  }
  submitButton.disabled = false;
  knownObservations.set(observation.id, observation);
  observations.push(observation);
  zoneFilter.value = "all";
  periodFilter.value = "all";
  typeFilter.value = "all";
  render();
  observationForm.reset();
  updateFormFields();
  dialog.close();
});
document.getElementById("menu-toggle").addEventListener("click", (event) => {
  const menu = document.getElementById("main-nav");
  const isOpen = menu.classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", String(isOpen));
});
document.querySelectorAll(".main-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.getElementById("main-nav").classList.remove("open");
    document.getElementById("menu-toggle").setAttribute("aria-expanded", "false");
  });
});

updateFormFields();
renderNotifications();
updateClock();
window.setInterval(updateClock, 60_000);
render();
initializeSession();
