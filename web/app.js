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
  favoriteSort: "added-desc",
  resultSort: "default",
  rates: null,
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

const customSelects = new WeakMap();
const customSelectForms = new WeakSet();
let openCustomSelect = null;
let customSelectId = 0;
let customSelectOutsideClickBound = false;

function customSelectOptionDisabled(option) {
  return option.disabled || (option.parentElement?.tagName === "OPTGROUP" && option.parentElement.disabled);
}

function customSelectOptionLabel(option) {
  return String(option.label || option.textContent || "").trim();
}

function nextCustomSelectId(select) {
  const base = select.id ? `${select.id}-trigger` : `custom-select-trigger-${++customSelectId}`;
  let candidate = base;
  while (document.getElementById(candidate)) {
    customSelectId += 1;
    candidate = `${base}-${customSelectId}`;
  }
  return candidate;
}

function setCustomSelectActive(custom, index, { scroll = true } = {}) {
  const nextIndex =
    Number.isInteger(index) &&
    index >= 0 &&
    index < custom.select.options.length &&
    !customSelectOptionDisabled(custom.select.options[index])
      ? index
      : -1;

  custom.activeIndex = nextIndex;
  const selectedIndex = custom.isOpen ? nextIndex : custom.select.selectedIndex;
  custom.optionNodes.forEach((optionNode, optionIndex) => {
    optionNode.classList.toggle("is-active", optionIndex === nextIndex);
    optionNode.classList.toggle("is-selected", optionIndex === selectedIndex);
    optionNode.setAttribute("aria-selected", String(optionIndex === selectedIndex));
  });

  const activeOption = nextIndex >= 0 ? custom.optionNodes[nextIndex] : null;
  if (activeOption) {
    custom.trigger.setAttribute("aria-activedescendant", activeOption.id);
    if (scroll && custom.isOpen) {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  } else {
    custom.trigger.removeAttribute("aria-activedescendant");
  }
}

function closeCustomSelect(custom, { focus = false } = {}) {
  if (!custom) return;
  custom.isOpen = false;
  custom.wrapper.classList.remove("is-open");
  custom.trigger.setAttribute("aria-expanded", "false");
  custom.list.hidden = true;
  setCustomSelectActive(custom, -1, { scroll: false });
  if (openCustomSelect === custom) openCustomSelect = null;
  if (focus && !custom.trigger.disabled) custom.trigger.focus();
}

function firstEnabledCustomSelectOption(select, fromEnd = false) {
  const start = fromEnd ? select.options.length - 1 : 0;
  const end = fromEnd ? -1 : select.options.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== end; index += step) {
    if (!customSelectOptionDisabled(select.options[index])) return index;
  }
  return -1;
}

function adjacentEnabledCustomSelectOption(select, index, direction) {
  let candidate =
    index < 0
      ? direction > 0
        ? 0
        : select.options.length - 1
      : index + direction;
  while (candidate >= 0 && candidate < select.options.length) {
    if (!customSelectOptionDisabled(select.options[candidate])) return candidate;
    candidate += direction;
  }
  return index;
}

function openCustomSelectList(custom) {
  if (custom.select.disabled) return;
  if (openCustomSelect && openCustomSelect !== custom) closeCustomSelect(openCustomSelect);

  syncCustomSelect(custom.select);
  custom.isOpen = true;
  openCustomSelect = custom;
  custom.wrapper.classList.add("is-open");
  custom.trigger.setAttribute("aria-expanded", "true");
  custom.list.hidden = false;
  custom.wrapper.classList.remove("is-above");
  const triggerRect = custom.trigger.getBoundingClientRect();
  const roomBelow = window.innerHeight - triggerRect.bottom;
  const roomAbove = triggerRect.top;
  const listHeight = Math.min(custom.list.scrollHeight, 288);
  custom.wrapper.classList.toggle(
    "is-above",
    roomBelow < listHeight + 12 && roomAbove > roomBelow,
  );

  const selectedIndex = custom.select.selectedIndex;
  const activeIndex =
    selectedIndex >= 0 && !customSelectOptionDisabled(custom.select.options[selectedIndex])
      ? selectedIndex
      : firstEnabledCustomSelectOption(custom.select);
  setCustomSelectActive(custom, activeIndex);
}

function chooseCustomSelectOption(custom, index, { focus = true } = {}) {
  const option = custom.select.options[index];
  if (!option || custom.select.disabled || customSelectOptionDisabled(option)) return;

  custom.select.value = option.value;
  if (custom.select.selectedIndex !== index) custom.select.selectedIndex = index;
  syncCustomSelect(custom.select);
  closeCustomSelect(custom, { focus });
  custom.select.dispatchEvent(new Event("input", { bubbles: true }));
  custom.select.dispatchEvent(new Event("change", { bubbles: true }));
}

function normalizedCustomSelectText(value) {
  return String(value)
    .normalize("NFKD")
    .toLocaleLowerCase("ru-RU");
}

