const STORAGE_KEY = "dandori-note-events";
const DB_NAME = "dandori-note-db";
const DB_VERSION = 1;
const ATTACHMENT_STORE = "attachments";

const state = {
  events: [],
  filter: "all",
  deferredInstallPrompt: null,
  toastTimer: null,
  attachmentUrls: new Map(),
};

const elements = {
  eventForm: document.querySelector("#event-form"),
  eventsList: document.querySelector("#events-list"),
  eventsEmpty: document.querySelector("#events-empty"),
  statusFilter: document.querySelector("#status-filter"),
  backupButton: document.querySelector("#backup-button"),
  restoreButton: document.querySelector("#restore-button"),
  restoreInput: document.querySelector("#restore-input"),
  notificationButton: document.querySelector("#notification-button"),
  notificationStatus: document.querySelector("#notification-status"),
  installButton: document.querySelector("#install-button"),
  installHint: document.querySelector("#install-hint"),
  connectivityDot: document.querySelector("#connectivity-dot"),
  connectivityLabel: document.querySelector("#connectivity-label"),
  offlineNote: document.querySelector("#offline-note"),
  upcomingCount: document.querySelector("#upcoming-count"),
  dueSoonCount: document.querySelector("#due-soon-count"),
  overdueCount: document.querySelector("#overdue-count"),
  toast: document.querySelector("#toast"),
};

let attachmentDbPromise = null;

document.addEventListener("DOMContentLoaded", () => {
  initializeApp().catch((error) => {
    console.error(error);
    showToast("アプリの初期化で問題が起きました。");
  });
});

async function initializeApp() {
  state.events = loadEvents();
  state.filter = elements.statusFilter.value;

  elements.eventForm.addEventListener("submit", handleCreateEvent);
  elements.statusFilter.addEventListener("change", (event) => {
    state.filter = event.target.value;
    void renderApp();
  });

  elements.notificationButton.addEventListener("click", async () => {
    await requestNotificationPermission();
  });

  elements.backupButton.addEventListener("click", async () => {
    await exportBackup();
  });

  elements.restoreButton.addEventListener("click", () => {
    elements.restoreInput.click();
  });

  elements.restoreInput.addEventListener("change", async (event) => {
    await importBackup(event);
  });

  elements.installButton.addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) {
      showToast("iPhoneではSafariの共有メニューからホーム画面に追加してください。");
      return;
    }

    state.deferredInstallPrompt.prompt();
    const outcome = await state.deferredInstallPrompt.userChoice;
    if (outcome.outcome === "accepted") {
      showToast("ホーム画面への追加を開始しました。");
    }
    state.deferredInstallPrompt = null;
    updateInstallUi();
  });

  document.addEventListener("click", handleActionClick);
  document.addEventListener("submit", handleNestedSubmit);
  document.addEventListener("change", handleCheckboxChange);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void scanDueReminders();
    }
  });

  window.addEventListener("online", updateConnectivityUi);
  window.addEventListener("offline", updateConnectivityUi);

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    updateInstallUi();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service worker registration failed:", error);
    });
  }

  updateNotificationUi();
  updateInstallUi();
  updateConnectivityUi();
  await renderApp();
  await scanDueReminders();
  window.setInterval(() => {
    void scanDueReminders();
  }, 60000);
}

function loadEvents() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? sortEvents(parsed) : [];
  } catch (error) {
    console.warn("Failed to parse stored events:", error);
    return [];
  }
}

function saveEvents() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.events));
}

function sortEvents(events) {
  return [...events].sort((left, right) => {
    const leftTime = parseLocalDateTime(left.scheduledAt)?.getTime() ?? 0;
    const rightTime = parseLocalDateTime(right.scheduledAt)?.getTime() ?? 0;
    return leftTime - rightTime;
  });
}

function generateId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseLocalDateTime(value) {
  if (!value) {
    return null;
  }

  const [datePart, timePart = "00:00"] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour = 0, minute = 0] = timePart.split(":").map(Number);

  if (!year || !month || !day) {
    return null;
  }

  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function formatDateTime(value) {
  const date = parseLocalDateTime(value);
  if (!date) {
    return "未設定";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatInputDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  const time = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ];
  return `${parts.join("-")}T${time.join(":")}`;
}

function defaultReminderFor(deadlineAt) {
  const deadline = parseLocalDateTime(deadlineAt);
  if (!deadline) {
    return "";
  }

  const reminder = new Date(deadline);
  const now = new Date();
  const hoursUntilDeadline = (deadline.getTime() - now.getTime()) / (60 * 60 * 1000);

  if (hoursUntilDeadline > 30) {
    reminder.setDate(reminder.getDate() - 1);
  } else if (hoursUntilDeadline > 4) {
    reminder.setHours(reminder.getHours() - 2);
  } else {
    reminder.setMinutes(reminder.getMinutes() - 30);
  }

  if (reminder.getTime() <= now.getTime()) {
    return formatInputDateTime(now);
  }

  return formatInputDateTime(reminder);
}

