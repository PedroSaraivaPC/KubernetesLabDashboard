"use strict";

const ui = {
  namespace: document.querySelector("#namespace"),
  refresh: document.querySelector("#refresh"),
  status: document.querySelector("#status"),
  updated: document.querySelector("#updated"),
  nodes: document.querySelector("#nodes"),
  nodeCount: document.querySelector("#node-count"),
  podCount: document.querySelector("#pod-count"),
  deploymentCount: document.querySelector("#deployment-count"),
  containerCount: document.querySelector("#container-count"),
  pods: document.querySelector("#pods"),
  deployments: document.querySelector("#deployments"),
  containers: document.querySelector("#containers"),
};

const REFRESH_MS = 5000;
const ACTION_REFRESH_MS = 500;
const ACTION_OBSERVATION_MS = 30000;
const REQUEST_TIMEOUT_MS = 15000;
let busy = false;
let timer;
let lastSuccess = null;
let requestController = null;
let requestVersion = 0;
let observationUntil = 0;
let displayedSnapshot = null;

function element(tag, text = null, className = "") {
  const result = document.createElement(tag);
  if (text !== null) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function badge(text, tone = "neutral") {
  return element("span", text, "badge " + tone);
}

function cell(row, value) {
  const result = element("td");
  if (value instanceof HTMLElement) {
    result.append(value);
  } else {
    result.textContent = value ?? "—";
  }
  row.append(result);
  return result;
}

function readyBadge(value) {
  const tone = value === "True" ? "good" : value === "False" ? "bad" : "warn";
  return badge(value, tone);
}

function rows(body, items, columns, fill) {
  body.replaceChildren();

  if (items.length === 0) {
    const row = element("tr");
    const message = cell(row, "No resources in this scope.");
    message.colSpan = columns;
    message.className = "muted";
    body.append(row);
    return;
  }

  for (const item of items) {
    const row = element("tr");
    fill(row, item);
    body.append(row);
  }
}

function resetView() {
  observationUntil = 0;
  displayedSnapshot = null;
  window.kubelabDetails?.clear();
  window.kubelabActions?.clearSnapshot();
  for (const target of [ui.nodes, ui.pods, ui.deployments, ui.containers]) {
    delete target.dataset.snapshot;
  }
  lastSuccess = null;
  ui.updated.textContent = "Not yet";
  ui.updated.removeAttribute("datetime");

  for (const counter of [
    ui.nodeCount, ui.podCount, ui.deploymentCount, ui.containerCount,
  ]) counter.textContent = "—";

  ui.nodes.replaceChildren(element("p", "Waiting for data.", "muted"));

  for (const [body, columns] of [
    [ui.pods, 7], [ui.deployments, 7], [ui.containers, 8],
  ]) {
    const row = element("tr");
    cell(row, "Waiting for data.").colSpan = columns;
    body.replaceChildren(row);
  }
}

function renderNodes(nodes) {
  ui.nodes.replaceChildren();

  for (const machine of nodes) {
    const card = element("article", null, "node-card");
    const heading = element("div", null, "node-heading");
    const name = element("button", machine.name, "resource-link");
    name.type = "button";
    name.dataset.resourceKey = "node:" + machine.name;
    name.addEventListener("click", () =>
      window.kubelabDetails.openNode(machine.name));
    const label = element("h3");
    label.append(name);
    heading.append(label, readyBadge(machine.ready));    
    card.append(heading);
    card.append(element(
      "p",
      machine.is_control_plane ? "Control plane" : "Worker",
      "muted",
    ));

    const facts = element("dl");
    for (const [label, value] of [
      ["Internal IP", machine.internal_ip],
      ["Kubelet", machine.kubelet_version],
      ["Runtime", machine.container_runtime],
    ]) {
      facts.append(element("dt", label), element("dd", value ?? "—"));
    }

    card.append(facts);
    ui.nodes.append(card);
  }
}

function renderPods(pods) {
  rows(ui.pods, pods, 7, (row, pod) => {
    const name = element("button", pod.name, "resource-link");
    name.type = "button";
    name.dataset.resourceKey = "pod:" + pod.uid;
    name.addEventListener("click", () =>
      window.kubelabDetails.openPod(pod.uid));
    cell(row, name);
    cell(row, pod.namespace);
    cell(row, pod.node_name);
    cell(row, pod.pod_ip);
    cell(row, pod.phase + (pod.deleting ? " · deleting" : ""));
    cell(row, readyBadge(pod.ready));
    cell(
      row,
      pod.owner_kind ? pod.owner_kind + "/" + pod.owner_name : "None reported",
    );
  });
}

function renderDeployments(deployments) {
  rows(ui.deployments, deployments, 7, (row, deployment) => {
    const name = element("button", deployment.name, "resource-link");
    name.type = "button";
    name.dataset.resourceKey = "deployment:" + deployment.uid;
    name.addEventListener("click", () =>
      window.kubelabDetails.openDeployment(deployment.uid));
    cell(row, name);
    cell(row, deployment.namespace);
    cell(row, deployment.desired_replicas);
    cell(row, deployment.ready_replicas);
    cell(row, deployment.available_replicas);
    cell(row, deployment.updated_replicas);
    cell(row, deployment.images.join("\n")).className = "image";
  });
}

function renderContainers(containers) {
  rows(ui.containers, containers, 8, (row, container) => {
    cell(row, container.name);
    cell(row, container.pod_name);
    cell(row, container.namespace);
    cell(row, container.kind);

    const parts = [container.state];
    if (container.reason) parts.push(container.reason);
    if (container.exit_code !== null) {
      parts.push("exit " + container.exit_code);
    }

    let tone = "neutral";
    if (container.state === "waiting") tone = "warn";
    if (container.state === "terminated") {
      tone = container.exit_code === 0
        ? "good"
        : container.exit_code === null ? "warn" : "bad";
    }

    cell(row, badge(parts.join(" · "), tone));

    const ready = container.ready === null ? "Unknown" : String(container.ready);
    cell(row, ready);
    cell(row, container.restart_count);

    const image = cell(row, container.image);
    image.className = "image";
    image.title = "Runtime image ID: " + (container.image_id ?? "not reported");
  });
}

function renderStable(target, items, render) {
  const signature = JSON.stringify(items);
  if (target.dataset.snapshot === signature) return;
  const focusedKey = target.contains(document.activeElement)
    ? document.activeElement?.dataset.resourceKey : null;
  render();
  target.dataset.snapshot = signature;
  if (focusedKey) {
    const replacement = [...target.querySelectorAll("[data-resource-key]")].find(
      (item) => item.dataset.resourceKey === focusedKey);
    const fallback = target.closest("section").querySelector("h2");
    if (!replacement) fallback.tabIndex = -1;
    (replacement ?? fallback).focus({ preventScroll: true });
  }
}

function renderSnapshot(nodes, pods, deployments) {
  displayedSnapshot = { nodes, pods, deployments };
  const containers = pods.flatMap((pod) =>
    pod.containers.map((container) => ({
      ...container,
      pod_name: pod.name,
      namespace: pod.namespace,
    })),
  );

  ui.nodeCount.textContent =
    nodes.filter((node) => node.ready === "True").length + " / " + nodes.length;
  ui.podCount.textContent =
    pods.filter((pod) => pod.ready === "True").length + " / " + pods.length;
  ui.deploymentCount.textContent = deployments.length;
  ui.containerCount.textContent = containers.filter(
    (container) => container.kind === "regular",
  ).length;

  renderStable(ui.nodes, nodes, () => renderNodes(nodes));
  renderStable(ui.pods, pods, () => renderPods(pods));
  renderStable(ui.deployments, deployments, () => renderDeployments(deployments));
  renderStable(ui.containers, containers, () => renderContainers(containers));

  window.kubelabDetails?.setSnapshot({
    nodes, pods, deployments, namespace: ui.namespace.value,
  });
}

async function getCollection(path, signal) {
  const response = await fetch(path, {
    signal,
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(path + " returned HTTP " + response.status);
  }

  const data = await response.json();
  if (!Array.isArray(data.items)) {
    throw new Error(path + " returned an unexpected response.");
  }

  return data.items;
}

function setStatus(message, state) {
  ui.status.textContent = message;
  ui.status.dataset.state = state;
}

function observingAction() {
  return Boolean(window.kubelabActions?.isBusy()) || Date.now() < observationUntil;
}

function observeAction() {
  observationUntil = Date.now() + ACTION_OBSERVATION_MS;
  // A new generation prevents a pre-action read from unlocking later writes.
  return refresh({ restart: true });
}

async function refresh({ restart = false } = {}) {
  if (busy && !restart) return;
  if (busy) requestController?.abort();
  const version = ++requestVersion;

  clearTimeout(timer);
  busy = true;
  window.kubelabActions?.setSnapshot(null);
  ui.refresh.disabled = true;

  if (lastSuccess === null) setStatus("Reading cluster data…", "neutral");

  const controller = new AbortController();
  requestController = controller;
  const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const scope = ui.namespace.value;
  const query = scope
    ? "?" + new URLSearchParams({ namespace: scope }).toString()
    : "";
  let snapshot = null;

  try {
    const results = await Promise.allSettled([
      getCollection("/api/nodes", controller.signal),
      getCollection("/api/pods" + query, controller.signal).then((pods) => {
        // Show Pod changes without waiting for slower Node or Deployment reads.
        if (version === requestVersion && observingAction() && displayedSnapshot) {
          renderSnapshot(displayedSnapshot.nodes, pods, displayedSnapshot.deployments);
        }
        return pods;
      }),
      getCollection("/api/deployments" + query, controller.signal),
    ]);

    if (version !== requestVersion) return;
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;

    const [nodes, pods, deployments] = results.map((result) => result.value);
    renderSnapshot(nodes, pods, deployments);
    snapshot = { pods, deployments };

    lastSuccess = new Date();
    ui.updated.textContent = lastSuccess.toLocaleString();
    ui.updated.dateTime = lastSuccess.toISOString();
    setStatus("Data refreshed. Automatic refresh is enabled.", "good");
  } catch (error) {
    if (version !== requestVersion) return;
    window.kubelabDetails?.setStale();
    const reason = error.name === "AbortError"
      ? "The request exceeded 15 seconds."
      : error.message;
    const retained = lastSuccess
      ? " Showing the latest available data; some data may be stale."
      : " No data has been loaded.";
    setStatus("Refresh failed. " + reason + retained, "bad");
  } finally {
    clearTimeout(deadline);
    if (version === requestVersion) {
      requestController = null;
      busy = false;
      ui.refresh.disabled = Boolean(window.kubelabActions?.isBusy());
      window.kubelabActions?.setSnapshot(snapshot);
      timer = setTimeout(refresh, observingAction() ? ACTION_REFRESH_MS : REFRESH_MS);
    }
  }
}

ui.refresh.addEventListener("click", () => refresh());
ui.namespace.addEventListener("change", () => {
  resetView();
  void refresh({ restart: true });
});

window.kubelabDashboard = {
  isBusy: () => busy,
  refresh,
  observeAction,
};

resetView();
refresh();
