"use strict";

const ROUTES = ["search", "models", "favorites", "setup"];
const ROUTE_TITLES = {
  search: "Поиск юзернеймов",
  models: "Данные и модели",
  favorites: "Избранное",
  setup: "Настройка Telegram",
};
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "cancelled"]);
const ACTIVE_JOB_STATES = new Set(["queued", "running"]);

const state = {
  route: "search",
  status: null,
  favorites: [],
  favoriteFilter: "all",
  jobs: [],
  currentJob: null,
  eventSource: null,
  eventJobId: null,
  login: null,
  loginPoll: null,
  toastTimer: null,
  toastAction: null,
  completedJobs: new Set(),
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat("ru-RU").format(number) : "0";
}

function formatDate(value, withTime = false) {
  if (!value) return "Дата неизвестна";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function relativeDate(value) {
  if (!value) return "время неизвестно";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDate(value, true);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const ranges = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  for (const [unit, size] of ranges) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(seconds, "second");
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeout ?? 20_000);
  try {
    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { error: raw };
      }
    }
    if (!response.ok) {
      const detail = isObject(payload) && typeof payload.error === "string" ? payload.error : "";
      throw new Error(detail || `Сервер ответил с кодом ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Локальный API не ответил вовремя. Проверьте, что веб-сервер запущен.");
    }
    if (error instanceof TypeError) {
      throw new Error("Нет связи с локальным API. Запустите веб-сервер и обновите страницу.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Неизвестная ошибка");
}

function setBusy(form, busy) {
  if (!form) return;
  const submit = $('button[type="submit"]', form);
  if (!submit) return;
  if (!submit.dataset.idleLabel) submit.dataset.idleLabel = submit.textContent.trim();
  submit.disabled = busy;
  submit.setAttribute("aria-busy", String(busy));
  submit.textContent = busy
    ? submit.dataset.busyLabel || "Выполняем…"
    : submit.dataset.idleLabel;
}

function showFormError(formId, message, field = null) {
  const error = $(`#${formId}-error`);
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.focus();
  }
}

function clearFormError(formId) {
  const form = $(`#${formId}`);
  const error = $(`#${formId}-error`);
  if (error) {
    error.textContent = "";
    error.hidden = true;
  }
  if (form) {
    $$("[aria-invalid='true']", form).forEach((field) => field.removeAttribute("aria-invalid"));
  }
}

function hideToast() {
  const toast = $("#toast");
  toast.hidden = true;
  state.toastAction = null;
  $("#toast-action").hidden = true;
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = null;
}

function showToast(message, tone = "success", action = null) {
  const toast = $("#toast");
  const actionButton = $("#toast-action");
  $("#toast-message").textContent = message;
  toast.className = `toast toast--${tone}`;
  toast.hidden = false;
  state.toastAction = typeof action?.onClick === "function" ? action.onClick : null;
  actionButton.hidden = !state.toastAction;
  actionButton.textContent = state.toastAction ? action.label || "Вернуть" : "";
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(hideToast, state.toastAction ? 6_500 : 4_500);
}

function routeFromHash() {
  const value = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return ROUTES.includes(value) ? value : "search";
}