function isPrepOverdue(prep) {
  if (prep.completed) {
    return false;
  }

  const deadline = parseLocalDateTime(prep.deadlineAt);
  return Boolean(deadline && deadline.getTime() < Date.now());
}

function isPrepDueSoon(prep) {
  if (prep.completed) {
    return false;
  }

  const deadline = parseLocalDateTime(prep.deadlineAt);
  if (!deadline) {
    return false;
  }

  const diff = deadline.getTime() - Date.now();
  return diff >= 0 && diff <= 48 * 60 * 60 * 1000;
}

function getEventAttentionLevel(event) {
  if (event.prepItems.some((prep) => isPrepOverdue(prep))) {
    return "danger";
  }
  if (event.prepItems.some((prep) => isPrepDueSoon(prep))) {
    return "attention";
  }
  if (event.prepItems.length > 0 && event.prepItems.every((prep) => prep.completed)) {
    return "done";
  }
  return "normal";
}

function getVisibleEvents() {
  if (state.filter === "attention") {
    return state.events.filter((event) => {
      const level = getEventAttentionLevel(event);
      return level === "danger" || level === "attention";
    });
  }

  if (state.filter === "done") {
    return state.events.filter((event) => {
      return event.prepItems.length > 0 && event.prepItems.every((prep) => prep.completed);
    });
  }

  return state.events;
}

function updateDashboard() {
  const now = Date.now();
  const upcomingCount = state.events.filter((event) => {
    const scheduled = parseLocalDateTime(event.scheduledAt);
    return Boolean(scheduled && scheduled.getTime() >= now);
  }).length;
  const prepItems = state.events.flatMap((event) => event.prepItems);
  const dueSoonCount = prepItems.filter((prep) => isPrepDueSoon(prep)).length;
  const overdueCount = prepItems.filter((prep) => isPrepOverdue(prep)).length;

  elements.upcomingCount.textContent = String(upcomingCount);
  elements.dueSoonCount.textContent = String(dueSoonCount);
  elements.overdueCount.textContent = String(overdueCount);
}

async function renderApp() {
  updateDashboard();
  updateNotificationUi();

  const visibleEvents = getVisibleEvents();
  elements.eventsEmpty.classList.toggle("is-hidden", visibleEvents.length > 0);
  elements.eventsList.innerHTML = "";

  if (visibleEvents.length === 0) {
    return;
  }

  const eventMarkup = await Promise.all(visibleEvents.map((event) => renderEventCard(event)));
  elements.eventsList.innerHTML = eventMarkup.join("");
}

async function renderEventCard(event) {
  const attentionLevel = getEventAttentionLevel(event);
  const statusTag = getEventStatusTag(attentionLevel);
  const attachmentsHtml = await renderAttachments(event);

  const prepItems = [...event.prepItems].sort((left, right) => {
    const leftTime = parseLocalDateTime(left.deadlineAt)?.getTime() ?? 0;
    const rightTime = parseLocalDateTime(right.deadlineAt)?.getTime() ?? 0;
    return leftTime - rightTime;
  });

  const prepItemsHtml = prepItems.length
    ? prepItems.map((prep) => renderPrepItem(event, prep)).join("")
    : `<div class="empty-state"><h3>準備期限はまだありません</h3><p>この予定に必要な準備を追加すると、締切の流れが見えるようになります。</p></div>`;

  return `
    <article class="event-card ${attentionLevel === "danger" || attentionLevel === "attention" ? "is-attention" : ""}">
      <div class="event-card__header">
        <div>
          <p class="eyebrow">Event</p>
          <h3 class="event-card__title">${escapeHtml(event.title)}</h3>
          <p class="event-card__meta">
            予定日時: ${escapeHtml(formatDateTime(event.scheduledAt))}
            ${event.location ? `<br>場所: ${escapeHtml(event.location)}` : ""}
          </p>
        </div>
        ${statusTag}
      </div>

      ${event.note ? `<p class="event-card__note">${escapeHtml(event.note)}</p>` : ""}
      ${attachmentsHtml}

      <div class="event-card__actions">
        <button class="button button--line button--small" type="button" data-action="toggle-event-edit" data-event-id="${escapeHtml(event.id)}">予定を編集</button>
        <button class="button button--line button--small" type="button" data-action="export-event-ics" data-event-id="${escapeHtml(event.id)}">iPhone通知用 .ics</button>
        <button class="button button--line-danger button--small" type="button" data-action="delete-event" data-event-id="${escapeHtml(event.id)}">予定を削除</button>
      </div>

      <div class="edit-block is-hidden" id="event-edit-${escapeHtml(event.id)}">
        <form class="event-edit-form" data-event-id="${escapeHtml(event.id)}">
          <div class="inline-fields">
            <label class="field">
              <span>予定名</span>
              <input name="title" type="text" value="${escapeHtml(event.title)}" required>
            </label>
            <label class="field">
              <span>予定日時</span>
              <input name="scheduledAt" type="datetime-local" value="${escapeHtml(event.scheduledAt)}" required>
            </label>
          </div>

          <label class="field">
            <span>場所</span>
            <input name="location" type="text" value="${escapeHtml(event.location ?? "")}">
          </label>

          <label class="field">
            <span>メモ</span>
            <textarea name="note" rows="3">${escapeHtml(event.note ?? "")}</textarea>
          </label>

          <label class="field">
            <span>添付を追加</span>
            <input name="attachments" type="file" accept="image/*,application/pdf" multiple>
            <small>既存の添付は残したまま、新しい画像やPDFを追加できます。</small>
          </label>

          <div class="edit-actions">
            <button class="button button--primary button--small" type="submit">予定を更新</button>
            <button class="button button--ghost button--small" type="button" data-action="cancel-event-edit" data-event-id="${escapeHtml(event.id)}">閉じる</button>
          </div>
        </form>
      </div>

      <section class="prep-section">
        <div class="prep-section__header">
          <div>
            <p class="eyebrow">Preparation</p>
            <strong>準備期限</strong>
          </div>
          <p class="panel-note">期限は手入力。通知時刻を空欄にすると自動で補完します。</p>
        </div>

        <ul class="prep-list">${prepItemsHtml}</ul>

        <form class="prep-form" data-event-id="${escapeHtml(event.id)}">
          <div class="inline-fields">
            <label class="field">
              <span>準備名</span>
              <input name="title" type="text" placeholder="例: 資料を印刷する" required>
            </label>
            <label class="field">
              <span>期限</span>
              <input name="deadlineAt" type="datetime-local" required>
            </label>
          </div>

          <div class="inline-fields">
            <label class="field">
              <span>通知時刻</span>
              <input name="reminderAt" type="datetime-local">
            </label>
            <label class="field">
              <span>メモ</span>
              <input name="note" type="text" placeholder="補足があれば">
            </label>
          </div>

          <button class="button button--primary button--small" type="submit">準備期限を追加</button>
        </form>
      </section>
    </article>
  `;
}

