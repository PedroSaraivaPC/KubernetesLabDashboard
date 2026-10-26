"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const ui = {
    scaleDialog: byId("scale-action-dialog"),
    podDialog: byId("pod-action-dialog"),
    openScale: byId("open-scale-action"),
    openPod: byId("open-pod-action"),
    closeScale: byId("close-scale-action"),
    closePod: byId("close-pod-action"),
    scaleForm: byId("scale-form"),
    deployment: byId("action-deployment"),
    replicas: byId("action-replicas"),
    scale: byId("action-scale"),
    podForm: byId("pod-form"),
    pod: byId("action-pod"),
    replace: byId("action-replace"),
  };

  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const transportAllowed = location.protocol === "https:" ||
    (location.protocol === "http:" && local);
  const allowedNames = new Set(["kubelab-backend", "kubelab-frontend"]);
  let policy = null;
  let fresh = false;
  let pending = false;
  let loadingPolicy = false;
  let deployments = [];
  let pods = [];
  let activeDialog = null;
  let opener = null;
  let openerKey = null;

  function closeActionDialog({ restoreFocus = true } = {}) {
    if (!activeDialog) return;
    activeDialog.close();
    activeDialog = null;
    document.body.classList.remove("actions-open");
    if (restoreFocus) {
      let target = opener?.isConnected ? opener : null;
      if (!target && openerKey) {
        target = [...document.querySelectorAll("[data-resource-key]")].find(
          (item) => item.dataset.resourceKey === openerKey);
      }
      target ??= byId("actions-title");
      if (!target.matches("button, a, input, select")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    opener = null;
    openerKey = null;
  }

  function openActionDialog(kind, returnTarget = null) {
    const dialog = kind === "scale" ? ui.scaleDialog : ui.podDialog;
    if (activeDialog === dialog) return;
    const origin = returnTarget?.element ?? document.activeElement;
    if (activeDialog) closeActionDialog({ restoreFocus: false });
    opener = origin;
    openerKey = returnTarget?.key ?? origin?.dataset.resourceKey ?? null;
    activeDialog = dialog;
    updateControls();
    dialog.showModal();
    document.body.classList.add("actions-open");
    dialog.scrollTop = 0;
    dialog.querySelector("h2").focus({ preventScroll: true });
  }

  ui.openScale.addEventListener("click", () => openActionDialog("scale"));
  ui.openPod.addEventListener("click", () => openActionDialog("pod"));
  ui.closeScale.addEventListener("click", () => closeActionDialog());
  ui.closePod.addEventListener("click", () => closeActionDialog());
  for (const dialog of [ui.scaleDialog, ui.podDialog]) {
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeActionDialog();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right ||
          event.clientY < box.top || event.clientY > box.bottom) closeActionDialog();
    });
  }

  function selected(items, select) {
    return items.find((item) => item.uid === select.value);
  }

  function updateControls() {
    const editingLocked = !transportAllowed || !policy || pending;
    const sendingLocked = editingLocked || !fresh ||
      window.kubelabDashboard?.isBusy();
    ui.deployment.disabled = editingLocked || deployments.length === 0;
    ui.pod.disabled = editingLocked || pods.length === 0;
    ui.replicas.disabled = editingLocked || !selected(deployments, ui.deployment);
    ui.scale.disabled = editingLocked || !selected(deployments, ui.deployment);
    ui.replace.disabled = editingLocked || !selected(pods, ui.pod);
    // Keep focused buttons in the tab order during short read refreshes.
    // mutate() still rejects submission until the snapshot is fresh.
    ui.scale.setAttribute("aria-disabled", String(sendingLocked ||
      !selected(deployments, ui.deployment)));
    ui.replace.setAttribute("aria-disabled", String(sendingLocked ||
      !selected(pods, ui.pod)));
  }

  function options(select, items, label) {
    const previous = select.value;
    const entries = items.map((item) => [item.uid, label(item)]);
    const signature = JSON.stringify(entries);
    if (select.dataset.signature === signature) return;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a target";
    select.replaceChildren(placeholder);
    for (const [value, text] of entries) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = items.some((item) => item.uid === previous) ? previous : "";
    select.dataset.signature = signature;
  }

  function renderTargets() {
    options(ui.deployment, deployments.filter((item) =>
      !policy || policy.deployments.includes(item.name)), (item) => item.name);
    options(ui.pod, pods, (item) => item.name);
    updateControls();
  }

  function validPolicy(value) {
    return value?.namespace === "kubelab" &&
      Array.isArray(value.deployments) && value.deployments.length > 0 &&
      value.deployments.every((name) => allowedNames.has(name)) &&
      Number.isInteger(value.min_replicas) &&
      Number.isInteger(value.max_replicas) &&
      value.min_replicas >= 1 && value.max_replicas <= 6 &&
      value.min_replicas <= value.max_replicas;
  }

  async function loadPolicy() {
    if (!transportAllowed || policy || loadingPolicy) return;
    loadingPolicy = true;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/actions/session", {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Action limits returned HTTP " + response.status);
      const data = await response.json();
      if (!validPolicy(data)) throw new Error("Unexpected action policy.");
      policy = data;
      ui.replicas.min = data.min_replicas;
      ui.replicas.max = data.max_replicas;
      renderTargets();
    } catch {
      // Keep actions disabled; the next successful snapshot retries loading limits.
    } finally {
      clearTimeout(deadline);
      loadingPolicy = false;
      updateControls();
    }
  }

  function showPodsAfterAction(dialog) {
    // A late response must not interrupt another popup the user has opened.
    const anotherDialog = [...document.querySelectorAll("dialog[open]")].some(
      (openDialog) => openDialog !== dialog);
    if (anotherDialog) return;

    if (activeDialog === dialog) closeActionDialog({ restoreFocus: false });
    const heading = byId("pods-title");
    heading.focus({ preventScroll: true });
    heading.closest("section").scrollIntoView({
      block: "start",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto" : "smooth",
    });
  }

  async function mutate(path, body, confirmation) {
    if (!transportAllowed || !policy || !fresh || pending ||
        window.kubelabDashboard?.isBusy()) return;
    const actionDialog = activeDialog;
    if (!window.confirm(confirmation)) return;

    pending = true;
    fresh = false;
    updateControls();
    byId("refresh").disabled = true;
    byId("namespace").disabled = true;
    void window.kubelabDashboard.observeAction();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 75000);

    try {
      const response = await fetch(path, {
        method: "POST",
        signal: controller.signal,
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const explanation = response.status === 403
          ? "The backend refused this target under its action policy."
          : response.status === 409
            ? "The object changed. Inspect the refreshed targets before retrying."
            : response.status >= 500
              ? "The outcome is uncertain. Inspect refreshed cluster state before retrying."
              : "Request rejected: HTTP " + response.status;
        window.alert(explanation + "\n\nRequest: " + confirmation.split("\n")[0]);
        return;
      }

      const data = await response.json();
      if (response.status !== 202 || data.status !== "accepted") {
        throw new Error("Unexpected action response.");
      }
      showPodsAfterAction(actionDialog);
    } catch (error) {
      window.alert(
        "The outcome could not be confirmed. Inspect refreshed cluster state before retrying." +
        "\n\nRequest: " + confirmation.split("\n")[0]);
    } finally {
      clearTimeout(deadline);
      pending = false;
      byId("namespace").disabled = false;
      // Require a new read after the POST settles, even if an earlier read is pending.
      await window.kubelabDashboard.observeAction();
      updateControls();
    }
  }

  ui.deployment.addEventListener("change", () => {
    const item = selected(deployments, ui.deployment);
    ui.replicas.value = item ? item.desired_replicas : "";
    updateControls();
  });
  ui.pod.addEventListener("change", updateControls);

  ui.scaleForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const item = selected(deployments, ui.deployment);
    if (!item || !policy || item.namespace !== policy.namespace ||
        !policy.deployments.includes(item.name)) return;
    const replicas = Number(ui.replicas.value);
    if (!Number.isInteger(replicas) || replicas < policy.min_replicas ||
        replicas > policy.max_replicas) {
      window.alert("Choose an integer replica count within the allowed limits.");
      return;
    }
    void mutate(
      "/api/actions/deployments/" + encodeURIComponent(item.name) + "/scale",
      { uid: item.uid, replicas },
      "Scale Deployment kubelab/" + item.name + " to " + replicas +
        " replicas?\nUID: " + item.uid,
    );
  });

  ui.podForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const item = selected(pods, ui.pod);
    if (!item || !policy || item.namespace !== policy.namespace ||
        item.owner_kind !== "ReplicaSet" || item.deleting) return;
    void mutate(
      "/api/actions/pods/" + encodeURIComponent(item.name) + "/delete",
      { uid: item.uid },
      "Delete Pod kubelab/" + item.name + "? Its controller will create a replacement." +
        "\nThe backend verifies Deployment ownership.\nUID: " + item.uid,
    );
  });

  function selectTarget(kind, uid, returnTarget = null) {
    const scaling = kind === "deployment";
    openActionDialog(scaling ? "scale" : "pod", returnTarget);
    if (!policy || pending) {
      window.alert("Wait for action limits and any current action to finish.");
      return false;
    }
    const item = (scaling ? deployments : pods).find((entry) => entry.uid === uid);
    if (!item || item.namespace !== policy.namespace ||
        (scaling && !policy.deployments.includes(item.name))) {
      window.alert("This action target is no longer available.");
      return false;
    }

    if (scaling) {
      ui.deployment.value = item.uid;
      ui.replicas.value = item.desired_replicas;
    } else {
      ui.pod.value = item.uid;
    }
    updateControls();

    (scaling ? ui.replicas : ui.replace).focus({ preventScroll: true });
    return true;
  }
  
  window.kubelabActions = {
    selectDeployment: (uid, returnTarget) =>
      selectTarget("deployment", uid, returnTarget),
    selectPod: (uid, returnTarget) => selectTarget("pod", uid, returnTarget),
    isBusy: () => pending,
    clearSnapshot() {
      fresh = false;
      deployments = [];
      pods = [];
      renderTargets();
    },
    setSnapshot(snapshot) {
      fresh = snapshot !== null;
      if (snapshot) {
        deployments = snapshot.deployments.filter((item) =>
          item.namespace === "kubelab" && allowedNames.has(item.name) && item.uid);
        pods = snapshot.pods.filter((item) =>
          item.namespace === "kubelab" && item.owner_kind === "ReplicaSet" &&
          !item.deleting && item.uid);
        renderTargets();
        if (!policy) void loadPolicy();
      } else {
        updateControls();
      }
    },
  };

  updateControls();
  void loadPolicy();
})();