function renderRoute({ focus = false } = {}) {
  const route = routeFromHash();
  state.route = route;
  $$("[data-route-view]").forEach((view) => {
    view.hidden = view.dataset.routeView !== route;
  });
  $$("[data-route-link]").forEach((link) => {
    const active = link.dataset.routeLink === route;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#page-title").textContent = ROUTE_TITLES[route];
  document.title = `${ROUTE_TITLES[route]} — Handle Radar`;
  if (focus) {
    $("#main-content").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

function dotClass(tone) {
  const known = ["success", "warning", "danger", "active", "neutral"];
  return `status-dot status-dot--${known.includes(tone) ? tone : "neutral"}`;
}

function setStatusChip(id, label, value, tone = "neutral") {
  const chip = $(`#${id}`);
  if (!chip) return;
  chip.classList.remove("status-chip--loading");
  const dot = $(".status-dot", chip);
  dot.className = dotClass(tone);
  $("small", chip).textContent = label;
  $("strong", chip).textContent = value;
}

function modelExists(model) {
  if (typeof model === "boolean") return model;
  return isObject(model) ? model.exists === true : false;
}

function modelTimestamp(model) {
  if (!isObject(model)) return null;
  return model.trainedAt || model.updatedAt || null;
}

function normalizeStatus(payload) {
  const source = isObject(payload) ? payload : {};
  const telegram = isObject(source.telegram) ? source.telegram : {};
  const data = isObject(source.data) ? source.data : {};
  const models = isObject(source.models) ? source.models : {};
  return {
    telegram: {
      credentialsConfigured: telegram.credentialsConfigured === true,
      sessionExists: telegram.sessionExists === true,
      login: isObject(telegram.login) ? telegram.login : null,
    },
    data: {
      soldCount: Math.max(0, Number(data.soldCount) || 0),
      favoritesCount: Math.max(0, Number(data.favoritesCount) || 0),
    },
    models: {
      price: models.price ?? false,
      generator: models.generator ?? false,
    },
    activeJob: isObject(source.activeJob) ? source.activeJob : null,
  };
}

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const telegram = status.telegram;
  const soldCount = status.data.soldCount;
  const priceReady = modelExists(status.models.price);
  const generatorReady = modelExists(status.models.generator);

  setStatusChip("status-api", "API", "На связи", "success");
  if (telegram.sessionExists) {
    setStatusChip("status-telegram", "Telegram", "Сессия найдена", "success");
  } else if (telegram.credentialsConfigured) {
    setStatusChip("status-telegram", "Telegram", "Нужен вход", "warning");
  } else {
    setStatusChip("status-telegram", "Telegram", "Нужна настройка", "danger");
  }
  setStatusChip(
    "status-data",
    "Датасет",
    `${formatNumber(soldCount)} продаж`,
    soldCount >= 30 ? "success" : soldCount > 0 ? "warning" : "neutral",
  );
  const readyModels = Number(priceReady) + Number(generatorReady);
  setStatusChip(
    "status-models",
    "Модели",
    `${readyModels} из 2 готовы`,
    readyModels === 2 ? "success" : readyModels > 0 ? "warning" : "neutral",
  );

  $("#sidebar-api-label").textContent = "Локальный API на связи";
  $("#sidebar-api-dot").className = dotClass("success");
  $("#mobile-api-state").innerHTML =
    `<span class="${dotClass("success")}" aria-hidden="true"></span>На связи`;

  renderModelMetrics();
  renderReadiness();
  updateModelButtons();
}

function renderOffline(error) {
  setStatusChip("status-api", "API", "Нет связи", "danger");
  $("#sidebar-api-label").textContent = "API недоступен";
  $("#sidebar-api-dot").className = dotClass("danger");
  $("#mobile-api-state").innerHTML =
    `<span class="${dotClass("danger")}" aria-hidden="true"></span>Нет связи`;
  showToast(errorMessage(error), "error");
}

function metricCard(label, value, description, ready, timestamp = null) {
  const update = timestamp ? ` Обновлено ${relativeDate(timestamp)}.` : "";
  return `
    <article class="metric-card">
      <div class="metric-label">
        <span>${escapeHtml(label)}</span>
        <span class="metric-state ${ready ? "metric-state--ready" : ""}">${ready ? "Готово" : "Не готово"}</span>
      </div>
      <strong class="metric-value">${escapeHtml(value)}</strong>
      <p>${escapeHtml(description)}${escapeHtml(update)}</p>
    </article>
  `;
}

function renderModelMetrics() {
  const mount = $("#model-metrics");
  if (!state.status) return;
  const { data, models } = state.status;
  const priceReady = modelExists(models.price);
  const generatorReady = modelExists(models.generator);
  mount.innerHTML = [
    metricCard(
      "История продаж",
      formatNumber(data.soldCount),
      data.soldCount >= 30 ? "Данных достаточно для первого обучения." : "Для цены нужно минимум 30 записей.",
      data.soldCount >= 30,
    ),
    metricCard(
      "Модель цены",
      priceReady ? "online" : "offline",
      priceReady ? "Оценка цены доступна в поиске." : "Сначала соберите данные и запустите обучение.",
      priceReady,
      modelTimestamp(models.price),
    ),
    metricCard(
      "AI-генератор",
      generatorReady ? "online" : "offline",
      generatorReady ? "Нейрогенерация доступна." : "Обучите модель на продажах и избранном.",
      generatorReady,
      modelTimestamp(models.generator),
    ),
  ].join("");
}

function updateModelButtons() {
  if (!state.status) return;
  const sold = state.status.data.soldCount;
  const corpus = sold + state.status.data.favoritesCount;
  const priceButton = $("#train-price-button");
  const generatorButton = $("#train-generator-button");
  const aiButton = $("#generate-ai-button");
  priceButton.disabled = sold < 30;
  generatorButton.disabled = corpus < 20;
  aiButton.disabled = !modelExists(state.status.models.generator);
  $("#price-training-hint").textContent =
    sold >= 30
      ? `${formatNumber(sold)} записей готовы к обучению.`
      : `Нужно ещё ${formatNumber(30 - sold)} записей до минимального датасета.`;
  $("#generator-training-hint").textContent =
    corpus >= 20
      ? `${formatNumber(corpus)} имён в общем корпусе.`
      : `Нужно ещё ${formatNumber(20 - corpus)} имён в продажах и избранном.`;
}

async function refreshStatus({ silent = false } = {}) {
  try {
    const payload = await api("/api/status");
    state.status = normalizeStatus(payload);
    if (state.status.telegram.login) state.login = state.status.telegram.login;
    renderStatus();
    if (state.status.activeJob) {
      updateJob(state.status.activeJob, { announce: false });
      subscribeToJob(state.status.activeJob.id);
    }
    if (state.login) renderLogin();
    return state.status;
  } catch (error) {
    renderOffline(error);
    if (!silent) throw error;
    return null;
  }
}

function numberValue(form, name, fallback) {
  const field = form.elements.namedItem(name);
  const value = Number(field?.value);
  return Number.isFinite(value) ? value : fallback;
}

function checkboxValue(form, name) {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement ? field.checked : false;
}

function validateLengthRange(form, prefix = "") {
  const minField = form.elements.namedItem(`${prefix}minLength`);
  const maxField = form.elements.namedItem(`${prefix}maxLength`);
  const min = Number(minField?.value);
  const max = Number(maxField?.value);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { valid: false, message: "Укажите корректный диапазон длины.", field: minField };
  }
  if (min > max) {
    return {
      valid: false,
      message: "Минимальная длина не может быть больше максимальной.",
      field: minField,
    };
  }
  return { valid: true, min, max };
}

async function startJob(type, params, form) {
  setBusy(form, true);
  try {
    const payload = await api("/api/jobs", {
      method: "POST",
      body: { type, params },
    });
    const job = isObject(payload) && isObject(payload.job) ? payload.job : null;
    if (!job?.id) throw new Error("Сервер создал задачу без идентификатора.");
    updateJob(job, { announce: false });
    subscribeToJob(job.id);
    await refreshJobs({ silent: true });
    showToast("Задача добавлена в очередь.", "success");
    return job;
  } finally {
    setBusy(form, false);
  }
}

function jobTypeLabel(type) {
  return {
    search: "Поиск",
    "collect-sales": "Сбор продаж",
    "train-price": "Обучение цены",
    "train-generator": "Обучение генератора",
    "generate-ai": "AI-генерация",
  }[type] || type || "Задача";
}

function jobStatusMeta(status) {
  return {
    queued: { label: "В очереди", tone: "neutral" },
    running: { label: "Выполняется", tone: "active" },
    succeeded: { label: "Готово", tone: "success" },
    failed: { label: "Ошибка", tone: "danger" },
    cancelled: { label: "Отменено", tone: "warning" },
  }[status] || { label: status || "Неизвестно", tone: "neutral" };
}

function jobProgress(job) {
  const progress = isObject(job.progress) ? job.progress : {};
  const total = Math.max(0, Number(progress.total) || 0);
  const current = clamp(progress.current, 0, total || 100);
  const percent = total > 0 ? Math.round((current / total) * 100) : job.status === "succeeded" ? 100 : 0;
  return {
    current,
    total,
    percent,
    label: typeof progress.label === "string" && progress.label ? progress.label : jobStatusMeta(job.status).label,
  };
}

function renderJobCard(job) {
  const meta = jobStatusMeta(job.status);
  const progress = jobProgress(job);
  const logs = toArray(job.logs).map(String);
  const active = ACTIVE_JOB_STATES.has(job.status);
  const timestamp = job.startedAt || job.createdAt;
  return `
    <article class="panel job-card" data-job-id="${escapeHtml(job.id)}">
      <header class="job-head">
        <div class="job-title">
          <span class="job-type">${escapeHtml(job.type || "job")}</span>
          <div>
            <h3>${escapeHtml(jobTypeLabel(job.type))}</h3>
            <p>
              <span class="${dotClass(meta.tone)}" aria-hidden="true"></span>
              ${escapeHtml(meta.label)} · ${escapeHtml(relativeDate(timestamp))}
            </p>
          </div>
        </div>
        <div class="job-actions">
          ${active ? `<button class="button button--danger button--small" type="button" data-cancel-job="${escapeHtml(job.id)}">Остановить</button>` : ""}
        </div>
      </header>
      <div class="progress-block">
        <label for="progress-${escapeHtml(job.id)}">${escapeHtml(progress.label)}</label>
        <output for="progress-${escapeHtml(job.id)}">${progress.percent}%</output>
        <progress id="progress-${escapeHtml(job.id)}" max="100" value="${progress.percent}">${progress.percent}%</progress>
      </div>
      ${job.error ? `<p class="job-error" role="alert">${escapeHtml(job.error)}</p>` : ""}
      <div class="log-box">
        <div class="log-head">
          <span>Журнал выполнения</span>
          <span>${formatNumber(logs.length)} строк</span>
        </div>
        <pre tabindex="0">${escapeHtml(logs.length ? logs.join("\n") : "Ожидаем первый ответ…")}</pre>
      </div>
    </article>
  `;
}

function renderJobPanels() {
  const job = state.currentJob;
  const searchMount = $("#search-job-panel");
  const modelsMount = $("#models-job-panel");
  searchMount.innerHTML = "";
  modelsMount.innerHTML = "";
  if (!job) return;
  const target = job.type === "search" ? searchMount : modelsMount;
  target.innerHTML = renderJobCard(job);
  const pre = $("pre", target);
  if (pre) pre.scrollTop = pre.scrollHeight;
}

function updateJob(job, { announce = true } = {}) {
  if (!isObject(job) || !job.id) return;
  const existingIndex = state.jobs.findIndex((item) => item.id === job.id);
  if (existingIndex >= 0) state.jobs.splice(existingIndex, 1, job);
  else state.jobs.unshift(job);
  state.currentJob = job;
  renderJobPanels();
  renderJobHistory();
  if (job.result !== undefined && ["search", "generate-ai"].includes(job.type)) {
    renderResults(job.result, job);
  }
  if (TERMINAL_JOB_STATES.has(job.status)) {
    if (state.eventJobId === job.id) closeEventSource();
    if (!state.completedJobs.has(job.id)) {
      state.completedJobs.add(job.id);
      if (announce) {
        const meta = jobStatusMeta(job.status);
        showToast(
          job.status === "succeeded"
            ? `${jobTypeLabel(job.type)}: задача завершена.`
            : `${jobTypeLabel(job.type)}: ${job.error || meta.label}.`,
          job.status === "succeeded" ? "success" : job.status === "failed" ? "error" : "warning",
        );
      }
      void refreshStatus({ silent: true });
      void refreshFavorites({ silent: true });
    }
  }
}

function closeEventSource() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  state.eventJobId = null;
}

function subscribeToJob(id) {
  if (!id || (state.eventSource && state.eventJobId === id)) return;
  closeEventSource();
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.eventSource = source;
  state.eventJobId = id;
  source.addEventListener("snapshot", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (isObject(payload) && isObject(payload.job)) updateJob(payload.job);
    } catch {
      showToast("Получено повреждённое обновление задачи.", "warning");
    }
  });
  source.addEventListener("error", () => {
    if (state.currentJob?.id === id && TERMINAL_JOB_STATES.has(state.currentJob.status)) {
      closeEventSource();
    }
  });
}