function renderPrepItem(event, prep) {
  const overdue = isPrepOverdue(prep);
  const dueSoon = isPrepDueSoon(prep);
  const itemClasses = [
    "prep-item",
    prep.completed ? "is-complete" : "",
    overdue ? "is-overdue" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const statusText = prep.completed ? "完了" : overdue ? "期限超過" : dueSoon ? "まもなく期限" : "進行中";

  return `
    <li class="${itemClasses}">
      <div class="prep-item__row">
        <label class="prep-item__label">
          <input type="checkbox" data-action="toggle-prep" data-event-id="${escapeHtml(event.id)}" data-prep-id="${escapeHtml(prep.id)}" ${prep.completed ? "checked" : ""}>
          <div>
            <h4 class="prep-item__title">${escapeHtml(prep.title)}</h4>
            <p class="prep-item__meta">
              状態: ${escapeHtml(statusText)}<br>
              期限: ${escapeHtml(formatDateTime(prep.deadlineAt))}<br>
              通知: ${escapeHtml(formatDateTime(prep.reminderAt))}
            </p>
          </div>
        </label>

        <div class="prep-item__actions">
          <button class="button button--line button--small" type="button" data-action="toggle-prep-edit" data-event-id="${escapeHtml(event.id)}" data-prep-id="${escapeHtml(prep.id)}">編集</button>
          <button class="button button--line button--small" type="button" data-action="export-prep-ics" data-event-id="${escapeHtml(event.id)}" data-prep-id="${escapeHtml(prep.id)}">通知を書き出し</button>
          <button class="button button--line-danger button--small" type="button" data-action="delete-prep" data-event-id="${escapeHtml(event.id)}" data-prep-id="${escapeHtml(prep.id)}">削除</button>
        </div>
      </div>

      ${prep.note ? `<p class="prep-item__note">${escapeHtml(prep.note)}</p>` : ""}

      <div class="edit-block is-hidden" id="prep-edit-${escapeHtml(prep.id)}">
        <form class="prep-edit-form" data-event-id="${escapeHtml(event.id)}" data-prep-id="${escapeHtml(prep.id)}">
          <div class="inline-fields">
            <label class="field">
              <span>準備名</span>
              <input name="title" type="text" value="${escapeHtml(prep.title)}" required>
            </label>
            <label class="field">
              <span>期限</span>
              <input name="deadlineAt" type="datetime-local" value="${escapeHtml(prep.deadlineAt)}" required>
            </label>
          </div>

          <div class="inline-fields">
            <label class="field">
              <span>通知時刻</span>
              <input name="reminderAt" type="datetime-local" value="${escapeHtml(prep.reminderAt ?? "")}">
            </label>
            <label class="field">
              <span>メモ</span>
              <input name="note" type="text" value="${escapeHtml(prep.note ?? "")}">
            </label>
          </div>

          <div class="edit-actions">
            <button class="button button--primary button--small" type="submit">準備を更新</button>
            <button class="button button--ghost button--small" type="button" data-action="cancel-prep-edit" data-prep-id="${escapeHtml(prep.id)}">閉じる</button>
          </div>
        </form>
      </div>
    </li>
  `;
}

async function renderAttachments(event) {
  if (!event.attachments?.length) {
    return "";
  }

  const cards = await Promise.all(
    event.attachments.map(async (attachment) => {
      const url = await getAttachmentUrl(attachment.id);
      const caption = `
        <span>${escapeHtml(attachment.name)}</span>
        <span>${escapeHtml(formatFileSize(attachment.size))}</span>
      `;

      if (!url) {
        return `
          <div class="attachment-card">
            <div class="attachment-card__frame">
              <span class="attachment-card__missing">見つかりません</span>
              <button class="attachment-card__remove" type="button" data-action="delete-attachment" data-event-id="${escapeHtml(event.id)}" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="添付を削除">×</button>
            </div>
            <div class="attachment-card__caption">${caption}</div>
          </div>
        `;
      }

      if (attachment.type.startsWith("image/")) {
        return `
          <a class="attachment-card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
            <div class="attachment-card__frame">
              <img src="${escapeHtml(url)}" alt="${escapeHtml(attachment.name)}">
              <button class="attachment-card__remove" type="button" data-action="delete-attachment" data-event-id="${escapeHtml(event.id)}" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="添付を削除">×</button>
            </div>
            <div class="attachment-card__caption">${caption}</div>
          </a>
        `;
      }

      if (attachment.type === "application/pdf") {
        return `
          <a class="attachment-card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
            <div class="attachment-card__frame">
              <object data="${escapeHtml(url)}#toolbar=0&navpanes=0&scrollbar=0" type="application/pdf" aria-label="${escapeHtml(attachment.name)}"></object>
              <span class="attachment-card__pdf-badge">PDF</span>
              <button class="attachment-card__remove" type="button" data-action="delete-attachment" data-event-id="${escapeHtml(event.id)}" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="添付を削除">×</button>
            </div>
            <div class="attachment-card__caption">${caption}</div>
          </a>
        `;
      }

      return `
        <a class="attachment-card" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">
          <div class="attachment-card__frame">
            <span class="attachment-card__pdf-badge">FILE</span>
            <button class="attachment-card__remove" type="button" data-action="delete-attachment" data-event-id="${escapeHtml(event.id)}" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="添付を削除">×</button>
          </div>
          <div class="attachment-card__caption">${caption}</div>
        </a>
      `;
    }),
  );

  return `
    <section class="attachments">
      <div>
        <p class="eyebrow">Attachments</p>
        <strong>画像 / PDF</strong>
      </div>
      <div class="attachments__grid">${cards.join("")}</div>
    </section>
  `;
}

function getEventStatusTag(level) {
  if (level === "danger") {
    return `<span class="tag tag--danger">期限超過あり</span>`;
  }
  if (level === "attention") {
    return `<span class="tag">準備が近づいています</span>`;
  }
  if (level === "done") {
    return `<span class="tag tag--done">準備完了</span>`;
  }
  return `<span class="tag">進行中</span>`;
}

async function handleCreateEvent(event) {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const files = event.currentTarget.elements.attachments.files;
  const attachments = await storeAttachments(files);

  const nextEvent = {
    id: generateId(),
    title: String(formData.get("title") || "").trim(),
    scheduledAt: String(formData.get("scheduledAt") || ""),
    location: String(formData.get("location") || "").trim(),
    note: String(formData.get("note") || "").trim(),
    attachments,
    prepItems: [],
    createdAt: new Date().toISOString(),
  };

  state.events = sortEvents([...state.events, nextEvent]);
  saveEvents();
  event.currentTarget.reset();
  await renderApp();
  showToast("予定を保存しました。次は準備期限を追加できます。");
}

async function handleNestedSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  if (form.matches(".prep-form")) {
    event.preventDefault();
    await handleCreatePrepItem(form);
    return;
  }

  if (form.matches(".event-edit-form")) {
    event.preventDefault();
    await handleUpdateEvent(form);
    return;
  }

  if (form.matches(".prep-edit-form")) {
    event.preventDefault();
    await handleUpdatePrepItem(form);
  }
}

