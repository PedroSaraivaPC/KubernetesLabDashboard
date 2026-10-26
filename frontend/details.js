"use strict";

(() => {
  let snapshot = null;
  let selected = null;
  let stale = false;
  let rendered = "";
  let opener = null;
  let openerKey = null;

  function make(tag, text = null, className = "") {
    const node = document.createElement(tag);
    if (text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action) {
    const node = make("button", text, "resource-link");
    node.type = "button";
    node.dataset.detailsKey = text;
    node.addEventListener("click", action);
    return node;
  }

  const panel = make("dialog", null, "resource-details");
  panel.setAttribute("aria-labelledby", "resource-details-title");

  const header = make("div", null, "details-header");
  const title = make("h2");
  title.id = "resource-details-title";
  title.tabIndex = -1;

  function closeDetails({ restoreFocus = true, afterClose = null } = {}) {
    selected = null;
    rendered = "";
    if (panel.open) panel.close();
    document.body.classList.remove("details-open");
    if (afterClose) {
      afterClose();
    } else if (restoreFocus) {
      let target = opener?.isConnected ? opener : null;
      if (!target && openerKey) {
        target = [...document.querySelectorAll("[data-resource-key]")].find(
          (item) => item.dataset.resourceKey === openerKey);
      }
      target ??= document.querySelector("#nodes-title");
      if (target) {
        if (!target.matches("button, a, input, select")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    }
    opener = null;
    openerKey = null;
  }

  const close = make("button", "×", "details-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close details");
  close.addEventListener("click", () => closeDetails());
  panel.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDetails();
  });
  panel.addEventListener("click", (event) => {
    if (event.target !== panel) return;
    const box = panel.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right ||
        event.clientY < box.top || event.clientY > box.bottom) closeDetails();
  });

  header.append(title, close);
  const notice = make("p", null, "muted");
  notice.setAttribute("role", "status");
  const content = make("div");
  panel.append(header, notice, content);
  document.body.append(panel);

  function selectAction(kind, uid) {
    // Polling may have replaced the overview button while details were open.
    const returnTarget = { element: opener, key: openerKey };
    closeDetails({
      restoreFocus: false,
      afterClose: () => kind === "deployment"
        ? window.kubelabActions.selectDeployment(uid, returnTarget)
        : window.kubelabActions.selectPod(uid, returnTarget),
    });
  }

  function facts(pairs) {
    const list = make("dl");
    for (const [label, value] of pairs) {
      list.append(make("dt", label), make("dd", value ?? "Unknown"));
    }
    return list;
  }

  function open(kind, identity, origin = null) {
    const opening = !panel.open;
    if (opening) {
      opener = document.activeElement;
      openerKey = opener?.dataset.resourceKey ?? null;
    }
    selected = { kind, identity, origin };
    rendered = "";
    render();
    if (opening) {
      panel.showModal();
      document.body.classList.add("details-open");
    }
    panel.scrollTop = 0;
    title.focus({ preventScroll: true });
  }

  function podButton(pod, origin) {
    const result = button(pod.name, () => open("pod", pod.uid, origin));
    result.dataset.detailsKey = "pod:" + pod.uid;
    return result;
  }

  function showNode(node, pods) {
    title.textContent = "Node: " + selected.identity;
    if (!node) {
      content.append(make("p", "This Node is absent from the latest snapshot."));
      return;
    }

    content.append(facts([
      ["Ready condition", node.ready],
      ["Role", node.is_control_plane ? "Control plane" : "Worker"],
      ["Internal IP", node.internal_ip],
      ["Kubelet", node.kubelet_version],
      ["Container runtime", node.container_runtime],
    ]));
    content.append(make("h3", "Pods assigned to this Node (" + pods.length + ")"));

    if (pods.length === 0) {
      content.append(make("p", "No Pods on this Node in the selected namespace."));
      return;
    }

    const list = make("ul", null, "details-pods");
    for (const pod of pods) {
      const item = make("li");
      item.append(
        podButton(pod, { kind: "node", identity: node.name }),
        make("span", " · " + pod.namespace + " · " + pod.phase +
          " · Ready: " + pod.ready + (pod.deleting ? " · deleting" : "")),
      );
      list.append(item);
    }
    content.append(list);
  }

  function showDeployment(deployment, pods) {
    title.textContent = "Deployment details";
    if (!deployment) {
      content.append(make("p",
        "The selected Deployment UID is absent from the latest snapshot."));
      content.append(facts([["Selected UID", selected.identity]]));
      return;
    }

    title.textContent = "Deployment: " + deployment.name;
    content.append(facts([
      ["Namespace", deployment.namespace],
      ["UID", deployment.uid],
      ["Desired replicas", deployment.desired_replicas],
      ["Ready replicas", deployment.ready_replicas],
      ["Available replicas", deployment.available_replicas],
      ["Updated replicas", deployment.updated_replicas],
      ["Generation", deployment.generation],
      ["Observed generation", deployment.observed_generation],
    ]));
    content.append(make("p", deployment.images.join("\n"), "image"));

    if (deployment.namespace === "kubelab" &&
        ["kubelab-backend", "kubelab-frontend"].includes(deployment.name)) {
      content.append(button("Select for scaling", () =>
        selectAction("deployment", deployment.uid)));
    }

    content.append(make("h3", "Owned Pods (" + pods.length + ")"));
    if (pods.length === 0) {
      content.append(make("p", "No linked Pods in the current snapshot."));
      return;
    }

    const list = make("ul", null, "details-pods");
    for (const pod of pods) {
      const item = make("li");
      item.append(
        podButton(pod, { kind: "deployment", identity: deployment.uid }),
        make("span", " · Node: " + (pod.node_name ?? "Not assigned") +
          " · " + pod.phase + " · Ready: " + pod.ready +
          (pod.deleting ? " · deleting" : "")),
      );
      list.append(item);
    }
    content.append(list);
  }
  
  function showPod(pod) {
    title.textContent = "Pod details";
    if (selected.origin) {
      const previous = selected.origin;
      const label = previous.kind === "node" ? "Back to Node" : "Back to Deployment";
      content.append(button(label, () => open(previous.kind, previous.identity)));
    }
    // A recreated Pod has a different UID and must be selected explicitly.
    if (!pod) {
      content.append(make("p",
        "The selected Pod UID is absent from the latest snapshot. " +
        "Select a current Pod to inspect its replacement."));
      content.append(facts([["Selected UID", selected.identity]]));
      return;
    }

    title.textContent = "Pod: " + pod.name;
    const owner = pod.owner_kind
      ? pod.owner_kind + "/" + pod.owner_name
      : "None reported";

    content.append(facts([
      ["Namespace", pod.namespace],
      ["UID", pod.uid],
      ["Node", pod.node_name ?? "Not assigned"],
      ["Node IP", pod.node_ip],
      ["Pod IP", pod.pod_ip],
      ["Phase", pod.phase],
      ["Ready condition", pod.ready],
      ["Deleting", String(pod.deleting)],
      ["Controller owner", owner],
      ["Deployment owner", pod.owner_deployment_name ?? "Unresolved or not a Deployment"],
      ["Created", pod.created_at],
    ]));
    const deployment = snapshot.deployments.find((item) =>
      item.namespace === pod.namespace &&
      item.uid === pod.owner_deployment_uid &&
      item.name === pod.owner_deployment_name);
    if (!pod.deleting && deployment?.namespace === "kubelab" &&
        ["kubelab-backend", "kubelab-frontend"].includes(deployment.name)) {
      content.append(button("Select for replacement", () =>
        selectAction("pod", pod.uid)));
    }
    content.append(make("h3", "Containers"));

    const wrap = make("div", null, "table-wrap");
    const table = make("table");
    table.setAttribute("aria-label", "Containers in " + pod.name);
    const head = make("thead");
    const headings = make("tr");
    for (const label of ["Name", "Kind", "State / reason", "Ready",
      "Restarts", "Image"]) {
      const th = make("th", label);
      th.scope = "col";
      headings.append(th);
    }
    head.append(headings);
    const body = make("tbody");

    for (const container of pod.containers) {
      const row = make("tr");
      const state = [container.state];
      if (container.reason) state.push(container.reason);
      if (container.exit_code !== null) {
        state.push("exit " + container.exit_code);
      }
      for (const value of [container.name, container.kind, state.join(" · "),
        container.ready === null ? "Unknown" : String(container.ready),
        container.restart_count, container.image]) {
        row.append(make("td", value ?? "Unknown"));
      }
      const image = row.lastElementChild;
      image.className = "image";
      image.title = "Runtime image ID: " + (container.image_id ?? "not reported");
      body.append(row);
    }

    table.append(head, body);
    wrap.append(table);
    content.append(wrap);
  }

  function render() {
    if (!snapshot || !selected) return;
    const scope = snapshot.namespace || "All namespaces";
    notice.textContent = (stale
      ? "Refresh failed; these details are stale. "
      : "From the latest successful dashboard refresh. ") +
      "Workload scope: " + scope + ".";

    const node = selected.kind === "node"
      ? snapshot.nodes.find((item) => item.name === selected.identity) : null;
    const deployment = selected.kind === "deployment"
      ? snapshot.deployments.find((item) => item.uid === selected.identity) : null;
    const pod = selected.kind === "pod"
      ? snapshot.pods.find((item) => item.uid === selected.identity) : null;

    const pods = selected.kind === "node"
      ? snapshot.pods.filter((item) => item.node_name === selected.identity)
      : deployment
        ? snapshot.pods.filter((item) =>
          item.namespace === deployment.namespace &&
          item.owner_deployment_uid === deployment.uid &&
          item.owner_deployment_name === deployment.name)
        : [];

    const key = JSON.stringify([selected, node, deployment, pods, pod]);
    if (key === rendered) return;
    const focusedKey = content.contains(document.activeElement)
      ? document.activeElement?.dataset.detailsKey : null;
    const scrollTop = panel.scrollTop;
    rendered = key;
    content.replaceChildren();

    if (selected.kind === "node") showNode(node, pods);
    else if (selected.kind === "deployment") showDeployment(deployment, pods);
    else showPod(pod);

    if (focusedKey) {
      const target = [...content.querySelectorAll("[data-details-key]")].find(
        (item) => item.dataset.detailsKey === focusedKey);
      (target ?? title).focus({ preventScroll: true });
    }
    panel.scrollTop = scrollTop;
  }

  window.kubelabDetails = {
    openNode: (name) => open("node", name),
    openDeployment: (uid) => open("deployment", uid),
    openPod: (uid) => open("pod", uid),
    setSnapshot(data) {
      snapshot = data;
      stale = false;
      render();
    },
    setStale() {
      stale = true;
      render();
    },
    clear() {
      snapshot = null;
      closeDetails({ restoreFocus: false });
    },
  };
})();