async function cancelJob(id, button) {
  if (!id) return;
  if (button) button.disabled = true;
  try {
    const payload = await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
    if (isObject(payload) && isObject(payload.job)) updateJob(payload.job, { announce: false });
    showToast("Остановка задачи запрошена.", "warning");
  } catch (error) {
    showToast(errorMessage(error), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function refreshJobs({ silent = false } = {}) {
  try {
    const payload = await api("/api/jobs");
    state.jobs = toArray(isObject(payload) ? payload.jobs : payload).filter(isObject);
    const active = state.jobs.find((job) => ACTIVE_JOB_STATES.has(job.status));
    const selected = state.currentJob && state.jobs.find((job) => job.id === state.currentJob.id);
    if (active) {
      state.currentJob = active;
      subscribeToJob(active.id);
    } else if (selected) {
      state.currentJob = selected;
    } else if (!state.currentJob && state.jobs.length) {
      state.currentJob = state.jobs[0];
    }
    renderJobPanels();
    renderJobHistory();
    if (
      state.currentJob &&
      TERMINAL_JOB_STATES.has(state.currentJob.status) &&
      state.currentJob.result !== undefined
    ) {
      renderResults(state.currentJob.result, state.currentJob);
    }
    return state.jobs;
  } catch (error) {
    if (!silent) showToast(errorMessage(error), "error");
    return [];
  }
}

function renderJobHistory() {
  const mount = $("#jobs-history");
  const jobs = state.jobs.slice(0, 8);
  if (!jobs.length) {
    mount.innerHTML = '<div class="empty-inline">История появится после первого запуска.</div>';
    return;
  }
  mount.innerHTML = `<div class="history-list">${jobs
    .map((job) => {
      const meta = jobStatusMeta(job.status);
      return `
        <div class="history-item">
          <div class="history-item-main">
            <span class="${dotClass(meta.tone)}" aria-hidden="true"></span>
            <strong>${escapeHtml(jobTypeLabel(job.type))}</strong>
          </div>
          <span class="status-label">${escapeHtml(meta.label)}</span>
          <time datetime="${escapeHtml(job.createdAt || "")}">${escapeHtml(formatDate(job.createdAt, true))}</time>
        </div>
      `;
    })
    .join("")}</div>`;
}

function extractResultItems(result) {
  if (Array.isArray(result)) return result;
  if (!isObject(result)) return [];
  for (const key of ["results", "items", "candidates", "usernames", "data"]) {
    if (Array.isArray(result[key])) return result[key];
  }
  return [];
}

function normalizeAvailability(value) {
  if (value === true) return "free";
  if (value === false) return "busy";
  if (value === "invalid") return "invalid";
  return "unknown";
}

function availabilityLabel(value) {
  return {
    free: "Свободно",
    busy: "Занято",
    invalid: "Некорректно",
    unknown: "Неизвестно",
    unchecked: "Не проверено",
  }[value] || "Неизвестно";
}

function availabilityTone(value) {
  return {
    free: "success",
    busy: "danger",
    invalid: "danger",
    unknown: "warning",
    unchecked: "neutral",
  }[value] || "neutral";
}

function groupResults(result) {
  const items = extractResultItems(result);
  const groups = new Map();
  for (const raw of items) {
    const item = typeof raw === "string" ? { username: raw } : isObject(raw) ? raw : null;
    if (!item) continue;
    const username = String(item.username || item.handle || item.name || "").replace(/^@/, "").trim();
    if (!username) continue;
    if (!groups.has(username)) {
      groups.set(username, {
        username,
        telegram: null,
        fragment: null,
        direct: null,
        price: item.price || item.estimatedPrice || item.estimate || null,
        checkedAt: item.checkedAt || null,
        confidence: item.confidence || null,
      });
    }
    const group = groups.get(username);
    const source = String(item.source || "").toLowerCase();
    const hasAvailability = item.available !== undefined || item.status !== undefined;
    const record = {
      availability: normalizeAvailability(item.available ?? item.status),
      detail: item.detail || item.reason || "",
      confidence: item.confidence || null,
      checkedAt: item.checkedAt || null,
    };
    if (source === "telegram" || source === "fragment") group[source] = record;
    else if (hasAvailability) group.direct = record;
    group.price ||= item.price || item.estimatedPrice || item.estimate || null;
    group.checkedAt ||= item.checkedAt || null;
    group.confidence ||= item.confidence || null;
  }
  return Array.from(groups.values());
}

function sourceStatus(group, source) {
  const record = group[source];
  if (record) return record.availability;
  if (group.direct && !group.telegram && !group.fragment) return group.direct.availability;
  return "unchecked";
}

function availabilityHtml(value, detail = "") {
  const label = availabilityLabel(value);
  const title = detail ? ` title="${escapeHtml(detail)}"` : "";
  return `
    <span class="availability availability--${escapeHtml(value)}"${title}>
      <span class="${dotClass(availabilityTone(value))}" aria-hidden="true"></span>
      ${escapeHtml(label)}
    </span>
  `;
}

function priceLabel(price) {
  if (price == null) return "—";
  if (typeof price === "number") return `${formatNumber(price)} TON`;
  if (isObject(price)) {
    if (Number.isFinite(Number(price.ton))) return `≈ ${Number(price.ton).toFixed(1)} TON`;
    if (Number.isFinite(Number(price.usd))) return `≈ $${Number(price.usd).toFixed(0)}`;
  }
  return String(price);
}

function normalizeFavoritePrice(price) {
  if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
    return { ton: price };
  }
  if (!isObject(price)) return null;
  const ton = Number(price.ton);
  if (!Number.isFinite(ton) || ton < 0) return null;
  const normalized = { ton };
  const usd = Number(price.usd);
  const rub = Number(price.rub);
  if (Number.isFinite(usd) && usd >= 0) normalized.usd = usd;
  if (Number.isFinite(rub) && rub >= 0) normalized.rub = rub;
  return normalized;
}

function encodeFavoritePrice(price) {
  const normalized = normalizeFavoritePrice(price);
  return normalized ? encodeURIComponent(JSON.stringify(normalized)) : "";
}

function decodeFavoritePrice(value) {
  if (!value) return null;
  try {
    return normalizeFavoritePrice(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}

function favoriteTimestamp(favorite) {
  const timestamp = Date.parse(favorite?.addedAt || "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function renderResults(result, job = null) {
  const mount = $("#results-content");
  const rows = groupResults(result);
  $("#results-count").textContent = rows.length
    ? `${formatNumber(rows.length)} ${rows.length === 1 ? "имя" : "имён"}`
    : "Нет структурированных данных";
  if (!rows.length) {
    const fallback =
      job?.status === "succeeded"
        ? "Задача завершилась, но структурированных результатов нет. Подробности сохранены в журнале."
        : "Результаты появятся после завершения задачи.";
    mount.innerHTML = `
      <div class="empty-state">
        <span class="empty-code" aria-hidden="true">@_</span>
        <h3>Список пока пуст</h3>
        <p>${escapeHtml(fallback)}</p>
      </div>
    `;
    return;
  }

  mount.innerHTML = `
    <div class="result-table" role="table" aria-label="Результаты проверки">
      <div class="result-row result-header" role="row">
        <span role="columnheader">Юзернейм</span>
        <span role="columnheader">Telegram</span>
        <span role="columnheader">Fragment</span>
        <span role="columnheader">Сигнал</span>
        <span role="columnheader">Действие</span>
      </div>
      ${rows
        .map((group) => {
          const telegram = sourceStatus(group, "telegram");
          const fragment = sourceStatus(group, "fragment");
          const preferredSource =
            telegram === "free" ? "telegram" : fragment === "free" ? "fragment" : "telegram";
          const checkedAt =
            group.telegram?.checkedAt || group.fragment?.checkedAt || group.checkedAt || null;
          const confidence =
            group.telegram?.confidence || group.fragment?.confidence || group.confidence || null;
          const encodedPrice = encodeFavoritePrice(group.price);
          const meta = [
            confidence === "high" ? "Высокая точность" : confidence === "low" ? "Эвристика" : "Без оценки",
            priceLabel(group.price),
          ];
          return `
            <div class="result-row" role="row">
              <div class="result-cell" role="cell" data-label="Юзернейм">
                <span class="result-username">@${escapeHtml(group.username)}</span>
              </div>
              <div class="result-cell" role="cell" data-label="Telegram">
                ${availabilityHtml(telegram, group.telegram?.detail)}
              </div>
              <div class="result-cell" role="cell" data-label="Fragment">
                ${availabilityHtml(fragment, group.fragment?.detail)}
              </div>
              <div class="result-cell" role="cell" data-label="Сигнал">
                <span class="result-meta">
                  ${escapeHtml(meta[0])} · ${escapeHtml(meta[1])}
                  <small>${escapeHtml(checkedAt ? relativeDate(checkedAt) : "Время не указано")}</small>
                </span>
              </div>
              <div class="result-cell" role="cell" data-label="Действие">
                <button
                  class="button button--quiet button--small result-action"
                  type="button"
                  data-add-result-favorite="${escapeHtml(group.username)}"
                  data-result-source="${preferredSource}"
                  data-result-price="${escapeHtml(encodedPrice)}"
                >
                  В избранное
                </button>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function favoritePayload(payload) {
  if (Array.isArray(payload)) return payload;
  return toArray(isObject(payload) ? payload.favorites : []);
}

async function refreshFavorites({ silent = false } = {}) {
  try {
    const payload = await api("/api/favorites");
    state.favorites = favoritePayload(payload).filter(isObject);
    renderFavorites();
    if (state.status) {
      state.status.data.favoritesCount = state.favorites.length;
      renderStatus();
    }
    return state.favorites;
  } catch (error) {
    $("#favorites-content").innerHTML = `
      <div class="empty-inline">Не удалось загрузить избранное. ${escapeHtml(errorMessage(error))}</div>
    `;
    if (!silent) showToast(errorMessage(error), "error");
    return [];
  }
}

function renderFavorites() {
  const mount = $("#favorites-content");
  const all = [...state.favorites].sort(
    (a, b) => favoriteTimestamp(b) - favoriteTimestamp(a),
  );
  const filtered =
    state.favoriteFilter === "all"
      ? all
      : all.filter((favorite) => favorite.source === state.favoriteFilter);
  $("#favorites-total").textContent = `${formatNumber(all.length)} сохранено`;

  if (!filtered.length) {
    const message = all.length
      ? "В выбранном источнике пока ничего нет."
      : "Добавьте находку из результатов поиска или вручную через форму выше.";
    mount.innerHTML = `
      <div class="empty-state">
        <span class="empty-code" aria-hidden="true">@+</span>
        <h3>${all.length ? "Нет совпадений" : "Короткий список пуст"}</h3>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
    return;
  }

  mount.innerHTML = `<div class="favorite-list">${filtered
    .map(
      (favorite) => `
        <article class="favorite-item">
          <div class="favorite-main">
            <h3>@${escapeHtml(favorite.username)}</h3>
            ${favorite.note ? `<p>${escapeHtml(favorite.note)}</p>` : ""}
            <time datetime="${escapeHtml(favorite.addedAt || "")}">
              Добавлено ${escapeHtml(relativeDate(favorite.addedAt))}
            </time>
          </div>
          <div class="favorite-actions">
            <span class="source-tag">${escapeHtml(
              favorite.source === "fragment" ? "Fragment" : "Telegram",
            )}</span>
            ${
              normalizeFavoritePrice(favorite.price)
                ? `<span class="favorite-price">${escapeHtml(priceLabel(favorite.price))}</span>`
                : ""
            }
            <button
              class="button button--danger button--small"
              type="button"
              data-remove-favorite="${escapeHtml(favorite.username)}"
              data-favorite-source="${escapeHtml(favorite.source || "telegram")}"
            >
              Удалить
            </button>
          </div>
        </article>
      `,
    )
    .join("")}</div>`;
}

async function addFavorite(data, { quiet = false } = {}) {
  const payload = await api("/api/favorites", { method: "POST", body: data });
  const favorite = isObject(payload) && isObject(payload.favorite) ? payload.favorite : data;
  const index = state.favorites.findIndex(
    (item) => item.username === favorite.username && item.source === favorite.source,
  );
  if (index >= 0) state.favorites.splice(index, 1, favorite);
  else state.favorites.unshift(favorite);
  renderFavorites();
  if (!quiet) showToast(`@${favorite.username} добавлен в избранное.`, "success");
  void refreshStatus({ silent: true });
  return favorite;
}

async function removeFavorite(username, source, button) {
  const existing = state.favorites.find(
    (item) => item.username === username && item.source === source,
  );
  if (button) button.disabled = true;
  try {
    await api(
      `/api/favorites/${encodeURIComponent(username)}?source=${encodeURIComponent(source)}`,
      { method: "DELETE" },
    );
    state.favorites = state.favorites.filter(
      (item) => !(item.username === username && item.source === source),
    );
    renderFavorites();
    showToast(`@${username} удалён.`, "warning", existing
      ? {
          label: "Вернуть",
          onClick: async () => {
            try {
              await addFavorite(
                {
                  username: existing.username,
                  source: existing.source,
                  note: existing.note || "",
                  price: existing.price,
                },
                { quiet: true },
              );
              showToast(`@${username} восстановлен.`, "success");
            } catch (error) {
              showToast(errorMessage(error), "error");
            }
          },
        }
      : null);
    void refreshStatus({ silent: true });
  } catch (error) {
    showToast(errorMessage(error), "error");
    if (button) button.disabled = false;
  }
}

function normalizeLogin(payload) {
  const candidate = isObject(payload) && isObject(payload.login) ? payload.login : payload;
  const login = isObject(candidate) ? candidate : {};
  const known = [
    "idle",
    "connecting",
    "code",
    "password",
    "email_address",
    "email_code",
    "success",
    "error",
    "cancelled",
  ];
  return {
    phase: known.includes(login.phase) ? login.phase : "idle",
    message: typeof login.message === "string" ? login.message : "Вход ещё не запускался",
    startedAt: login.startedAt || null,
    updatedAt: login.updatedAt || null,
  };
}

function renderLogin() {
  const login = state.login || normalizeLogin({});
  const phase = login.phase;
  const meta = {
    idle: { title: "Ожидает запуска", tone: "neutral" },
    connecting: { title: "Подключаемся", tone: "active" },
    code: { title: "Нужен код", tone: "warning" },
    password: { title: "Нужен пароль 2FA", tone: "warning" },
    email_address: { title: "Нужен резервный email", tone: "warning" },
    email_code: { title: "Нужен код из email", tone: "warning" },
    success: { title: "Telegram подключён", tone: "success" },
    error: { title: "Ошибка входа", tone: "danger" },
    cancelled: { title: "Вход отменён", tone: "neutral" },
  }[phase];

  $("#login-state").innerHTML = `
    <div class="login-state-head">
      <span class="${dotClass(meta.tone)}" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(meta.title)}</strong>
        <small>${escapeHtml(login.message)}</small>
      </div>
    </div>
  `;

  const credentialsReady = state.status?.telegram.credentialsConfigured === true;
  const sessionExists = state.status?.telegram.sessionExists === true;
  const phoneForm = $("#login-phone-form");
  const answerForm = $("#login-answer-form");
  const cancelConnecting = $("#cancel-connecting");
  const answerModes = {
    code: {
      label: "Код из Telegram",
      hint: "Код придёт в официальное приложение Telegram.",
      type: "text",
      inputMode: "numeric",
      autocomplete: "one-time-code",
    },
    password: {
      label: "Пароль 2FA",
      hint: "Пароль облачной двухэтапной аутентификации.",
      type: "password",
      inputMode: "text",
      autocomplete: "current-password",
    },
    email_address: {
      label: "Резервный email",
      hint: "Telegram запросил адрес для подтверждения входа.",
      type: "email",
      inputMode: "email",
      autocomplete: "email",
    },
    email_code: {
      label: "Код из email",
      hint: "Введите код из письма Telegram.",
      type: "text",
      inputMode: "numeric",
      autocomplete: "one-time-code",
    },
  };
  const answerMode = answerModes[phase] || answerModes.code;

  phoneForm.hidden =
    !credentialsReady ||
    sessionExists ||
    !["idle", "error", "cancelled"].includes(phase);
  answerForm.hidden = !Object.hasOwn(answerModes, phase);
  cancelConnecting.hidden = phase !== "connecting";

  const answer = $("#login-answer");
  $("#login-answer-label").textContent = answerMode.label;
  $("#login-answer-hint").textContent = answerMode.hint;
  answer.type = answerMode.type;
  answer.inputMode = answerMode.inputMode;
  answer.autocomplete = answerMode.autocomplete;

  if (["connecting", "code", "password", "email_address", "email_code"].includes(phase)) {
    startLoginPolling();
  } else {
    stopLoginPolling();
  }
}

function renderReadiness() {
  if (!state.status) return;
  const credentials = state.status.telegram.credentialsConfigured;
  const session = state.status.telegram.sessionExists;
  const rows = [
    {
      title: "API credentials",
      description: credentials ? "Сохранены локально" : "Нужно добавить API ID и API Hash",
      tone: credentials ? "success" : "warning",
    },
    {
      title: "MTProto-сессия",
      description: session ? "Локальная сессия найдена" : "Нужно пройти вход по номеру",
      tone: session ? "success" : "warning",
    },
    {
      title: "Telegram-проверка",
      description: credentials && session
        ? "Данные готовы; сеть проверяется при поиске"
        : "Пока недоступна",
      tone: credentials && session ? "success" : "neutral",
    },
  ];
  $("#readiness-list").innerHTML = rows
    .map(
      (row) => `
        <div>
          <span class="${dotClass(row.tone)}" aria-hidden="true"></span>
          <p>
            <strong>${escapeHtml(row.title)}</strong>
            <small>${escapeHtml(row.description)}</small>
          </p>
        </div>
      `,
    )
    .join("");
  $("#setup-state-badge").textContent =
    credentials && session ? "Готово" : credentials ? "Нужен вход" : "Нужна настройка";
}

async function refreshLogin({ silent = false } = {}) {
  try {
    const payload = await api("/api/login");
    state.login = normalizeLogin(payload);
    renderLogin();
    if (state.login.phase === "success") await refreshStatus({ silent: true });
    return state.login;
  } catch (error) {
    if (!silent) showToast(errorMessage(error), "error");
    return null;
  }
}

function startLoginPolling() {
  if (state.loginPoll) return;
  state.loginPoll = window.setInterval(() => {
    void refreshLogin({ silent: true });
  }, 1_200);
}

function stopLoginPolling() {
  if (!state.loginPoll) return;
  window.clearInterval(state.loginPoll);
  state.loginPoll = null;
}

function bindSearchForm() {
  const form = $("#search-form");
  const mode = $("#search-mode");
  const digits = $("#search-digits");
  const digitsRequire = digits.querySelector('option[value="require"]');
  const updateModeFields = () => {
    const isWord = mode.value === "word";
    const isTranslit = mode.value === "translit";
    $("#word-fields").hidden = !isWord;
    $("#search-word").required = isWord;
    digitsRequire.disabled = isTranslit;
    if (isTranslit && digits.value === "require") digits.value = "exclude";
    $("#search-digits-hint").textContent = isTranslit
      ? "Точный транслит одного существительного — без цифр и суффиксов."
      : "Политика цифр для сгенерированных имён.";
  };
  mode.addEventListener("change", updateModeFields);
  updateModeFields();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("search-form");
    const range = validateLengthRange(form);
    if (!range.valid) {
      showFormError("search-form", range.message, range.field);
      return;
    }
    const word = String(form.elements.word.value || "").trim().toLowerCase();
    if (form.elements.mode.value === "word" && !/^[a-z][a-z0-9]*$/.test(word)) {
      showFormError(
        "search-form",
        "Слово должно начинаться с латинской буквы и содержать только a–z и цифры.",
        form.elements.word,
      );
      return;
    }
    if (word && word.length > range.max) {
      showFormError(
        "search-form",
        "Обязательное слово длиннее максимальной длины юзернейма.",
        form.elements.word,
      );
      return;
    }
    const params = {
      source: form.elements.source.value,
      mode: form.elements.mode.value,
      minLength: range.min,
      maxLength: range.max,
      digits: form.elements.digits.value,
      count: numberValue(form, "count", 20),
      charset: String(form.elements.charset.value || "").trim(),
      word,
      wordPosition: form.elements.wordPosition.value,
      delayMs: numberValue(form, "delayMs", 2000),
      debug: checkboxValue(form, "debug"),
      usePlaywright: checkboxValue(form, "usePlaywright"),
      legacyWeb: checkboxValue(form, "legacyWeb"),
      estimatePrice: checkboxValue(form, "estimatePrice"),
    };
    try {
      await startJob("search", params, form);
    } catch (error) {
      showFormError("search-form", errorMessage(error));
    }
  });
}

function bindModelForms() {
  const collectForm = $("#collect-form");
  collectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("collect-form");
    const params = {
      pages: numberValue(collectForm, "pages", 3),
      delayMs: numberValue(collectForm, "delayMs", 2000),
      debug: checkboxValue(collectForm, "debug"),
    };
    try {
      await startJob("collect-sales", params, collectForm);
    } catch (error) {
      showFormError("collect-form", errorMessage(error));
    }
  });

  for (const [formId, type] of [
    ["train-price-form", "train-price"],
    ["train-generator-form", "train-generator"],
  ]) {
    const form = $(`#${formId}`);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearFormError(formId);
      try {
        await startJob(type, { epochs: numberValue(form, "epochs", 100) }, form);
      } catch (error) {
        showFormError(formId, errorMessage(error));
      }
    });
  }

  const aiForm = $("#generate-ai-form");
  aiForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("generate-ai-form");
    const range = validateLengthRange(aiForm);
    if (!range.valid) {
      showFormError("generate-ai-form", range.message, range.field);
      return;
    }
    const params = {
      count: numberValue(aiForm, "count", 20),
      minLength: range.min,
      maxLength: range.max,
      temperature: numberValue(aiForm, "temperature", 0.8),
      source: aiForm.elements.source.value,
      delayMs: numberValue(aiForm, "delayMs", 2000),
      estimatePrice: checkboxValue(aiForm, "estimatePrice"),
    };
    try {
      await startJob("generate-ai", params, aiForm);
    } catch (error) {
      showFormError("generate-ai-form", errorMessage(error));
    }
  });
}

function bindFavorites() {
  const form = $("#favorite-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("favorite-form");
    const username = String(form.elements.username.value || "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
    const source = form.elements.source.value;
    const priceRaw = String(form.elements.priceTon.value || "").trim();
    if (!/^[a-z][a-z0-9_]{3,31}$/.test(username) || username.includes("__") || username.endsWith("_")) {
      showFormError(
        "favorite-form",
        "Введите 4–32 символа: первая буква, далее латинские буквы, цифры или одиночное подчёркивание.",
        form.elements.username,
      );
      return;
    }
    if (source === "telegram" && username.length < 5) {
      showFormError(
        "favorite-form",
        "Обычный Telegram-юзернейм должен содержать минимум 5 символов.",
        form.elements.username,
      );
      return;
    }
    const priceTon = priceRaw === "" ? null : Number(priceRaw);
    if (priceTon !== null && (!Number.isFinite(priceTon) || priceTon < 0 || priceTon > 1_000_000_000_000)) {
      showFormError(
        "favorite-form",
        "Цена должна быть числом от 0 до 1 000 000 000 000 TON.",
        form.elements.priceTon,
      );
      return;
    }
    setBusy(form, true);
    try {
      await addFavorite({
        username,
        source,
        note: String(form.elements.note.value || "").trim(),
        price: priceTon === null ? undefined : { ton: priceTon },
      });
      form.reset();
    } catch (error) {
      showFormError("favorite-form", errorMessage(error));
    } finally {
      setBusy(form, false);
    }
  });

  $$("[data-favorite-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.favoriteFilter = button.dataset.favoriteFilter;
      $$("[data-favorite-filter]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      });
      renderFavorites();
    });
  });
}