async function handleCreatePrepItem(form) {
  const eventId = form.dataset.eventId;
  const eventIndex = state.events.findIndex((item) => item.id === eventId);
  if (eventIndex === -1) {
    return;
  }

  const data = new FormData(form);
  const deadlineAt = String(data.get("deadlineAt") || "");
  const reminderAt = String(data.get("reminderAt") || "").trim() || defaultReminderFor(deadlineAt);

  const prep = {
    id: generateId(),
    title: String(data.get("title") || "").trim(),
    deadlineAt,
    reminderAt,
    note: String(data.get("note") || "").trim(),
    completed: false,
    reminderSentAt: "",
  };

  state.events[eventIndex].prepItems.push(prep);
  saveEvents();
  form.reset();
  await renderApp();
  await scanDueReminders();
  showToast("準備期限を追加しました。");
}

async function handleUpdateEvent(form) {
  const eventId = form.dataset.eventId;
  const eventIndex = state.events.findIndex((item) => item.id === eventId);
  if (eventIndex === -1) {
    return;
  }

  const data = new FormData(form);
  const files = form.elements.attachments.files;
  const attachments = await storeAttachments(files);
  const currentEvent = state.events[eventIndex];

  state.events[eventIndex] = {
    ...currentEvent,
    title: String(data.get("title") || "").trim(),
    scheduledAt: String(data.get("scheduledAt") || ""),
    location: String(data.get("location") || "").trim(),
    note: String(data.get("note") || "").trim(),
    attachments: [...currentEvent.attachments, ...attachments],
  };

  state.events = sortEvents(state.events);
  saveEvents();
  await renderApp();
  showToast("予定を更新しました。");
}