function typeaheadCustomSelect(custom, key) {
  const now = Date.now();
  const normalizedKey = normalizedCustomSelectText(key);
  custom.typeahead =
    now - custom.typeaheadAt > 700 ? normalizedKey : `${custom.typeahead}${normalizedKey}`;
  custom.typeaheadAt = now;

  const findMatch = (query) => {
    if (!query) return -1;
    const repeated = query.length > 1 && Array.from(query).every((character) => character === query[0]);
    const needle = repeated ? query[0] : query;
    const currentIndex =
      custom.activeIndex >= 0 ? custom.activeIndex : custom.select.selectedIndex;
    const startIndex = repeated || query.length === 1 ? currentIndex + 1 : Math.max(currentIndex, 0);

    for (let offset = 0; offset < custom.select.options.length; offset += 1) {
      const index = (startIndex + offset) % custom.select.options.length;
      const option = custom.select.options[index];
      if (
        !customSelectOptionDisabled(option) &&
        normalizedCustomSelectText(customSelectOptionLabel(option)).startsWith(needle)
      ) {
        return index;
      }
    }
    return -1;
  };

  let matchIndex = findMatch(custom.typeahead);
  if (matchIndex < 0 && custom.typeahead.length > normalizedKey.length) {
    custom.typeahead = normalizedKey;
    matchIndex = findMatch(custom.typeahead);
  }
  if (matchIndex < 0) return;

  if (custom.isOpen) setCustomSelectActive(custom, matchIndex);
  else chooseCustomSelectOption(custom, matchIndex);
}

function handleCustomSelectKeydown(custom, event) {
  const { key } = event;

  if (key === "Tab") {
    if (custom.isOpen && custom.activeIndex >= 0) {
      chooseCustomSelectOption(custom, custom.activeIndex, { focus: false });
    } else if (custom.isOpen) {
      closeCustomSelect(custom);
    }
    return;
  }

  if (key === "Escape") {
    if (custom.isOpen) {
      event.preventDefault();
      closeCustomSelect(custom, { focus: true });
    }
    return;
  }

  if (key === "Enter" || key === " " || key === "Spacebar") {
    event.preventDefault();
    if (!custom.isOpen) {
      openCustomSelectList(custom);
    } else if (custom.activeIndex >= 0) {
      chooseCustomSelectOption(custom, custom.activeIndex);
    }
    return;
  }

  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    if (!custom.isOpen) {
      openCustomSelectList(custom);
      return;
    }
    const direction = key === "ArrowDown" ? 1 : -1;
    const nextIndex = adjacentEnabledCustomSelectOption(
      custom.select,
      custom.activeIndex,
      direction,
    );
    setCustomSelectActive(custom, nextIndex);
    return;
  }

  if (key === "Home" || key === "End") {
    event.preventDefault();
    if (!custom.isOpen) openCustomSelectList(custom);
    setCustomSelectActive(
      custom,
      firstEnabledCustomSelectOption(custom.select, key === "End"),
    );
    return;
  }

  if (
    key.length === 1 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    typeaheadCustomSelect(custom, key);
  }
}

function syncCustomSelect(select) {
  const custom = customSelects.get(select);
  if (!custom) return;

  select.classList.add("custom-select__native");
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;
  select.hidden = true;

  const selectedOption = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
  custom.value.textContent = selectedOption ? customSelectOptionLabel(selectedOption) : "";
  custom.trigger.disabled = select.disabled;
  custom.trigger.setAttribute("aria-disabled", String(select.disabled));
  custom.wrapper.classList.toggle("is-disabled", select.disabled);

  for (const attribute of [
    "aria-describedby",
    "aria-invalid",
    "aria-label",
    "aria-labelledby",
  ]) {
    const value = select.getAttribute(attribute);
    if (value) custom.trigger.setAttribute(attribute, value);
    else custom.trigger.removeAttribute(attribute);
  }
  if (select.required) custom.trigger.setAttribute("aria-required", "true");
  else custom.trigger.removeAttribute("aria-required");

  const fragment = document.createDocumentFragment();
  custom.optionNodes = Array.from(select.options, (option, index) => {
    const optionNode = document.createElement("div");
    optionNode.className = "custom-select__option";
    optionNode.id = `${custom.list.id}-option-${index}`;
    optionNode.dataset.index = String(index);
    optionNode.setAttribute("role", "option");
    optionNode.setAttribute("aria-selected", String(index === select.selectedIndex));
    optionNode.textContent = customSelectOptionLabel(option);

    const disabled = customSelectOptionDisabled(option);
    optionNode.classList.toggle("is-selected", index === select.selectedIndex);
    optionNode.classList.toggle("is-disabled", disabled);
    optionNode.hidden = option.hidden;
    if (disabled) optionNode.setAttribute("aria-disabled", "true");
    fragment.append(optionNode);
    return optionNode;
  });
  custom.list.replaceChildren(fragment);

  if (select.disabled && custom.isOpen) {
    closeCustomSelect(custom);
  } else if (custom.isOpen) {
    const selectedIndex =
      select.selectedIndex >= 0 &&
      !customSelectOptionDisabled(select.options[select.selectedIndex])
        ? select.selectedIndex
        : firstEnabledCustomSelectOption(select);
    setCustomSelectActive(custom, selectedIndex, { scroll: false });
  } else {
    setCustomSelectActive(custom, -1, { scroll: false });
  }
}