function bindSetup() {
  const credentialsForm = $("#credentials-form");
  credentialsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("credentials-form");
    const apiId = Number(credentialsForm.elements.apiId.value);
    const apiHash = String(credentialsForm.elements.apiHash.value || "").trim();
    if (!Number.isInteger(apiId) || apiId <= 0) {
      showFormError(
        "credentials-form",
        "API ID должен быть положительным целым числом.",
        credentialsForm.elements.apiId,
      );
      return;
    }
    if (!/^[a-fA-F0-9]{16,128}$/.test(apiHash)) {
      showFormError(
        "credentials-form",
        "API Hash должен содержать от 16 до 128 шестнадцатеричных символов.",
        credentialsForm.elements.apiHash,
      );
      return;
    }
    setBusy(credentialsForm, true);
    try {
      await api("/api/settings/telegram", {
        method: "POST",
        body: { apiId, apiHash },
      });
      credentialsForm.reset();
      $("#telegram-api-hash").type = "password";
      $("#toggle-api-hash").textContent = "Показать";
      $("#toggle-api-hash").setAttribute("aria-pressed", "false");
      showToast("Telegram credentials сохранены локально.", "success");
      await refreshStatus({ silent: true });
      await refreshLogin({ silent: true });
    } catch (error) {
      showFormError("credentials-form", errorMessage(error));
    } finally {
      setBusy(credentialsForm, false);
    }
  });

  $("#toggle-api-hash").addEventListener("click", () => {
    const input = $("#telegram-api-hash");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("#toggle-api-hash").textContent = show ? "Скрыть" : "Показать";
    $("#toggle-api-hash").setAttribute("aria-pressed", String(show));
  });

  const phoneForm = $("#login-phone-form");
  phoneForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("login-phone-form");
    const phone = String(phoneForm.elements.phone.value || "").replace(/[\s()-]/g, "");
    if (!/^\+\d{8,15}$/.test(phone)) {
      showFormError(
        "login-phone-form",
        "Введите номер в международном формате, например +79991234567.",
        phoneForm.elements.phone,
      );
      return;
    }
    setBusy(phoneForm, true);
    try {
      const payload = await api("/api/login/start", { method: "POST", body: { phone } });
      state.login = normalizeLogin(payload);
      renderLogin();
      startLoginPolling();
      showToast("Запрос на вход отправлен.", "success");
    } catch (error) {
      showFormError("login-phone-form", errorMessage(error));
    } finally {
      setBusy(phoneForm, false);
    }
  });

  const answerForm = $("#login-answer-form");
  answerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("login-answer-form");
    const phase = state.login?.phase;
    const rawValue = String(answerForm.elements.value.value || "");
    const value = phase === "password" ? rawValue : rawValue.trim();
    if (!value) {
      const missingValueMessage = {
        password: "Введите пароль 2FA.",
        email_address: "Введите резервный email.",
        email_code: "Введите код из email.",
      }[phase] || "Введите код из Telegram.";
      showFormError(
        "login-answer-form",
        missingValueMessage,
        answerForm.elements.value,
      );
      return;
    }
    setBusy(answerForm, true);
    try {
      const payload = await api("/api/login/answer", { method: "POST", body: { value } });
      answerForm.reset();
      state.login = normalizeLogin(payload);
      renderLogin();
      startLoginPolling();
    } catch (error) {
      showFormError("login-answer-form", errorMessage(error));
    } finally {
      setBusy(answerForm, false);
    }
  });

  const cancel = async (button) => {
    button.disabled = true;
    try {
      const payload = await api("/api/login", { method: "DELETE" });
      state.login = normalizeLogin(payload);
      renderLogin();
      showToast("Вход отменён.", "warning");
    } catch (error) {
      showToast(errorMessage(error), "error");
    } finally {
      button.disabled = false;
    }
  };
  $("#cancel-login").addEventListener("click", (event) => void cancel(event.currentTarget));
  $("#cancel-connecting").addEventListener("click", (event) => void cancel(event.currentTarget));
}