async function handleUpdatePrepItem(form) {
  const eventId = form.dataset.eventId;
  const prepId = form.dataset.prepId;
  const eventIndex = state.events.findIndex((item) => item.id === eventId);
  if (eventIndex === -1) {
    return;
  }

  const prepIndex = state.events[eventIndex].prepItems.findIndex((item) => item.id === prepId);
  if (prepIndex === -1) {
    return;
  }

  const data = new FormData(form);
  const deadlineAt = String(data.get("deadlineAt") || "");
  const reminderAt = String(data.get("reminderAt") || "").trim() || defaultReminderFor(deadlineAt);
  const currentPrep = state.events[eventIndex].prepItems[prepIndex];

  state.events[eventIndex].prepItems[prepIndex] = {
    ...currentPrep,
    title: String(data.get("title") || "").trim(),
    deadlineAt,
    reminderAt,
    note: String(data.get("note") || "").trim(),
    reminderSentAt: reminderAt !== currentPrep.reminderAt ? "" : currentPrep.reminderSentAt,
  };

  saveEvents();
  await renderApp();
  await scanDueReminders();
  showToast("準備期限を更新しました。");
}

function handleCheckboxChange(event) {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement)) {
    return;
  }

  if (checkbox.matches('[data-action="toggle-prep"]')) {
    const eventIndex = state.events.findIndex((item) => item.id === checkbox.dataset.eventId);
    if (eventIndex === -1) {
      return;
    }

    const prepIndex = state.events[eventIndex].prepItems.findIndex((item) => item.id === checkbox.dataset.prepId);
    if (prepIndex === -1) {
      return;
    }

    state.events[eventIndex].prepItems[prepIndex].completed = checkbox.checked;
    saveEvents();
    void renderApp();
    showToast(checkbox.checked ? "準備を完了にしました。" : "準備を未完了に戻しました。");
  }
}

async function handleActionClick(event) {
  const button = event.target.closest("[data-action]");
  if (!(button instanceof HTMLElement)) {
    return;
  }

  if (button.dataset.action === "toggle-event-edit") {
    const block = document.querySelector(`#event-edit-${button.dataset.eventId}`);
    block?.classList.toggle("is-hidden");
    return;
  }

  if (button.dataset.action === "cancel-event-edit") {
    const block = document.querySelector(`#event-edit-${button.dataset.eventId}`);
    block?.classList.add("is-hidden");
    return;
  }

  if (button.dataset.action === "toggle-prep-edit") {
    const block = document.querySelector(`#prep-edit-${button.dataset.prepId}`);
    block?.classList.toggle("is-hidden");
    return;
  }

  if (button.dataset.action === "cancel-prep-edit") {
    const block = document.querySelector(`#prep-edit-${button.dataset.prepId}`);
    block?.classList.add("is-hidden");
    return;
  }

  if (button.dataset.action === "delete-prep") {
    await deletePrep(button.dataset.eventId, button.dataset.prepId);
    return;
  }

  if (button.dataset.action === "delete-event") {
    await deleteEvent(button.dataset.eventId);
    return;
  }

  if (button.dataset.action === "delete-attachment") {
    event.preventDefault();
    event.stopPropagation();
    await deleteAttachment(button.dataset.eventId, button.dataset.attachmentId);
    return;
  }

  if (button.dataset.action === "export-prep-ics") {
    exportPrepIcs(button.dataset.eventId, button.dataset.prepId);
    return;
  }

  if (button.dataset.action === "export-event-ics") {
    exportEventIcs(button.dataset.eventId);
  }
}

async function deletePrep(eventId, prepId) {
  const eventIndex = state.events.findIndex((item) => item.id === eventId);
  if (eventIndex === -1) {
    return;
  }

  const prep = state.events[eventIndex].prepItems.find((item) => item.id === prepId);
  if (!prep) {
    return;
  }

  const shouldDelete = window.confirm(`「${prep.title}」を削除しますか？`);
  if (!shouldDelete) {
    return;
  }

  state.events[eventIndex].prepItems = state.events[eventIndex].prepItems.filter((item) => item.id !== prepId);
  saveEvents();
  await renderApp();
  showToast("準備期限を削除しました。");
}