function enhanceCustomSelect(select) {
  if (customSelects.has(select)) return customSelects.get(select);

  const wrapper = document.createElement("div");
  wrapper.className = "custom-select";

  const trigger = document.createElement("button");
  const triggerId = nextCustomSelectId(select);
  trigger.type = "button";
  trigger.className = "custom-select__trigger";
  trigger.id = triggerId;
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-autocomplete", "none");

  const value = document.createElement("span");
  value.className = "custom-select__value";
  trigger.append(value);

  const list = document.createElement("div");
  list.className = "custom-select__list";
  list.id = `${triggerId}-listbox`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-labelledby", triggerId);
  list.hidden = true;
  trigger.setAttribute("aria-controls", list.id);

  wrapper.append(trigger, list);
  select.insertAdjacentElement("afterend", wrapper);

  if (select.id) {
    $$("label[for]").forEach((label) => {
      if (label.htmlFor === select.id) label.htmlFor = triggerId;
    });
  }

  const custom = {
    select,
    wrapper,
    trigger,
    value,
    list,
    optionNodes: [],
    activeIndex: -1,
    isOpen: false,
    typeahead: "",
    typeaheadAt: 0,
  };
  customSelects.set(select, custom);

  trigger.addEventListener("click", () => {
    if (custom.isOpen) closeCustomSelect(custom);
    else openCustomSelectList(custom);
  });
  trigger.addEventListener("keydown", (event) => {
    handleCustomSelectKeydown(custom, event);
  });
  list.addEventListener("pointerover", (event) => {
    const optionNode = event.target.closest?.(".custom-select__option");
    if (!optionNode || !list.contains(optionNode)) return;
    const optionIndex = Number(optionNode.dataset.index);
    if (customSelectOptionDisabled(custom.select.options[optionIndex])) return;
    setCustomSelectActive(custom, optionIndex, { scroll: false });
  });
  list.addEventListener("click", (event) => {
    const optionNode = event.target.closest?.(".custom-select__option");
    if (!optionNode || !list.contains(optionNode)) return;
    chooseCustomSelectOption(custom, Number(optionNode.dataset.index));
  });
  select.addEventListener("input", () => syncCustomSelect(select));
  select.addEventListener("change", () => syncCustomSelect(select));

  if (select.form && !customSelectForms.has(select.form)) {
    customSelectForms.add(select.form);
    select.form.addEventListener("reset", () => {
      window.setTimeout(() => {
        Array.from(select.form.elements).forEach((field) => {
          if (field instanceof HTMLSelectElement) syncCustomSelect(field);
        });
      }, 0);
    });
  }

  syncCustomSelect(select);
  return custom;
}

function initializeCustomSelects() {
  $$("select").forEach(enhanceCustomSelect);
  if (customSelectOutsideClickBound) return;
  customSelectOutsideClickBound = true;
  document.addEventListener("pointerdown", (event) => {
    if (openCustomSelect && !openCustomSelect.wrapper.contains(event.target)) {
      closeCustomSelect(openCustomSelect);
    }
  });
}

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
  if (openCustomSelect) {
    closeCustomSelect(openCustomSelect);
  }

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
  document.title = `${ROUTE_TITLES[route]} — Token`;
  if (focus) {
    $("#main-content").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

function dotClass(tone) {
  const known = ["success", "warning", "danger", "active", "neutral"];
  return `status-dot status-dot--${known.includes(tone) ? tone : "neutral"}`;
}

function modelExists(model) {
  if (typeof model === "boolean") return model;
  if (!isObject(model)) return false;
  // New API responses distinguish a physical artifact from a compatible,
  // loadable model. Fall back to the legacy `exists` contract for generator
  // models and older servers that do not expose `valid` yet.
  return typeof model.valid === "boolean"
    ? model.exists === true && model.valid === true
    : model.exists === true;
}

function modelApproved(model) {
  return (
    modelExists(model) &&
    isObject(model) &&
    model.approved === true &&
    model.dataCurrent !== false &&
    model.stale !== true
  );
}

function modelInferenceReady(model) {
  return (
    modelExists(model) &&
    isObject(model) &&
    model.dataCurrent !== false &&
    model.stale !== true
  );
}

const PRICE_RELEASE_REASON_LABELS = {
  "non-temporal-evaluation":
    "Нет строгого temporal benchmark: история продаж не содержит достаточного покрытия точными saleAt.",
  "insufficient-test-data": "В независимой test-когорте недостаточно наблюдений для release gate.",
  "uncalibrated-confidence": "Недостаточно независимых данных для эмпирической калибровки confidence.",
  "did-not-beat-baseline": "Модель не превзошла лучший time-safe baseline на независимом тесте.",
  passed: "Все release-gate проверки пройдены.",
};

function priceModelPresentation(model) {
  if (!isObject(model) || model.exists !== true) {
    return {
      value: "не готова",
      description: "Artifact не найден. Сначала соберите продажи и запустите обучение.",
      approved: false,
    };
  }
  if (model.valid === false) {
    const reason = String(model.reason || "неизвестная ошибка совместимости");
    return {
      value: "несовместима",
      description: `Artifact найден, но не загружается: ${reason}. Переобучите модель текущей версией Token.`,
      approved: false,
    };
  }
  if (model.dataCurrent === false || model.stale === true) {
    return {
      value: "устарела",
      description:
        "История продаж изменилась после обучения. Оценка и ценовой фильтр заблокированы до переобучения модели.",
      approved: false,
    };
  }
  const approved = modelApproved(model);
  const split = model.splitStrategy ? ` Split: ${model.splitStrategy}.` : "";
  if (approved) {
    return {
      value: "одобрена",
      description: `Строгий temporal benchmark и confidence calibration пройдены.${split}`,
      approved: true,
    };
  }
  const releaseReason = String(model.releaseGateReason || "");
  const reason =
    PRICE_RELEASE_REASON_LABELS[releaseReason] ||
    (model.confidenceCalibrated === false
      ? PRICE_RELEASE_REASON_LABELS["uncalibrated-confidence"]
      : "Artifact совместим, но accuracy-sensitive release gate не пройден.");
  return {
    value: "кандидат",
    description: `${reason}${split} Оценки помечаются provisional, ценовой фильтр заблокирован.`,
    approved: false,
  };
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
  if (!state.status) return;

  $("#sidebar-api-label").textContent = "API онлайн";
  $("#sidebar-api-dot").className = dotClass("success");
  $("#mobile-api-state").innerHTML =
    `<span class="${dotClass("success")}" aria-hidden="true"></span>API онлайн`;

  renderModelMetrics();
  renderReadiness();
  updateModelButtons();
}

function renderOffline(error) {
  $("#sidebar-api-label").textContent = "API офлайн";
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
  const pricePresentation = priceModelPresentation(models.price);
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
      pricePresentation.value,
      pricePresentation.description,
      pricePresentation.approved,
      modelTimestamp(models.price),
    ),
    metricCard(
      "AI-генератор",
      generatorReady ? "готов" : "не готов",
      generatorReady ? "Нейрогенерация доступна." : "Обучите модель на продажах и словаре.",
      generatorReady,
      modelTimestamp(models.generator),
    ),
  ].join("");
}