function bindDelegatedActions() {
  document.addEventListener("click", async (event) => {
    const cancelButton = event.target.closest("[data-cancel-job]");
    if (cancelButton) {
      await cancelJob(cancelButton.dataset.cancelJob, cancelButton);
      return;
    }

    const resultFavorite = event.target.closest("[data-add-result-favorite]");
    if (resultFavorite) {
      resultFavorite.disabled = true;
      try {
        await addFavorite({
          username: resultFavorite.dataset.addResultFavorite,
          source: resultFavorite.dataset.resultSource || "telegram",
          note: "Найдено через Handle Radar",
          price: decodeFavoritePrice(resultFavorite.dataset.resultPrice) || undefined,
        });
        resultFavorite.textContent = "Сохранено";
      } catch (error) {
        resultFavorite.disabled = false;
        showToast(errorMessage(error), "error");
      }
      return;
    }

    const removeButton = event.target.closest("[data-remove-favorite]");
    if (removeButton) {
      await removeFavorite(
        removeButton.dataset.removeFavorite,
        removeButton.dataset.favoriteSource,
        removeButton,
      );
    }
  });
}

function bindGlobalActions() {
  window.addEventListener("hashchange", () => renderRoute({ focus: true }));
  $("#toast-close").addEventListener("click", hideToast);
  $("#toast-action").addEventListener("click", () => {
    const action = state.toastAction;
    hideToast();
    if (action) void action();
  });
  $("#refresh-jobs").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshJobs();
      showToast("История задач обновлена.", "success");
    } finally {
      button.disabled = false;
    }
  });
  window.addEventListener("beforeunload", () => {
    closeEventSource();
    stopLoginPolling();
  });
}

async function initialize() {
  renderRoute();
  bindGlobalActions();
  bindSearchForm();
  bindModelForms();
  bindFavorites();
  bindSetup();
  bindDelegatedActions();

  const results = await Promise.allSettled([
    refreshStatus({ silent: true }),
    refreshFavorites({ silent: true }),
    refreshJobs({ silent: true }),
    refreshLogin({ silent: true }),
  ]);
  const statusResult = results[0];
  if (statusResult.status === "rejected" || !state.status) {
    renderOffline(statusResult.status === "rejected" ? statusResult.reason : new Error("API недоступен"));
  }
}

void initialize();