async function deleteEvent(eventId) {
  const currentEvent = state.events.find((item) => item.id === eventId);
  if (!currentEvent) {
    return;
  }

  const shouldDelete = window.confirm(`「${currentEvent.title}」を削除しますか？ 添付ファイルも一緒に消えます。`);
  if (!shouldDelete) {
    return;
  }

  await Promise.all((currentEvent.attachments ?? []).map((attachment) => removeAttachmentBlob(attachment.id)));
  state.events = state.events.filter((item) => item.id !== eventId);
  saveEvents();
  await renderApp();
  showToast("予定を削除しました。");
}

async function deleteAttachment(eventId, attachmentId) {
  const eventIndex = state.events.findIndex((item) => item.id === eventId);
  if (eventIndex === -1) {
    return;
  }

  const attachment = state.events[eventIndex].attachments.find((item) => item.id === attachmentId);
  if (!attachment) {
    return;
  }

  const shouldDelete = window.confirm(`添付「${attachment.name}」を削除しますか？`);
  if (!shouldDelete) {
    return;
  }

  state.events[eventIndex].attachments = state.events[eventIndex].attachments.filter((item) => item.id !== attachmentId);
  await removeAttachmentBlob(attachmentId);
  saveEvents();
  await renderApp();
  showToast("添付ファイルを削除しました。");
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    showToast("このブラウザは通知に対応していません。");
    return;
  }

  const result = await Notification.requestPermission();
  updateNotificationUi();

  if (result === "granted") {
    new Notification("段取りノート", {
      body: "準備期限の通知を受け取れるようになりました。",
    });
    showToast("通知を有効にしました。");
    await scanDueReminders();
    return;
  }

  showToast("通知権限が許可されていません。");
}

function updateNotificationUi() {
  if (!("Notification" in window)) {
    elements.notificationStatus.textContent = "このブラウザでは通知を使えません。";
    elements.notificationButton.disabled = true;
    return;
  }

  const permission = Notification.permission;
  if (permission === "granted") {
    elements.notificationStatus.textContent = "ブラウザ通知は有効です。iPhoneで確実に残したいものは .ics 書き出しも使えます。";
    elements.notificationButton.textContent = "通知は有効です";
    elements.notificationButton.disabled = true;
    return;
  }

  if (permission === "denied") {
    elements.notificationStatus.textContent = "通知は拒否されています。必要ならブラウザ設定から再許可してください。";
    elements.notificationButton.textContent = "通知は拒否中";
    elements.notificationButton.disabled = true;
    return;
  }

  elements.notificationStatus.textContent = "通知を許可すると、期限前の準備をアプリ起動中に知らせます。";
  elements.notificationButton.textContent = "通知を有効にする";
  elements.notificationButton.disabled = false;
}

function updateInstallUi() {
  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  if (state.deferredInstallPrompt && !isIos) {
    elements.installButton.classList.remove("is-hidden");
    elements.installHint.textContent = "インストールすると、ホーム画面からアプリのように開けます。";
    return;
  }

  elements.installButton.classList.add("is-hidden");
  elements.installHint.textContent = isIos
    ? "iPhoneではSafariの共有ボタンから「ホーム画面に追加」でアプリ風に使えます。"
    : "PCではブラウザのインストール機能が出たらホーム画面追加できます。";
}

function isStandaloneMode() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function updateConnectivityUi() {
  const online = window.navigator.onLine;
  elements.connectivityDot.classList.toggle("is-online", online);
  elements.connectivityDot.classList.toggle("is-offline", !online);
  elements.connectivityLabel.textContent = online ? "今はオンラインです。" : "今はオフラインです。";

  if (!online) {
    elements.offlineNote.textContent = "保存済みの予定はこのまま使えます。バックアップ復元も端末内ファイルならそのまま可能です。";
    return;
  }

  if (isStandaloneMode()) {
    elements.offlineNote.textContent = "ホーム画面から開いています。いまの内容は端末内に保存され、次回はオフラインでも開きやすくなります。";
    return;
  }

  elements.offlineNote.textContent = "最初に一度開けば、その後はオフラインでも予定の確認と更新ができます。";
}

async function scanDueReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }

  const dueItems = [];
  const now = Date.now();

  for (const event of state.events) {
    for (const prep of event.prepItems) {
      if (prep.completed || !prep.reminderAt || prep.reminderSentAt) {
        continue;
      }

      const reminderTime = parseLocalDateTime(prep.reminderAt)?.getTime();
      if (!reminderTime || reminderTime > now) {
        continue;
      }

      dueItems.push({ event, prep });
    }
  }

  if (dueItems.length === 0) {
    return;
  }

  for (const item of dueItems) {
    const message = `${item.prep.title} / ${item.event.title}`;
    new Notification("準備の時間です", {
      body: `${message}\n期限: ${formatDateTime(item.prep.deadlineAt)}`,
    });

    item.prep.reminderSentAt = new Date().toISOString();
  }

  saveEvents();
  await renderApp();
  showToast(`${dueItems.length}件の準備が通知対象になりました。`);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");

  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 3200);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 KB";
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function openAttachmentDb() {
  if (attachmentDbPromise) {
    return attachmentDbPromise;
  }

  attachmentDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) {
        db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

  return attachmentDbPromise;
}