function updateModelButtons() {
  if (!state.status) return;
  const sold = state.status.data.soldCount;
  const dictionaryInput = $("#train-generator-form")?.elements?.dictionaryWords;
  const requestedDictionaryWords = Number(dictionaryInput?.value ?? 1200);
  const dictionaryWords = Number.isFinite(requestedDictionaryWords)
    ? Math.max(0, Math.floor(requestedDictionaryWords))
    : 1200;
  // Generator training intentionally excludes favorites. The displayed size
  // is a conservative readiness estimate from the two real sources; sold
  // records are reweighted inside the trainer and can contribute more rows.
  const corpus = sold + dictionaryWords;
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
      ? `Оценочный корпус: ${formatNumber(sold)} продаж + ${formatNumber(dictionaryWords)} слов; избранное не используется.`
      : `Нужно ещё ${formatNumber(20 - corpus)} имён из продаж или словаря; избранное не используется.`;

  const pricePresentation = priceModelPresentation(state.status.models.price);
  const priceApproved = pricePresentation.approved;
  const priceInferenceReady = modelInferenceReady(state.status.models.price);
  const priceReadyHint = priceApproved
    ? "Необязательно. Каждый кандидат сразу получит полную оценку с аналогами и ликвидностью до проверки доступности."
    : `Недоступно: ${pricePresentation.description}`;
  const searchMinPriceHint = $("#search-min-price-hint");
  if (searchMinPriceHint) searchMinPriceHint.textContent = priceReadyHint;
  const aiMinPriceHint = $("#ai-min-price-hint");
  if (aiMinPriceHint) aiMinPriceHint.textContent = priceReadyHint;
  for (const input of [$("#search-min-price-ton"), $("#ai-min-price-ton")]) {
    if (!input) continue;
    input.disabled = !priceApproved;
    input.setAttribute("aria-disabled", String(!priceApproved));
  }
  for (const input of [
    $("#search-form")?.elements?.estimatePrice,
    $("#generate-ai-form")?.elements?.estimatePrice,
  ]) {
    if (!input) continue;
    input.disabled = !priceInferenceReady;
    input.setAttribute("aria-disabled", String(!priceInferenceReady));
  }
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

/** Как numberValue, но пустое поле означает «фильтр выключен» — возвращает undefined, а не 0/фолбэк. */
function optionalNumberValue(form, name) {
  const field = form.elements.namedItem(name);
  const raw = String(field?.value ?? "").trim();
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
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

const STATUS_RANK = { free: 0, unknown: 1, unchecked: 2, invalid: 3, busy: 4 };

function combinedStatusRank(group) {
  const telegram = STATUS_RANK[sourceStatus(group, "telegram")] ?? 2;
  const fragment = STATUS_RANK[sourceStatus(group, "fragment")] ?? 2;
  return Math.min(telegram, fragment);
}

function resultPriceTon(group) {
  const resolved = resolvePrice(group.price);
  return resolved ? resolved.ton : null;
}

function sortResultGroups(rows, sortKey) {
  if (sortKey === "default") return rows;
  const withIndex = rows.map((group, index) => ({ group, index }));
  withIndex.sort((a, b) => {
    switch (sortKey) {
      case "username-asc":
        return a.group.username.localeCompare(b.group.username);
      case "username-desc":
        return b.group.username.localeCompare(a.group.username);
      case "status":
        return combinedStatusRank(a.group) - combinedStatusRank(b.group) || a.index - b.index;
      case "price-asc":
      case "price-desc": {
        const priceA = resultPriceTon(a.group);
        const priceB = resultPriceTon(b.group);
        if (priceA === null && priceB === null) return a.index - b.index;
        if (priceA === null) return 1;
        if (priceB === null) return -1;
        return sortKey === "price-asc" ? priceA - priceB : priceB - priceA;
      }
      default:
        return a.index - b.index;
    }
  });
  return withIndex.map((item) => item.group);
}

// Вместо двух широких колонок Telegram/Fragment — один компактный статус
// с двумя читаемыми бейджами. Подробности остаются доступны в title/aria-label,
// а в таблице освобождается место под цену сразу в трёх валютах.
function compactStatusHtml(group) {
  const chip = (label, value, detail) => {
    const tone = availabilityTone(value);
    const shortLabel = {
      free: "Свободен",
      busy: "Занят",
      invalid: "Ошибка",
      unchecked: "Не проверен",
      unknown: "Нет данных",
    }[value] || "Нет данных";
    const title = `${label === "TG" ? "Telegram" : "Fragment"}: ${availabilityLabel(value)}${detail ? ` — ${detail}` : ""}`;
    return `
      <span
        class="status-compact__item status-compact__item--${escapeHtml(tone)}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}"
      >
        <span class="${dotClass(tone)}" aria-hidden="true"></span>
        <span class="status-compact__source">${label}</span>
        <span class="status-compact__label">${escapeHtml(shortLabel)}</span>
      </span>
    `;
  };
  const telegram = sourceStatus(group, "telegram");
  const fragment = sourceStatus(group, "fragment");
  return `
    <span class="status-compact">
      ${chip("TG", telegram, group.telegram?.detail)}
      ${chip("FR", fragment, group.fragment?.detail)}
    </span>
  `;
}

function resolvePrice(price) {
  const normalized = normalizeFavoritePrice(price);
  if (!normalized) return null;
  const resolved = { ...normalized };
  if (resolved.usd === undefined && state.rates) {
    resolved.usd = resolved.ton * state.rates.tonUsd;
  }
  if (resolved.rub === undefined && state.rates) {
    const usd = resolved.usd !== undefined ? resolved.usd : resolved.ton * state.rates.tonUsd;
    resolved.rub = usd * state.rates.usdRub;
  }
  return resolved;
}

function formatTon(value) {
  return `${formatNumber(Math.round(value * 100) / 100)} TON`;
}

function formatUsd(value) {
  return `$${formatNumber(Math.round(value))}`;
}

function formatRub(value) {
  return `₽${formatNumber(Math.round(value))}`;
}

function priceLabel(price) {
  const resolved = resolvePrice(price);
  if (!resolved) return "—";
  const parts = [`≈ ${formatTon(resolved.ton)}`];
  if (resolved.p10Ton !== undefined && resolved.p90Ton !== undefined) {
    parts.push(`P10–P90 ${formatTon(resolved.p10Ton)}–${formatTon(resolved.p90Ton)}`);
  }
  if (resolved.confidence) parts.push(`confidence: ${resolved.confidence}`);
  if (resolved.liquidity && !resolved.liquidity.outOfDistribution) {
    parts.push(
      `P(продажа ≤90д): ${Math.round(resolved.liquidity.saleProbability90d * 100)}%`,
    );
  }
  if (resolved.usd !== undefined) parts.push(`≈ ${formatUsd(resolved.usd)}`);
  if (resolved.rub !== undefined) parts.push(`≈ ${formatRub(resolved.rub)}`);
  return parts.join(" · ");
}

// Отдельные "чипы" на TON/USD/RUB вместо одной строки — если известен курс
// (см. refreshRates), USD/RUB досчитываются на лету даже для старых записей,
// у которых сохранён только TON.
function priceChipsHtml(price) {
  const resolved = resolvePrice(price);
  if (!resolved) return "";
  const chips = [`<span class="price-chip">≈ ${escapeHtml(formatTon(resolved.ton))}</span>`];
  if (resolved.p10Ton !== undefined && resolved.p90Ton !== undefined) {
    chips.push(
      `<span class="price-chip price-chip--secondary">P10–P90 ${escapeHtml(formatTon(resolved.p10Ton))}–${escapeHtml(formatTon(resolved.p90Ton))}</span>`,
    );
  }
  if (resolved.confidence) {
    const score =
      resolved.confidenceScore === undefined
        ? ""
        : resolved.confidenceDefinition === "probability-within-2x"
          ? ` · ${Math.round(resolved.confidenceScore * 100)}% within ×2`
          : ` · heuristic ${Math.round(resolved.confidenceScore * 100)}%`;
    chips.push(
      `<span class="price-chip price-chip--secondary">confidence: ${escapeHtml(resolved.confidence + score)}</span>`,
    );
  }
  if (resolved.liquidity) {
    const liquidityLabel = resolved.liquidity.outOfDistribution
      ? "ликвидность: мало данных"
      : `P(продажа ≤90д): ${Math.round(resolved.liquidity.saleProbability90d * 100)}%`;
    chips.push(
      `<span class="price-chip price-chip--secondary">${escapeHtml(liquidityLabel)}</span>`,
    );
  }
  if (resolved.priceOutOfDistribution === true) {
    const score =
      resolved.oodScore === undefined
        ? ""
        : ` · ${Math.round(resolved.oodScore * 100)}%`;
    chips.push(
      `<span class="price-chip price-chip--secondary">price OOD${escapeHtml(score)}</span>`,
    );
  }
  if (resolved.comparableEffectiveSampleSize !== undefined) {
    chips.push(
      `<span class="price-chip price-chip--secondary">аналоги n_eff ${escapeHtml(formatNumber(Math.round(resolved.comparableEffectiveSampleSize * 10) / 10))}</span>`,
    );
  }
  if (resolved.releaseGatePassed === false) {
    const reason = resolved.releaseGateReason
      ? PRICE_RELEASE_REASON_LABELS[resolved.releaseGateReason] || resolved.releaseGateReason
      : "release gate не пройден";
    const split = resolved.splitStrategy ? ` Split: ${resolved.splitStrategy}.` : "";
    chips.push(
      `<span class="price-chip price-chip--secondary">provisional: ${escapeHtml(reason + split)}</span>`,
    );
  }
  if (resolved.dataCurrent === false) {
    chips.push(
      '<span class="price-chip price-chip--secondary">stale data: переобучите модель</span>',
    );
  }
  if (resolved.usd !== undefined) {
    chips.push(
      `<span class="price-chip price-chip--secondary">≈ ${escapeHtml(formatUsd(resolved.usd))}</span>`,
    );
  }
  if (resolved.rub !== undefined) {
    chips.push(
      `<span class="price-chip price-chip--secondary">≈ ${escapeHtml(formatRub(resolved.rub))}</span>`,
    );
  }
  return `<span class="price-breakdown">${chips.join("")}</span>`;
}

function normalizeFavoritePrice(price) {
  if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
    return { ton: price };
  }
  if (!isObject(price)) return null;
  const ton = Number(price.ton);
  if (!Number.isFinite(ton) || ton < 0) return null;
  const normalized = { ton };
  const usd = price.usd === null || price.usd === undefined ? Number.NaN : Number(price.usd);
  const rub = price.rub === null || price.rub === undefined ? Number.NaN : Number(price.rub);
  if (Number.isFinite(usd) && usd >= 0) normalized.usd = usd;
  if (Number.isFinite(rub) && rub >= 0) normalized.rub = rub;
  const p10Ton = Number(price.p10Ton);
  const p90Ton = Number(price.p90Ton);
  if (
    Number.isFinite(p10Ton) &&
    Number.isFinite(p90Ton) &&
    p10Ton >= 0 &&
    p10Ton <= ton &&
    p90Ton >= ton
  ) {
    normalized.p10Ton = p10Ton;
    normalized.p90Ton = p90Ton;
  }
  if (["low", "medium", "high"].includes(price.confidence)) {
    normalized.confidence = price.confidence;
  }
  const confidenceScore =
    price.confidenceScore === null || price.confidenceScore === undefined
      ? Number.NaN
      : Number(price.confidenceScore);
  if (Number.isFinite(confidenceScore) && confidenceScore >= 0 && confidenceScore <= 1) {
    normalized.confidenceScore = confidenceScore;
  }
  if (["probability-within-2x", "heuristic-score"].includes(price.confidenceDefinition)) {
    normalized.confidenceDefinition = price.confidenceDefinition;
  }
  if (typeof price.releaseGatePassed === "boolean") {
    normalized.releaseGatePassed = price.releaseGatePassed;
  }
  const oodScore =
    price.oodScore === null || price.oodScore === undefined
      ? Number.NaN
      : Number(price.oodScore);
  if (Number.isFinite(oodScore) && oodScore >= 0 && oodScore <= 1) {
    normalized.oodScore = oodScore;
  }
  if (typeof price.priceOutOfDistribution === "boolean") {
    normalized.priceOutOfDistribution = price.priceOutOfDistribution;
  } else if (typeof price.outOfDistribution === "boolean") {
    // Runtime predictions use the concise field name; favorites keep the
    // explicit price prefix so it cannot be confused with liquidity OOD.
    normalized.priceOutOfDistribution = price.outOfDistribution;
  }
  const modelDisagreementLog =
    price.modelDisagreementLog === null || price.modelDisagreementLog === undefined
      ? Number.NaN
      : Number(price.modelDisagreementLog);
  if (Number.isFinite(modelDisagreementLog) && modelDisagreementLog >= 0) {
    normalized.modelDisagreementLog = modelDisagreementLog;
  }
  const comparableEffectiveSampleSize =
    price.comparableEffectiveSampleSize === null ||
    price.comparableEffectiveSampleSize === undefined
      ? Number.NaN
      : Number(price.comparableEffectiveSampleSize);
  if (Number.isFinite(comparableEffectiveSampleSize) && comparableEffectiveSampleSize >= 0) {
    normalized.comparableEffectiveSampleSize = comparableEffectiveSampleSize;
  }
  for (const field of ["trainedAt", "trainedThrough"]) {
    if (typeof price[field] !== "string") continue;
    const parsed = Date.parse(price[field]);
    if (Number.isFinite(parsed)) normalized[field] = new Date(parsed).toISOString();
  }
  if (
    typeof price.releaseGateReason === "string" &&
    price.releaseGateReason.length > 0 &&
    price.releaseGateReason.length <= 120
  ) {
    normalized.releaseGateReason = price.releaseGateReason;
  }
  if (["temporal-group", "group-random", "random"].includes(price.splitStrategy)) {
    normalized.splitStrategy = price.splitStrategy;
  }
  if (typeof price.dataCurrent === "boolean") {
    normalized.dataCurrent = price.dataCurrent;
  }
  if (isObject(price.liquidity)) {
    const saleProbability90d = Number(price.liquidity.saleProbability90d);
    if (
      Number.isFinite(saleProbability90d) &&
      saleProbability90d >= 0 &&
      saleProbability90d <= 1
    ) {
      normalized.liquidity = {
        saleProbability90d,
        outOfDistribution: Boolean(price.liquidity.outOfDistribution),
      };
    }
  }
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
  const rows = sortResultGroups(groupResults(result), state.resultSort);
  $("#results-count").textContent = rows.length
    ? `${formatNumber(rows.length)} ${rows.length === 1 ? "имя" : "имён"}`
    : "Нет структурированных данных";
  const resultsSortSelect = $("#results-sort");
  if (resultsSortSelect && resultsSortSelect.value !== state.resultSort) {
    resultsSortSelect.value = state.resultSort;
  }
  if (resultsSortSelect) syncCustomSelect(resultsSortSelect);
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
        <span role="columnheader">Статус</span>
        <span role="columnheader">Цена</span>
        <span role="columnheader">Проверено</span>
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
          const confidenceLabel =
            confidence === "high" ? "Высокая точность" : confidence === "low" ? "Эвристика" : "Без оценки";
          const priceChips = priceChipsHtml(group.price);
          return `
            <div class="result-row" role="row">
              <div class="result-cell" role="cell" data-label="Юзернейм">
                <span
                  class="result-username"
                  title="@${escapeHtml(group.username)}"
                >@${escapeHtml(group.username)}</span>
              </div>
              <div class="result-cell" role="cell" data-label="Статус">
                ${compactStatusHtml(group)}
              </div>
              <div class="result-cell" role="cell" data-label="Цена">
                ${priceChips || `<span class="result-meta">—</span>`}
              </div>
              <div class="result-cell" role="cell" data-label="Проверено">
                <span class="result-meta">
                  ${escapeHtml(confidenceLabel)}
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

async function refreshRates({ silent = true } = {}) {
  try {
    const payload = await api("/api/rates");
    if (isObject(payload) && Number.isFinite(Number(payload.tonUsd)) && Number.isFinite(Number(payload.usdRub))) {
      state.rates = { tonUsd: Number(payload.tonUsd), usdRub: Number(payload.usdRub) };
      renderFavorites();
      if (state.currentJob) renderResults(state.currentJob.result, state.currentJob);
    }
    return state.rates;
  } catch (error) {
    // Курс TON — это улучшение отображения, а не критичная функция: без него
    // просто показываем то, что уже сохранено (обычно TON, иногда и USD/RUB,
    // если они были посчитаны на сервере в момент добавления в избранное).
    if (!silent) showToast(errorMessage(error), "error");
    return null;
  }
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

function favoritePriceTon(favorite) {
  const resolved = resolvePrice(favorite.price);
  return resolved ? resolved.ton : null;
}

function sortFavorites(list, sortKey) {
  const withIndex = list.map((favorite, index) => ({ favorite, index }));
  withIndex.sort((a, b) => {
    switch (sortKey) {
      case "added-asc":
        return favoriteTimestamp(a.favorite) - favoriteTimestamp(b.favorite);
      case "username-asc":
        return a.favorite.username.localeCompare(b.favorite.username);
      case "username-desc":
        return b.favorite.username.localeCompare(a.favorite.username);
      case "price-asc":
      case "price-desc": {
        const priceA = favoritePriceTon(a.favorite);
        const priceB = favoritePriceTon(b.favorite);
        // Записи без известной цены всегда уходят в конец списка независимо
        // от направления сортировки — иначе "дешевле" внезапно поднимало бы
        // наверх записи, для которых цена просто не указана.
        if (priceA === null && priceB === null) return a.index - b.index;
        if (priceA === null) return 1;
        if (priceB === null) return -1;
        return sortKey === "price-asc" ? priceA - priceB : priceB - priceA;
      }
      case "added-desc":
      default:
        return favoriteTimestamp(b.favorite) - favoriteTimestamp(a.favorite);
    }
  });
  return withIndex.map((item) => item.favorite);
}

function renderFavorites() {
  const mount = $("#favorites-content");
  const sorted = sortFavorites(state.favorites, state.favoriteSort);
  $("#favorites-total").textContent = `${formatNumber(sorted.length)} сохранено`;
  const sortSelect = $("#favorites-sort");
  if (sortSelect && sortSelect.value !== state.favoriteSort) sortSelect.value = state.favoriteSort;
  if (sortSelect) syncCustomSelect(sortSelect);

  if (!sorted.length) {
    mount.innerHTML = `
      <div class="empty-state">
        <span class="empty-code" aria-hidden="true">@+</span>
        <h3>Короткий список пуст</h3>
        <p>Добавьте находку из результатов поиска или вручную через форму выше.</p>
      </div>
    `;
    return;
  }

  mount.innerHTML = `<div class="favorite-list">${sorted
    .map(
      (favorite) => `
        <article class="favorite-item">
          <div class="favorite-main">
            <h3 title="@${escapeHtml(favorite.username)}">@${escapeHtml(favorite.username)}</h3>
            ${
              favorite.note
                ? `<p>${escapeHtml(
                    favorite.note === "Найдено через Handle Radar"
                      ? "Найдено через Token"
                      : favorite.note,
                  )}</p>`
                : ""
            }
            <time datetime="${escapeHtml(favorite.addedAt || "")}">
              Добавлено ${escapeHtml(relativeDate(favorite.addedAt))}
            </time>
          </div>
          <div class="favorite-actions">
            ${priceChipsHtml(favorite.price)}
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
    syncCustomSelect(digits);
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
    const minPriceTon = optionalNumberValue(form, "minPriceTon");
    if (minPriceTon !== undefined && !modelApproved(state.status?.models?.price)) {
      showFormError(
        "search-form",
        `Ценовой фильтр недоступен. ${priceModelPresentation(state.status?.models?.price).description}`,
        form.elements.minPriceTon,
      );
      return;
    }
    if (
      checkboxValue(form, "estimatePrice") &&
      !modelInferenceReady(state.status?.models?.price)
    ) {
      showFormError(
        "search-form",
        `Оценка цены недоступна. ${priceModelPresentation(state.status?.models?.price).description}`,
        form.elements.estimatePrice,
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
      minPriceTon,
      debug: checkboxValue(form, "debug"),
      usePlaywright: checkboxValue(form, "usePlaywright"),
      legacyWeb: checkboxValue(form, "legacyWeb"),
      estimatePrice: checkboxValue(form, "estimatePrice"),
      safeMode: checkboxValue(form, "safeMode"),
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
      const params = { epochs: numberValue(form, "epochs", 100) };
      if (type === "train-generator") {
        params.dictionaryWords = numberValue(form, "dictionaryWords", 1200);
      }
      try {
        await startJob(type, params, form);
      } catch (error) {
        showFormError(formId, errorMessage(error));
      }
    });
  }
  const dictionaryWordsInput = $("#train-generator-form")?.elements?.dictionaryWords;
  dictionaryWordsInput?.addEventListener("input", updateModelButtons);

  const aiForm = $("#generate-ai-form");
  aiForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError("generate-ai-form");
    const range = validateLengthRange(aiForm);
    if (!range.valid) {
      showFormError("generate-ai-form", range.message, range.field);
      return;
    }
    const minPriceTon = optionalNumberValue(aiForm, "minPriceTon");
    if (minPriceTon !== undefined && !modelApproved(state.status?.models?.price)) {
      showFormError(
        "generate-ai-form",
        `Ценовой фильтр недоступен. ${priceModelPresentation(state.status?.models?.price).description}`,
        aiForm.elements.minPriceTon,
      );
      return;
    }
    if (
      checkboxValue(aiForm, "estimatePrice") &&
      !modelInferenceReady(state.status?.models?.price)
    ) {
      showFormError(
        "generate-ai-form",
        `Оценка цены недоступна. ${priceModelPresentation(state.status?.models?.price).description}`,
        aiForm.elements.estimatePrice,
      );
      return;
    }
    const params = {
      count: numberValue(aiForm, "count", 20),
      minLength: range.min,
      maxLength: range.max,
      temperature: numberValue(aiForm, "temperature", 0.8),
      source: aiForm.elements.source.value,
      delayMs: numberValue(aiForm, "delayMs", 2000),
      minPriceTon,
      estimatePrice: checkboxValue(aiForm, "estimatePrice"),
      safeMode: checkboxValue(aiForm, "safeMode"),
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

  const sortSelect = $("#favorites-sort");
  sortSelect.addEventListener("change", () => {
    state.favoriteSort = sortSelect.value;
    renderFavorites();
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
          note: "Найдено через Token",
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

function bindResultsSort() {
  const select = $("#results-sort");
  select.addEventListener("change", () => {
    state.resultSort = select.value;
    if (state.currentJob) renderResults(state.currentJob.result, state.currentJob);
  });
}

async function initialize() {
  renderRoute();
  initializeCustomSelects();
  bindGlobalActions();
  bindSearchForm();
  bindModelForms();
  bindFavorites();
  bindResultsSort();
  bindSetup();
  bindDelegatedActions();

  const results = await Promise.allSettled([
    refreshStatus({ silent: true }),
    refreshFavorites({ silent: true }),
    refreshJobs({ silent: true }),
    refreshLogin({ silent: true }),
    refreshRates({ silent: true }),
  ]);
  const statusResult = results[0];
  if (statusResult.status === "rejected" || !state.status) {
    renderOffline(statusResult.status === "rejected" ? statusResult.reason : new Error("API недоступен"));
  }
}

void initialize();