async function storeAttachments(fileList) {
  if (!fileList?.length) {
    return [];
  }

  const files = Array.from(fileList).filter((file) => file.type.startsWith("image/") || file.type === "application/pdf");
  const db = await openAttachmentDb();

  return Promise.all(
    files.map((file) => {
      const id = generateId();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(ATTACHMENT_STORE, "readwrite");
        transaction.objectStore(ATTACHMENT_STORE).put({
          id,
          blob: file,
          updatedAt: Date.now(),
        });

        transaction.addEventListener("complete", () => {
          resolve({
            id,
            name: file.name,
            type: file.type,
            size: file.size,
          });
        });
        transaction.addEventListener("error", () => reject(transaction.error));
      });
    }),
  );
}

async function getAttachmentUrl(attachmentId) {
  if (state.attachmentUrls.has(attachmentId)) {
    return state.attachmentUrls.get(attachmentId);
  }

  const db = await openAttachmentDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE, "readonly");
    const request = transaction.objectStore(ATTACHMENT_STORE).get(attachmentId);

    request.addEventListener("success", () => {
      if (!request.result?.blob) {
        resolve("");
        return;
      }

      const url = URL.createObjectURL(request.result.blob);
      state.attachmentUrls.set(attachmentId, url);
      resolve(url);
    });
    request.addEventListener("error", () => reject(request.error));
  });
}

async function removeAttachmentBlob(attachmentId) {
  const db = await openAttachmentDb();
  const currentUrl = state.attachmentUrls.get(attachmentId);
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    state.attachmentUrls.delete(attachmentId);
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE, "readwrite");
    transaction.objectStore(ATTACHMENT_STORE).delete(attachmentId);
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function getAttachmentBlob(attachmentId) {
  const db = await openAttachmentDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE, "readonly");
    const request = transaction.objectStore(ATTACHMENT_STORE).get(attachmentId);
    request.addEventListener("success", () => resolve(request.result?.blob ?? null));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function putAttachmentBlob(attachmentId, blob) {
  const db = await openAttachmentDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE, "readwrite");
    transaction.objectStore(ATTACHMENT_STORE).put({
      id: attachmentId,
      blob,
      updatedAt: Date.now(),
    });
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function clearAttachmentStore() {
  const db = await openAttachmentDb();
  state.attachmentUrls.forEach((url) => URL.revokeObjectURL(url));
  state.attachmentUrls.clear();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE, "readwrite");
    transaction.objectStore(ATTACHMENT_STORE).clear();
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, body] = String(dataUrl).split(",");
  const mimeMatch = header.match(/^data:(.*?);base64$/);
  const mimeType = mimeMatch?.[1] || "application/octet-stream";
  const binary = window.atob(body || "");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

function normalizeImportedEvents(events) {
  return sortEvents(
    events.map((event) => ({
      id: event.id || generateId(),
      title: String(event.title || "").trim() || "名称未設定",
      scheduledAt: String(event.scheduledAt || ""),
      location: String(event.location || "").trim(),
      note: String(event.note || "").trim(),
      createdAt: event.createdAt || new Date().toISOString(),
      attachments: Array.isArray(event.attachments)
        ? event.attachments.map((attachment) => ({
            id: attachment.id || generateId(),
            name: String(attachment.name || "attachment"),
            type: String(attachment.type || "application/octet-stream"),
            size: Number(attachment.size || 0),
          }))
        : [],
      prepItems: Array.isArray(event.prepItems)
        ? event.prepItems.map((prep) => ({
            id: prep.id || generateId(),
            title: String(prep.title || "").trim() || "準備",
            deadlineAt: String(prep.deadlineAt || ""),
            reminderAt: String(prep.reminderAt || ""),
            note: String(prep.note || "").trim(),
            completed: Boolean(prep.completed),
            reminderSentAt: String(prep.reminderSentAt || ""),
          }))
        : [],
    })),
  );
}

async function exportBackup() {
  const uniqueAttachments = new Map();

  for (const event of state.events) {
    for (const attachment of event.attachments ?? []) {
      if (uniqueAttachments.has(attachment.id)) {
        continue;
      }

      const blob = await getAttachmentBlob(attachment.id);
      if (!blob) {
        continue;
      }

      uniqueAttachments.set(attachment.id, {
        ...attachment,
        dataUrl: await blobToDataUrl(blob),
      });
    }
  }

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    events: state.events,
    attachments: [...uniqueAttachments.values()],
  };

  const timestamp = new Date().toISOString().slice(0, 10);
  downloadTextFile(
    `dandori-note-backup-${timestamp}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
  showToast("バックアップを書き出しました。");
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const raw = await file.text();
    const payload = JSON.parse(raw);
    if (!Array.isArray(payload.events)) {
      throw new Error("events missing");
    }

    const shouldReplace = window.confirm("今の予定と添付をバックアップの内容で置き換えますか？");
    if (!shouldReplace) {
      event.target.value = "";
      return;
    }

    await clearAttachmentStore();
    const normalizedEvents = normalizeImportedEvents(payload.events);

    if (Array.isArray(payload.attachments)) {
      for (const attachment of payload.attachments) {
        if (!attachment.id || !attachment.dataUrl) {
          continue;
        }
        await putAttachmentBlob(attachment.id, dataUrlToBlob(attachment.dataUrl));
      }
    }

    state.events = normalizedEvents;
    saveEvents();
    await renderApp();
    showToast("バックアップから復元しました。");
  } catch (error) {
    console.error(error);
    showToast("バックアップの復元に失敗しました。");
  } finally {
    event.target.value = "";
  }
}

function buildIcsTimestamp(date) {
  return date
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function buildDurationTrigger(minutesBefore) {
  const safeMinutes = Math.max(0, Math.round(minutesBefore));
  if (safeMinutes === 0) {
    return "TRIGGER:PT0M";
  }
  return `TRIGGER:-PT${safeMinutes}M`;
}

function exportPrepIcs(eventId, prepId) {
  const selectedEvent = state.events.find((item) => item.id === eventId);
  const prep = selectedEvent?.prepItems.find((item) => item.id === prepId);
  if (!selectedEvent || !prep) {
    return;
  }

  const deadline = parseLocalDateTime(prep.deadlineAt);
  if (!deadline) {
    return;
  }

  const end = new Date(deadline.getTime() + 15 * 60 * 1000);
  const reminder = parseLocalDateTime(prep.reminderAt);
  const reminderMinutes = reminder ? (deadline.getTime() - reminder.getTime()) / 60000 : 0;
  const uid = `${prep.id}@dandori-note`;
  const summary = `${prep.title} / ${selectedEvent.title}`;
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dandori Note//JA",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${buildIcsTimestamp(new Date())}`,
    `DTSTART:${buildIcsTimestamp(deadline)}`,
    `DTEND:${buildIcsTimestamp(end)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(prep.note || `予定: ${selectedEvent.title}`)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(summary)}`,
    buildDurationTrigger(reminderMinutes),
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  downloadTextFile(`${sanitizeFileName(summary)}.ics`, body, "text/calendar");
  showToast(".ics を書き出しました。iPhoneカレンダーに追加して通知に使えます。");
}

function exportEventIcs(eventId) {
  const selectedEvent = state.events.find((item) => item.id === eventId);
  if (!selectedEvent) {
    return;
  }

  const scheduled = parseLocalDateTime(selectedEvent.scheduledAt);
  if (!scheduled) {
    return;
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dandori Note//JA",
  ];

  const eventEnd = new Date(scheduled.getTime() + 60 * 60 * 1000);
  lines.push(
    "BEGIN:VEVENT",
    `UID:${selectedEvent.id}@dandori-note`,
    `DTSTAMP:${buildIcsTimestamp(new Date())}`,
    `DTSTART:${buildIcsTimestamp(scheduled)}`,
    `DTEND:${buildIcsTimestamp(eventEnd)}`,
    `SUMMARY:${escapeIcsText(selectedEvent.title)}`,
    `DESCRIPTION:${escapeIcsText(selectedEvent.note || "予定本体")}`,
    "END:VEVENT",
  );

  for (const prep of selectedEvent.prepItems) {
    const deadline = parseLocalDateTime(prep.deadlineAt);
    if (!deadline) {
      continue;
    }
    const reminder = parseLocalDateTime(prep.reminderAt);
    const reminderMinutes = reminder ? (deadline.getTime() - reminder.getTime()) / 60000 : 0;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${prep.id}@dandori-note`,
      `DTSTAMP:${buildIcsTimestamp(new Date())}`,
      `DTSTART:${buildIcsTimestamp(deadline)}`,
      `DTEND:${buildIcsTimestamp(new Date(deadline.getTime() + 15 * 60 * 1000))}`,
      `SUMMARY:${escapeIcsText(`準備: ${prep.title}`)}`,
      `DESCRIPTION:${escapeIcsText(prep.note || selectedEvent.title)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcsText(prep.title)}`,
      buildDurationTrigger(reminderMinutes),
      "END:VALARM",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  downloadTextFile(`${sanitizeFileName(selectedEvent.title)}-bundle.ics`, lines.join("\r\n"), "text/calendar");
  showToast("予定と準備期限をまとめて .ics に書き出しました。");
}

function escapeIcsText(text) {
  return String(text ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r?\n/g, "\\n");
}

function sanitizeFileName(text) {
  return String(text ?? "schedule").replace(/[\\/:*?"<>|]/g, "_");
}

function downloadTextFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
